import { z } from 'zod';
import type { AuditLog } from '../../common/audit.js';
import { requireRole, type Actor } from '../../common/auth.js';
import { ApiError } from '../../common/errors.js';
import { newId, type Clock } from '../../common/ids.js';
import { parseAmount } from '../../common/money.js';
import { KeyedMutex, type Repository } from '../../common/repository.js';
import type { Storage } from '../../persistence/storage.js';
import { isEscrowError, mapGatewayError, type EscrowChainStatus, type StellarGateway, type UnsignedEscrowTx } from '../exchange/gateway.js';
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
  /** escrow mode only: the merchant never answered and the credit was refunded after the deadline */
  | 'EXPIRED'
  | 'FAILED'
  | 'CANCELLED';

const NEXT: Record<RedemptionState, readonly RedemptionState[]> = {
  AWAITING_RETURN: ['RETURN_SUBMITTED', 'CANCELLED', 'FAILED'],
  RETURN_SUBMITTED: ['RETURN_CONFIRMED', 'FAILED'],
  RETURN_CONFIRMED: ['FULFILLED', 'REJECTED', 'EXPIRED'],
  FULFILLED: [],
  REJECTED: [],
  EXPIRED: [],
  FAILED: [],
  CANCELLED: [],
};

/**
 * NATIVE: the return is a classic payment to the issuer (burned on arrival); a rejection leaves an
 * off-chain refund obligation. ESCROW: the return goes into the Soroban redemption escrow
 * (unbound-stellar ADR 0002) and is released to the issuer, refunded, or refundable after the deadline.
 */
export type RedemptionMode = 'NATIVE' | 'ESCROW';

/** Escrow-side state as core last observed it. `HELD` = credit locked in the contract. */
export type EscrowState = 'AWAITING_OPEN' | 'HELD' | 'RELEASED' | 'REFUNDED' | 'EXPIRED_REFUNDED';
export type EscrowAction = 'CONFIRM' | 'REJECT' | 'EXPIRE';

export interface EscrowInfo {
  contractId: string;
  /** unix seconds; after this only a refund is possible */
  deadline: number;
  state: EscrowState;
  /** a built-but-unconfirmed release/refund transaction waiting for a signature or the ledger */
  pending?: { action: EscrowAction; hash: string; xdr: string; reason?: string; requestedAt: string };
  closeTxHash?: string;
  closeLedger?: number;
  lastFailure?: string;
}

/** Default merchant answer window for escrowed returns (7 days); the contract allows 1h..30d. */
export const DEFAULT_ESCROW_WINDOW_SECS = 7 * 24 * 3600;

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
  /** set when the merchant rejects AFTER the credit was returned (native mode): an off-chain refund/dispute is owed */
  refundDue?: boolean;
  /** absent on records created before escrow support: NATIVE */
  mode?: RedemptionMode;
  escrow?: EscrowInfo;
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
  readonly requests: Repository<RedemptionRequest>;
  private readonly lock = new KeyedMutex();

  constructor(
    private readonly deps: {
      clock: Clock;
      audit: AuditLog;
      issuers: IssuerService;
      wallets: WalletService;
      gateway: StellarGateway;
      guard: OperationsGuard;
      storage: Storage;
      /** merchant answer window for escrowed returns */
      escrowWindowSecs?: number;
    },
  ) {
    this.requests = deps.storage.repo<RedemptionRequest>('redemption_requests');
  }

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
      await this.deps.guard.assertNotPaused();
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
      const deadline = Math.floor(this.deps.clock.now().getTime() / 1000) + (this.deps.escrowWindowSecs ?? DEFAULT_ESCROW_WINDOW_SECS);
      let built: { xdr: string; hash: string };
      let escrow: EscrowInfo | undefined;
      const escrowGw = this.deps.gateway.escrow;
      const tryEscrow = async (): Promise<UnsignedEscrowTx | undefined> => {
        if (!escrowGw) return undefined;
        try {
          return await escrowGw.open({ asset: req.asset, holder: req.holder, amount: req.amount, redemptionId: id, deadline });
        } catch (e) {
          // ADR 0002: no escrow, an issuer that has not authorized it, or a paused escrow -> native return
          if (isEscrowError(e)) {
            await this.deps.audit.record(user, 'redemption', 'REDEMPTION_ESCROW_FALLBACK', id, requestId, { reason: (e as { code: string }).code });
            return undefined;
          }
          throw mapGatewayError(e);
        }
      };
      const escrowTx = await tryEscrow();
      if (escrowTx) {
        built = escrowTx;
        escrow = { contractId: escrowTx.contractId, deadline, state: 'AWAITING_OPEN' };
      } else {
        try {
          built = await this.deps.gateway.buildRedemptionReturn({ asset: req.asset, holder: req.holder, amount: req.amount, idempotencyKey: id });
        } catch (e) {
          throw mapGatewayError(e);
        }
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
        mode: escrow ? 'ESCROW' : 'NATIVE',
        ...(escrow ? { escrow } : {}),
        requestId,
        createdAt: now,
        updatedAt: now,
      };
      await this.requests.put(r);
      await this.deps.audit.record(user, 'redemption', 'REDEMPTION_REQUESTED', r.id, requestId, { merchantId: r.merchantId, mode: r.mode ?? 'NATIVE' });
      return r;
    });
  }

  /** Extra endpoint: submit the user-signed return (burn) payment. Idempotent per signed tx. */
  async submitReturn(actor: Actor | undefined, id: string, signedXdr: string, requestId: string): Promise<RedemptionRequest> {
    const user = requireRole(actor, 'user');
    return this.lock.run(`red:${id}`, async () => {
      let r = await this.getFor(user, id);
      if (r.state !== 'AWAITING_RETURN') return r; // replay of an already-submitted return
      await this.deps.guard.assertNotPaused();
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

  /**
   * POST /v1/merchants/me/redemptions/:id/confirm - only after the on-chain return is CONFIRMED.
   * NATIVE: marks the redemption FULFILLED. ESCROW: builds the issuer-signed `confirm` invocation
   * (returned as `escrow.pending`); FULFILLED follows once that transaction is confirmed on the ledger.
   */
  async merchantConfirm(actor: Actor | undefined, id: string, requestId: string): Promise<RedemptionRequest> {
    const m = requireRole(actor, 'merchant');
    return this.lock.run(`red:${id}`, async () => {
      const r = await this.getFor(m, id);
      await this.deps.guard.assertNotPaused();
      if (r.state === 'FULFILLED') return r; // idempotent
      if (r.state !== 'RETURN_CONFIRMED') throw new ApiError('INVALID_STATE', `cannot confirm a redemption in ${r.state}; the returned credit must be confirmed on the ledger first`);
      if (r.mode !== 'ESCROW') return this.move(r, 'FULFILLED', m, requestId);
      if (this.nowSec() >= r.escrow!.deadline) throw new ApiError('INVALID_STATE', 'the escrow deadline has passed; only a refund to the holder is possible');
      return this.buildEscrowAction(r, 'CONFIRM', m, requestId);
    });
  }

  /** NATIVE: REJECTED with refundDue. ESCROW: builds the issuer-signed `reject` (on-chain refund). */
  async merchantReject(actor: Actor | undefined, id: string, reason: string, requestId: string): Promise<RedemptionRequest> {
    const m = requireRole(actor, 'merchant');
    if (!reason || reason.length < 3 || reason.length > 500) throw new ApiError('VALIDATION_FAILED', 'a rejection reason (3-500 characters) is required');
    return this.lock.run(`red:${id}`, async () => {
      const r = await this.getFor(m, id);
      if (r.state === 'REJECTED') return r; // idempotent
      if (r.state !== 'RETURN_CONFIRMED') throw new ApiError('INVALID_STATE', `cannot reject a redemption in ${r.state}`);
      if (r.mode !== 'ESCROW') {
        r.rejectionReason = reason;
        r.refundDue = true;
        return this.move(r, 'REJECTED', m, requestId);
      }
      return this.buildEscrowAction(r, 'REJECT', m, requestId, reason);
    });
  }

  /** Holder asks for the timeout refund (escrow mode, after the deadline). Builds `expire_refund` with the holder as source. */
  async claimRefund(actor: Actor | undefined, id: string, requestId: string): Promise<RedemptionRequest> {
    const user = requireRole(actor, 'user');
    return this.lock.run(`red:${id}`, async () => {
      const r = await this.getFor(user, id);
      if (r.state === 'EXPIRED') return r;
      if (r.mode !== 'ESCROW' || r.state !== 'RETURN_CONFIRMED') throw new ApiError('INVALID_STATE', 'only an escrowed return can be refunded after its deadline');
      if (this.nowSec() < r.escrow!.deadline) throw new ApiError('INVALID_STATE', 'the merchant still has time to answer; the refund opens at the deadline');
      return this.buildEscrowAction(r, 'EXPIRE', user, requestId);
    });
  }

  /**
   * Submits the signed escrow transaction built by confirm / reject / claimRefund. The merchant
   * signs CONFIRM and REJECT with the issuer key; the holder signs EXPIRE. Unknown outcomes keep the
   * pending action; the reconciliation event decides.
   */
  async submitEscrowAction(actor: Actor | undefined, id: string, signedXdr: string, requestId: string): Promise<RedemptionRequest> {
    const a = requireRole(actor, 'merchant', 'user');
    return this.lock.run(`red:${id}`, async () => {
      let r = await this.getFor(a, id);
      const p = r.escrow?.pending;
      if (!p) {
        if (r.state === 'FULFILLED' || r.state === 'REJECTED' || r.state === 'EXPIRED') return r; // replay after completion
        throw new ApiError('INVALID_STATE', 'there is no escrow transaction waiting for a signature');
      }
      const mayAct = p.action === 'EXPIRE' ? a.role === 'user' : a.role === 'merchant';
      if (!mayAct) throw new ApiError('FORBIDDEN', p.action === 'EXPIRE' ? 'the holder signs the timeout refund' : 'the issuer signs this escrow action');
      try {
        const o = await this.deps.gateway.submit({ signedXdr, expectedHash: p.hash });
        if (o.state === 'CONFIRMED') r = await this.applyEscrowClose(r, p.action, o.hash, o.ledger, a, requestId);
        else if (o.state === 'FAILED') r = await this.failEscrowAction(r, o.reason, a, requestId);
      } catch {
        // outcome unknown: keep the pending action; reconciliation decides
      }
      return r;
    });
  }

  /**
   * Scheduled job: brings escrowed returns in line with the contract. Picks up closes made outside
   * core (e.g. someone else called expire_refund), flags refunds that became claimable, and records
   * a DISCREPANCY when core and the contract disagree. Returns the ids it changed.
   */
  async reconcileEscrows(requestId: string): Promise<string[]> {
    const gw = this.deps.gateway.escrow;
    if (!gw) return [];
    const system = { id: 'system', role: 'admin' } as const;
    const changed: string[] = [];
    const candidates = await this.requests.find((r) => r.mode === 'ESCROW' && r.state === 'RETURN_CONFIRMED');
    for (const c of candidates) {
      await this.lock.run(`red:${c.id}`, async () => {
        const r = (await this.requests.get(c.id))!;
        if (r.state !== 'RETURN_CONFIRMED') return;
        let chain: EscrowChainStatus | undefined;
        try {
          chain = (await gw.getReturn(r.id)).return?.status;
        } catch {
          return; // transient; next run retries
        }
        if (!chain) {
          await this.deps.audit.record(system, 'redemption', 'DISCREPANCY', r.id, requestId, { local: r.state, ledger: 'ESCROW_MISSING' });
          changed.push(r.id);
          return;
        }
        if (chain === 'OPEN') return;
        const action: EscrowAction = chain === 'CONFIRMED' ? 'CONFIRM' : chain === 'REJECTED' ? 'REJECT' : 'EXPIRE';
        await this.applyEscrowClose(r, action, r.escrow?.pending?.hash, undefined, system, requestId);
        changed.push(r.id);
      });
    }
    return changed;
  }

  async onObservation(obs: LedgerObservation, requestId: string): Promise<'NOT_MINE' | 'APPLIED' | 'IGNORED' | 'DISCREPANCY'> {
    const closing = (await this.requests.find((r) => r.escrow?.pending?.hash === obs.txHash))[0];
    if (closing) return this.onEscrowCloseObservation(closing.id, obs, requestId);
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
      const confirmedLocally = r.state === 'RETURN_CONFIRMED' || r.state === 'FULFILLED' || r.state === 'REJECTED' || r.state === 'EXPIRED';
      if ((obs.status === 'CONFIRMED') === confirmedLocally) return 'IGNORED';
      await this.deps.audit.record(system, 'redemption', 'DISCREPANCY', r.id, requestId, { local: r.state, ledger: obs.status });
      return 'DISCREPANCY';
    });
  }

  private async onEscrowCloseObservation(id: string, obs: LedgerObservation, requestId: string): Promise<'APPLIED' | 'IGNORED'> {
    return this.lock.run(`red:${id}`, async () => {
      const r = (await this.requests.get(id))!;
      const p = r.escrow?.pending;
      if (!p || p.hash !== obs.txHash || obs.status === 'RECONCILING') return 'IGNORED';
      const system = { id: 'system', role: 'admin' } as const;
      if (obs.status === 'CONFIRMED') await this.applyEscrowClose(r, p.action, obs.txHash, obs.ledger, system, requestId);
      else await this.failEscrowAction(r, 'LEDGER_FAILED', system, requestId);
      return 'APPLIED';
    });
  }

  private nowSec(): number {
    return Math.floor(this.deps.clock.now().getTime() / 1000);
  }

  private async buildEscrowAction(r: RedemptionRequest, action: EscrowAction, actor: Actor, requestId: string, reason?: string): Promise<RedemptionRequest> {
    const gw = this.deps.gateway.escrow;
    if (!gw || !r.escrow) throw new ApiError('GATEWAY_REJECTED', 'the redemption escrow is not reachable right now; try again later', 'ESCROW_UNAVAILABLE');
    if (r.escrow.pending) {
      if (r.escrow.pending.action === action) return r; // idempotent: same transaction to sign
      throw new ApiError('INVALID_STATE', `an escrow ${r.escrow.pending.action} is already waiting for the ledger`);
    }
    let tx: UnsignedEscrowTx;
    try {
      tx =
        action === 'CONFIRM'
          ? await gw.confirm({ redemptionId: r.id, issuer: r.asset.issuer })
          : action === 'REJECT'
            ? await gw.reject({ redemptionId: r.id, issuer: r.asset.issuer })
            : await gw.expire({ redemptionId: r.id, source: r.holder });
    } catch (e) {
      throw mapGatewayError(e);
    }
    r.escrow.pending = { action, hash: tx.hash, xdr: tx.xdr, requestedAt: this.deps.clock.now().toISOString(), ...(reason ? { reason } : {}) };
    delete r.escrow.lastFailure;
    r.updatedAt = this.deps.clock.now().toISOString();
    await this.requests.put(r);
    await this.deps.audit.record(actor, 'redemption', `REDEMPTION_ESCROW_${action}_REQUESTED`, r.id, requestId, { hash: tx.hash });
    return r;
  }

  private async applyEscrowClose(
    r: RedemptionRequest,
    action: EscrowAction,
    hash: string | undefined,
    ledger: number | undefined,
    actor: Pick<Actor, 'id' | 'role'>,
    requestId: string,
  ): Promise<RedemptionRequest> {
    const e = r.escrow!;
    const reason = e.pending?.action === 'REJECT' ? e.pending.reason : undefined;
    delete e.pending;
    if (hash) e.closeTxHash = hash;
    if (ledger !== undefined) e.closeLedger = ledger;
    if (action === 'CONFIRM') {
      e.state = 'RELEASED';
      return this.move(r, 'FULFILLED', actor, requestId);
    }
    if (action === 'REJECT') {
      e.state = 'REFUNDED';
      r.rejectionReason = reason ?? 'rejected by the issuer on-chain';
      r.refundDue = false; // refunded on-chain by the escrow; nothing is owed off-chain
      return this.move(r, 'REJECTED', actor, requestId);
    }
    e.state = 'EXPIRED_REFUNDED';
    r.refundDue = false;
    return this.move(r, 'EXPIRED', actor, requestId);
  }

  private async failEscrowAction(r: RedemptionRequest, reason: string, actor: Pick<Actor, 'id' | 'role'>, requestId: string): Promise<RedemptionRequest> {
    const action = r.escrow?.pending?.action;
    if (r.escrow) {
      delete r.escrow.pending;
      r.escrow.lastFailure = reason;
    }
    r.updatedAt = this.deps.clock.now().toISOString();
    await this.requests.put(r);
    await this.deps.audit.record(actor, 'redemption', `REDEMPTION_ESCROW_${action ?? 'ACTION'}_FAILED`, r.id, requestId, { reason });
    return r;
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
    if (to === 'RETURN_CONFIRMED' && r.escrow) r.escrow.state = 'HELD';
    r.updatedAt = this.deps.clock.now().toISOString();
    await this.requests.put(r);
    await this.deps.audit.record(actor, 'redemption', `REDEMPTION_${to}`, r.id, requestId, { from });
    return r;
  }
}
