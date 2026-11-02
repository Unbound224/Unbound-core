import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { AuditLog } from '../../common/audit.js';
import { requireRole, type Actor } from '../../common/auth.js';
import { ApiError } from '../../common/errors.js';
import { newId, type Clock } from '../../common/ids.js';
import { parseAmount } from '../../common/money.js';
import { KeyedMutex, type Repository } from '../../common/repository.js';
import type { Storage } from '../../persistence/storage.js';
import type { IssuerService } from '../issuers/service.js';
import type { OperationsGuard } from '../reconciliation/guard.js';
import type { LedgerObservation } from '../reconciliation/service.js';
import { mapGatewayError, type GatewayOutcome, type GatewayQuote, type StellarGateway } from './gateway.js';
import { assertTransition, type IntentState } from './state.js';
import type { WalletService } from '../wallets/service.js';

export const EXCHANGE_SCHEMA_VERSION = '1.0';

export const QuoteRequestSchema = z
  .object({
    schemaVersion: z.literal(EXCHANGE_SCHEMA_VERSION),
    requestId: z.string().min(1).max(100).optional(),
    sourceAsset: z.object({ code: z.string().regex(/^[A-Za-z0-9]{1,12}$/), issuer: z.string().min(56).max(56) }).strict(),
    targetAsset: z.object({ code: z.string().regex(/^[A-Za-z0-9]{1,12}$/), issuer: z.string().min(56).max(56) }).strict(),
    sourceAmount: z.string(),
    minimumDestinationAmount: z.string().optional(),
    slippageBps: z.number().int().min(0).max(1000),
    destinationAccount: z.string().min(56).max(56),
    network: z.literal('TESTNET'),
  })
  .strict();

export interface StoredQuote {
  id: string; // == gateway quoteId
  userId: string;
  sourceAccount: string;
  destinationAccount: string;
  quote: GatewayQuote;
  createdAt: string;
}

export interface ExchangeIntent {
  id: string;
  schemaVersion: typeof EXCHANGE_SCHEMA_VERSION;
  userId: string;
  quoteId: string;
  sourceAccount: string;
  destinationAccount: string;
  state: IntentState;
  /** client key for POST /intents; same key + same body returns this very intent */
  idempotencyKey: string;
  requestFingerprint: string;
  submitKey?: string;
  txHash?: string;
  unsignedXdr?: string;
  failureReason?: string;
  ledger?: number;
  amountOutActual?: string;
  requestId: string;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export class ExchangeService {
  readonly quotes: Repository<StoredQuote>;
  readonly intents: Repository<ExchangeIntent>;
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
    },
  ) {
    this.quotes = deps.storage.repo<StoredQuote>('exchange_quotes');
    this.intents = deps.storage.repo<ExchangeIntent>('exchange_intents');
  }

  /** POST /v1/exchange/quote */
  async quote(actor: Actor | undefined, input: unknown, requestId: string): Promise<StoredQuote> {
    const user = requireRole(actor, 'user');
    await this.deps.guard.assertNotPaused();
    const parsed = QuoteRequestSchema.safeParse(input);
    if (!parsed.success) throw new ApiError('VALIDATION_FAILED', 'invalid quote request', parsed.error.issues.map((i) => i.path.join('.')));
    const req = parsed.data;
    parseAmount(req.sourceAmount);
    // Server-side authorization BEFORE any signature request: both assets must be eligible now.
    await this.deps.issuers.assertEligible(req.sourceAsset);
    await this.deps.issuers.assertEligible(req.targetAsset);
    const sourceAccount = await this.deps.wallets.requireBound(user.id, req.destinationAccount);
    let quote: GatewayQuote;
    try {
      quote = await this.deps.gateway.quote({
        sourceAsset: req.sourceAsset,
        targetAsset: req.targetAsset,
        sourceAmount: req.sourceAmount,
        slippageBps: req.slippageBps,
        ...(req.minimumDestinationAmount !== undefined ? { minimumDestinationAmount: req.minimumDestinationAmount } : {}),
      });
    } catch (e) {
      throw mapGatewayError(e);
    }
    if (quote.network !== 'TESTNET') throw new ApiError('UNKNOWN_NETWORK', 'quote is not for TESTNET');
    const stored: StoredQuote = {
      id: quote.quoteId,
      userId: user.id,
      sourceAccount,
      destinationAccount: req.destinationAccount,
      quote,
      createdAt: this.deps.clock.now().toISOString(),
    };
    await this.quotes.put(stored);
    await this.deps.audit.record(user, 'exchange', 'QUOTE_ISSUED', stored.id, requestId);
    return stored;
  }

  /**
   * POST /v1/exchange/intents. Exactly one business intent per (user, idempotencyKey). A reused key
   * with a different body is a conflict, never a silent second intent.
   */
  async createIntent(actor: Actor | undefined, input: { quoteId: string; idempotencyKey: string }, requestId: string): Promise<ExchangeIntent> {
    const user = requireRole(actor, 'user');
    if (!input.idempotencyKey || input.idempotencyKey.length < 8 || input.idempotencyKey.length > 128) {
      throw new ApiError('VALIDATION_FAILED', 'Idempotency-Key must be 8-128 characters');
    }
    const lockKey = `create:${user.id}:${input.idempotencyKey}`;
    return this.lock.run(lockKey, async () => {
      const fingerprint = createHash('sha256').update(JSON.stringify({ quoteId: input.quoteId })).digest('hex');
      const existing = (await this.intents.find((i) => i.userId === user.id && i.idempotencyKey === input.idempotencyKey))[0];
      if (existing) {
        if (existing.requestFingerprint !== fingerprint) {
          throw new ApiError('IDEMPOTENCY_CONFLICT', 'Idempotency-Key was already used with a different request');
        }
        return existing;
      }
      await this.deps.guard.assertNotPaused();
      const sq = await this.quotes.get(input.quoteId);
      if (!sq || sq.userId !== user.id) throw new ApiError('NOT_FOUND', 'quote not found');
      const now = this.deps.clock.now().toISOString();
      let intent: ExchangeIntent = {
        id: newId('int'),
        schemaVersion: EXCHANGE_SCHEMA_VERSION,
        userId: user.id,
        quoteId: sq.id,
        sourceAccount: sq.sourceAccount,
        destinationAccount: sq.destinationAccount,
        state: 'DRAFT',
        idempotencyKey: input.idempotencyKey,
        requestFingerprint: fingerprint,
        requestId,
        version: 1,
        createdAt: now,
        updatedAt: now,
      };
      await this.intents.put(intent);
      await this.deps.audit.record(user, 'exchange', 'INTENT_CREATED', intent.id, requestId);

      // DRAFT -> VERIFIED: re-run every server-side check; failure parks the intent in FAILED with a reason.
      try {
        this.assertQuoteFresh(sq.quote);
        await this.deps.issuers.assertEligible(sq.quote.sourceAsset as { code: string; issuer: string });
        await this.deps.issuers.assertEligible(sq.quote.targetAsset as { code: string; issuer: string });
        intent = await this.move(intent, 'VERIFIED', user, requestId);
        const built = await this.deps.gateway.buildSettlement({
          quote: sq.quote,
          sourceAccount: sq.sourceAccount,
          destinationAccount: sq.destinationAccount,
          idempotencyKey: intent.id,
        });
        intent.txHash = built.hash;
        intent.unsignedXdr = built.xdr;
        intent = await this.move(intent, 'AWAITING_SIGNATURE', user, requestId);
      } catch (e) {
        const err = mapGatewayError(e);
        if (intent.state === 'DRAFT' || intent.state === 'VERIFIED') {
          intent.failureReason = err.code;
          await this.move(intent, 'FAILED', user, requestId);
        }
        throw err;
      }
      return intent;
    });
  }

  async getIntent(actor: Actor | undefined, id: string): Promise<ExchangeIntent> {
    const a = requireRole(actor, 'user', 'admin');
    const i = await this.intents.get(id);
    if (!i || (a.role === 'user' && i.userId !== a.id)) throw new ApiError('NOT_FOUND', 'intent not found');
    return i;
  }

  /**
   * POST /v1/exchange/intents/:id/submit. SUBMITTED is persisted BEFORE the network call
   * (write-ahead), so a crash leaves a resumable state; an unknown outcome becomes RECONCILING,
   * never FAILED, and is never retried with changed parameters.
   */
  async submit(actor: Actor | undefined, id: string, input: { signedXdr: string; submitKey: string }, requestId: string): Promise<ExchangeIntent> {
    const user = requireRole(actor, 'user');
    if (!input.signedXdr || input.signedXdr.length > 20_000) throw new ApiError('VALIDATION_FAILED', 'signedXdr missing or too large');
    if (!input.submitKey || input.submitKey.length < 8) throw new ApiError('VALIDATION_FAILED', 'Idempotency-Key required');
    return this.lock.run(`intent:${id}`, async () => {
      let intent = await this.getIntent(user, id);
      if (intent.submitKey === input.submitKey) return intent; // idempotent replay: no second submission
      if (intent.state !== 'AWAITING_SIGNATURE') throw new ApiError('INVALID_STATE', `intent is ${intent.state}; it cannot be submitted`);
      await this.deps.guard.assertNotPaused();
      const sq = await this.quotes.get(intent.quoteId);
      if (!sq) throw new ApiError('INTERNAL', 'quote missing');
      // Stale quote / revoked issuer => nothing has been spent; require a fresh approval.
      try {
        this.assertQuoteFresh(sq.quote);
        await this.deps.issuers.assertEligible(sq.quote.sourceAsset as { code: string; issuer: string });
        await this.deps.issuers.assertEligible(sq.quote.targetAsset as { code: string; issuer: string });
      } catch (e) {
        const err = mapGatewayError(e);
        intent.failureReason = err.code;
        await this.move(intent, 'FAILED', user, requestId);
        throw err;
      }
      intent.submitKey = input.submitKey;
      intent = await this.move(intent, 'SUBMITTED', user, requestId);
      let outcome: GatewayOutcome;
      try {
        outcome = await this.deps.gateway.submit({ signedXdr: input.signedXdr, expectedHash: intent.txHash ?? '' });
      } catch {
        outcome = { state: 'RECONCILING', hash: intent.txHash ?? '', detail: 'submit outcome unknown' };
      }
      return this.applyOutcome(intent, outcome, { id: 'system', role: 'admin' }, requestId);
    });
  }

  async cancel(actor: Actor | undefined, id: string, requestId: string): Promise<ExchangeIntent> {
    const user = requireRole(actor, 'user');
    return this.lock.run(`intent:${id}`, async () => {
      const intent = await this.getIntent(user, id);
      return this.move(intent, 'CANCELLED', user, requestId);
    });
  }

  /** Crash recovery: anything left SUBMITTED longer than `olderThanMs` becomes RECONCILING for the indexer to resolve. */
  async recoverStuck(olderThanMs: number, requestId: string): Promise<string[]> {
    const cutoff = this.deps.clock.now().getTime() - olderThanMs;
    const moved: string[] = [];
    for (const i of await this.intents.find((x) => x.state === 'SUBMITTED' && Date.parse(x.updatedAt) <= cutoff)) {
      await this.lock.run(`intent:${i.id}`, async () => {
        const fresh = (await this.intents.get(i.id))!;
        if (fresh.state === 'SUBMITTED') {
          await this.move(fresh, 'RECONCILING', { id: 'system', role: 'admin' }, requestId);
          moved.push(fresh.id);
        }
      });
    }
    return moved;
  }

  /** Called by ReconciliationService. Returns what happened so discrepancies can be escalated. */
  async onObservation(obs: LedgerObservation, requestId: string): Promise<'NOT_MINE' | 'APPLIED' | 'IGNORED' | 'DISCREPANCY'> {
    const mine = (await this.intents.find((i) => i.txHash === obs.txHash))[0];
    if (!mine) return 'NOT_MINE';
    return this.lock.run(`intent:${mine.id}`, async () => {
      const intent = (await this.intents.get(mine.id))!;
      const system = { id: 'system', role: 'admin' } as const;
      if (obs.status === 'RECONCILING') return 'IGNORED';
      if (intent.state === 'SUBMITTED' || intent.state === 'RECONCILING') {
        await this.applyOutcome(
          intent,
          obs.status === 'CONFIRMED'
            ? { state: 'CONFIRMED', hash: obs.txHash, ledger: obs.ledger ?? 0, ...(obs.amountOutActual ? { amountOutActual: obs.amountOutActual } : {}) }
            : { state: 'FAILED', hash: obs.txHash, reason: 'LEDGER_FAILED' },
          system,
          requestId,
        );
        return 'APPLIED';
      }
      const agrees = (obs.status === 'CONFIRMED') === (intent.state === 'CONFIRMED');
      if (agrees) return 'IGNORED'; // duplicate/late confirmation of what we already know
      // Ledger and database disagree (e.g. we recorded FAILED/CANCELLED but the ledger shows CONFIRMED).
      await this.deps.audit.record(system, 'exchange', 'DISCREPANCY', intent.id, requestId, { local: intent.state, ledger: obs.status });
      return 'DISCREPANCY';
    });
  }

  private assertQuoteFresh(q: GatewayQuote): void {
    if (this.deps.clock.now().getTime() >= Date.parse(q.expiresAt)) {
      throw new ApiError('QUOTE_EXPIRED', 'quote expired; request a new quote and approve again');
    }
  }

  private async applyOutcome(intent: ExchangeIntent, o: GatewayOutcome, actor: Pick<Actor, 'id' | 'role'>, requestId: string): Promise<ExchangeIntent> {
    if (o.hash && intent.txHash && o.hash !== intent.txHash) {
      // never trust an outcome for a different transaction
      await this.deps.audit.record(actor, 'exchange', 'OUTCOME_HASH_MISMATCH', intent.id, requestId);
      return this.move(intent, 'RECONCILING', actor, requestId);
    }
    if (o.state === 'CONFIRMED') {
      intent.ledger = o.ledger;
      if (o.amountOutActual) intent.amountOutActual = o.amountOutActual;
      return this.move(intent, 'CONFIRMED', actor, requestId);
    }
    if (o.state === 'FAILED') {
      intent.failureReason = o.reason;
      return this.move(intent, 'FAILED', actor, requestId);
    }
    if (intent.state === 'RECONCILING') return intent;
    return this.move(intent, 'RECONCILING', actor, requestId);
  }

  private async move(intent: ExchangeIntent, to: IntentState, actor: Pick<Actor, 'id' | 'role'>, requestId: string): Promise<ExchangeIntent> {
    assertTransition(intent.state, to);
    const from = intent.state;
    intent.state = to;
    intent.version += 1;
    intent.updatedAt = this.deps.clock.now().toISOString();
    await this.intents.put(intent);
    await this.deps.audit.record(actor, 'exchange', `INTENT_${to}`, intent.id, requestId, {
      from,
      ...(intent.failureReason ? { reason: intent.failureReason } : {}),
    });
    return intent;
  }
}
