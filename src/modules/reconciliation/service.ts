import type { AuditLog } from '../../common/audit.js';
import { ApiError } from '../../common/errors.js';
import type { Clock } from '../../common/ids.js';
import { InMemoryRepository, type Repository } from '../../common/repository.js';
import { ReconciliationEventSchema } from './contract.js';
import type { OperationsGuard } from './guard.js';

/** Canonical record of a ledger fact we were told about (SRD: LedgerObservation). */
export interface LedgerObservation {
  id: string; // == event id; dedup key
  txHash: string;
  status: 'CONFIRMED' | 'FAILED' | 'RECONCILING';
  ledgerCursor: string;
  ledger?: number;
  amountOutActual?: string;
  observedAt: string;
  receivedAt: string;
  outcome: 'APPLIED' | 'IGNORED' | 'NOT_MINE' | 'DISCREPANCY';
}

export type ObservationHandler = (obs: LedgerObservation, requestId: string) => Promise<'NOT_MINE' | 'APPLIED' | 'IGNORED' | 'DISCREPANCY'>;

export type IngestResult = { duplicate: true; observation: LedgerObservation } | { duplicate: false; observation: LedgerObservation };

/**
 * Consumes unbound-stellar's reconciliation events (at-least-once, possibly out of order and
 * replayed). Validation is strict and fail-closed; ingest is idempotent on event id.
 */
export class ReconciliationService {
  readonly observations: Repository<LedgerObservation> = new InMemoryRepository<LedgerObservation>();
  private readonly handlers: ObservationHandler[] = [];

  constructor(
    private readonly deps: { clock: Clock; audit: AuditLog; guard: OperationsGuard },
  ) {}

  register(handler: ObservationHandler): void {
    this.handlers.push(handler);
  }

  async ingest(raw: unknown, requestId: string): Promise<IngestResult> {
    const parsed = ReconciliationEventSchema.safeParse(raw);
    if (!parsed.success) {
      const net = (raw as { network?: unknown } | null)?.network;
      if (net !== undefined && net !== 'TESTNET') throw new ApiError('UNKNOWN_NETWORK', 'event is for an unrecognized network');
      throw new ApiError('VALIDATION_FAILED', 'reconciliation event failed contract validation', parsed.error.issues.map((i) => i.path.join('.')));
    }
    const ev = parsed.data;
    const dup = await this.observations.get(ev.id);
    if (dup) return { duplicate: true, observation: dup };

    const obs: LedgerObservation = {
      id: ev.id,
      txHash: ev.entityRef.ref,
      status: ev.status,
      ledgerCursor: ev.ledgerCursor,
      ...(ev.ledger !== undefined ? { ledger: ev.ledger } : {}),
      ...(ev.amountOutActual !== undefined ? { amountOutActual: ev.amountOutActual } : {}),
      observedAt: ev.observedAt,
      receivedAt: this.deps.clock.now().toISOString(),
      outcome: 'NOT_MINE',
    };
    let result: LedgerObservation['outcome'] = 'NOT_MINE';
    for (const h of this.handlers) {
      const r = await h(obs, requestId);
      if (r !== 'NOT_MINE') result = r;
      if (r === 'DISCREPANCY') {
        await this.deps.guard.pause(`ledger/database discrepancy for tx ${obs.txHash}`, obs.txHash, requestId);
      }
    }
    obs.outcome = result;
    await this.observations.put(obs);
    await this.deps.audit.record({ id: 'system', role: 'system' }, 'reconciliation', 'OBSERVATION_INGESTED', obs.id, requestId, { status: obs.status, outcome: result });
    return { duplicate: false, observation: obs };
  }
}
