import { describe, expect, it } from 'vitest';
import { DEFAULT_ESCROW_WINDOW_SECS } from '../src/modules/redemption/service.js';
import { FAKE_ESCROW_CONTRACT } from '../src/testing/fake-gateway.js';
import { makeWorld } from './helpers.js';

/** Escrow mode (unbound-stellar ADR 0002) driven through the FakeEscrow test adapter. */
async function escrowWorld() {
  const w = makeWorld();
  const escrow = w.gateway.enableEscrow();
  const { merchant } = await w.onboardMerchant();
  const user = await w.newUser();
  const create = (amount = '30.0000000', key = 'redeem-key-001') => w.app.redemption.create(user.actor, { asset: w.SHOP, amount, holder: user.publicKey }, key, w.rid());
  /** request + signed escrow open, confirmed on the "ledger" */
  const held = async (key?: string) => {
    const r = await create('30.0000000', key);
    return w.app.redemption.submitReturn(user.actor, r.id, w.signFake(r.unsignedXdr!), w.rid());
  };
  return { w, escrow, merchant, user, create, held };
}

describe('redemption escrow (Soroban, via the StellarGateway port)', () => {
  it('opens in ESCROW mode with a bounded deadline and holds the credit once the ledger confirms', async () => {
    const { w, create, user } = await escrowWorld();
    const r = await create();
    expect(r.mode).toBe('ESCROW');
    expect(r.escrow).toMatchObject({ contractId: FAKE_ESCROW_CONTRACT, state: 'AWAITING_OPEN', deadline: w.t.ms / 1000 + DEFAULT_ESCROW_WINDOW_SECS });
    const s = await w.app.redemption.submitReturn(user.actor, r.id, w.signFake(r.unsignedXdr!), w.rid());
    expect(s.state).toBe('RETURN_CONFIRMED');
    expect(s.escrow?.state).toBe('HELD');
  });

  it('merchant confirm builds an issuer transaction; FULFILLED only after it lands', async () => {
    const { w, escrow, merchant, held } = await escrowWorld();
    const r = await held();
    const pending = await w.app.redemption.merchantConfirm(merchant, r.id, w.rid());
    expect(pending.state).toBe('RETURN_CONFIRMED');
    expect(pending.escrow?.pending).toMatchObject({ action: 'CONFIRM' });
    // idempotent: same transaction to sign
    expect((await w.app.redemption.merchantConfirm(merchant, r.id, w.rid())).escrow?.pending?.hash).toBe(pending.escrow?.pending?.hash);
    // a different action cannot be started while one is in flight
    await expect(w.app.redemption.merchantReject(merchant, r.id, 'changed my mind', w.rid())).rejects.toMatchObject({ code: 'INVALID_STATE' });
    const done = await w.app.redemption.submitEscrowAction(merchant, r.id, w.signFake(pending.escrow!.pending!.xdr), w.rid());
    expect(done).toMatchObject({ state: 'FULFILLED', escrow: { state: 'RELEASED' } });
    expect(done.escrow?.closeTxHash).toBe(pending.escrow?.pending?.hash);
    expect((await escrow.getReturn(r.id)).return?.status).toBe('CONFIRMED');
  });

  it('merchant reject refunds on-chain: REJECTED with nothing owed off-chain', async () => {
    const { w, escrow, merchant, held } = await escrowWorld();
    const r = await held();
    const p = await w.app.redemption.merchantReject(merchant, r.id, 'item out of stock', w.rid());
    expect(p.escrow?.pending).toMatchObject({ action: 'REJECT', reason: 'item out of stock' });
    const done = await w.app.redemption.submitEscrowAction(merchant, r.id, w.signFake(p.escrow!.pending!.xdr), w.rid());
    expect(done).toMatchObject({ state: 'REJECTED', refundDue: false, rejectionReason: 'item out of stock', escrow: { state: 'REFUNDED' } });
    expect((await escrow.getReturn(r.id)).return?.status).toBe('REJECTED');
  });

  it('timeout: no confirm after the deadline; the holder claims the refund', async () => {
    const { w, merchant, user, held } = await escrowWorld();
    const r = await held();
    await expect(w.app.redemption.claimRefund(user.actor, r.id, w.rid())).rejects.toMatchObject({ code: 'INVALID_STATE' });
    w.t.ms += DEFAULT_ESCROW_WINDOW_SECS * 1000;
    await expect(w.app.redemption.merchantConfirm(merchant, r.id, w.rid())).rejects.toMatchObject({ code: 'INVALID_STATE' });
    const p = await w.app.redemption.claimRefund(user.actor, r.id, w.rid());
    expect(p.escrow?.pending?.action).toBe('EXPIRE');
    // only the holder signs the refund
    await expect(w.app.redemption.submitEscrowAction(merchant, r.id, w.signFake(p.escrow!.pending!.xdr), w.rid())).rejects.toMatchObject({ code: 'FORBIDDEN' });
    const done = await w.app.redemption.submitEscrowAction(user.actor, r.id, w.signFake(p.escrow!.pending!.xdr), w.rid());
    expect(done).toMatchObject({ state: 'EXPIRED', refundDue: false, escrow: { state: 'EXPIRED_REFUNDED' } });
    // replays after completion are harmless
    expect((await w.app.redemption.submitEscrowAction(user.actor, r.id, 'SIGNED:anything', w.rid())).state).toBe('EXPIRED');
  });

  it('an unknown outcome keeps the action pending; the reconciliation event decides', async () => {
    const { w, merchant, held } = await escrowWorld();
    const r = await held();
    const p = await w.app.redemption.merchantConfirm(merchant, r.id, w.rid());
    w.gateway.submitMode = 'timeout-before-apply';
    const s = await w.app.redemption.submitEscrowAction(merchant, r.id, w.signFake(p.escrow!.pending!.xdr), w.rid());
    expect(s.state).toBe('RETURN_CONFIRMED');
    expect(s.escrow?.pending?.action).toBe('CONFIRM');
    await w.app.reconciliation.ingest(w.eventFor(p.escrow!.pending!.hash, 'CONFIRMED'), w.rid());
    expect(await w.app.redemption.get(merchant, r.id)).toMatchObject({ state: 'FULFILLED', escrow: { state: 'RELEASED', closeLedger: 1234 } });
  });

  it('a failed escrow transaction clears the pending action so it can be retried', async () => {
    const { w, merchant, held } = await escrowWorld();
    const r = await held();
    const p = await w.app.redemption.merchantConfirm(merchant, r.id, w.rid());
    w.gateway.submitMode = 'reject-min-output';
    const s = await w.app.redemption.submitEscrowAction(merchant, r.id, w.signFake(p.escrow!.pending!.xdr), w.rid());
    expect(s.state).toBe('RETURN_CONFIRMED');
    expect(s.escrow).toMatchObject({ state: 'HELD', lastFailure: 'MIN_OUTPUT_VIOLATION' });
    expect(s.escrow?.pending).toBeUndefined();
    w.gateway.submitMode = 'confirm';
    const again = await w.app.redemption.merchantConfirm(merchant, r.id, w.rid());
    const done = await w.app.redemption.submitEscrowAction(merchant, r.id, w.signFake(again.escrow!.pending!.xdr), w.rid());
    expect(done.state).toBe('FULFILLED');
  });

  it('a failed reconciliation event for the pending action also clears it', async () => {
    const { w, merchant, held } = await escrowWorld();
    const r = await held();
    const p = await w.app.redemption.merchantReject(merchant, r.id, 'not in stock', w.rid());
    await w.app.reconciliation.ingest(w.eventFor(p.escrow!.pending!.hash, 'FAILED'), w.rid());
    expect((await w.app.redemption.get(merchant, r.id)).escrow).toMatchObject({ state: 'HELD', lastFailure: 'LEDGER_FAILED' });
  });

  it('falls back to the native return when the escrow is unavailable (ADR 0002)', async () => {
    const { w, escrow, merchant, user, create } = await escrowWorld();
    escrow.unavailable = true;
    const r = await create();
    expect(r.mode).toBe('NATIVE');
    expect(r.escrow).toBeUndefined();
    await w.app.redemption.submitReturn(user.actor, r.id, w.signFake(r.unsignedXdr!), w.rid());
    expect(await w.app.redemption.merchantReject(merchant, r.id, 'out of stock', w.rid())).toMatchObject({ state: 'REJECTED', refundDue: true });
    const audit = await w.app.audit.forObject(r.id);
    expect(audit.some((a) => a.action === 'REDEMPTION_ESCROW_FALLBACK')).toBe(true);
  });

  it('falls back when the escrow refuses to open (e.g. the issuer has not authorized it)', async () => {
    const { w, escrow, user } = await escrowWorld();
    escrow.open = async () => {
      const { GatewayError } = await import('../src/modules/exchange/gateway.js');
      throw new GatewayError('ESCROW_REJECTED', 'escrow simulation failed');
    };
    const r = await w.app.redemption.create(user.actor, { asset: w.SHOP, amount: '10', holder: user.publicKey }, 'redeem-key-099', w.rid());
    expect(r.mode).toBe('NATIVE');
  });

  it('reconcileEscrows picks up closes made outside core and leaves open ones alone', async () => {
    const { w, escrow, held } = await escrowWorld();
    const a = await held('redeem-key-a01');
    const b = await held('redeem-key-b01');
    w.t.ms += DEFAULT_ESCROW_WINDOW_SECS * 1000;
    escrow.closeOutOfBand(a.id, 'EXPIRED'); // someone called expire_refund directly
    expect(await w.app.redemption.reconcileEscrows(w.rid())).toEqual([a.id]);
    expect(await w.app.redemption.get(w.admin, a.id)).toMatchObject({ state: 'EXPIRED', escrow: { state: 'EXPIRED_REFUNDED' } });
    expect((await w.app.redemption.get(w.admin, b.id)).state).toBe('RETURN_CONFIRMED');
    expect(await w.app.redemption.reconcileEscrows(w.rid())).toEqual([]); // idempotent
  });

  it('reconcileEscrows flags a held return the contract does not know as a discrepancy', async () => {
    const { w, escrow, held } = await escrowWorld();
    const r = await held();
    escrow.returns.delete(r.id);
    expect(await w.app.redemption.reconcileEscrows(w.rid())).toEqual([r.id]);
    expect((await w.app.audit.forObject(r.id)).some((e) => e.action === 'DISCREPANCY')).toBe(true);
    expect((await w.app.redemption.get(w.admin, r.id)).state).toBe('RETURN_CONFIRMED');
  });

  it('without an escrow on the gateway nothing changes: native mode, reconcile is a no-op', async () => {
    const w = makeWorld();
    await w.onboardMerchant();
    const user = await w.newUser();
    const r = await w.app.redemption.create(user.actor, { asset: w.SHOP, amount: '10', holder: user.publicKey }, 'redeem-key-100', w.rid());
    expect(r.mode).toBe('NATIVE');
    expect(await w.app.redemption.reconcileEscrows(w.rid())).toEqual([]);
    await expect(w.app.redemption.claimRefund(user.actor, r.id, w.rid())).rejects.toMatchObject({ code: 'INVALID_STATE' });
  });

  it('there is nothing to submit without a pending action', async () => {
    const { w, merchant, held } = await escrowWorld();
    const r = await held();
    await expect(w.app.redemption.submitEscrowAction(merchant, r.id, 'SIGNED:x', w.rid())).rejects.toMatchObject({ code: 'INVALID_STATE' });
  });
});
