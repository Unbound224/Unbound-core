import { z } from 'zod';
import {
  GatewayError,
  type RedemptionEscrowGateway,
  type GatewayBalance,
  type GatewayOutcome,
  type GatewayQuote,
  type QuoteInput,
  type StellarGateway,
  type UnsignedSettlement,
} from '../modules/exchange/gateway.js';

/**
 * StellarGateway backed by the unbound-stellar gateway service (HTTP, Horizon behind it).
 * Core never builds or parses Stellar transactions; it only forwards and validates responses.
 * Contract: fixtures/gateway/*.json (copied/compared with unbound-stellar's fixtures).
 * NOT yet exercised against a running unbound-stellar service or live Testnet.
 */
const Asset = z.object({ code: z.string(), issuer: z.string().nullable() }).strict();
const Amount7 = z.string().regex(/^\d+\.\d{7}$/);

export const QuoteSchema = z
  .object({
    schemaVersion: z.literal('1.0'),
    quoteId: z.string(),
    network: z.literal('TESTNET'),
    networkPassphrase: z.string(),
    sourceAsset: Asset,
    targetAsset: Asset,
    sourceAmount: Amount7,
    expectedDestinationAmount: Amount7,
    minDestinationAmount: Amount7,
    slippageBps: z.number().int(),
    path: z.array(Asset),
    estimatedFeeStroops: z.number().int(),
    routesConsidered: z.number().int(),
    issuedAt: z.string(),
    expiresAt: z.string(),
    warnings: z.array(z.string()),
  })
  .strict();

const Unsigned = z.object({ xdr: z.string().min(1), hash: z.string().regex(/^[0-9a-f]{64}$/), networkPassphrase: z.string() }).strict();

const Outcome = z.discriminatedUnion('state', [
  z.object({ state: z.literal('CONFIRMED'), hash: z.string().regex(/^[0-9a-f]{64}$/), ledger: z.number().int(), amountOutActual: Amount7.optional() }).strict(),
  z.object({ state: z.literal('FAILED'), hash: z.string().regex(/^[0-9a-f]{64}$/), reason: z.string() }).strict(),
  z.object({ state: z.literal('RECONCILING'), hash: z.string().regex(/^[0-9a-f]{64}$/), detail: z.string().optional() }).strict(),
]);

const EscrowTx = z
  .object({
    xdr: z.string().min(1),
    hash: z.string().regex(/^[0-9a-f]{64}$/),
    networkPassphrase: z.string(),
    contractId: z.string().regex(/^C[A-Z2-7]{55}$/),
    fn: z.enum(['open_return', 'confirm', 'reject', 'expire_refund']),
    redemptionKeyHex: z.string().regex(/^[0-9a-f]{64}$/),
  })
  .strict();
const EscrowReturn = z
  .object({
    contractId: z.string().regex(/^C[A-Z2-7]{55}$/),
    return: z
      .object({
        consumer: z.string(),
        issuer: z.string(),
        token: z.string(),
        amount: Amount7,
        deadline: z.number().int(),
        openedAt: z.number().int(),
        status: z.enum(['OPEN', 'CONFIRMED', 'REJECTED', 'EXPIRED']),
        closedAt: z.number().int().nullable(),
      })
      .strict()
      .nullable(),
  })
  .strict();
const Balances = z.object({ balances: z.array(z.object({ asset: Asset, balance: Amount7, isAuthorized: z.boolean() }).strict()) }).strict();
const ErrorBody = z.object({ error: z.object({ code: z.string(), message: z.string() }) });

export class HttpStellarGateway implements StellarGateway {
  /** Present only when the deployment opted in (STELLAR_ESCROW_ENABLED); the service may still answer ESCROW_UNAVAILABLE. */
  readonly escrow?: RedemptionEscrowGateway;

  constructor(
    private readonly opts: { baseUrl: string; token: string; fetchImpl?: typeof fetch; timeoutMs?: number; escrow?: boolean },
  ) {
    if (opts.escrow) {
      const enc = encodeURIComponent;
      this.escrow = {
        open: (a) => this.call('POST', '/gateway/v1/escrow/open', EscrowTx, a),
        confirm: (a) => this.call('POST', '/gateway/v1/escrow/confirm', EscrowTx, a),
        reject: (a) => this.call('POST', '/gateway/v1/escrow/reject', EscrowTx, a),
        expire: (a) => this.call('POST', '/gateway/v1/escrow/expire', EscrowTx, a),
        getReturn: (id) => this.call('GET', `/gateway/v1/escrow/returns/${enc(id)}`, EscrowReturn),
      };
    }
  }

  quote(input: QuoteInput): Promise<GatewayQuote> {
    return this.call('POST', '/gateway/v1/quote', QuoteSchema, input) as Promise<GatewayQuote>;
  }

  buildSettlement(args: { quote: GatewayQuote; sourceAccount: string; destinationAccount: string; idempotencyKey: string }): Promise<UnsignedSettlement> {
    return this.call('POST', '/gateway/v1/settlement', Unsigned, args);
  }

  buildRedemptionReturn(args: { asset: { code: string; issuer: string }; holder: string; amount: string; idempotencyKey: string }): Promise<UnsignedSettlement> {
    return this.call('POST', '/gateway/v1/redemption-return', Unsigned, args);
  }

  /** Any transport problem throws; the caller then records RECONCILING (never FAILED). */
  async submit(args: { signedXdr: string; expectedHash: string }): Promise<GatewayOutcome> {
    return (await this.call('POST', '/gateway/v1/submit', Outcome, args)) as GatewayOutcome;
  }

  async balances(account: string): Promise<GatewayBalance[]> {
    const r = await this.call('GET', `/gateway/v1/accounts/${encodeURIComponent(account)}/balances`, Balances);
    return r.balances;
  }

  /** Core is the authority on which issuers are trusted; push the current list to the stellar service. */
  async syncTrustedAssets(assets: { code: string; issuer: string }[]): Promise<void> {
    await this.call('PUT', '/gateway/v1/trusted-assets', z.object({ count: z.number().int() }).strict(), { assets });
  }

  private async call<T>(method: string, path: string, schema: z.ZodType<T>, body?: unknown): Promise<T> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.opts.timeoutMs ?? 15_000);
    try {
      const res = await (this.opts.fetchImpl ?? fetch)(this.opts.baseUrl.replace(/\/$/, '') + path, {
        method,
        signal: ctrl.signal,
        headers: { authorization: `Bearer ${this.opts.token}`, accept: 'application/json', ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
      const json: unknown = await res.json().catch(() => {
        throw new Error('gateway returned non-JSON');
      });
      if (res.status === 422 || res.status === 400) {
        const e = ErrorBody.safeParse(json);
        if (e.success) throw new GatewayError(e.data.error.code, e.data.error.message);
        throw new Error('gateway returned a malformed rejection');
      }
      if (!res.ok) throw new Error(`gateway HTTP ${res.status}`);
      const parsed = schema.safeParse(json);
      if (!parsed.success) throw new Error('gateway response violates the contract');
      return parsed.data;
    } finally {
      clearTimeout(timer);
    }
  }
}
