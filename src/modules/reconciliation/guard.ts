import { requireRole, type Actor } from '../../common/auth.js';
import type { AuditLog } from '../../common/audit.js';
import { ApiError } from '../../common/errors.js';
import { newId } from '../../common/ids.js';
import type { Repository } from '../../common/repository.js';
import type { Storage } from '../../persistence/storage.js';

interface PauseRecord {
  id: string;
  reason: string;
  objectRef: string;
  active: boolean;
}

/**
 * "Reconciliation discrepancy -> pause sensitive actions pending investigation" (SRD).
 * The pause is DURABLE: a restart must not silently lift it.
 */
export class OperationsGuard {
  private readonly pauses: Repository<PauseRecord>;
  constructor(
    private readonly audit: AuditLog,
    storage: Storage,
  ) {
    this.pauses = storage.repo<PauseRecord>('operation_pauses');
  }

  private async active(): Promise<PauseRecord[]> {
    return this.pauses.find((p) => p.active);
  }

  async isPaused(): Promise<boolean> {
    return (await this.active()).length > 0;
  }

  async pauseReasons(): Promise<string[]> {
    return (await this.active()).map((p) => p.reason);
  }

  async pause(reason: string, objectRef: string, requestId: string): Promise<void> {
    await this.pauses.put({ id: newId('pau'), reason, objectRef, active: true });
    await this.audit.record({ id: 'system', role: 'system' }, 'reconciliation', 'SENSITIVE_ACTIONS_PAUSED', objectRef, requestId, { reason });
  }

  async resume(actor: Actor | undefined, note: string, requestId: string): Promise<void> {
    const admin = requireRole(actor, 'admin');
    for (const p of await this.active()) await this.pauses.put({ ...p, active: false });
    await this.audit.record(admin, 'reconciliation', 'SENSITIVE_ACTIONS_RESUMED', 'operations', requestId, { note });
  }

  async assertNotPaused(): Promise<void> {
    if (await this.isPaused()) throw new ApiError('SENSITIVE_ACTIONS_PAUSED', 'sensitive actions are paused pending reconciliation review');
  }
}
