import { Keypair } from '@stellar/stellar-sdk';
import { describe, expect, it } from 'vitest';
import { canTransition } from '../src/modules/exchange/state.js';
import { makeWorld } from './helpers.js';

async function ready() {
  const w = makeWorld();
  await w.onboardMerchant();
  const user = await w.newUser();
  return { w, user };
}

describe('intent state machine', () => {
  it('table forbids skipping, reversing and leaving terminal states', () => {
    expect(canTransition('DRAFT', 'SUBMITTED')).toBe(false);
    expect(canTransition('AWAITING_SIGNATURE', 'CONFIRMED')).toBe(false);
    expect(canTransition('SUBMITTED', 'AWAITING_SIGNATURE')).toBe(false);
    expect(canTransition('SUBMITTED', 'CANCELLED')).toBe(false); // cannot cancel once on the network
    expect(canTransition('RECONCILING', 'SUBMITTED')).toBe(false);
    for (const t of ['CONFIRMED', 'FAILED', 'CANCELLED'] as const) {
      for (const to of ['DRAFT', 'VERIFIED', 'SUBMITTED', 'CONFIRMED', 'FAILED', 'RECONCILING'] as const) expect(canTransition(t, to)).toBe(false);
    }
    expect(canTransition('RECONCILING', 'CONFIRMED')).toBe(true);
  });
});

describe('quote and intent creation', () => {
  it('walks to AWAITING_SIGNATURE returning a stateful intent (not a fake success)', async () => {
    const { w, user } = await ready();
    const { intent, q } = await w.readyIntent(user);
    expect(intent.state).toBe('AWAITING_SIGNATURE');
    expect(intent.unsignedXdr).toBeTruthy();
    expect(intent.txHash).toMatch(/^[0-9a-f]{64}$/);
    expect(q.quote.warnings.length).toBeGreaterThan(0);
    const states = (await w.app.audit.forObject(intent.id)).map((e) => e.action);
    expect(states).toEqual(['INTENT_CREATED', 'INTENT_VERIFIED', 'INTENT_AWAITING_SIGNATURE']);
  });

  it('refuses a quote for an asset with no verified issuer', async () => {
    const { w, user } = await ready();
    const rogue = { code: 'SHOP', issuer: Keypair.random().publicKey() };
    await expect(w.quoteFor(user, { sourceAsset: rogue })).rejects.toMatchObject({ code: 'ASSET_NOT_ELIGIBLE' });
  });

  it('refuses a quote whose destination wallet is not bound to the caller', async () => {
    const { w, user } = await ready();
    const other = await w.newUser();
    await expect(w.quoteFor(user, { destinationAccount: other.publicKey })).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('maps "no liquidity" to NO_ROUTE and never creates a quote', async () => {
    const { w, user } = await ready();
    w.gateway.hasLiquidity = false;
    await expect(w.quoteFor(user)).rejects.toMatchObject({ code: 'NO_ROUTE' });
    expect(await w.app.exchange.quotes.list()).toHaveLength(0);
  });

  it('rejects malformed input, wrong network and unauthenticated callers', async () => {
    const { w, user } = await ready();
    await expect(w.quoteFor(user, { sourceAmount: '0' })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    await expect(w.quoteFor(user, { sourceAmount: '1e3' })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    await expect(w.quoteFor(user, { network: 'PUBLIC' })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    await expect(w.quoteFor(user, { slippageBps: 5000 })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    await expect(w.quoteFor(user, { extra: 1 })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    await expect(w.app.exchange.quote(undefined, {}, 'r')).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
    await expect(w.app.exchange.quote({ id: 'adm', role: 'admin' }, {}, 'r')).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('fails closed on a quote that claims a different network', async () => {
    const { w, user } = await ready();
    (w.gateway as unknown as { network: string }).network = 'PUBLIC';
    await expect(w.quoteFor(user)).rejects.toMatchObject({ code: 'UNKNOWN_NETWORK' });
  });

  it('same Idempotency-Key + same body returns exactly one intent, even concurrently', async () => {
    const { w, user } = await ready();
    const q = await w.quoteFor(user);
    const calls = await Promise.all(
      [1, 2, 3, 4].map(() => w.app.exchange.createIntent(user.actor, { quoteId: q.id, idempotencyKey: 'same-key-1' }, w.rid())),
    );
    expect(new Set(calls.map((i) => i.id)).size).toBe(1);
    expect(await w.app.exchange.intents.list()).toHaveLength(1);
  });

  it('same key with a different quote is a conflict, never a second intent', async () => {
    const { w, user } = await ready();
    const q1 = await w.quoteFor(user);
    const q2 = await w.quoteFor(user, { sourceAmount: '10.0000000' });
    await w.app.exchange.createIntent(user.actor, { quoteId: q1.id, idempotencyKey: 'key-conflict-1' }, w.rid());
    await expect(w.app.exchange.createIntent(user.actor, { quoteId: q2.id, idempotencyKey: 'key-conflict-1' }, w.rid())).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    expect(await w.app.exchange.intents.list()).toHaveLength(1);
  });

  it('a stale quote cannot become an intent; the draft is parked FAILED(QUOTE_EXPIRED) with nothing sent', async () => {
    const { w, user } = await ready();
    const q = await w.quoteFor(user);
    w.t.ms += 61_000;
    await expect(w.app.exchange.createIntent(user.actor, { quoteId: q.id, idempotencyKey: 'stale-quote-1' }, w.rid())).rejects.toMatchObject({ code: 'QUOTE_EXPIRED' });
    const [i] = await w.app.exchange.intents.list();
    expect(i).toMatchObject({ state: 'FAILED', failureReason: 'QUOTE_EXPIRED' });
    expect(w.gateway.submitCalls).toBe(0);
  });

  it("one user cannot use or read another user's quote or intent", async () => {
    const { w, user } = await ready();
    const mallory = await w.newUser();
    const { intent, q } = await w.readyIntent(user);
    await expect(w.app.exchange.createIntent(mallory.actor, { quoteId: q.id, idempotencyKey: 'steal-quote-1' }, w.rid())).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(w.app.exchange.getIntent(mallory.actor, intent.id)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(w.app.exchange.submit(mallory.actor, intent.id, { signedXdr: w.signFake(intent.unsignedXdr!), submitKey: 'steal-submit-1' }, w.rid())).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});

describe('submit, settlement and failure recovery', () => {
  it('confirms on a successful submit and records the ledger-derived amount', async () => {
    const { w, user } = await ready();
    const { intent } = await w.readyIntent(user);
    const done = await w.app.exchange.submit(user.actor, intent.id, { signedXdr: w.signFake(intent.unsignedXdr!), submitKey: 'submit-key-1' }, w.rid());
    expect(done).toMatchObject({ state: 'CONFIRMED', amountOutActual: '72.0000000' });
  });

  it('repeated submit with the same key hits the network exactly once', async () => {
    const { w, user } = await ready();
    const { intent } = await w.readyIntent(user);
    const input = { signedXdr: w.signFake(intent.unsignedXdr!), submitKey: 'submit-key-2' };
    const results = await Promise.all([1, 2, 3].map(() => w.app.exchange.submit(user.actor, intent.id, input, w.rid())));
    expect(w.gateway.submitCalls).toBe(1);
    expect(results.every((r) => r.state === 'CONFIRMED')).toBe(true);
  });

  it('a second submit under a DIFFERENT key after submission is refused, not re-sent', async () => {
    const { w, user } = await ready();
    const { intent } = await w.readyIntent(user);
    const xdr = w.signFake(intent.unsignedXdr!);
    await w.app.exchange.submit(user.actor, intent.id, { signedXdr: xdr, submitKey: 'submit-key-3a' }, w.rid());
    await expect(w.app.exchange.submit(user.actor, intent.id, { signedXdr: xdr, submitKey: 'submit-key-3b' }, w.rid())).rejects.toMatchObject({ code: 'INVALID_STATE' });
    expect(w.gateway.submitCalls).toBe(1);
  });

  it('timeout after submit -> RECONCILING (not FAILED); the ledger event then confirms it', async () => {
    const { w, user } = await ready();
    const { intent } = await w.readyIntent(user);
    w.gateway.submitMode = 'timeout-after-apply';
    const r = await w.app.exchange.submit(user.actor, intent.id, { signedXdr: w.signFake(intent.unsignedXdr!), submitKey: 'submit-key-4' }, w.rid());
    expect(r.state).toBe('RECONCILING');
    const res = await w.app.reconciliation.ingest(w.eventFor(intent.txHash!, 'CONFIRMED'), w.rid());
    expect(res.observation.outcome).toBe('APPLIED');
    expect(await w.app.exchange.getIntent(user.actor, intent.id)).toMatchObject({ state: 'CONFIRMED', amountOutActual: '72.0000000', ledger: 1234 });
  });

  it('timeout BEFORE the tx lands stays RECONCILING until the ledger says FAILED; never retried with changed params', async () => {
    const { w, user } = await ready();
    const { intent } = await w.readyIntent(user);
    w.gateway.submitMode = 'timeout-before-apply';
    expect((await w.app.exchange.submit(user.actor, intent.id, { signedXdr: w.signFake(intent.unsignedXdr!), submitKey: 'submit-key-5' }, w.rid())).state).toBe('RECONCILING');
    expect(w.gateway.submitCalls).toBe(1);
    await w.app.reconciliation.ingest(w.eventFor(intent.txHash!, 'FAILED'), w.rid());
    expect((await w.app.exchange.getIntent(user.actor, intent.id)).state).toBe('FAILED');
    expect(w.gateway.submitCalls).toBe(1);
  });

  it('a ledger-side rejection (min output) is FAILED with its reason', async () => {
    const { w, user } = await ready();
    const { intent } = await w.readyIntent(user);
    w.gateway.submitMode = 'reject-min-output';
    const r = await w.app.exchange.submit(user.actor, intent.id, { signedXdr: w.signFake(intent.unsignedXdr!), submitKey: 'submit-key-6' }, w.rid());
    expect(r).toMatchObject({ state: 'FAILED', failureReason: 'MIN_OUTPUT_VIOLATION' });
  });

  it('an outcome for a different tx hash is not trusted; intent goes RECONCILING', async () => {
    const { w, user } = await ready();
    const { intent } = await w.readyIntent(user);
    w.gateway.submitMode = 'wrong-hash';
    const r = await w.app.exchange.submit(user.actor, intent.id, { signedXdr: w.signFake(intent.unsignedXdr!), submitKey: 'submit-key-7' }, w.rid());
    expect(r.state).toBe('RECONCILING');
  });

  it('a quote that expires between approval and submit fails without touching the network', async () => {
    const { w, user } = await ready();
    const { intent } = await w.readyIntent(user);
    w.t.ms += 61_000;
    await expect(w.app.exchange.submit(user.actor, intent.id, { signedXdr: w.signFake(intent.unsignedXdr!), submitKey: 'submit-key-8' }, w.rid())).rejects.toMatchObject({ code: 'QUOTE_EXPIRED' });
    expect(w.gateway.submitCalls).toBe(0);
    expect((await w.app.exchange.getIntent(user.actor, intent.id)).state).toBe('FAILED');
  });

  it('issuer revoked between quote and submit => stale authorization blocks the submit', async () => {
    const { w, user } = await ready();
    const { intent } = await w.readyIntent(user);
    const merchants = await w.app.issuers.merchants.list();
    await w.app.issuers.revokeMerchant(w.admin, merchants[0]!.id, 'fraud', w.rid());
    await expect(w.app.exchange.submit(user.actor, intent.id, { signedXdr: w.signFake(intent.unsignedXdr!), submitKey: 'submit-key-9' }, w.rid())).rejects.toMatchObject({ code: 'ASSET_NOT_ELIGIBLE' });
    expect(w.gateway.submitCalls).toBe(0);
    expect((await w.app.exchange.getIntent(user.actor, intent.id)).state).toBe('FAILED');
  });

  it('a signature for the wrong transaction is rejected by the adapter and FAILs the intent', async () => {
    const { w, user } = await ready();
    const { intent } = await w.readyIntent(user);
    const r = await w.app.exchange.submit(user.actor, intent.id, { signedXdr: 'SIGNED:FAKE-XDR:' + 'e'.repeat(64), submitKey: 'submit-key-10' }, w.rid());
    expect(r).toMatchObject({ state: 'FAILED', failureReason: 'BAD_AUTH' });
  });

  it('validates submit payloads', async () => {
    const { w, user } = await ready();
    const { intent } = await w.readyIntent(user);
    await expect(w.app.exchange.submit(user.actor, intent.id, { signedXdr: '', submitKey: 'submit-key-11' }, w.rid())).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    await expect(w.app.exchange.submit(user.actor, intent.id, { signedXdr: 'x'.repeat(30_000), submitKey: 'submit-key-11' }, w.rid())).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    await expect(w.app.exchange.submit(user.actor, intent.id, { signedXdr: 'x', submitKey: 'k' }, w.rid())).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it('cancel works before submission and not after', async () => {
    const { w, user } = await ready();
    const a = await w.readyIntent(user, 'cancel-key-0001');
    expect((await w.app.exchange.cancel(user.actor, a.intent.id, w.rid())).state).toBe('CANCELLED');
    await expect(w.app.exchange.submit(user.actor, a.intent.id, { signedXdr: w.signFake(a.intent.unsignedXdr!), submitKey: 'submit-key-12' }, w.rid())).rejects.toMatchObject({ code: 'INVALID_STATE' });
    const b = await w.readyIntent(user, 'cancel-key-0002');
    await w.app.exchange.submit(user.actor, b.intent.id, { signedXdr: w.signFake(b.intent.unsignedXdr!), submitKey: 'submit-key-13' }, w.rid());
    await expect(w.app.exchange.cancel(user.actor, b.intent.id, w.rid())).rejects.toMatchObject({ code: 'INVALID_STATE' });
  });

  it('crash recovery: an intent stuck in SUBMITTED becomes RECONCILING after the grace period', async () => {
    const { w, user } = await ready();
    const { intent } = await w.readyIntent(user);
    // simulate a crash between the write-ahead SUBMITTED and the network call
    const raw = (await w.app.exchange.intents.get(intent.id))!;
    raw.state = 'SUBMITTED';
    raw.updatedAt = new Date(w.t.ms).toISOString();
    await w.app.exchange.intents.put(raw);
    expect(await w.app.exchange.recoverStuck(60_000, w.rid())).toEqual([]);
    w.t.ms += 61_000;
    expect(await w.app.exchange.recoverStuck(60_000, w.rid())).toEqual([intent.id]);
    expect((await w.app.exchange.getIntent(user.actor, intent.id)).state).toBe('RECONCILING');
  });

  it('audit trail never contains signed payloads or secrets', async () => {
    const { w, user } = await ready();
    const { intent } = await w.readyIntent(user);
    await w.app.exchange.submit(user.actor, intent.id, { signedXdr: w.signFake(intent.unsignedXdr!), submitKey: 'submit-key-14' }, w.rid());
    const dump = JSON.stringify(await w.app.audit.all());
    expect(dump).not.toContain('SIGNED:');
    expect(dump).not.toContain('FAKE-XDR');
    await expect(w.app.audit.record({ id: 'x', role: 'user' }, 's', 'a', 'o', 'r', { signedXdr: 'abc' })).rejects.toThrow(/not allowed/);
  });
});
