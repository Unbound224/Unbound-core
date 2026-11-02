import { ApiError } from '../../common/errors.js';

/**
 * Port to unbound-stellar. unbound-core NEVER builds or parses Stellar transactions; it asks the
 * gateway. The shape mirrors unbound-stellar's Quote (schema 1.0) and settlement outcome.
 */
export interface GatewayAsset {
  code: string;
  issuer: string | null;
}

export interface GatewayQuote {
  schemaVersion: '1.0';
  quoteId: string;
  network: 'TESTNET';
  networkPassphrase: string;
  sourceAsset: GatewayAsset;
  targetAsset: GatewayAsset;
  sourceAmount: string;
  expectedDestinationAmount: string;
  minDestinationAmount: string;
  slippageBps: number;
  path: GatewayAsset[];
  estimatedFeeStroops: number;
  routesConsidered: number;
  issuedAt: string;
  expiresAt: string;
  warnings: string[];
}

export interface QuoteInput {
  sourceAsset: GatewayAsset;
  targetAsset: GatewayAsset;
  sourceAmount: string;
  slippageBps: number;
  minimumDestinationAmount?: string;
}

export interface UnsignedSettlement {
  xdr: string;
  /** hex tx hash, known before signing */
  hash: string;
  networkPassphrase: string;
}

export type GatewayOutcome =
  | { state: 'CONFIRMED'; hash: string; ledger: number; amountOutActual?: string }
  | { state: 'FAILED'; hash: string; reason: string }
  | { state: 'RECONCILING'; hash: string; detail?: string };

/** Typed rejection from the gateway (maps unbound-stellar's UnboundStellarError codes). */
export class GatewayError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'GatewayError';
  }
}

export interface GatewayBalance {
  asset: GatewayAsset;
  /** 7-dp decimal string */
  balance: string;
  isAuthorized: boolean;
}

export interface StellarGateway {
  /** Ledger balances for an account; empty list when the account does not exist yet. */
  balances(account: string): Promise<GatewayBalance[]>;
  quote(input: QuoteInput): Promise<GatewayQuote>;
  buildSettlement(args: { quote: GatewayQuote; sourceAccount: string; destinationAccount: string; idempotencyKey: string }): Promise<UnsignedSettlement>;
  /** Unsigned holder->issuer payment returning (burning) credit for a merchant redemption. */
  buildRedemptionReturn(args: { asset: { code: string; issuer: string }; holder: string; amount: string; idempotencyKey: string }): Promise<UnsignedSettlement>;
  /** Throws (any error) when the outcome is unknown; core then records RECONCILING. */
  submit(args: { signedXdr: string; expectedHash: string }): Promise<GatewayOutcome>;
}

/** Translate a gateway rejection into the public error taxonomy. */
export function mapGatewayError(e: unknown): ApiError {
  if (e instanceof ApiError) return e;
  if (e instanceof GatewayError) {
    switch (e.code) {
      case 'NO_ROUTE':
        return new ApiError('NO_ROUTE', 'no approved liquidity route exists for this pair and amount');
      case 'QUOTE_EXPIRED':
        return new ApiError('QUOTE_EXPIRED', 'quote expired; request a new quote');
      case 'UNKNOWN_NETWORK':
        return new ApiError('UNKNOWN_NETWORK', 'unrecognized network');
      case 'NO_TRUSTLINE':
      case 'TRUSTLINE_UNAUTHORIZED':
      case 'TRUSTLINE_LIMIT_EXCEEDED':
      case 'INSUFFICIENT_BALANCE':
      case 'MIN_OUTPUT_VIOLATION':
      case 'UNTRUSTED_ISSUER':
      case 'ACCOUNT_MISSING':
      case 'INVALID_AMOUNT':
      case 'INVALID_SLIPPAGE':
        return new ApiError('GATEWAY_REJECTED', e.message, e.code);
      default:
        return new ApiError('GATEWAY_REJECTED', 'the Stellar adapter rejected this request', e.code);
    }
  }
  return new ApiError('INTERNAL', 'unexpected error');
}
