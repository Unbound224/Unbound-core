import { z } from 'zod';
import type { AuditLog } from '../../common/audit.js';
import { requireRole, type Actor } from '../../common/auth.js';
import { ApiError } from '../../common/errors.js';
import { newId, type Clock } from '../../common/ids.js';
import { parseAmount } from '../../common/money.js';
import { InMemoryRepository, KeyedMutex, type Repository } from '../../common/repository.js';
import { mapGatewayError, type StellarGateway } from '../exchange/gateway.js';
import type { IssuerService } from '../issuers/service.js';
import type { LedgerObservation } from '../reconciliation/service.js';
import type { OperationsGuard } from '../reconciliation/guard.js';
import type { WalletService } from '../wallets/service.js';

export type RedemptionState =
  | 'AWAITING_RETURN'
  | 'RETURN_SUBMITTED'
  | 'RETURN_CONFIRMED'
  | 'FULFILLED'
  | 'REJECTED'
  | 'FAILED'
  | 'CANCELLED';

const NEXT: Record<RedemptionState, readonly RedemptionState[]> = {
  AWAITING_RETURN: ['RETURN_SUBMITTED', 'CANCELLED', 'FAILED'],
  RETURN_SUBMITTED: ['RETURN_CONFIRMED', 'FAILED'],
  RETURN_CONFIRMED: ['FULFILLED', 'REJECTED'],
  FULFILLED: [],
  REJECTED: [],
  FAILED: [],
  CANCELLED: [],
};

export interface RedemptionRequest {
  id: string;
  userId: string;
  merchantId: string;
  programId: string;
  asset: { code: string; issuer: string };
  amount: string;
  holder: string;
  state: RedemptionState;
  idempotencyKey: string;
  returnTxHash?: string;
  unsignedXdr?: string;
  returnLedger?: number;
  rejectionReason?: string;
  /** set when the merchant rejects AFTER the credit was returned: an off-chain refund/dispute is owed */
  refundDue?: boolean;
  requestId: string;
  createdAt: string;
  updatedAt: string;
}

export const RedemptionCreateSchema = z
  .object({
    asset: z.object({ code: z.string().regex(/^[A-Za-z0-9]{1,12}$/), issuer: z.string().length(56) }).strict(),
    amount: z.string(),
    holder: z.string().length(56),
  })
  .strict();

export class RedemptionService {
  readonly requests: Repository<RedemptionRequest> = new InMemoryRepository<RedemptionRequest>();
  private readonly lock = new KeyedMutex();

  constructor(
    private readonly deps: {
      clock: Clock;
      audit: AuditLog;
      issuers: IssuerService;
      wallets: WalletService;
      gateway: StellarGateway;
      guard: OperationsGuard;
    },
  ) {}

  /**
   * POST /v1/redemptions. Only credits with an ACTIVE, verified, unexpired issuer program and an
   * amount inside the signed policy limits are redeemable. Everything else is UNAVAILABLE:
   * this service never fakes a cash-out for unsupported credit.
   */
  async create(actor: Actor | undefined, input: unknown, idempotencyKey: string, requestId: string): Promise<RedemptionRequest> {
    const user = requireRole(actor, 'user');
    if (!idempotencyKey || idempotencyKey.length < 8) throw new ApiError('VALIDATION_FAILED', 'Idempotency-Key required');
    return this.lock.run(`create:${user.id}:${idempotencyKey}`, async () => {
      const parsed = RedemptionCreateSchema.safeParse(input);
      if (!parsed.success) throw new ApiError('VALIDATION_FAILED', 'invalid redemption request');
      const req = parsed.data;
      const existing = (await this.requests.find((r) => r.userId === user.id && r.idempotencyKey === idempotencyKey))[0];
      if (existing) {
        if (existing.asset.code !== req.asset.code || existing.asset.issuer !== req.asset.issuer || existing.amount !== req.amount) {
          throw new ApiError('IDEMPOTENCY_CONFLICT', 'Idempotency-Key was already used with a different request');
        }
        return existing;
      }
      this.deps.guard.assertNotPaused();
      const units = parseAmount(req.amount);
      const elig = await this.deps.issuers.eligibility(req.asset);
      if (!elig.eligible || elig.kind !== 'CREDIT' || !elig.program) {
        throw new ApiError('REDEMPTION_UNAVAILABLE', 'this credit has no active verified issuer redemption program', elig.reasons);
      }
      const lim = elig.program.policy.redemptionLimits;
      if (lim.minUnits !== undefined && units < parseAmount(lim.minUnits, { allowZero: true })) {
        throw new ApiError('REDEMPTION_UNAVAILABLE', 'amount is below the issuer minimum redemption');
      }
      if (lim.maxUnitsPerRequest !== undefined && units > parseAmount(lim.maxUnitsPerRequest, { allowZero: true })) {
        throw new ApiError('REDEMPTION_UNAVAILABLE', 'amount exceeds the issuer maximum per redemption');
      }
      await this.deps.wallets.requireBound(user.id, req.holder);
      const now = this.deps.clock.now().toISOString();
      const id = newId('red');
      let built;
      try {
        built = await this.deps.gateway.buildRedemptionReturn({ asset: req.asset, holder: req.holder, amount: req.amount, idempotencyKey: id });
      } catch (e) {
        throw mapGatewayError(e);
      }
      const r: RedemptionRequest = {
        id,
        userId: user.id,
        merchantId: elig.program.merchantId,
        programId: elig.program.id,
        asset: req.asset,
        amount: req.amount,
        holder: req.holder,
        state: 'AWAITING_RETURN',
        idempotencyKey,
        returnTxHash: built.hash,
        unsignedXdr: built.xdr,
        requestId,
        createdAt: now,
        updatedAt: now,
      };
      await this.requests.put(r);
      await this.deps.audit.record(user, 'redemption', 'REDEMPTION_REQUESTED', r.id, requestId, { merchantId: r.merchantId });
      return r;
    });
  }

  /** Extra endpoint: submit the user-signed return (burn) payment. Idempotent per signed tx. */
  async submitReturn(actor: Actor | undefined, id: string, signedXdr: string, requestId: string): Promise<RedemptionRequest> {
    const user = requireRole(actor, 'user');
    return this.lock.run(`red:${id}`, async () => {
      let r = await this.getFor(user, id);
      if (r.state !== 'AWAITING_RETURN') return r; // replay of an already-submitted return
      this.deps.guard.assertNotPaused();
      r = await this.move(r, 'RETURN_SUBMITTED', user, requestId);
      try {
        const o = await this.deps.gateway.submit({ signedXdr, expectedHash: r.returnTxHash ?? '' });
        if (o.state === 'CONFIRMED') {
          r.returnLedger = o.ledger;
          r = await this.move(r, 'RETURN_CONFIRMED', user, requestId);
        } else if (o.state === 'FAILED') {
          r = await this.move(r, 'FAILED', user, requestId);
        } // RECONCILING: stay RETURN_SUBMITTED until the ledger verdict arrives
      } catch {
        // outcome unknown: stay RETURN_SUBMITTED; reconciliation event decides
      }
      return r;
    });
  }

  async get(actor: Actor | undefined, id: string): Promise<RedemptionRequest> {
    const a = requireRole(actor, 'user', 'merchant', 'admin');
    return this.getFor(a, id);
  }

  async listForMerchant(actor: Actor | undefined): Promise<RedemptionRequest[]> {
    const m = requireRole(actor, 'merchant');
    return this.requests.find((r) => r.merchantId === m.merchantId);
  }

  /** POST /v1/merchants/me/redemptions/:id/confirm - only after the on-chain return is CONFIRMED. */
  async merchantConfirm(actor: Actor | undefined, id: string, requestId: string): Promise<RedemptionRequest> {
    const m = requireRole(actor, 'merchant');
    return this.lock.run(`red:${id}`, async () => {
      const r = await this.getFor(m, id);
      this.deps.guard.assertNotPaused();
      if (r.state === 'FULFILLED') return r; // idempotent
      if (r.state !== 'RETURN_CONFIRMED') throw new ApiError('INVALID_STATE', `cannot confirm a redemption in ${r.state}; the returned credit must be confirmed on the ledger first`);
      return this.move(r, 'FULFILLED', m, requestId);
    });
  }

  async merchantReject(actor: Actor | undefined, id: string, reason: string, requestId: string): Promise<RedemptionRequest> {
    const m = requireRole(actor, 'merchant');
    if (!reason || reason.length < 3) throw new ApiError('VALIDATION_FAILED', 'a rejection reason is required');
    return this.lock.run(`red:${id}`, async () => {
      const r = await this.getFor(m, id);
      if (r.state !== 'RETURN_CONFIRMED') throw new ApiError('INVALID_STATE', `cannot reject a redemption in ${r.state}`);
      r.rejectionReason = reason;
      r.refundDue = true;
      return this.move(r, 'REJECTED', m, requestId);
    });
  }

  async onObservation(obs: LedgerObservation, requestId: string): Promise<'NOT_MINE' | 'APPLIED' | 'IGNORED' | 'DISCREPANCY'> {
    const found = (await this.requests.find((r) => r.returnTxHash === obs.txHash))[0];
    if (!found) return 'NOT_MINE';
    return this.lock.run(`red:${found.id}`, async () => {
      const r = (await this.requests.get(found.id))!;
      const system = { id: 'system', role: 'admin' } as const;
      if (obs.status === 'RECONCILING') return 'IGNORED';
      if (r.state === 'RETURN_SUBMITTED' || r.state === 'AWAITING_RETURN') {
        if (r.state === 'AWAITING_RETURN') await this.move(r, 'RETURN_SUBMITTED', system, requestId); // user submitted out-of-band
        const cur = (await this.requests.get(r.id))!;
        if (obs.status === 'CONFIRMED') {
          if (obs.ledger !== undefined) cur.returnLedger = obs.ledger;
          await this.move(cur, 'RETURN_CONFIRMED', system, requestId);
        } else {
          await this.move(cur, 'FAILED', system, requestId);
        }
        return 'APPLIED';
      }
      const confirmedLocally = r.state === 'RETURN_CONFIRMED' || r.state === 'FULFILLED' || r.state === 'REJECTED';
      if ((obs.status === 'CONFIRMED') === confirmedLocally) return 'IGNORED';
      await this.deps.audit.record(system, 'redemption', 'DISCREPANCY', r.id, requestId, { local: r.state, ledger: obs.status });
      return 'DISCREPANCY';
    });
  }

  private async getFor(a: Actor, id: string): Promise<RedemptionRequest> {
    const r = await this.requests.get(id);
    const visible =
      r && (a.role === 'admin' || (a.role === 'user' && r.userId === a.id) || (a.role === 'merchant' && r.merchantId === a.merchantId));
    if (!r || !visible) throw new ApiError('NOT_FOUND', 'redemption not found');
    return r;
  }

  private async move(r: RedemptionRequest, to: RedemptionState, actor: Pick<Actor, 'id' | 'role'>, requestId: string): Promise<RedemptionRequest> {
    if (!NEXT[r.state].includes(to)) throw new ApiError('INVALID_STATE', `illegal transition ${r.state} -> ${to}`);
    const from = r.state;
    r.state = to;
    r.updatedAt = this.deps.clock.now().toISOString();
    await this.requests.put(r);
    await this.deps.audit.record(actor, 'redemption', `REDEMPTION_${to}`, r.id, requestId, { from });
    return r;
  }
}
