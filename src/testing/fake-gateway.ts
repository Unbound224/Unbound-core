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
  type EscrowReturnView,
  type RedemptionEscrowGateway,
  type UnsignedEscrowTx,
  type GatewayBalance,
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
  balancesByAccount = new Map<string, GatewayBalance[]>();
  balanceError: Error | undefined;
  /** In-memory stand-in for the Soroban escrow; set to undefined to emulate a deployment without one. */
  escrow: FakeEscrow | undefined;

  async balances(account: string): Promise<GatewayBalance[]> {
    if (this.balanceError) throw this.balanceError;
    return this.balancesByAccount.get(account) ?? [];
  }

  constructor(private readonly now: () => number) {
    this.escrow = undefined;
  }

  /** Opt in to the emulated Soroban escrow (off by default, like a deployment without the contract). */
  enableEscrow(): FakeEscrow {
    this.escrow ??= new FakeEscrow(this.now, (seed) => this.fakeTx(seed));
    return this.escrow;
  }

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
        this.escrow?.apply(hash);
        throw new Error('timeout');
      case 'reject-min-output':
        return { state: 'FAILED', hash, reason: 'MIN_OUTPUT_VIOLATION' };
      case 'wrong-hash':
        return { state: 'CONFIRMED', hash: 'f'.repeat(64), ledger: 1 };
      default:
        this.applied.add(hash);
        this.escrow?.apply(hash);
        return { state: 'CONFIRMED', hash, ledger: 1000 + this.applied.size, amountOutActual: '72.0000000' };
    }
  }

  fakeTx(seed: string): UnsignedSettlement {
    const hash = createHash('sha256').update(seed).digest('hex');
    return { xdr: `FAKE-XDR:${hash}`, hash, networkPassphrase: this.networkPassphrase };
  }
}

export function signFake(unsignedXdr: string): string {
  return `SIGNED:${unsignedXdr}`;
}

export const FAKE_ESCROW_CONTRACT = 'CADQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQP5KR';

type Planned = { fn: UnsignedEscrowTx['fn']; redemptionId: string; open?: Omit<EscrowReturnView, 'status' | 'closedAt' | 'openedAt'> };

/**
 * FakeEscrow - TEST ADAPTER emulating the redemption-escrow contract's rules (single-use ids,
 * confirm before the deadline, reject while open, anyone-can-refund after the deadline). A built
 * transaction only takes effect when the fake gateway "confirms" its hash, like the real ledger.
 * The real contract and its tests live in unbound-stellar/contracts/redemption-escrow.
 */
export class FakeEscrow implements RedemptionEscrowGateway {
  unavailable = false;
  readonly returns = new Map<string, EscrowReturnView>();
  private readonly planned = new Map<string, Planned>();

  constructor(
    private readonly now: () => number,
    private readonly tx: (seed: string) => UnsignedSettlement,
  ) {}

  private nowSec(): number {
    return Math.floor(this.now() / 1000);
  }

  private build(p: Planned): UnsignedEscrowTx {
    if (this.unavailable) throw new GatewayError('ESCROW_UNAVAILABLE', 'no escrow configured');
    const t = this.tx(`escrow:${p.fn}:${p.redemptionId}:${this.planned.size}`);
    this.planned.set(t.hash, p);
    return { ...t, contractId: FAKE_ESCROW_CONTRACT, fn: p.fn, redemptionKeyHex: createHash('sha256').update(p.redemptionId).digest('hex') };
  }

  private open_(id: string): EscrowReturnView {
    const r = this.returns.get(id);
    if (!r || r.status !== 'OPEN') throw new GatewayError('ESCROW_REJECTED', 'escrow simulation failed: NotOpen');
    return r;
  }

  async open(a: { asset: { code: string; issuer: string }; holder: string; amount: string; redemptionId: string; deadline: number }): Promise<UnsignedEscrowTx> {
    if (this.returns.has(a.redemptionId)) throw new GatewayError('ESCROW_REJECTED', 'escrow simulation failed: DuplicateRedemption');
    if (a.deadline < this.nowSec() + 3600) throw new GatewayError('ESCROW_INVALID', 'deadline too soon');
    return this.build({ fn: 'open_return', redemptionId: a.redemptionId, open: { consumer: a.holder, issuer: a.asset.issuer, token: FAKE_ESCROW_CONTRACT, amount: a.amount, deadline: a.deadline } });
  }

  async confirm(a: { redemptionId: string; issuer: string }): Promise<UnsignedEscrowTx> {
    const r = this.open_(a.redemptionId);
    if (this.nowSec() >= r.deadline) throw new GatewayError('ESCROW_REJECTED', 'escrow simulation failed: DeadlinePassed');
    return this.build({ fn: 'confirm', redemptionId: a.redemptionId });
  }

  async reject(a: { redemptionId: string; issuer: string }): Promise<UnsignedEscrowTx> {
    this.open_(a.redemptionId);
    return this.build({ fn: 'reject', redemptionId: a.redemptionId });
  }

  async expire(a: { redemptionId: string; source: string }): Promise<UnsignedEscrowTx> {
    const r = this.open_(a.redemptionId);
    if (this.nowSec() < r.deadline) throw new GatewayError('ESCROW_REJECTED', 'escrow simulation failed: DeadlineNotReached');
    return this.build({ fn: 'expire_refund', redemptionId: a.redemptionId });
  }

  async getReturn(redemptionId: string): Promise<{ contractId: string; return: EscrowReturnView | null }> {
    if (this.unavailable) throw new GatewayError('ESCROW_UNAVAILABLE', 'no escrow configured');
    const r = this.returns.get(redemptionId);
    return { contractId: FAKE_ESCROW_CONTRACT, return: r ? { ...r } : null };
  }

  /** Applies a planned invocation when its transaction "lands" (called by FakeStellarGateway.submit). */
  apply(hash: string): void {
    const p = this.planned.get(hash);
    if (!p) return;
    this.planned.delete(hash);
    const t = this.nowSec();
    if (p.fn === 'open_return' && p.open) {
      this.returns.set(p.redemptionId, { ...p.open, openedAt: t, status: 'OPEN', closedAt: null });
      return;
    }
    const r = this.returns.get(p.redemptionId);
    if (!r || r.status !== 'OPEN') return;
    r.status = p.fn === 'confirm' ? 'CONFIRMED' : p.fn === 'reject' ? 'REJECTED' : 'EXPIRED';
    r.closedAt = t;
  }

  /** Emulates someone else (not core) closing the escrow on-chain, e.g. a direct expire_refund. */
  closeOutOfBand(redemptionId: string, status: 'CONFIRMED' | 'REJECTED' | 'EXPIRED'): void {
    const r = this.returns.get(redemptionId);
    if (r) {
      r.status = status;
      r.closedAt = this.nowSec();
    }
  }
}
