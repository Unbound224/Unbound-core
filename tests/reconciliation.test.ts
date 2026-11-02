import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ReconciliationEventSchema } from '../src/modules/reconciliation/contract.js';
import { z } from 'zod';
import { makeWorld } from './helpers.js';

async function submitted(mode: 'timeout-after-apply' | 'confirm' = 'timeout-after-apply') {
  const w = makeWorld();
  await w.onboardMerchant();
  const user = await w.newUser();
  const { intent } = await w.readyIntent(user);
  w.gateway.submitMode = mode;
  const r = await w.app.exchange.submit(user.actor, intent.id, { signedXdr: w.signFake(intent.unsignedXdr!), submitKey: 'submit-key-r1' }, w.rid());
  return { w, user, intent: r };
}

describe('contract (consumer side)', () => {
  it('accepts the golden fixture published by unbound-stellar', () => {
    const f = JSON.parse(readFileSync(new URL('../fixtures/reconciliation-event.confirmed.v1.json', import.meta.url), 'utf8'));
    expect(ReconciliationEventSchema.parse(f).sourceRepo).toBe('unbound-stellar');
  });
  it("our schema equals the producer's published JSON Schema snapshot", () => {
    const theirs = JSON.parse(readFileSync(new URL('../fixtures/reconciliation-event.stellar-schema.v1.json', import.meta.url), 'utf8'));
    expect(z.toJSONSchema(ReconciliationEventSchema)).toEqual(theirs);
  });
});

describe('ingest', () => {
  it('rejects malformed events, unknown versions, wrong source and unrecognized networks (fail closed)', async () => {
    const { w } = await submitted();
    const good = w.eventFor('a'.repeat(64), 'CONFIRMED');
    await expect(w.app.reconciliation.ingest({ ...good, schemaVersion: '2.0' }, 'r')).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    await expect(w.app.reconciliation.ingest({ ...good, sourceRepo: 'evil' }, 'r')).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    await expect(w.app.reconciliation.ingest({ ...good, extra: true }, 'r')).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    await expect(w.app.reconciliation.ingest({ ...good, network: 'PUBLIC' }, 'r')).rejects.toMatchObject({ code: 'UNKNOWN_NETWORK' });
    await expect(w.app.reconciliation.ingest(null, 'r')).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    expect(await w.app.reconciliation.observations.list()).toHaveLength(0);
  });

  it('duplicate delivery of the same event is a no-op', async () => {
    const { w, intent } = await submitted();
    const ev = w.eventFor(intent.txHash!, 'CONFIRMED');
    const first = await w.app.reconciliation.ingest(ev, 'r1');
    const second = await w.app.reconciliation.ingest(ev, 'r2');
    expect(first.duplicate).toBe(false);
    expect(second.duplicate).toBe(true);
    const audit = (await w.app.audit.forObject(intent.id)).filter((e) => e.action === 'INTENT_CONFIRMED');
    expect(audit).toHaveLength(1);
  });

  it('events for transactions we do not know are recorded as NOT_MINE and change nothing', async () => {
    const { w, intent } = await submitted();
    const r = await w.app.reconciliation.ingest(w.eventFor('9'.repeat(64), 'CONFIRMED'), 'r');
    expect(r.observation.outcome).toBe('NOT_MINE');
    expect((await w.app.exchange.intents.get(intent.id))!.state).toBe('RECONCILING');
  });

  it('a RECONCILING hint from the chain worker does not change state', async () => {
    const { w, intent } = await submitted();
    const r = await w.app.reconciliation.ingest(w.eventFor(intent.txHash!, 'RECONCILING'), 'r');
    expect(r.observation.outcome).toBe('IGNORED');
    expect((await w.app.exchange.intents.get(intent.id))!.state).toBe('RECONCILING');
  });

  it('replaying a whole history (new event ids irrelevant, same tx) never double-applies', async () => {
    const { w, intent } = await submitted();
    await w.app.reconciliation.ingest(w.eventFor(intent.txHash!, 'CONFIRMED', { ledgerCursor: '10' }), 'r1');
    // producer re-emits the same fact with a different cursor but SAME deterministic id => duplicate
    const again = await w.app.reconciliation.ingest(w.eventFor(intent.txHash!, 'CONFIRMED', { ledgerCursor: '99' }), 'r2');
    expect(again.duplicate).toBe(true);
    // a distinct id for an already-confirmed tx is ignored, not re-applied
    const other = await w.app.reconciliation.ingest(w.eventFor(intent.txHash!, 'CONFIRMED', { id: 'evt_other_id_1' }), 'r3');
    expect(other.observation.outcome).toBe('IGNORED');
    expect((await w.app.exchange.intents.get(intent.id))!.version).toBeGreaterThan(1);
  });
});

describe('discrepancy handling', () => {
  it('ledger CONFIRMED vs local FAILED pauses sensitive actions pending investigation', async () => {
    const w = makeWorld();
    await w.onboardMerchant();
    const user = await w.newUser();
    const { intent } = await w.readyIntent(user);
    w.gateway.submitMode = 'reject-min-output';
    const failed = await w.app.exchange.submit(user.actor, intent.id, { signedXdr: w.signFake(intent.unsignedXdr!), submitKey: 'submit-key-d1' }, w.rid());
    expect(failed.state).toBe('FAILED');
    const res = await w.app.reconciliation.ingest(w.eventFor(intent.txHash!, 'CONFIRMED'), 'r');
    expect(res.observation.outcome).toBe('DISCREPANCY');
    expect(await w.app.guard.isPaused()).toBe(true);
    // local state is not silently rewritten
    expect((await w.app.exchange.intents.get(intent.id))!.state).toBe('FAILED');
    // new sensitive work is blocked
    await expect(w.quoteFor(user)).rejects.toMatchObject({ code: 'SENSITIVE_ACTIONS_PAUSED' });
    // only an admin can resume
    await expect(w.app.guard.resume(user.actor, 'ok', 'r')).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await w.app.guard.resume(w.admin, 'investigated INC-1', 'r');
    expect(await w.app.guard.isPaused()).toBe(false);
    await expect(w.quoteFor(user)).resolves.toBeTruthy();
    const trail = (await w.app.audit.all()).map((e) => e.action);
    expect(trail).toEqual(expect.arrayContaining(['DISCREPANCY', 'SENSITIVE_ACTIONS_PAUSED', 'SENSITIVE_ACTIONS_RESUMED']));
  });

  it('ledger FAILED vs local CONFIRMED is also a discrepancy', async () => {
    const { w, intent } = await submitted('confirm');
    expect(intent.state).toBe('CONFIRMED');
    const res = await w.app.reconciliation.ingest(w.eventFor(intent.txHash!, 'FAILED'), 'r');
    expect(res.observation.outcome).toBe('DISCREPANCY');
    expect(await w.app.guard.isPaused()).toBe(true);
  });
});
