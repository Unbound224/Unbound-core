import { newId, type Clock } from './ids.js';
import type { Actor } from './auth.js';
import { InMemoryRepository, type Repository } from './repository.js';

export interface AuditEvent {
  id: string;
  seq: number;
  at: string;
  actorId: string;
  actorRole: string;
  scope: string;
  action: string;
  objectRef: string;
  requestId: string;
  detail?: Record<string, string | number | boolean | null>;
}

const FORBIDDEN_KEYS = /secret|seed|private|mnemonic|signedxdr|password|token/i;

/**
 * Append-only audit trail: actor, scope, action, time, object and request id. Refuses detail keys
 * that look like secrets so a coding mistake cannot leak key material or signed payloads.
 */
export class AuditLog {
  private seq = 0;
  constructor(
    private readonly clock: Clock,
    private readonly repo: Repository<AuditEvent> = new InMemoryRepository<AuditEvent>(),
  ) {}

  async record(
    actor: Pick<Actor, 'id' | 'role'> | { id: string; role: string },
    scope: string,
    action: string,
    objectRef: string,
    requestId: string,
    detail?: AuditEvent['detail'],
  ): Promise<AuditEvent> {
    for (const k of Object.keys(detail ?? {})) {
      if (FORBIDDEN_KEYS.test(k)) throw new Error(`audit detail key "${k}" is not allowed`);
    }
    const ev: AuditEvent = {
      id: newId('aud'),
      seq: ++this.seq,
      at: this.clock.now().toISOString(),
      actorId: actor.id,
      actorRole: actor.role,
      scope,
      action,
      objectRef,
      requestId,
      ...(detail ? { detail } : {}),
    };
    await this.repo.put(ev);
    return ev;
  }

  async forObject(objectRef: string): Promise<AuditEvent[]> {
    return (await this.repo.find((e) => e.objectRef === objectRef)).sort((a, b) => a.seq - b.seq);
  }

  async all(): Promise<AuditEvent[]> {
    return this.repo.list();
  }
}
