/**
 * LIVE end-to-end run: core (HTTP) -> Stellar gateway -> Stellar Testnet + the deployed redemption escrow.
 * Not a unit test; needs both services running (the gateway from Unbound-stellar and core; see docs/DEPLOYMENT.md in Unbound-stellar) and the Testnet accounts
 * created by Unbound-stellar/scripts/testnet-smoke.ts. Testnet and synthetic data only.
 *
 *   node --env-file=.env --import tsx scripts/testnet-e2e.ts          # onboard, redeem+confirm, redeem+reject, open the expiry case
 *   node --env-file=.env --import tsx scripts/testnet-e2e.ts finish   # after the escrow window: holder claims the timeout refund
 *
 * Secrets: the issuer and consumer secret seeds are read in memory from the local stellar-cli keystore through
 * `stellar keys show` and are never printed, logged or written. The evidence file holds public ids and hashes only.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { Keypair, Networks, TransactionBuilder } from '@stellar/stellar-sdk';
import { canonicalPolicyBytes, type RedemptionPolicy, type UnsignedPolicy } from '../src/modules/issuers/policy.js';
import { challengeMessage } from '../src/modules/wallets/service.js';

const CORE = process.env.CORE_URL ?? 'http://127.0.0.1:3001';
const OUT = process.env.E2E_OUT ?? '../Unbound-stellar/contracts/deployments/testnet-e2e.json';
const ISSUER_ALIAS = process.env.ISSUER_ALIAS ?? 'unbound-issuer';
const CONSUMER_ALIAS = process.env.CONSUMER_ALIAS ?? 'unbound-consumer';
const CODE = 'SHOP';
const MERCHANT_EMAIL = process.env.E2E_MERCHANT_EMAIL ?? 'e2e-merchant@example.invalid';
const MERCHANT_PASSWORD = process.env.E2E_MERCHANT_PASSWORD ?? `E2e-${process.env.BOOTSTRAP_ADMIN_PASSWORD ?? 'missing'}`;

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
type Step = { name: string; ok: boolean; redemptionId?: string; state?: string; txHashes?: Record<string, string>; note?: string };
type Log = { network: 'testnet'; startedAt: string; core: string; asset: string; issuer: string; holder: string; steps: Step[]; pendingExpiry?: { redemptionId: string; deadline: string } };

function secretOf(alias: string): Keypair {
  // The secret stays inside this process; stdout is parsed and dropped.
  const r = spawnSync('stellar', ['keys', 'show', alias], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`no stellar-cli key named ${alias}`);
  return Keypair.fromSecret(r.stdout.trim());
}

async function call(method: string, path: string, o: { token?: string; body?: unknown; key?: string } = {}): Promise<{ status: number; json: Json }> {
  const res = await fetch(CORE + path, {
    method,
    headers: { 'content-type': 'application/json', ...(o.token ? { authorization: `Bearer ${o.token}` } : {}), ...(o.key ? { 'idempotency-key': o.key } : {}) },
    ...(o.body !== undefined ? { body: JSON.stringify(o.body) } : {}),
  });
  return { status: res.status, json: (await res.json()) as Json };
}

function need(cond: unknown, msg: string, ctx?: unknown): asserts cond {
  if (!cond) throw new Error(`E2E FAILED: ${msg}${ctx !== undefined ? `\n${JSON.stringify(ctx, null, 2).slice(0, 1500)}` : ''}`);
}

const sign = (kp: Keypair, xdr: string): string => {
  const tx = TransactionBuilder.fromXDR(xdr, Networks.TESTNET);
  tx.sign(kp);
  return tx.toXDR();
};

const hashes = (j: Json): Record<string, string> => {
  const out: Record<string, string> = {};
  const walk = (o: unknown, p: string): void => {
    if (!o || typeof o !== 'object') return;
    for (const [k, v] of Object.entries(o as Json)) {
      if (typeof v === 'string' && /hash/i.test(k) && /^[0-9a-f]{64}$/.test(v)) out[p + k] = v;
      else walk(v, `${p}${k}.`);
    }
  };
  walk(j, '');
  return out;
};

const save = (log: Log): void => writeFileSync(OUT, JSON.stringify(log, null, 2) + '\n');
const note = (log: Log, s: Step): void => {
  log.steps.push(s);
  save(log);
  console.log(`${s.ok ? 'OK ' : 'FAIL'} ${s.name}${s.state ? ` -> ${s.state}` : ''}${s.txHashes ? ' ' + Object.values(s.txHashes).join(' ') : ''}${s.note ? ` (${s.note})` : ''}`);
};

async function login(email: string, password: string): Promise<string> {
  const r = await call('POST', '/v1/auth/login', { body: { email, password } });
  need(r.status === 200 && r.json.token, 'login', { status: r.status, error: r.json.error });
  return r.json.token as string;
}

async function walletSession(kp: Keypair): Promise<string> {
  const ch = await call('POST', '/v1/wallets/challenge', { body: { publicKey: kp.publicKey() } });
  need(ch.status === 200 || ch.status === 201, 'wallet challenge', ch.json);
  need(ch.json.message === challengeMessage(ch.json.message.split(':')[3], kp.publicKey()), 'challenge message shape');
  const signature = Buffer.from(kp.sign(Buffer.from(ch.json.message as string))).toString('base64');
  const v = await call('POST', '/v1/wallets/verify', { body: { challengeId: ch.json.challengeId, signature } });
  need(v.status === 200 && v.json.token, 'wallet verify', v.json);
  return v.json.token as string;
}

async function onboard(issuer: Keypair): Promise<string> {
  const adminToken = await login(process.env.BOOTSTRAP_ADMIN_EMAIL!, process.env.BOOTSTRAP_ADMIN_PASSWORD!);
  let mtoken: string | undefined;
  const reg = await call('POST', '/v1/auth/register', { body: { email: MERCHANT_EMAIL, password: MERCHANT_PASSWORD } });
  if (reg.status === 201) {
    mtoken = await login(MERCHANT_EMAIL, MERCHANT_PASSWORD);
    const ap = await call('POST', '/v1/merchants/apply', { token: mtoken, body: { legalName: 'Unbound Testnet Coffee (SYNTHETIC)', jurisdiction: 'Testland', contact: 'redemptions@example.invalid' } });
    need(ap.status === 201, 'merchant apply', ap.json);
    const v = await call('POST', `/v1/admin/merchants/${ap.json.id}/verify`, { token: adminToken, body: { evidenceRef: 'E2E-SYNTHETIC-EVIDENCE' } });
    need(v.status === 200, 'admin verify merchant', v.json);
    mtoken = await login(MERCHANT_EMAIL, MERCHANT_PASSWORD); // new session carries the verified merchant
    const unsigned: UnsignedPolicy = {
      schemaVersion: '1.0',
      legalIdentity: { legalName: 'Unbound Testnet Coffee (SYNTHETIC)', registrationRef: 'SYNTHETIC-E2E-0001' },
      assetCode: CODE,
      issuerPublicKey: issuer.publicKey(),
      unitOfAccount: '1 SHOP = 1 USD of store credit (synthetic)',
      faceValue: { amountPerUnit: '1.0000000', currency: 'USD' },
      redemptionLimits: { minUnits: '1', maxUnitsPerRequest: '500' },
      expiresAt: new Date(Date.now() + 365 * 86_400_000).toISOString(),
      jurisdiction: 'Testland',
      refundPolicy: 'Synthetic Testnet demo: rejected redemptions are refunded on-chain by the escrow.',
      contact: 'redemptions@example.invalid',
      kycRequirements: 'None for the Testnet demo',
      tokenizationAuthorized: true,
      transferAllowed: true,
    };
    const policy: RedemptionPolicy = { ...unsigned, signature: Buffer.from(issuer.sign(canonicalPolicyBytes(unsigned))).toString('base64') };
    const asset = await call('POST', '/v1/merchants/me/assets', { token: mtoken, body: { assetCode: CODE, issuerPublicKey: issuer.publicKey(), policy } });
    need(asset.status === 201, 'register credit program', asset.json);
  } else {
    need(reg.json.error, 'register', reg.json);
    mtoken = await login(MERCHANT_EMAIL, MERCHANT_PASSWORD); // already onboarded in an earlier run
  }
  return mtoken;
}

async function redeemToEscrow(log: Log, consumer: Keypair, ctoken: string, issuer: Keypair, label: string, amount: string): Promise<Json> {
  const c = await call('POST', '/v1/redemptions', { token: ctoken, key: `e2e-${label}-${Date.now()}`, body: { asset: { code: CODE, issuer: issuer.publicKey() }, amount, holder: consumer.publicKey() } });
  need(c.status === 201 && c.json.unsignedXdr, `create redemption (${label})`, c.json);
  const s = await call('POST', `/v1/redemptions/${c.json.id}/return`, { token: ctoken, body: { signedXdr: sign(consumer, c.json.unsignedXdr) } });
  need(s.status === 202, `submit return (${label})`, s.json);
  // the holder's open_return is on the ledger once core has seen it confirmed; poll the redemption
  let r = s.json;
  for (let i = 0; i < 20 && r.state !== 'RETURN_CONFIRMED'; i++) {
    await new Promise((res) => setTimeout(res, 3000));
    r = (await call('GET', `/v1/redemptions/${c.json.id}`, { token: ctoken })).json;
  }
  need(r.state === 'RETURN_CONFIRMED' && r.mode === 'ESCROW' && r.escrow?.state === 'HELD', `credit is held in the escrow (${label})`, { state: r.state, mode: r.mode, escrow: r.escrow });
  note(log, { name: `holder returns ${amount} ${CODE} into the escrow (${label})`, ok: true, redemptionId: r.id, state: `${r.state}/${r.escrow.state}`, txHashes: hashes(r), note: `mode ${r.mode}` });
  return r;
}

async function main(): Promise<void> {
  const mode = process.argv[2] ?? 'run';
  const issuer = secretOf(ISSUER_ALIAS);
  const consumer = secretOf(CONSUMER_ALIAS);
  const ctoken = await walletSession(consumer);

  if (mode === 'finish') {
    const log = JSON.parse(readFileSync(OUT, 'utf8')) as Log;
    need(log.pendingExpiry, 'no pending expiry case in the evidence file');
    const id = log.pendingExpiry.redemptionId;
    const cur = (await call('GET', `/v1/redemptions/${id}`, { token: ctoken })).json;
    if (!cur.escrow?.refundAvailable) {
      console.log(`refund not available yet (deadline ${cur.escrow?.deadline}); try again after it`);
      return;
    }
    const p = await call('POST', `/v1/redemptions/${id}/refund`, { token: ctoken });
    need(p.status < 300 && p.json.escrow?.pendingXdr, 'prepare timeout refund', p.json);
    const done = await call('POST', `/v1/redemptions/${id}/escrow/submit`, { token: ctoken, body: { signedXdr: sign(consumer, p.json.escrow.pendingXdr) } });
    need(done.json.state === 'EXPIRED', 'redemption ends EXPIRED after the refund lands', done.json);
    note(log, { name: 'holder claims the timeout refund after the deadline', ok: true, redemptionId: id, state: `${done.json.state}/${done.json.escrow.state}`, txHashes: hashes(done.json) });
    delete log.pendingExpiry;
    save(log);
    return;
  }

  const log: Log = { network: 'testnet', startedAt: new Date().toISOString(), core: CORE, asset: `${CODE}:${issuer.publicKey()}`, issuer: issuer.publicKey(), holder: consumer.publicKey(), steps: [] };
  const mtoken = await onboard(issuer);
  // push core's trusted issuers to the gateway now instead of waiting for the 30 s job interval
  const adminToken = await login(process.env.BOOTSTRAP_ADMIN_EMAIL!, process.env.BOOTSTRAP_ADMIN_PASSWORD!);
  const sync = await call('POST', '/v1/admin/jobs/sync-trusted-assets/run', { token: adminToken });
  need(sync.status === 200, 'trusted-asset sync job ran', sync.json);
  note(log, { name: 'merchant registered, verified by an admin, credit program registered with an issuer-signed policy', ok: true });

  // 1. redeem, merchant confirms (issuer signs the escrow confirm transaction)
  let r = await redeemToEscrow(log, consumer, ctoken, issuer, 'confirm', '4');
  const c = await call('POST', `/v1/merchants/me/redemptions/${r.id}/confirm`, { token: mtoken });
  need(c.status === 202 && c.json.escrow?.pendingXdr, 'merchant confirm prepares an issuer transaction', c.json);
  let done = await call('POST', `/v1/merchants/me/redemptions/${r.id}/escrow/submit`, { token: mtoken, body: { signedXdr: sign(issuer, c.json.escrow.pendingXdr) } });
  need(done.json.state === 'FULFILLED' && done.json.escrow?.state === 'RELEASED', 'confirm lands on the ledger and core shows FULFILLED', done.json);
  note(log, { name: 'merchant confirms; issuer-signed escrow confirm submitted', ok: true, redemptionId: r.id, state: `${done.json.state}/${done.json.escrow.state}`, txHashes: hashes(done.json) });

  // 2. redeem, merchant rejects: credit goes back to the holder on-chain
  r = await redeemToEscrow(log, consumer, ctoken, issuer, 'reject', '3');
  const rej = await call('POST', `/v1/merchants/me/redemptions/${r.id}/reject`, { token: mtoken, body: { reason: 'out of stock (synthetic)' } });
  need(rej.status === 202 && rej.json.escrow?.pendingXdr, 'merchant reject prepares an issuer transaction', rej.json);
  done = await call('POST', `/v1/merchants/me/redemptions/${r.id}/escrow/submit`, { token: mtoken, body: { signedXdr: sign(issuer, rej.json.escrow.pendingXdr) } });
  need(done.json.state === 'REJECTED' && done.json.escrow?.state === 'REFUNDED', 'reject lands on the ledger and core shows REJECTED/REFUNDED', done.json);
  note(log, { name: 'merchant rejects; credit refunded to the holder by the escrow', ok: true, redemptionId: r.id, state: `${done.json.state}/${done.json.escrow.state}`, txHashes: hashes(done.json) });

  // 3. redeem and leave it unanswered: after the deadline the holder reclaims it (run `finish`)
  r = await redeemToEscrow(log, consumer, ctoken, issuer, 'expiry', '2');
  log.pendingExpiry = { redemptionId: r.id, deadline: r.escrow.deadline };
  save(log);
  console.log(`\nleft unanswered on purpose. After ${r.escrow.deadline} run:\n  node --env-file=.env --import tsx scripts/testnet-e2e.ts finish`);
}

if (!existsSync(OUT.replace(/[^/\\]+$/, ''))) throw new Error(`evidence directory missing: ${OUT}`);
main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
