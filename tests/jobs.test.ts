/* eslint-disable @typescript-eslint/no-explicit-any */
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { createHttpServer } from '../src/http/server.js';
import { JobRunner, MAX_BACKOFF_MS, type Scheduler } from '../src/jobs/runner.js';
import { DEFAULT_ESCROW_WINDOW_SECS } from '../src/modules/redemption/service.js';
import { makeWorld } from './helpers.js';

function fakeScheduler() {
  const timers: { fn: () => void; ms: number; cleared: boolean }[] = [];
  const s: Scheduler = {
    setInterval: (fn, ms) => {
      timers.push({ fn, ms, cleared: false });
      return timers.length - 1;
    },
    clearInterval: (h) => {
      timers[h as number]!.cleared = true;
    },
  };
  return { s, timers };
}

function deferred() {
  let resolve!: (v: unknown) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise((res, rej) => ((resolve = res), (reject = rej)));
  return { promise, resolve, reject };
}

const flush = () => new Promise((r) => setImmediate(r));

describe('JobRunner', () => {
  const t = { ms: Date.UTC(2026, 10, 3, 12) };
  const clock = { now: () => new Date(t.ms) };

  it('schedules every registered job on its interval and stops cleanly', async () => {
    const { s, timers } = fakeScheduler();
    const r = new JobRunner({ clock, scheduler: s });
    let runs = 0;
    r.register({ name: 'count-a', intervalMs: 5000, run: async () => [++runs] });
    r.start();
    r.start(); // idempotent
    expect(timers.map((x) => x.ms)).toEqual([5000]);
    timers[0]!.fn();
    await flush();
    expect(r.status()[0]).toMatchObject({ runs: 1, lastItems: 1, lastError: null, running: false });
    r.register({ name: 'late-b', intervalMs: 1000, run: async () => null }); // registered after start -> scheduled too
    expect(timers).toHaveLength(2);
    r.stop();
    expect(timers.every((x) => x.cleared)).toBe(true);
  });

  it('never overlaps a run with itself', async () => {
    const r = new JobRunner({ clock });
    const d = deferred();
    let calls = 0;
    r.register({ name: 'slow-job', intervalMs: 1000, run: () => (calls++, d.promise) });
    const first = r.tick('slow-job');
    expect(await r.tick('slow-job')).toBeUndefined();
    const now = r.runNow('slow-job'); // joins the run in progress
    expect(r.status()[0]!.running).toBe(true);
    d.resolve([]);
    expect((await first)!.runs).toBe(1);
    expect((await now).runs).toBe(1);
    expect(calls).toBe(1);
  });

  it('backs off exponentially after failures (bounded) and recovers on success', async () => {
    const lines: string[] = [];
    const r = new JobRunner({ clock, log: (l) => lines.push(l) });
    let fail = true;
    r.register({ name: 'flaky-job', intervalMs: 60_000, run: async () => { if (fail) throw new Error('db unavailable'); return ['x']; } });
    const s1 = (await r.tick('flaky-job'))!;
    expect(s1).toMatchObject({ failures: 1, consecutiveFailures: 1, lastError: 'db unavailable' });
    expect(Date.parse(s1.nextEligibleAt!)).toBe(t.ms + 120_000);
    expect(await r.tick('flaky-job')).toBeUndefined(); // backing off
    t.ms += 120_000;
    const s2 = (await r.tick('flaky-job'))!;
    expect(Date.parse(s2.nextEligibleAt!)).toBe(t.ms + 240_000);
    for (let i = 0; i < 10; i++) {
      t.ms += MAX_BACKOFF_MS;
      await r.tick('flaky-job');
    }
    const capped = r.status()[0]!;
    expect(Date.parse(capped.nextEligibleAt!) - t.ms).toBe(MAX_BACKOFF_MS);
    fail = false;
    const ok = await r.runNow('flaky-job'); // admin run ignores backoff
    expect(ok).toMatchObject({ consecutiveFailures: 0, lastError: null, nextEligibleAt: null, lastItems: 1 });
    expect(ok.failures).toBe(12);
    expect(lines.some((l) => l.includes('backing off'))).toBe(true);
  });

  it('validates registrations', () => {
    const r = new JobRunner({ clock });
    r.register({ name: 'ok-job', intervalMs: 1000, run: async () => null });
    expect(() => r.register({ name: 'ok-job', intervalMs: 1000, run: async () => null })).toThrow(/already/);
    expect(() => r.register({ name: 'Bad Name', intervalMs: 1000, run: async () => null })).toThrow(/invalid/);
    expect(() => r.register({ name: 'too-fast', intervalMs: 10, run: async () => null })).toThrow(/interval/);
    expect(() => r.runNow('missing')).toThrow(/unknown/);
  });
});

describe('default maintenance jobs (wired in createApp)', () => {
  it('registers recover-stuck-intents, escalate-overdue-disputes and reconcile-escrows', () => {
    const w = makeWorld();
    expect(w.app.jobs.status().map((j) => j.name)).toEqual(['recover-stuck-intents', 'escalate-overdue-disputes', 'reconcile-escrows']);
  });

  it('recover-stuck-intents moves a crash-stuck SUBMITTED intent to RECONCILING', async () => {
    const w = makeWorld();
    await w.onboardMerchant();
    const user = await w.newUser();
    const { intent } = await w.readyIntent(user);
    const raw = (await w.app.exchange.intents.get(intent.id))!;
    raw.state = 'SUBMITTED';
    raw.updatedAt = new Date(w.t.ms).toISOString();
    await w.app.exchange.intents.put(raw);
    expect((await w.app.jobs.runNow('recover-stuck-intents')).lastItems).toBe(0);
    w.t.ms += 5 * 60_000;
    expect((await w.app.jobs.runNow('recover-stuck-intents')).lastItems).toBe(1);
    expect((await w.app.exchange.getIntent(user.actor, intent.id)).state).toBe('RECONCILING');
  });

  it('reconcile-escrows applies an on-chain timeout refund made outside core', async () => {
    const w = makeWorld();
    const escrow = w.gateway.enableEscrow();
    await w.onboardMerchant();
    const user = await w.newUser();
    const r = await w.app.redemption.create(user.actor, { asset: w.SHOP, amount: '10', holder: user.publicKey }, 'job-redeem-01', w.rid());
    await w.app.redemption.submitReturn(user.actor, r.id, w.signFake(r.unsignedXdr!), w.rid());
    w.t.ms += DEFAULT_ESCROW_WINDOW_SECS * 1000;
    escrow.closeOutOfBand(r.id, 'EXPIRED');
    expect((await w.app.jobs.runNow('reconcile-escrows')).lastItems).toBe(1);
    expect((await w.app.redemption.get(user.actor, r.id)).state).toBe('EXPIRED');
  });
});

describe('admin job endpoints', () => {
  let server: Server | undefined;
  afterEach(() => new Promise<void>((r) => (server ? server.close(() => r()) : r())));

  it('only admins can read job status or trigger a run; runs are audited', async () => {
    const w = makeWorld();
    server = createHttpServer(w.app);
    await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const adminToken = await w.app.wallets.openSession(w.admin);
    const merchantToken = await w.app.wallets.openSession({ id: 'usr_m', role: 'merchant' });
    const call = async (method: string, path: string, token?: string) => {
      const res = await fetch(base + path, { method, headers: token ? { authorization: `Bearer ${token}` } : {} });
      return { status: res.status, json: (await res.json()) as any };
    };
    expect((await call('GET', '/v1/admin/jobs')).status).toBe(401);
    expect((await call('GET', '/v1/admin/jobs', merchantToken)).status).toBe(403);
    const list = await call('GET', '/v1/admin/jobs', adminToken);
    expect(list.json.jobs).toHaveLength(3);
    const run = await call('POST', '/v1/admin/jobs/escalate-overdue-disputes/run', adminToken);
    expect(run.json).toMatchObject({ name: 'escalate-overdue-disputes', runs: 1, lastItems: 0 });
    expect((await call('POST', '/v1/admin/jobs/nope-nope/run', adminToken)).status).toBe(404);
    expect((await w.app.audit.forObject('escalate-overdue-disputes')).map((e) => e.action)).toEqual(['JOB_RUN_REQUESTED']);
  });
});
