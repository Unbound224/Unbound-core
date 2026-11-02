/**
 * FakeStellarGateway - a TEST ADAPTER for the StellarGateway port. It does NOT talk to Stellar and
 * produces NO real transactions: "XDR" is an opaque placeholder string and hashes are deterministic
 * digests. It exists to drive unbound-core's state machine and failure paths. Real Stellar
 * semantics live and are tested in unbound-stellar; cross-repo E2E is future work.
 */
import { createHash } from 'node:crypto';
import { formatAmount, parseAmount } from '../common/money.js';
import {
  GatewayError,
  type GatewayOutcome,
  type GatewayQuote,
  type QuoteInput,
  type StellarGateway,
  type UnsignedSettlement,
} from '../modules/exchange/gateway.js';

export const TESTNET_PASSPHRASE = 'Test SDF Network ; September 2015';

export type SubmitMode = 'confirm' | 'reject-min-output' | 'timeout-after-apply' | 'timeout-before-apply' | 'wrong-hash';

export class FakeStellarGateway implements StellarGateway {
  /** units of target per 1 unit of source, as n/d */
  rate = { n: 9n, d: 10n };
  hasLiquidity = true;
  networkPassphrase = TESTNET_PASSPHRASE;
  network = 'TESTNET' as const;
  submitMode: SubmitMode = 'confirm';
  submitCalls = 0;
  /** hashes the fake "ledger" has applied (lets tests emulate timeout-after-apply) */
  applied = new Set<string>();
  ttlMs = 60_000;
  private n = 0;
  constructor(private readonly now: () => number) {}

  async quote(input: QuoteInput): Promise<GatewayQuote> {
    if (!this.hasLiquidity) throw new GatewayError('NO_ROUTE', 'no route');
    const src = parseAmount(input.sourceAmount);
    const out = (src * this.rate.n) / this.rate.d;
    const min = (out * BigInt(10_000 - input.slippageBps)) / 10_000n;
    if (input.minimumDestinationAmount && out < parseAmount(input.minimumDestinationAmount)) {
      throw new GatewayError('MIN_OUTPUT_VIOLATION', 'below minimum');
    }
    const body = { s: input.sourceAsset, t: input.targetAsset, a: input.sourceAmount, n: ++this.n };
    return {
      schemaVersion: '1.0',
      quoteId: 'q_' + createHash('sha256').update(JSON.stringify(body)).digest('hex').slice(0, 32),
      network: this.network,
      networkPassphrase: this.networkPassphrase,
      sourceAsset: input.sourceAsset,
      targetAsset: input.targetAsset,
      sourceAmount: formatAmount(src),
      expectedDestinationAmount: formatAmount(out),
      minDestinationAmount: formatAmount(min),
      slippageBps: input.slippageBps,
      path: [],
      estimatedFeeStroops: 100,
      routesConsidered: 1,
      issuedAt: new Date(this.now()).toISOString(),
      expiresAt: new Date(this.now() + this.ttlMs).toISOString(),
      warnings: ['FAKE ADAPTER: not a real quote'],
    };
  }

  async buildSettlement(args: { quote: GatewayQuote; sourceAccount: string; destinationAccount: string; idempotencyKey: string }): Promise<UnsignedSettlement> {
    return this.fakeTx(`settle:${args.quote.quoteId}:${args.sourceAccount}:${args.idempotencyKey}`);
  }

  async buildRedemptionReturn(args: { asset: { code: string; issuer: string }; holder: string; amount: string; idempotencyKey: string }): Promise<UnsignedSettlement> {
    return this.fakeTx(`redeem:${args.asset.code}:${args.holder}:${args.amount}:${args.idempotencyKey}`);
  }

  async submit(args: { signedXdr: string; expectedHash: string }): Promise<GatewayOutcome> {
    this.submitCalls++;
    const hash = args.signedXdr.replace(/^SIGNED:FAKE-XDR:/, '');
    if (!args.signedXdr.startsWith('SIGNED:FAKE-XDR:') || hash !== args.expectedHash) {
      return { state: 'FAILED', hash: args.expectedHash, reason: 'BAD_AUTH' };
    }
    switch (this.submitMode) {
      case 'timeout-before-apply':
        throw new Error('timeout');
      case 'timeout-after-apply':
        this.applied.add(hash);
        throw new Error('timeout');
      case 'reject-min-output':
        return { state: 'FAILED', hash, reason: 'MIN_OUTPUT_VIOLATION' };
      case 'wrong-hash':
        return { state: 'CONFIRMED', hash: 'f'.repeat(64), ledger: 1 };
      default:
        this.applied.add(hash);
        return { state: 'CONFIRMED', hash, ledger: 1000 + this.applied.size, amountOutActual: '72.0000000' };
    }
  }

  private fakeTx(seed: string): UnsignedSettlement {
    const hash = createHash('sha256').update(seed).digest('hex');
    return { xdr: `FAKE-XDR:${hash}`, hash, networkPassphrase: this.networkPassphrase };
  }
}

export function signFake(unsignedXdr: string): string {
  return `SIGNED:${unsignedXdr}`;
}
