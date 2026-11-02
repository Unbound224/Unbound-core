import { z } from 'zod';
import type { AuditLog } from '../../common/audit.js';
import { requireRole, type Actor } from '../../common/auth.js';
import { ApiError } from '../../common/errors.js';
import { newId, type Clock } from '../../common/ids.js';
import { KeyedMutex, type Repository } from '../../common/repository.js';
import type { Storage } from '../../persistence/storage.js';
import type { ExchangeService } from '../exchange/service.js';
import type { RedemptionService } from '../redemption/service.js';

export type DisputeState = 'OPEN' | 'MERCHANT_RESPONDED' | 'ESCALATED' | 'RESOLVED_FOR_HOLDER' | 'RESOLVED_FOR_MERCHANT' | 'WITHDRAWN';
const CLOSED: ReadonlySet<DisputeState> = new Set(['RESOLVED_FOR_HOLDER', 'RESOLVED_FOR_MERCHANT', 'WITHDRAWN']);

export const MERCHANT_RESPONSE_WINDOW_MS = 7 * 24 * 3_600_000;

export interface DisputeMessage {
  at: string;
  authorId: string;
  authorRole: string;
  text: string;
}

export interface Dispute {
  id: string;
  openedBy: string;
  kind: 'REDEMPTION' | 'EXCHANGE';
  subjectRef: string;
  /** set for redemption disputes: the merchant who must respond */
  merchantId?: string;
  reason: string;
  state: DisputeState;
  messages: DisputeMessage[];
  respondBy?: string;
  resolution?: { outcome: 'FOR_HOLDER' | 'FOR_MERCHANT'; note: string; decidedBy: string; at: string };
  createdAt: string;
  updatedAt: string;
}

const Text = z.string().trim().min(10, 'at least 10 characters').max(2000);
const OpenSchema = z.object({ kind: z.enum(['REDEMPTION', 'EXCHANGE']), subjectRef: z.string().min(3).max(100), reason: Text }).strict();
const MessageSchema = z.object({ text: Text }).strict();
const ResolveSchema = z.object({ outcome: z.enum(['FOR_HOLDER', 'FOR_MERCHANT']), note: Text }).strict();

const bad = (e: z.ZodError) => new ApiError('VALIDATION_FAILED', 'invalid dispute input', e.issues.map((i) => `${i.path.join('.')}: ${i.message}`));

/**
 * Dispute workflow. It records claims, responses and a human decision. It NEVER moves funds or
 * changes ledger-derived state: a ruling for the holder marks the obligation (refund owed by the
 * issuer under its own policy) and the issuer must act off-chain.
 */
export class DisputeService {
  readonly disputes: Repository<Dispute>;
  private readonly lock = new KeyedMutex();

  constructor(
    private readonly deps: { clock: Clock; audit: AuditLog; exchange: ExchangeService; redemption: RedemptionService; storage: Storage },
  ) {
    this.disputes = deps.storage.repo<Dispute>('disputes');
  }

  async open(actor: Actor | undefined, input: unknown, requestId: string): Promise<Dispute> {
    const user = requireRole(actor, 'user');
    const p = OpenSchema.safeParse(input);
    if (!p.success) throw bad(p.error);
    const { kind, subjectRef, reason } = p.data;
    return this.lock.run(`open:${subjectRef}`, async () => {
      // exactly one live dispute per subject
      const live = (await this.disputes.find((d) => d.subjectRef === subjectRef && !CLOSED.has(d.state)))[0];
      if (live) {
        if (live.openedBy !== user.id) throw new ApiError('NOT_FOUND', 'subject not found');
        return live;
      }
      let merchantId: string | undefined;
      if (kind === 'REDEMPTION') {
        const r = await this.deps.redemption.get(user, subjectRef); // NOT_FOUND unless it is the user's own
        merchantId = r.merchantId;
      } else {
        await this.deps.exchange.getIntent(user, subjectRef);
      }
      const now = this.deps.clock.now();
      const d: Dispute = {
        id: newId('dsp'),
        openedBy: user.id,
        kind,
        subjectRef,
        ...(merchantId ? { merchantId, respondBy: new Date(now.getTime() + MERCHANT_RESPONSE_WINDOW_MS).toISOString() } : {}),
        reason,
        state: 'OPEN',
        messages: [{ at: now.toISOString(), authorId: user.id, authorRole: 'user', text: reason }],
        createdAt: now.toISOString(),
        updatedAt: now.toISOString(),
      };
      await this.disputes.put(d);
      await this.deps.audit.record(user, 'dispute', 'DISPUTE_OPENED', d.id, requestId, { kind });
      return d;
    });
  }

  async get(actor: Actor | undefined, id: string): Promise<Dispute> {
    const a = requireRole(actor, 'user', 'merchant', 'admin');
    const d = await this.disputes.get(id);
    if (!d || !this.canSee(a, d)) throw new ApiError('NOT_FOUND', 'dispute not found');
    return d;
  }

  async list(actor: Actor | undefined): Promise<Dispute[]> {
    const a = requireRole(actor, 'user', 'merchant', 'admin');
    return this.disputes.find((d) => this.canSee(a, d));
  }

  async addMessage(actor: Actor | undefined, id: string, input: unknown, requestId: string): Promise<Dispute> {
    const a = requireRole(actor, 'user', 'merchant', 'admin');
    const p = MessageSchema.safeParse(input);
    if (!p.success) throw bad(p.error);
    return this.lock.run(`dsp:${id}`, async () => {
      const d = await this.get(a, id);
      if (CLOSED.has(d.state)) throw new ApiError('INVALID_STATE', 'this dispute is closed');
      const now = this.deps.clock.now().toISOString();
      d.messages.push({ at: now, authorId: a.id, authorRole: a.role, text: p.data.text });
      if (a.role === 'merchant' && d.state === 'OPEN') d.state = 'MERCHANT_RESPONDED';
      d.updatedAt = now;
      await this.disputes.put(d);
      await this.deps.audit.record(a, 'dispute', 'DISPUTE_MESSAGE', d.id, requestId);
      return d;
    });
  }

  async withdraw(actor: Actor | undefined, id: string, requestId: string): Promise<Dispute> {
    const user = requireRole(actor, 'user');
    return this.lock.run(`dsp:${id}`, async () => {
      const d = await this.get(user, id);
      if (d.openedBy !== user.id) throw new ApiError('FORBIDDEN', 'only the opener can withdraw');
      return this.close(d, 'WITHDRAWN', user, requestId);
    });
  }

  /** Admin decision. Records the ruling; does not move funds. */
  async resolve(actor: Actor | undefined, id: string, input: unknown, requestId: string): Promise<Dispute> {
    const admin = requireRole(actor, 'admin');
    const p = ResolveSchema.safeParse(input);
    if (!p.success) throw bad(p.error);
    return this.lock.run(`dsp:${id}`, async () => {
      const d = await this.get(admin, id);
      if (CLOSED.has(d.state)) throw new ApiError('INVALID_STATE', 'this dispute is already closed');
      const now = this.deps.clock.now().toISOString();
      d.resolution = { outcome: p.data.outcome, note: p.data.note, decidedBy: admin.id, at: now };
      return this.close(d, p.data.outcome === 'FOR_HOLDER' ? 'RESOLVED_FOR_HOLDER' : 'RESOLVED_FOR_MERCHANT', admin, requestId, { outcome: p.data.outcome });
    });
  }

  /** Flags disputes whose merchant response window passed so an admin sees them first. */
  async escalateOverdue(requestId: string): Promise<string[]> {
    const now = this.deps.clock.now().getTime();
    const ids: string[] = [];
    for (const d of await this.disputes.find((x) => x.state === 'OPEN' && x.respondBy !== undefined && Date.parse(x.respondBy) <= now)) {
      await this.lock.run(`dsp:${d.id}`, async () => {
        const fresh = (await this.disputes.get(d.id))!;
        if (fresh.state !== 'OPEN') return;
        fresh.state = 'ESCALATED';
        fresh.updatedAt = this.deps.clock.now().toISOString();
        await this.disputes.put(fresh);
        await this.deps.audit.record({ id: 'system', role: 'system' }, 'dispute', 'DISPUTE_ESCALATED', fresh.id, requestId);
        ids.push(fresh.id);
      });
    }
    return ids;
  }

  private canSee(a: Actor, d: Dispute): boolean {
    return a.role === 'admin' || (a.role === 'user' && d.openedBy === a.id) || (a.role === 'merchant' && d.merchantId !== undefined && d.merchantId === a.merchantId);
  }

  private async close(d: Dispute, to: DisputeState, actor: Pick<Actor, 'id' | 'role'>, requestId: string, detail?: Record<string, string>): Promise<Dispute> {
    d.state = to;
    d.updatedAt = this.deps.clock.now().toISOString();
    await this.disputes.put(d);
    await this.deps.audit.record(actor, 'dispute', `DISPUTE_${to}`, d.id, requestId, detail);
    return d;
  }
}
