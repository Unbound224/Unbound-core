import type { Job } from './runner.js';
import type { ExchangeService } from '../modules/exchange/service.js';
import type { DisputeService } from '../modules/disputes/service.js';
import type { RedemptionService } from '../modules/redemption/service.js';

export interface DefaultJobOptions {
  /** an intent SUBMITTED for longer than this becomes RECONCILING (default 5 minutes) */
  stuckAfterMs?: number;
}

/** The maintenance jobs core needs to stay consistent without an operator. */
export function defaultJobs(s: { exchange: ExchangeService; disputes: DisputeService; redemption: RedemptionService }, o: DefaultJobOptions = {}): Job[] {
  return [
    { name: 'recover-stuck-intents', intervalMs: 60_000, run: (rid) => s.exchange.recoverStuck(o.stuckAfterMs ?? 5 * 60_000, rid) },
    { name: 'escalate-overdue-disputes', intervalMs: 5 * 60_000, run: (rid) => s.disputes.escalateOverdue(rid) },
    { name: 'reconcile-escrows', intervalMs: 2 * 60_000, run: (rid) => s.redemption.reconcileEscrows(rid) },
  ];
}
