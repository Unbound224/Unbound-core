import { requireRole, type Actor } from '../../common/auth.js';
import { ApiError } from '../../common/errors.js';
import type { Clock } from '../../common/ids.js';
import { parseAmount } from '../../common/money.js';
import { mapGatewayError, type StellarGateway } from '../exchange/gateway.js';
import type { IssuerService } from '../issuers/service.js';
import type { WalletService } from '../wallets/service.js';

export type HoldingStatus = 'REDEEMABLE' | 'SUPPORTED_ASSET' | 'UNVERIFIED' | 'SUSPENDED' | 'EXPIRED' | 'FROZEN';

export interface PortfolioHolding {
  wallet: string;
  asset: { code: string; issuer: string };
  balance: string;
  status: HoldingStatus;
  /** present only for REDEEMABLE/EXPIRED/SUSPENDED credits with a known program */
  program?: { id: string; unitOfAccount: string; expiresAt: string; jurisdiction: string; contact: string };
}

export interface Portfolio {
  asOf: string;
  wallets: string[];
  holdings: PortfolioHolding[];
  /** native balances are reported for fees only and carry no credit value */
  native: { wallet: string; balance: string }[];
  notice: string;
}

export class PortfolioService {
  constructor(
    private readonly deps: { clock: Clock; issuers: IssuerService; wallets: WalletService; gateway: StellarGateway },
  ) {}

  /** GET /v1/portfolio. The ledger is the source of balances; the database only classifies them. */
  async get(actor: Actor | undefined): Promise<Portfolio> {
    const user = requireRole(actor, 'user');
    const bindings = await this.deps.wallets.bindings.find((b) => b.userId === user.id);
    const holdings: PortfolioHolding[] = [];
    const native: Portfolio['native'] = [];
    for (const b of bindings) {
      let lines;
      try {
        lines = await this.deps.gateway.balances(b.publicKey);
      } catch (e) {
        throw mapGatewayError(e) instanceof ApiError ? new ApiError('GATEWAY_REJECTED', 'balances are temporarily unavailable') : e;
      }
      for (const l of lines) {
        if (l.asset.issuer === null) {
          native.push({ wallet: b.publicKey, balance: l.balance });
          continue;
        }
        if (parseAmount(l.balance, { allowZero: true }) === 0n) continue;
        const asset = { code: l.asset.code, issuer: l.asset.issuer };
        const e = await this.deps.issuers.eligibility(asset);
        let status: HoldingStatus;
        if (e.kind === undefined) status = 'UNVERIFIED';
        else if (e.kind === 'SUPPORTED_TARGET') status = 'SUPPORTED_ASSET';
        else if (e.reasons.includes('PROGRAM_SUSPENDED') || e.reasons.includes('MERCHANT_NOT_VERIFIED')) status = 'SUSPENDED';
        else if (e.reasons.includes('POLICY_EXPIRED')) status = 'EXPIRED';
        else if (!l.isAuthorized) status = 'FROZEN';
        else status = 'REDEEMABLE';
        const p = e.program;
        holdings.push({
          wallet: b.publicKey,
          asset,
          balance: l.balance,
          status,
          ...(p && e.kind === 'CREDIT'
            ? { program: { id: p.id, unitOfAccount: p.policy.unitOfAccount, expiresAt: p.policy.expiresAt, jurisdiction: p.policy.jurisdiction, contact: p.policy.contact } }
            : {}),
        });
      }
    }
    return {
      asOf: this.deps.clock.now().toISOString(),
      wallets: bindings.map((b) => b.publicKey),
      holdings,
      native,
      notice: 'Only REDEEMABLE credit can be exchanged or redeemed. No value is implied for any other status.',
    };
  }
}
