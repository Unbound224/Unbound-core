import { describe, expect, it } from 'vitest';
import { MERCHANT_RESPONSE_WINDOW_MS } from '../src/modules/disputes/service.js';
import { makeWorld } from './helpers.js';

const REASON = 'The merchant rejected my redemption without a reason.';

async function setup() {
  const w = makeWorld();
  const { merchant } = await w.onboardMerchant();
  const user = await w.newUser();
  const r = await w.app.redemption.create(user.actor, { asset: w.SHOP, amount: '30', holder: user.publicKey }, 'dispute-redeem-1', w.rid());
  await w.app.redemption.submitReturn(user.actor, r.id, w.signFake(r.unsignedXdr!), w.rid());
  await w.app.redemption.merchantReject(merchant, r.id, 'out of stock', w.rid());
  return { w, merchant, user, r };
}

describe('disputes', () => {
  it('holder opens on their own redemption; merchant responds; admin rules; ruling is recorded, not executed', async () => {
    const { w, merchant, user, r } = await setup();
    const d = await w.app.disputes.open(user.actor, { kind: 'REDEMPTION', subjectRef: r.id, reason: REASON }, w.rid());
    expect(d).toMatchObject({ state: 'OPEN', merchantId: merchant.merchantId });
    expect(Date.parse(d.respondBy!) - w.t.ms).toBe(MERCHANT_RESPONSE_WINDOW_MS);
    const after = await w.app.disputes.addMessage(merchant, d.id, { text: 'Item was out of stock; refund is being arranged.' }, w.rid());
    expect(after.state).toBe('MERCHANT_RESPONDED');
    const closed = await w.app.disputes.resolve(w.admin, d.id, { outcome: 'FOR_HOLDER', note: 'Refund owed under the published refund policy.' }, w.rid());
    expect(closed).toMatchObject({ state: 'RESOLVED_FOR_HOLDER', resolution: { outcome: 'FOR_HOLDER', decidedBy: w.admin.id } });
    // the redemption record itself is untouched by a ruling
    expect((await w.app.redemption.get(user.actor, r.id)).state).toBe('REJECTED');
  });

  it('is idempotent per subject: re-opening returns the live dispute', async () => {
    const { w, user, r } = await setup();
    const a = await w.app.disputes.open(user.actor, { kind: 'REDEMPTION', subjectRef: r.id, reason: REASON }, w.rid());
    const b = await w.app.disputes.open(user.actor, { kind: 'REDEMPTION', subjectRef: r.id, reason: REASON + ' again' }, w.rid());
    expect(b.id).toBe(a.id);
    expect(await w.app.disputes.disputes.list()).toHaveLength(1);
  });

  it("cannot dispute someone else's subject, and cannot learn that it exists", async () => {
    const { w, r } = await setup();
    const mallory = await w.newUser();
    await expect(w.app.disputes.open(mallory.actor, { kind: 'REDEMPTION', subjectRef: r.id, reason: REASON }, w.rid())).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(w.app.disputes.open(mallory.actor, { kind: 'EXCHANGE', subjectRef: 'int_nonexistent', reason: REASON }, w.rid())).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('visibility: only the opener, the disputed merchant and admins', async () => {
    const { w, merchant, user, r } = await setup();
    const d = await w.app.disputes.open(user.actor, { kind: 'REDEMPTION', subjectRef: r.id, reason: REASON }, w.rid());
    const mallory = await w.newUser();
    const otherMerchant = { id: 'usr_o', role: 'merchant' as const, merchantId: 'mer_other' };
    for (const who of [mallory.actor, otherMerchant]) {
      await expect(w.app.disputes.get(who, d.id)).rejects.toMatchObject({ code: 'NOT_FOUND' });
      await expect(w.app.disputes.addMessage(who, d.id, { text: 'I should not be here at all' }, w.rid())).rejects.toMatchObject({ code: 'NOT_FOUND' });
      expect(await w.app.disputes.list(who)).toEqual([]);
    }
    expect(await w.app.disputes.list(merchant)).toHaveLength(1);
    expect(await w.app.disputes.list(w.admin)).toHaveLength(1);
    await expect(w.app.disputes.resolve(user.actor, d.id, { outcome: 'FOR_HOLDER', note: 'I rule for myself, obviously.' }, w.rid())).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(w.app.disputes.resolve(merchant, d.id, { outcome: 'FOR_MERCHANT', note: 'I rule for myself, obviously.' }, w.rid())).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('closed disputes are immutable; withdraw is for the opener only', async () => {
    const { w, merchant, user, r } = await setup();
    const d = await w.app.disputes.open(user.actor, { kind: 'REDEMPTION', subjectRef: r.id, reason: REASON }, w.rid());
    await expect(w.app.disputes.withdraw(merchant, d.id, w.rid())).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await w.app.disputes.withdraw(user.actor, d.id, w.rid());
    await expect(w.app.disputes.addMessage(user.actor, d.id, { text: 'one more thing to add here' }, w.rid())).rejects.toMatchObject({ code: 'INVALID_STATE' });
    await expect(w.app.disputes.resolve(w.admin, d.id, { outcome: 'FOR_HOLDER', note: 'Too late to rule on this.' }, w.rid())).rejects.toMatchObject({ code: 'INVALID_STATE' });
    // a new dispute may then be opened for the same subject
    expect((await w.app.disputes.open(user.actor, { kind: 'REDEMPTION', subjectRef: r.id, reason: REASON }, w.rid())).id).not.toBe(d.id);
  });

  it('escalates when the merchant misses the response window, but not if they responded', async () => {
    const { w, merchant, user, r } = await setup();
    const d = await w.app.disputes.open(user.actor, { kind: 'REDEMPTION', subjectRef: r.id, reason: REASON }, w.rid());
    w.t.ms += MERCHANT_RESPONSE_WINDOW_MS - 1;
    expect(await w.app.disputes.escalateOverdue(w.rid())).toEqual([]);
    w.t.ms += 2;
    expect(await w.app.disputes.escalateOverdue(w.rid())).toEqual([d.id]);
    expect((await w.app.disputes.get(w.admin, d.id)).state).toBe('ESCALATED');
    expect(await w.app.disputes.escalateOverdue(w.rid())).toEqual([]);
    void merchant;
  });

  it('supports exchange disputes (admin-handled, no merchant party) and validates input', async () => {
    const w = makeWorld();
    await w.onboardMerchant();
    const user = await w.newUser();
    const { intent } = await w.readyIntent(user);
    const d = await w.app.disputes.open(user.actor, { kind: 'EXCHANGE', subjectRef: intent.id, reason: 'I received less than the guaranteed minimum.' }, w.rid());
    expect(d.merchantId).toBeUndefined();
    await expect(w.app.disputes.open(user.actor, { kind: 'EXCHANGE', subjectRef: intent.id, reason: 'short' }, w.rid())).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    await expect(w.app.disputes.open(user.actor, { kind: 'OTHER', subjectRef: intent.id, reason: REASON }, w.rid())).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    await expect(w.app.disputes.open(user.actor, { kind: 'EXCHANGE', subjectRef: intent.id, reason: REASON, extra: 1 }, w.rid())).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    await expect(w.app.disputes.open(undefined, { kind: 'EXCHANGE', subjectRef: intent.id, reason: REASON }, w.rid())).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
  });

  it('writes an audit trail', async () => {
    const { w, user, r } = await setup();
    const d = await w.app.disputes.open(user.actor, { kind: 'REDEMPTION', subjectRef: r.id, reason: REASON }, w.rid());
    await w.app.disputes.resolve(w.admin, d.id, { outcome: 'FOR_MERCHANT', note: 'Merchant followed its policy.' }, w.rid());
    expect((await w.app.audit.forObject(d.id)).map((e) => e.action)).toEqual(['DISPUTE_OPENED', 'DISPUTE_RESOLVED_FOR_MERCHANT']);
  });
});
