/**
 * CROSS-REPO tests. They import the sibling `unbound-stellar` checkout (../Unbound-stellar) and are
 * skipped when it is not present next to this repo. They run unbound-core's real code against
 * unbound-stellar's real gateway service, with a SimulatedLedger (in-memory TEST ADAPTER) behind it.
 * Nothing here touches Stellar Testnet.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { HttpStellarGateway } from '../src/integrations/stellar-http-gateway.js';
import { canonicalPolicyBytes, type UnsignedPolicy } from '../src/modules/issuers/policy.js';
import { ReconciliationEventSchema } from '../src/modules/reconciliation/contract.js';

const stellar = fileURLToPath(new URL('../../Unbound-stellar', import.meta.url));
const present = existsSync(join(stellar, 'src/service/server.ts'));
const d = present ? describe : describe.skip;

d('contract fixtures are identical in both repos', () => {
  it('gateway fixtures', () => {
    const mine = readdirSync(new URL('../fixtures/gateway', import.meta.url)).sort();
    const theirs = readdirSync(join(stellar, 'fixtures/gateway')).sort();
    expect(mine).toEqual(theirs);
    for (const f of mine) {
      expect(readFileSync(new URL(`../fixtures/gateway/${f}`, import.meta.url), 'utf8'), f).toBe(readFileSync(join(stellar, 'fixtures/gateway', f), 'utf8'));
    }
  });
  it('reconciliation event golden fixture and JSON schema snapshot', () => {
    for (const [mine, theirs] of [
      ['reconciliation-event.confirmed.v1.json', 'fixtures/reconciliation-event.confirmed.v1.json'],
      ['reconciliation-event.stellar-schema.v1.json', 'schemas/reconciliation-event.v1.json'],
    ] as const) {
      expect(readFileSync(new URL(`../fixtures/${mine}`, import.meta.url), 'utf8'), mine).toBe(readFileSync(join(stellar, theirs), 'utf8'));
    }
    expect(ReconciliationEventSchema.safeParse(JSON.parse(readFileSync(join(stellar, 'fixtures/reconciliation-event.confirmed.v1.json'), 'utf8'))).success).toBe(true);
  });
});

d('core + stellar gateway service, wired over real HTTP', () => {
  async function rig(opts: { escrow?: 'none' | 'fixture' } = {}) {
    const helpers = await import(/* @vite-ignore */ join(stellar, 'tests/helpers.ts'));
    const serverMod = await import(/* @vite-ignore */ join(stellar, 'src/service/server.ts'));
    const signing = await import(/* @vite-ignore */ join(stellar, 'src/settlement/signing.ts'));
    const pendingMod = await import(/* @vite-ignore */ join(stellar, 'src/worker/pending-store.ts'));
    const sw = helpers.makeWorld();
    await sw.issueSampleCredit('100');
    await sw.seedLiquidity();
    const pending = new pendingMod.InMemoryPendingStore();
    const token = 'cross-repo-test-token-0123456789';
    let escrow: unknown;
    if (opts.escrow === 'fixture') {
      // unbound-stellar's real SorobanRedemptionEscrow over its FixtureSorobanRpc TEST ADAPTER (no Soroban RPC)
      const escrowMod = await import(/* @vite-ignore */ join(stellar, 'src/soroban/escrow.ts'));
      const rpcMod = await import(/* @vite-ignore */ join(stellar, 'src/testing/fixture-soroban-rpc.ts'));
      const rpc = new rpcMod.FixtureSorobanRpc();
      rpc.sequences.set(sw.user.publicKey, '100');
      rpc.sequences.set(sw.issuer.publicKey, '200');
      escrow = new escrowMod.SorobanRedemptionEscrow({ rpc, contractId: 'CADQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQP5KR', registry: sw.registry });
    }
    const server = serverMod.createGatewayServer({
      reader: sw.ledger, pathSource: sw.ledger, submitter: sw.ledger, lookup: sw.ledger, registry: sw.registry, pending, token, now: () => sw.clock.t,
      ...(escrow ? { escrow } : {}),
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const gateway = new HttpStellarGateway({ baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, token, escrow: opts.escrow !== undefined });
    const clock = { now: () => new Date(sw.clock.t) };
    const app = createApp({ gateway, clock });
    return { sw, app, gateway, pending, signing, close: () => new Promise<void>((r) => server.close(() => r())) };
  }

  const b64 = (u: Uint8Array) => Buffer.from(u).toString('base64');

  async function onboard(r: Awaited<ReturnType<typeof rig>>) {
    const { sw, app } = r;
    const admin = { id: 'adm', role: 'admin' as const };
    const owner = { id: 'usr_m', role: 'merchant' as const };
    const m = await app.issuers.apply(owner, { legalName: 'Cross Repo Shop', jurisdiction: 'Testland', contact: 'x@example.invalid' }, 'r');
    await app.issuers.verifyMerchant(admin, m.id, 'EVIDENCE', 'r');
    const unsigned: UnsignedPolicy = {
      schemaVersion: '1.0', legalIdentity: { legalName: 'Cross Repo Shop', registrationRef: 'X-1' }, assetCode: 'SHOP', issuerPublicKey: sw.issuer.publicKey,
      unitOfAccount: '1 SHOP = 1 USD (synthetic)', faceValue: { amountPerUnit: '1.0000000', currency: 'USD' }, redemptionLimits: { minUnits: '1', maxUnitsPerRequest: '500' },
      expiresAt: '2027-11-02T00:00:00.000Z', jurisdiction: 'Testland', refundPolicy: 'Synthetic refunds within 30 days.', contact: 'x@example.invalid', kycRequirements: 'None',
      tokenizationAuthorized: true, transferAllowed: true,
    };
    const policy = { ...unsigned, signature: b64(sw.issuer.signHash(canonicalPolicyBytes(unsigned))) };
    await app.issuers.registerProgram({ ...owner, merchantId: m.id }, { assetCode: 'SHOP', issuerPublicKey: sw.issuer.publicKey, policy }, 'r');
    await app.issuers.addSupportedTarget(admin, sw.USDC, 'r');
    // core is the authority on trust: push its list to the stellar service
    await r.gateway.syncTrustedAssets(await app.issuers.trustedAssets() as { code: string; issuer: string }[]);
    // user logs in by proving wallet control with the same key that holds the credit
    const ch = await app.wallets.createChallenge(sw.user.publicKey);
    const v = await app.wallets.verifyChallenge(ch.challengeId, b64(sw.user.signHash(Buffer.from(ch.message))), 'r');
    return { user: v.actor, admin, merchant: { ...owner, merchantId: m.id } };
  }

  it('exchange: portfolio -> quote -> intent -> user signs the REAL unsigned tx -> confirmed with the ledger amount', async () => {
    const r = await rig();
    try {
      const { user } = await onboard(r);
      const { sw, app } = r;
      const pf = await app.portfolio.get(user);
      expect(pf.holdings.find((h) => h.asset.code === 'SHOP')).toMatchObject({ status: 'REDEEMABLE', balance: '100.0000000' });

      const q = await app.exchange.quote(user, { schemaVersion: '1.0', sourceAsset: sw.SHOP, targetAsset: sw.USDC, sourceAmount: '80', slippageBps: 100, destinationAccount: sw.user.publicKey, network: 'TESTNET' }, 'r');
      expect(q.quote.minDestinationAmount).toBe('71.2800000');
      const intent = await app.exchange.createIntent(user, { quoteId: q.id, idempotencyKey: 'cross-repo-key-1' }, 'r');
      expect(intent.state).toBe('AWAITING_SIGNATURE');
      expect(await r.pending.list()).toHaveLength(1); // worker will report this hash

      const signed = r.signing.signTransaction(intent.unsignedXdr!, q.quote.networkPassphrase, sw.user);
      const done = await app.exchange.submit(user, intent.id, { signedXdr: signed, submitKey: 'cross-repo-submit-1' }, 'r');
      expect(done).toMatchObject({ state: 'CONFIRMED', amountOutActual: '72.0000000' });
      expect(sw.ledger.balanceOf(sw.user.publicKey, sw.USDC)).toBe(720000000n);
    } finally {
      await r.close();
    }
  });

  it('ledger-side failure surfaces as FAILED in core and nothing moves', async () => {
    const r = await rig();
    try {
      const { user } = await onboard(r);
      const { sw, app } = r;
      const q = await app.exchange.quote(user, { schemaVersion: '1.0', sourceAsset: sw.SHOP, targetAsset: sw.USDC, sourceAmount: '80', slippageBps: 100, destinationAccount: sw.user.publicKey, network: 'TESTNET' }, 'r');
      const intent = await app.exchange.createIntent(user, { quoteId: q.id, idempotencyKey: 'cross-repo-key-2' }, 'r');
      sw.ledger.clearOffers(); // liquidity vanishes between approval and submit
      const signed = r.signing.signTransaction(intent.unsignedXdr!, q.quote.networkPassphrase, sw.user);
      const done = await app.exchange.submit(user, intent.id, { signedXdr: signed, submitKey: 'cross-repo-submit-2' }, 'r');
      expect(done).toMatchObject({ state: 'FAILED', failureReason: 'NO_ROUTE' });
      expect(sw.ledger.balanceOf(sw.user.publicKey, sw.SHOP)).toBe(1_000_000_000n);
    } finally {
      await r.close();
    }
  });

  it('unknown submit outcome -> RECONCILING; the worker-style event then confirms it in core', async () => {
    const r = await rig();
    try {
      const { user, admin } = await onboard(r);
      const { sw, app } = r;
      const q = await app.exchange.quote(user, { schemaVersion: '1.0', sourceAsset: sw.SHOP, targetAsset: sw.USDC, sourceAmount: '80', slippageBps: 100, destinationAccount: sw.user.publicKey, network: 'TESTNET' }, 'r');
      const intent = await app.exchange.createIntent(user, { quoteId: q.id, idempotencyKey: 'cross-repo-key-3' }, 'r');
      sw.ledger.injectNextSubmit('timeout-after-apply');
      const signed = r.signing.signTransaction(intent.unsignedXdr!, q.quote.networkPassphrase, sw.user);
      const mid = await app.exchange.submit(user, intent.id, { signedXdr: signed, submitKey: 'cross-repo-submit-3' }, 'r');
      expect(mid.state).toBe('RECONCILING');

      // run stellar's REAL HashWatcher, delivering into core's REAL reconciliation ingest
      const { HashWatcher } = await import(/* @vite-ignore */ join(stellar, 'src/worker/watcher.ts'));
      const sink = { publish: async (events: unknown[]) => { for (const e of events) await app.reconciliation.ingest(e, 'worker'); } };
      const res = await new HashWatcher({ lookup: sw.ledger, pending: r.pending, sink, now: () => sw.clock.t }).tick();
      expect(res.resolved).toBe(1);
      expect(await app.exchange.getIntent(user, intent.id)).toMatchObject({ state: 'CONFIRMED', amountOutActual: '72.0000000' });
      void admin;
    } finally {
      await r.close();
    }
  });

  it('redemption: core asks stellar for the burn tx, user signs it, merchant confirms after the ledger confirms', async () => {
    const r = await rig();
    try {
      const { user, merchant } = await onboard(r);
      const { sw, app } = r;
      const red = await app.redemption.create(user, { asset: sw.SHOP, amount: '30', holder: sw.user.publicKey }, 'cross-redeem-1', 'r');
      const signed = r.signing.signTransaction(red.unsignedXdr!, 'Test SDF Network ; September 2015', sw.user);
      const after = await app.redemption.submitReturn(user, red.id, signed, 'r');
      expect(after.state).toBe('RETURN_CONFIRMED');
      expect(sw.ledger.balanceOf(sw.user.publicKey, sw.SHOP)).toBe(700000000n);
      expect((await app.redemption.merchantConfirm(merchant, red.id, 'r')).state).toBe('FULFILLED');
    } finally {
      await r.close();
    }
  });

  it('escrow opted in but not configured on the gateway: ESCROW_UNAVAILABLE -> native return, end to end', async () => {
    const r = await rig({ escrow: 'none' });
    try {
      const { user, merchant } = await onboard(r);
      const { sw, app } = r;
      const red = await app.redemption.create(user, { asset: sw.SHOP, amount: '30', holder: sw.user.publicKey }, 'cross-redeem-2', 'r');
      expect(red.mode).toBe('NATIVE');
      const signed = r.signing.signTransaction(red.unsignedXdr!, 'Test SDF Network ; September 2015', sw.user);
      expect((await app.redemption.submitReturn(user, red.id, signed, 'r')).state).toBe('RETURN_CONFIRMED');
      expect((await app.redemption.merchantConfirm(merchant, red.id, 'r')).state).toBe('FULFILLED');
    } finally {
      await r.close();
    }
  });

  it('escrow configured: core receives a real, prepared Soroban open_return invocation the holder can sign', async () => {
    const r = await rig({ escrow: 'fixture' });
    try {
      const { user } = await onboard(r);
      const { sw, app } = r;
      const red = await app.redemption.create(user, { asset: sw.SHOP, amount: '30', holder: sw.user.publicKey }, 'cross-redeem-3', 'r');
      expect(red.mode).toBe('ESCROW');
      expect(red.escrow?.contractId).toBe('CADQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQP5KR');
      const { TransactionBuilder } = await import('@stellar/stellar-sdk');
      const tx = TransactionBuilder.fromXDR(red.unsignedXdr!, 'Test SDF Network ; September 2015') as import('@stellar/stellar-sdk').Transaction;
      expect(tx.operations[0]!.type).toBe('invokeHostFunction');
      expect(tx.source).toBe(sw.user.publicKey);
      expect(Buffer.from(tx.hash()).toString('hex')).toBe(red.returnTxHash);
      // the holder (only) can sign it; the simulator cannot execute Soroban, so the flow stops here
      expect(() => r.signing.signTransaction(red.unsignedXdr!, 'Test SDF Network ; September 2015', sw.user)).not.toThrow();
    } finally {
      await r.close();
    }
  });
});
