import { Keypair } from '@stellar/stellar-sdk';
import { createApp } from '../src/app.js';
import type { Storage } from '../src/persistence/storage.js';
import type { Actor } from '../src/common/auth.js';
import type { Clock } from '../src/common/ids.js';
import { canonicalPolicyBytes, type RedemptionPolicy, type UnsignedPolicy } from '../src/modules/issuers/policy.js';
import { challengeMessage } from '../src/modules/wallets/service.js';
import { FakeStellarGateway, signFake } from '../src/testing/fake-gateway.js';
import { createHash } from 'node:crypto';

/** All keys are throwaway and generated per run. */
export function makeWorld(storage?: Storage) {
  const t = { ms: Date.UTC(2026, 10, 2, 12, 0, 0) };
  const clock: Clock = { now: () => new Date(t.ms) };
  const gateway = new FakeStellarGateway(() => t.ms);
  const app = createApp({ gateway, clock, ...(storage ? { storage } : {}) });
  const admin: Actor = { id: 'adm_1', role: 'admin' };
  const issuerKp = Keypair.random();
  const targetIssuerKp = Keypair.random();
  const SHOP = { code: 'SHOP', issuer: issuerKp.publicKey() };
  const USDC = { code: 'USDC', issuer: targetIssuerKp.publicKey() };
  let n = 0;
  const rid = () => `req_${++n}`;

  function policyFor(kp: Keypair, assetCode: string, over: Partial<UnsignedPolicy> = {}): RedemptionPolicy {
    const unsigned: UnsignedPolicy = {
      schemaVersion: '1.0',
      legalIdentity: { legalName: 'Example Coffee Roasters Ltd (SYNTHETIC)', registrationRef: 'TEST-0001' },
      assetCode,
      issuerPublicKey: kp.publicKey(),
      unitOfAccount: '1 SHOP = 1 USD of store credit (synthetic)',
      faceValue: { amountPerUnit: '1.0000000', currency: 'USD' },
      redemptionLimits: { minUnits: '1', maxUnitsPerRequest: '500' },
      expiresAt: '2027-11-02T00:00:00.000Z',
      jurisdiction: 'Testland',
      refundPolicy: 'Unredeemed credit refundable within 30 days of rejection (synthetic).',
      contact: 'redemptions@example.invalid',
      kycRequirements: 'None for Testnet demo',
      tokenizationAuthorized: true,
      transferAllowed: true,
      ...over,
    };
    const signature = Buffer.from(kp.sign(canonicalPolicyBytes(unsigned))).toString('base64');
    return { ...unsigned, signature };
  }

  /** merchant applies, admin verifies, merchant registers SHOP; admin lists USDC as swap target. */
  async function onboardMerchant(policyOver: Partial<UnsignedPolicy> = {}) {
    const owner: Actor = { id: 'usr_merchant', role: 'merchant' };
    const m = await app.issuers.apply(owner, { legalName: 'Example Coffee Roasters Ltd', jurisdiction: 'Testland', contact: 'a@example.invalid' }, rid());
    const merchant: Actor = { ...owner, merchantId: m.id };
    await app.issuers.verifyMerchant(admin, m.id, 'EVIDENCE-TICKET-1', rid());
    const program = await app.issuers.registerProgram(merchant, { assetCode: 'SHOP', issuerPublicKey: issuerKp.publicKey(), policy: policyFor(issuerKp, 'SHOP', policyOver) }, rid());
    await app.issuers.addSupportedTarget(admin, USDC, rid());
    return { merchant, merchantRecord: m, program };
  }

  /** Real challenge/verify flow with a fresh keypair. */
  async function newUser() {
    const kp = Keypair.random();
    const ch = await app.wallets.createChallenge(kp.publicKey());
    const sig = Buffer.from(kp.sign(Buffer.from(ch.message))).toString('base64');
    const v = await app.wallets.verifyChallenge(ch.challengeId, sig, rid());
    return { kp, actor: v.actor, token: v.token, publicKey: kp.publicKey() };
  }

  async function quoteFor(user: Awaited<ReturnType<typeof newUser>>, over: Record<string, unknown> = {}) {
    return app.exchange.quote(
      user.actor,
      {
        schemaVersion: '1.0',
        sourceAsset: SHOP,
        targetAsset: USDC,
        sourceAmount: '80.0000000',
        slippageBps: 100,
        destinationAccount: user.publicKey,
        network: 'TESTNET',
        ...over,
      },
      rid(),
    );
  }

  async function readyIntent(user: Awaited<ReturnType<typeof newUser>>, key = 'idem-key-0001') {
    const q = await quoteFor(user);
    const intent = await app.exchange.createIntent(user.actor, { quoteId: q.id, idempotencyKey: key }, rid());
    return { q, intent };
  }

  const eventFor = (hash: string, status: 'CONFIRMED' | 'FAILED' | 'RECONCILING', extra: Record<string, unknown> = {}) => ({
    id: 'evt_' + createHash('sha256').update(`TESTNET:${hash}`).digest('hex').slice(0, 32),
    sourceRepo: 'unbound-stellar',
    schemaVersion: '1.0',
    network: 'TESTNET',
    ledgerCursor: '10',
    entityRef: { type: 'transaction', ref: hash },
    status,
    observedAt: new Date(t.ms).toISOString(),
    ledger: 1234,
    ...(status === 'CONFIRMED' ? { amountOutActual: '72.0000000' } : {}),
    ...extra,
  });

  return { t, clock, gateway, app, admin, issuerKp, targetIssuerKp, SHOP, USDC, rid, policyFor, onboardMerchant, newUser, quoteFor, readyIntent, eventFor, signFake, challengeMessage };
}
export type World = ReturnType<typeof makeWorld>;
