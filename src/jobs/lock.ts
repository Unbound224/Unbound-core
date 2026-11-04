import type { DatabaseSync } from 'node:sqlite';

/**
 * Cross-process lease for scheduled jobs, so two core processes sharing one database do not run the same job at once.
 * A lease expires on its own (ttl), so a crashed holder never blocks a job forever.
 */
export interface JobLock {
  /** true when this process now holds the lease for `name` (re-entrant for the same owner). */
  acquire(name: string, ttlMs: number): Promise<boolean>;
  release(name: string): Promise<void>;
}

type Leases = Map<string, { owner: string; expiresAt: number }>;

/** Single-process / test implementation; `forOwner` makes handles with distinct owners over the same leases. */
export class InMemoryJobLock implements JobLock {
  constructor(
    private readonly now: () => number = Date.now,
    private readonly owner = 'local',
    private readonly leases: Leases = new Map(),
  ) {}
  forOwner(owner: string): InMemoryJobLock {
    return new InMemoryJobLock(this.now, owner, this.leases);
  }
  async acquire(name: string, ttlMs: number): Promise<boolean> {
    const cur = this.leases.get(name);
    if (cur && cur.expiresAt > this.now() && cur.owner !== this.owner) return false;
    this.leases.set(name, { owner: this.owner, expiresAt: this.now() + ttlMs });
    return true;
  }
  async release(name: string): Promise<void> {
    if (this.leases.get(name)?.owner === this.owner) this.leases.delete(name);
  }
}

/** Lease table in the same SQLite file the processes already share; one atomic upsert decides the winner. */
export class SqliteJobLock implements JobLock {
  constructor(
    private readonly db: DatabaseSync,
    private readonly owner: string,
    private readonly now: () => number = Date.now,
  ) {
    db.exec('CREATE TABLE IF NOT EXISTS job_leases (name TEXT PRIMARY KEY, owner TEXT NOT NULL, expires_at INTEGER NOT NULL)');
  }
  async acquire(name: string, ttlMs: number): Promise<boolean> {
    const t = this.now();
    const r = this.db
      .prepare(
        `INSERT INTO job_leases (name, owner, expires_at) VALUES (?, ?, ?)
         ON CONFLICT(name) DO UPDATE SET owner = excluded.owner, expires_at = excluded.expires_at
         WHERE job_leases.expires_at <= ? OR job_leases.owner = excluded.owner`,
      )
      .run(name, this.owner, t + ttlMs, t);
    return Number(r.changes) === 1;
  }
  async release(name: string): Promise<void> {
    this.db.prepare('DELETE FROM job_leases WHERE name = ? AND owner = ?').run(name, this.owner);
  }
}
