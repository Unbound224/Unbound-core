import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { JobRunner } from '../src/jobs/runner.js';
import { InMemoryJobLock, SqliteJobLock } from '../src/jobs/lock.js';
import { SqliteStorage } from '../src/persistence/storage.js';

const dirs: string[] = [];
const stores: SqliteStorage[] = [];
afterEach(() => {
  for (const s of stores.splice(0)) s.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});
const clock = { now: () => new Date() };

describe('job lease across processes', () => {
  it('in memory: a second owner skips the job while the first runs it, and runs it afterwards', async () => {
    const base = new InMemoryJobLock();
    let release!: () => void;
    const open = new Promise<void>((r) => (release = r));
    let runsA = 0;
    let runsB = 0;
    const a = new JobRunner({ clock, lock: base.forOwner('A') });
    const b = new JobRunner({ clock, lock: base.forOwner('B') });
    a.register({ name: 'sync-things', intervalMs: 60_000, run: async () => { runsA++; await open; } });
    b.register({ name: 'sync-things', intervalMs: 60_000, run: async () => { runsB++; } });
    const first = a.runNow('sync-things');
    await new Promise((r) => setTimeout(r, 10));
    await b.runNow('sync-things');
    expect(runsB).toBe(0);
    release();
    await first;
    await b.runNow('sync-things');
    expect([runsA, runsB]).toEqual([1, 1]);
  });

  it('SQLite: two storages on one file elect one runner; a dead holder is replaced after its ttl', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'unbound-lock-'));
    dirs.push(dir);
    const file = join(dir, 'core.db');
    const s1 = new SqliteStorage(file);
    const s2 = new SqliteStorage(file);
    stores.push(s1, s2);
    let t = 1_000_000;
    const l1 = new SqliteJobLock(s1.db, 'p1', () => t);
    const l2 = new SqliteJobLock(s2.db, 'p2', () => t);
    expect(await l1.acquire('reconcile-escrows', 60_000)).toBe(true);
    expect(await l2.acquire('reconcile-escrows', 60_000)).toBe(false);
    expect(await l1.acquire('reconcile-escrows', 60_000)).toBe(true); // re-entrant for its owner
    expect(await l2.acquire('other-job', 60_000)).toBe(true); // independent per job name
    t += 60_001; // p1 "crashed": its lease expires
    expect(await l2.acquire('reconcile-escrows', 60_000)).toBe(true);
    await l1.release('reconcile-escrows'); // a stale owner cannot release someone else's lease
    expect(await l1.acquire('reconcile-escrows', 60_000)).toBe(false);
    await l2.release('reconcile-escrows');
    expect(await l1.acquire('reconcile-escrows', 60_000)).toBe(true);
  });
});
