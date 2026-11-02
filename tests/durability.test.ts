import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { SqliteStorage } from '../src/persistence/storage.js';
import { makeWorld } from './helpers.js';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('state survives a process restart (SQLite)', () => {
  it('keeps issuers, intents, sessions, audit sequence and a reconciliation pause', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'unbound-dur-'));
    dirs.push(dir);
    const file = join(dir, 'core.db');

    const s1 = new SqliteStorage(file);
    const w = makeWorld(s1);
    await w.onboardMerchant();
    const user = await w.newUser();
    const { intent } = await w.readyIntent(user);
    w.gateway.submitMode = 'reject-min-output';
    await w.app.exchange.submit(user.actor, intent.id, { signedXdr: w.signFake(intent.unsignedXdr!), submitKey: 'dur-submit-1' }, w.rid());
    // chain says CONFIRMED but we recorded FAILED => discrepancy => durable pause
    await w.app.reconciliation.ingest(w.eventFor(intent.txHash!, 'CONFIRMED'), w.rid());
    expect(await w.app.guard.isPaused()).toBe(true);
    const auditBefore = (await w.app.audit.all()).length;
    s1.close();

    // "restart": brand-new app objects over the same file
    const s2 = new SqliteStorage(file);
    const app2 = createApp({ gateway: w.gateway, clock: w.clock, storage: s2 });
    expect(await app2.wallets.authenticate(user.token)).toMatchObject({ id: user.actor.id, role: 'user' });
    expect((await app2.exchange.getIntent(user.actor, intent.id)).state).toBe('FAILED');
    expect((await app2.issuers.eligibility(w.SHOP)).eligible).toBe(true);
    expect((await app2.issuers.eligibility(w.USDC)).kind).toBe('SUPPORTED_TARGET');
    expect(await app2.guard.isPaused()).toBe(true); // a restart must not lift the pause
    await expect(
      app2.exchange.quote(user.actor, { schemaVersion: '1.0', sourceAsset: w.SHOP, targetAsset: w.USDC, sourceAmount: '1', slippageBps: 1, destinationAccount: user.publicKey, network: 'TESTNET' }, 'r'),
    ).rejects.toMatchObject({ code: 'SENSITIVE_ACTIONS_PAUSED' });
    await app2.guard.resume(w.admin, 'ok', 'r');
    const audit = await app2.audit.all();
    expect(audit.length).toBeGreaterThan(auditBefore);
    expect(new Set(audit.map((e) => e.seq)).size).toBe(audit.length); // sequence continued, no reuse
    // processed events stay deduplicated across restarts
    const dup = await app2.reconciliation.ingest(w.eventFor(intent.txHash!, 'CONFIRMED'), 'r');
    expect(dup.duplicate).toBe(true);
    s2.close();
  });

  it('an intent mid-flight (RECONCILING) is resolved by an event after restart', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'unbound-dur-'));
    dirs.push(dir);
    const file = join(dir, 'core.db');
    const s1 = new SqliteStorage(file);
    const w = makeWorld(s1);
    await w.onboardMerchant();
    const user = await w.newUser();
    const { intent } = await w.readyIntent(user);
    w.gateway.submitMode = 'timeout-after-apply';
    expect((await w.app.exchange.submit(user.actor, intent.id, { signedXdr: w.signFake(intent.unsignedXdr!), submitKey: 'dur-submit-2' }, w.rid())).state).toBe('RECONCILING');
    s1.close();
    const s2 = new SqliteStorage(file);
    const app2 = createApp({ gateway: w.gateway, clock: w.clock, storage: s2 });
    await app2.reconciliation.ingest(w.eventFor(intent.txHash!, 'CONFIRMED'), 'r');
    expect(await app2.exchange.getIntent(user.actor, intent.id)).toMatchObject({ state: 'CONFIRMED', amountOutActual: '72.0000000' });
    s2.close();
  });
});
