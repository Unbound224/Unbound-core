import { randomUUID } from 'node:crypto';
import type { Clock } from '../common/ids.js';
import type { JobLock } from './lock.js';

/**
 * In-process job runner for the periodic maintenance jobs (stuck-intent recovery, dispute
 * escalation, escrow reconciliation). Each job runs on its own interval, never overlaps itself,
 * backs off exponentially after failures (bounded), and exposes its status for admins.
 *
 * With a `JobLock` (a lease per job in the shared database) several core processes keep each job single-flight;
 * without one, every instance runs every job, which is safe (the jobs are idempotent) but wasteful.
 */
export interface Job {
  name: string;
  intervalMs: number;
  /** returns whatever the job did (an array is counted as "items changed") */
  run(requestId: string): Promise<unknown>;
}

export interface JobStatus {
  name: string;
  intervalMs: number;
  running: boolean;
  runs: number;
  failures: number;
  consecutiveFailures: number;
  lastStartedAt: string | null;
  lastFinishedAt: string | null;
  lastError: string | null;
  lastItems: number | null;
  /** next time a tick may start the job (later than the interval while backing off) */
  nextEligibleAt: string | null;
}

export interface Scheduler {
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
}

const realScheduler: Scheduler = {
  setInterval: (fn, ms) => {
    const h = setInterval(fn, ms);
    h.unref?.();
    return h;
  },
  clearInterval: (h) => clearInterval(h as NodeJS.Timeout),
};

/** Backoff after n consecutive failures: interval * 2^n, capped at MAX_BACKOFF_MS. */
export const MAX_BACKOFF_MS = 30 * 60_000;

interface Entry {
  job: Job;
  status: JobStatus;
  nextEligibleMs: number;
  inFlight: Promise<JobStatus> | undefined;
  handle: unknown;
}

export class JobRunner {
  private readonly entries = new Map<string, Entry>();
  private started = false;

  constructor(
    private readonly opts: { clock: Clock; scheduler?: Scheduler; log?: (line: string) => void; lock?: JobLock },
  ) {}

  register(job: Job): void {
    if (!/^[a-z0-9-]{3,64}$/.test(job.name)) throw new Error(`invalid job name ${job.name}`);
    if (this.entries.has(job.name)) throw new Error(`job ${job.name} already registered`);
    if (!Number.isInteger(job.intervalMs) || job.intervalMs < 1000) throw new Error('job interval must be >= 1000 ms');
    this.entries.set(job.name, {
      job,
      nextEligibleMs: 0,
      inFlight: undefined,
      handle: undefined,
      status: {
        name: job.name,
        intervalMs: job.intervalMs,
        running: false,
        runs: 0,
        failures: 0,
        consecutiveFailures: 0,
        lastStartedAt: null,
        lastFinishedAt: null,
        lastError: null,
        lastItems: null,
        nextEligibleAt: null,
      },
    });
    if (this.started) this.schedule(this.entries.get(job.name)!);
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    for (const e of this.entries.values()) this.schedule(e);
  }

  stop(): void {
    this.started = false;
    for (const e of this.entries.values()) {
      if (e.handle !== undefined) (this.opts.scheduler ?? realScheduler).clearInterval(e.handle);
      e.handle = undefined;
    }
  }

  status(): JobStatus[] {
    return [...this.entries.values()].map((e) => ({ ...e.status }));
  }

  /** Scheduled tick: skipped while the job is running or backing off. */
  async tick(name: string): Promise<JobStatus | undefined> {
    const e = this.entry(name);
    if (e.inFlight || this.opts.clock.now().getTime() < e.nextEligibleMs) return undefined;
    return this.execute(e);
  }

  /** Admin "run now": ignores backoff but never overlaps a run in progress (returns that run's result). */
  runNow(name: string): Promise<JobStatus> {
    const e = this.entry(name);
    return e.inFlight ?? this.execute(e);
  }

  has(name: string): boolean {
    return this.entries.has(name);
  }

  private entry(name: string): Entry {
    const e = this.entries.get(name);
    if (!e) throw new Error(`unknown job ${name}`);
    return e;
  }

  private schedule(e: Entry): void {
    e.handle = (this.opts.scheduler ?? realScheduler).setInterval(() => void this.tick(e.job.name), e.job.intervalMs);
  }

  private execute(e: Entry): Promise<JobStatus> {
    const run = (async () => {
      const s = e.status;
      // With a lock, only the process holding the lease runs the job; a crashed holder's lease expires by itself.
      const lock = this.opts.lock;
      if (lock && !(await lock.acquire(e.job.name, Math.max(e.job.intervalMs * 2, 60_000)))) {
        this.opts.log?.(`[jobs] ${e.job.name}: another process holds the lease; skipped`);
        e.inFlight = undefined;
        return { ...s };
      }
      const started = this.opts.clock.now();
      s.running = true;
      s.lastStartedAt = started.toISOString();
      s.runs += 1;
      const requestId = `job_${e.job.name}_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
      try {
        const out = await e.job.run(requestId);
        s.lastItems = Array.isArray(out) ? out.length : null;
        s.lastError = null;
        s.consecutiveFailures = 0;
        e.nextEligibleMs = 0;
        if (Array.isArray(out) && out.length) this.opts.log?.(`[jobs] ${e.job.name}: ${out.length} item(s) (${requestId})`);
      } catch (err) {
        s.failures += 1;
        s.consecutiveFailures += 1;
        // never surface internals beyond a short message
        s.lastError = (err instanceof Error ? err.message : 'job failed').slice(0, 200);
        const backoff = Math.min(e.job.intervalMs * 2 ** s.consecutiveFailures, MAX_BACKOFF_MS);
        e.nextEligibleMs = this.opts.clock.now().getTime() + backoff;
        this.opts.log?.(`[jobs] ${e.job.name} failed (${s.consecutiveFailures}x), backing off ${Math.round(backoff / 1000)}s: ${s.lastError}`);
      } finally {
        await lock?.release(e.job.name);
        s.running = false;
        s.lastFinishedAt = this.opts.clock.now().toISOString();
        s.nextEligibleAt = e.nextEligibleMs ? new Date(e.nextEligibleMs).toISOString() : null;
        e.inFlight = undefined;
      }
      return { ...s };
    })();
    e.inFlight = run;
    return run;
  }
}
