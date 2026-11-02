import { Keypair } from '@stellar/stellar-sdk';
import { describe, expect, it } from 'vitest';
import { makeWorld } from './helpers.js';

describe('wallet challenge/verify', () => {
  it('issues a session only for a valid signature, and only once per challenge', async () => {
    const w = makeWorld();
    const kp = Keypair.random();
    const ch = await w.app.wallets.createChallenge(kp.publicKey());
    const sig = Buffer.from(kp.sign(Buffer.from(ch.message))).toString('base64');
    const v = await w.app.wallets.verifyChallenge(ch.challengeId, sig, 'r');
    expect(await w.app.wallets.authenticate(v.token)).toMatchObject({ role: 'user', id: v.actor.id });
    await expect(w.app.wallets.verifyChallenge(ch.challengeId, sig, 'r')).rejects.toMatchObject({ code: 'CHALLENGE_INVALID' });
  });
  it('rejects a signature from a different key and burns the challenge', async () => {
    const w = makeWorld();
    const kp = Keypair.random();
    const ch = await w.app.wallets.createChallenge(kp.publicKey());
    const bad = Buffer.from(Keypair.random().sign(Buffer.from(ch.message))).toString('base64');
    await expect(w.app.wallets.verifyChallenge(ch.challengeId, bad, 'r')).rejects.toMatchObject({ code: 'CHALLENGE_INVALID' });
    const good = Buffer.from(kp.sign(Buffer.from(ch.message))).toString('base64');
    await expect(w.app.wallets.verifyChallenge(ch.challengeId, good, 'r')).rejects.toMatchObject({ code: 'CHALLENGE_INVALID' });
  });
  it('rejects expired challenges, invalid keys and unknown tokens', async () => {
    const w = makeWorld();
    const kp = Keypair.random();
    const ch = await w.app.wallets.createChallenge(kp.publicKey());
    w.t.ms += 5 * 60_000 + 1;
    const sig = Buffer.from(kp.sign(Buffer.from(ch.message))).toString('base64');
    await expect(w.app.wallets.verifyChallenge(ch.challengeId, sig, 'r')).rejects.toMatchObject({ code: 'CHALLENGE_INVALID' });
    await expect(w.app.wallets.createChallenge('GNOTAKEY')).rejects.toThrow(/invalid Stellar public key/);
    expect(await w.app.wallets.authenticate('nope')).toBeUndefined();
    expect(await w.app.wallets.authenticate(undefined)).toBeUndefined();
  });
  it('the same wallet always maps to the same user', async () => {
    const w = makeWorld();
    const kp = Keypair.random();
    const ids = new Set<string>();
    for (let i = 0; i < 2; i++) {
      const ch = await w.app.wallets.createChallenge(kp.publicKey());
      const v = await w.app.wallets.verifyChallenge(ch.challengeId, Buffer.from(kp.sign(Buffer.from(ch.message))).toString('base64'), 'r');
      ids.add(v.actor.id);
    }
    expect(ids.size).toBe(1);
  });
});

async function redeemable() {
  const w = makeWorld();
  const { merchant } = await w.onboardMerchant();
  const user = await w.newUser();
  const create = (amount = '30.0000000', key = 'redeem-key-001') =>
    w.app.redemption.create(user.actor, { asset: w.SHOP, amount, holder: user.publicKey }, key, w.rid());
  return { w, merchant, user, create };
}

describe('redemption', () => {
  it('never offers redemption for credit without an active verified issuer program', async () => {
    const { w, user } = await redeemable();
    const rogue = { code: 'SHOP', issuer: Keypair.random().publicKey() };
    await expect(w.app.redemption.create(user.actor, { asset: rogue, amount: '5', holder: user.publicKey }, 'redeem-key-002', w.rid())).rejects.toMatchObject({ code: 'REDEMPTION_UNAVAILABLE' });
    // a swap-target asset is not redeemable credit either
    await expect(w.app.redemption.create(user.actor, { asset: w.USDC, amount: '5', holder: user.publicKey }, 'redeem-key-003', w.rid())).rejects.toMatchObject({ code: 'REDEMPTION_UNAVAILABLE' });
  });
  it('enforces the signed policy limits', async () => {
    const { create } = await redeemable();
    await expect(create('0.5', 'redeem-key-004')).rejects.toMatchObject({ code: 'REDEMPTION_UNAVAILABLE' });
    await expect(create('501', 'redeem-key-005')).rejects.toMatchObject({ code: 'REDEMPTION_UNAVAILABLE' });
  });
  it('is unavailable after issuer revocation or policy expiry', async () => {
    const a = await redeemable();
    const [m] = await a.w.app.issuers.merchants.list();
    await a.w.app.issuers.revokeMerchant(a.w.admin, m!.id, 'fraud', a.w.rid());
    await expect(a.create()).rejects.toMatchObject({ code: 'REDEMPTION_UNAVAILABLE' });
    const b = await redeemable();
    b.w.t.ms = Date.parse('2027-12-01T00:00:00Z');
    await expect(b.create()).rejects.toMatchObject({ code: 'REDEMPTION_UNAVAILABLE' });
  });
  it('full flow: request -> signed return -> ledger-confirmed -> merchant confirms (and only then)', async () => {
    const { w, merchant, user, create } = await redeemable();
    const r = await create();
    expect(r.state).toBe('AWAITING_RETURN');
    w.gateway.submitMode = 'timeout-after-apply';
    const sub = await w.app.redemption.submitReturn(user.actor, r.id, w.signFake(r.unsignedXdr!), w.rid());
    expect(sub.state).toBe('RETURN_SUBMITTED'); // unknown outcome: not confirmed yet
    await expect(w.app.redemption.merchantConfirm(merchant, r.id, w.rid())).rejects.toMatchObject({ code: 'INVALID_STATE' });
    await w.app.reconciliation.ingest(w.eventFor(r.returnTxHash!, 'CONFIRMED'), w.rid());
    expect((await w.app.redemption.get(user.actor, r.id)).state).toBe('RETURN_CONFIRMED');
    const done = await w.app.redemption.merchantConfirm(merchant, r.id, w.rid());
    expect(done.state).toBe('FULFILLED');
    expect((await w.app.redemption.merchantConfirm(merchant, r.id, w.rid())).state).toBe('FULFILLED'); // idempotent
    expect(await w.app.redemption.listForMerchant(merchant)).toHaveLength(1);
  });
  it('request creation is idempotent per key and conflicts on a different body', async () => {
    const { create } = await redeemable();
    const a = await create('30.0000000', 'redeem-key-006');
    const b = await create('30.0000000', 'redeem-key-006');
    expect(b.id).toBe(a.id);
    await expect(create('31.0000000', 'redeem-key-006')).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
  });
  it('merchant rejection after return flags a refund obligation instead of hiding it', async () => {
    const { w, merchant, user, create } = await redeemable();
    const r = await create();
    await w.app.redemption.submitReturn(user.actor, r.id, w.signFake(r.unsignedXdr!), w.rid());
    const rej = await w.app.redemption.merchantReject(merchant, r.id, 'item out of stock', w.rid());
    expect(rej).toMatchObject({ state: 'REJECTED', refundDue: true });
  });
  it("another merchant cannot see or confirm someone else's redemption", async () => {
    const { w, user, create } = await redeemable();
    const r = await create();
    await w.app.redemption.submitReturn(user.actor, r.id, w.signFake(r.unsignedXdr!), w.rid());
    const intruder = { id: 'usr_other', role: 'merchant' as const, merchantId: 'mer_other' };
    await expect(w.app.redemption.merchantConfirm(intruder, r.id, w.rid())).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(w.app.redemption.merchantConfirm(user.actor, r.id, w.rid())).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(await w.app.redemption.listForMerchant(intruder)).toEqual([]);
  });
  it('a failed ledger return ends FAILED and cannot be confirmed', async () => {
    const { w, merchant, user, create } = await redeemable();
    const r = await create();
    w.gateway.submitMode = 'reject-min-output';
    const sub = await w.app.redemption.submitReturn(user.actor, r.id, w.signFake(r.unsignedXdr!), w.rid());
    expect(sub.state).toBe('FAILED');
    await expect(w.app.redemption.merchantConfirm(merchant, r.id, w.rid())).rejects.toMatchObject({ code: 'INVALID_STATE' });
  });
  it('requires a wallet bound to the caller', async () => {
    const { w, user } = await redeemable();
    await expect(
      w.app.redemption.create(user.actor, { asset: w.SHOP, amount: '5', holder: Keypair.random().publicKey() }, 'redeem-key-007', w.rid()),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
});
