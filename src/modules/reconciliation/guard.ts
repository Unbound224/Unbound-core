import { requireRole, type Actor } from '../../common/auth.js';
import type { AuditLog } from '../../common/audit.js';
import { ApiError } from '../../common/errors.js';

/**
 * "Reconciliation discrepancy -> pause sensitive actions pending investigation" (SRD).
 * While paused, no new quotes' intents/submissions/redemption confirmations proceed.
 */
export class OperationsGuard {
  private reasons: string[] = [];
  constructor(private readonly audit: AuditLog) {}

  get paused(): boolean {
    return this.reasons.length > 0;
  }
  get pauseReasons(): readonly string[] {
    return this.reasons;
  }

  async pause(reason: string, objectRef: string, requestId: string): Promise<void> {
    this.reasons.push(reason);
    await this.audit.record({ id: 'system', role: 'system' }, 'reconciliation', 'SENSITIVE_ACTIONS_PAUSED', objectRef, requestId, { reason });
  }

  async resume(actor: Actor | undefined, note: string, requestId: string): Promise<void> {
    const admin = requireRole(actor, 'admin');
    this.reasons = [];
    await this.audit.record(admin, 'reconciliation', 'SENSITIVE_ACTIONS_RESUMED', 'operations', requestId, { note });
  }

  assertNotPaused(): void {
    if (this.paused) throw new ApiError('SENSITIVE_ACTIONS_PAUSED', 'sensitive actions are paused pending reconciliation review');
  }
}
