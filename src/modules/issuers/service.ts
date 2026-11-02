import { z } from 'zod';
import { requireRole, type Actor } from '../../common/auth.js';
import type { AuditLog } from '../../common/audit.js';
import { ApiError } from '../../common/errors.js';
import { newId, type Clock } from '../../common/ids.js';
import type { Repository } from '../../common/repository.js';
import type { Storage } from '../../persistence/storage.js';
import { validatePolicy, type RedemptionPolicy } from './policy.js';

export type MerchantStatus = 'APPLIED' | 'VERIFIED' | 'REJECTED' | 'REVOKED';

export interface Merchant {
  id: string;
  ownerActorId: string;
  legalName: string;
  jurisdiction: string;
  contact: string;
  status: MerchantStatus;
  createdAt: string;
  updatedAt: string;
}

export interface IssuerVerification {
  id: string;
  merchantId: string;
  status: 'VERIFIED' | 'REVOKED';
  /** reference to the reviewer's evidence (document id, ticket). Never the evidence itself. */
  evidenceRef: string;
  decidedBy: string;
  createdAt: string;
  updatedAt: string;
}

export type ProgramStatus = 'ACTIVE' | 'SUSPENDED';

export interface AssetProgram {
  id: string;
  merchantId: string;
  assetCode: string;
  issuerPublicKey: string;
  status: ProgramStatus;
  policy: RedemptionPolicy;
  createdAt: string;
  updatedAt: string;
}

export interface AssetRef {
  code: string;
  issuer: string;
}

export type EligibilityReason =
  | 'ASSET_UNKNOWN'
  | 'PROGRAM_SUSPENDED'
  | 'MERCHANT_NOT_VERIFIED'
  | 'POLICY_EXPIRED';

export interface Eligibility {
  eligible: boolean;
  reasons: EligibilityReason[];
  kind?: 'CREDIT' | 'SUPPORTED_TARGET';
  program?: AssetProgram;
}

export const ApplySchema = z
  .object({
    legalName: z.string().min(2).max(200),
    jurisdiction: z.string().min(2).max(100),
    contact: z.string().min(3).max(200),
  })
  .strict();

const key = (a: AssetRef) => `${a.code}:${a.issuer}`;

export class IssuerService {
  readonly merchants: Repository<Merchant>;
  readonly verifications: Repository<IssuerVerification>;
  readonly programs: Repository<AssetProgram>;
  /** admin-curated non-credit assets (e.g. a Testnet stable asset) that may be a swap TARGET */
  private readonly targets: Repository<AssetRef & { id: string }>;

  constructor(
    private readonly clock: Clock,
    private readonly audit: AuditLog,
    storage: Storage,
  ) {
    this.merchants = storage.repo<Merchant>('merchants');
    this.verifications = storage.repo<IssuerVerification>('issuer_verifications');
    this.programs = storage.repo<AssetProgram>('asset_programs');
    this.targets = storage.repo<AssetRef & { id: string }>('supported_targets');
  }

  async apply(actor: Actor | undefined, input: unknown, requestId: string): Promise<Merchant> {
    const a = requireRole(actor, 'merchant', 'user', 'admin');
    const parsed = ApplySchema.safeParse(input);
    if (!parsed.success) throw new ApiError('VALIDATION_FAILED', 'invalid merchant application', parsed.error.issues.map((i) => i.path.join('.')));
    const now = this.clock.now().toISOString();
    const m: Merchant = { id: newId('mer'), ownerActorId: a.id, ...parsed.data, status: 'APPLIED', createdAt: now, updatedAt: now };
    await this.merchants.put(m);
    await this.audit.record(a, 'merchant', 'MERCHANT_APPLIED', m.id, requestId);
    return m;
  }

  /** Admin-only. Verification requires an evidence reference; this system never self-certifies. */
  async verifyMerchant(actor: Actor | undefined, merchantId: string, evidenceRef: string, requestId: string): Promise<IssuerVerification> {
    const admin = requireRole(actor, 'admin');
    if (!evidenceRef || evidenceRef.trim().length < 3) throw new ApiError('VALIDATION_FAILED', 'evidenceRef is required');
    const m = await this.mustMerchant(merchantId);
    if (m.status === 'REVOKED') throw new ApiError('INVALID_STATE', 'a revoked merchant must re-apply');
    const now = this.clock.now().toISOString();
    m.status = 'VERIFIED';
    m.updatedAt = now;
    await this.merchants.put(m);
    const v: IssuerVerification = { id: newId('ver'), merchantId, status: 'VERIFIED', evidenceRef, decidedBy: admin.id, createdAt: now, updatedAt: now };
    await this.verifications.put(v);
    await this.audit.record(admin, 'issuer', 'ISSUER_VERIFIED', merchantId, requestId, { evidenceRef });
    return v;
  }

  /** Revocation immediately suspends every program: eligibility is re-evaluated server-side each time. */
  async revokeMerchant(actor: Actor | undefined, merchantId: string, reason: string, requestId: string): Promise<void> {
    const admin = requireRole(actor, 'admin');
    const m = await this.mustMerchant(merchantId);
    const now = this.clock.now().toISOString();
    m.status = 'REVOKED';
    m.updatedAt = now;
    await this.merchants.put(m);
    for (const v of await this.verifications.find((x) => x.merchantId === merchantId)) {
      v.status = 'REVOKED';
      v.updatedAt = now;
      await this.verifications.put(v);
    }
    for (const p of await this.programs.find((x) => x.merchantId === merchantId)) {
      p.status = 'SUSPENDED';
      p.updatedAt = now;
      await this.programs.put(p);
    }
    await this.audit.record(admin, 'issuer', 'ISSUER_REVOKED', merchantId, requestId, { reason });
  }

  async registerProgram(
    actor: Actor | undefined,
    input: { assetCode: string; issuerPublicKey: string; policy: unknown },
    requestId: string,
  ): Promise<AssetProgram> {
    const a = requireRole(actor, 'merchant');
    const m = await this.mustMerchant(a.merchantId ?? '');
    if (m.ownerActorId !== a.id) throw new ApiError('FORBIDDEN', 'not your merchant');
    if (m.status !== 'VERIFIED') throw new ApiError('MERCHANT_NOT_VERIFIED', 'issuer verification is required before registering a credit');
    const check = validatePolicy(input.policy, { assetCode: input.assetCode, issuerPublicKey: input.issuerPublicKey }, this.clock.now());
    if (!check.ok || !check.policy) throw new ApiError('POLICY_INVALID', 'redemption policy failed validation', check.problems);
    const dup = (await this.programs.find((p) => p.assetCode === input.assetCode && p.issuerPublicKey === input.issuerPublicKey))[0];
    if (dup) throw new ApiError('INVALID_STATE', 'this asset is already registered');
    const now = this.clock.now().toISOString();
    const program: AssetProgram = {
      id: newId('prg'),
      merchantId: m.id,
      assetCode: input.assetCode,
      issuerPublicKey: input.issuerPublicKey,
      status: 'ACTIVE',
      policy: check.policy,
      createdAt: now,
      updatedAt: now,
    };
    await this.programs.put(program);
    await this.audit.record(a, 'asset', 'PROGRAM_REGISTERED', program.id, requestId, { assetCode: program.assetCode });
    return program;
  }

  async addSupportedTarget(actor: Actor | undefined, asset: AssetRef, requestId: string): Promise<void> {
    const admin = requireRole(actor, 'admin');
    await this.targets.put({ id: key(asset), code: asset.code, issuer: asset.issuer });
    await this.audit.record(admin, 'asset', 'TARGET_ADDED', key(asset), requestId);
  }

  /** Evaluated fresh on every call; never cached, so revocation and expiry take effect at once. */
  async eligibility(asset: AssetRef): Promise<Eligibility> {
    const program = (await this.programs.find((p) => p.assetCode === asset.code && p.issuerPublicKey === asset.issuer))[0];
    if (!program) {
      if (await this.targets.get(key(asset))) return { eligible: true, reasons: [], kind: 'SUPPORTED_TARGET' };
      return { eligible: false, reasons: ['ASSET_UNKNOWN'] };
    }
    const reasons: EligibilityReason[] = [];
    if (program.status !== 'ACTIVE') reasons.push('PROGRAM_SUSPENDED');
    const m = await this.merchants.get(program.merchantId);
    if (!m || m.status !== 'VERIFIED') reasons.push('MERCHANT_NOT_VERIFIED');
    if (Date.parse(program.policy.expiresAt) <= this.clock.now().getTime()) reasons.push('POLICY_EXPIRED');
    return { eligible: reasons.length === 0, reasons, kind: 'CREDIT', program };
  }

  async assertEligible(asset: AssetRef): Promise<Eligibility> {
    const e = await this.eligibility(asset);
    if (!e.eligible) throw new ApiError('ASSET_NOT_ELIGIBLE', `asset ${asset.code} is not eligible`, e.reasons);
    return e;
  }

  /** The list unbound-stellar's TrustedAssetRegistry should be fed with. */
  async trustedAssets(): Promise<AssetRef[]> {
    const out: AssetRef[] = [];
    for (const p of await this.programs.list()) {
      const e = await this.eligibility({ code: p.assetCode, issuer: p.issuerPublicKey });
      if (e.eligible) out.push({ code: p.assetCode, issuer: p.issuerPublicKey });
    }
    const targets = (await this.targets.list()).map((t) => ({ code: t.code, issuer: t.issuer }));
    return [...out, ...targets];
  }

  async listAssets(filter: { issuer?: string } = {}): Promise<AssetProgram[]> {
    const all = await this.programs.list();
    const out: AssetProgram[] = [];
    for (const p of all) {
      if (filter.issuer && p.issuerPublicKey !== filter.issuer) continue;
      if ((await this.eligibility({ code: p.assetCode, issuer: p.issuerPublicKey })).eligible) out.push(p);
    }
    return out;
  }

  async getAsset(id: string): Promise<AssetProgram> {
    const p = await this.programs.get(id);
    if (!p) throw new ApiError('NOT_FOUND', 'asset not found');
    return p;
  }

  private async mustMerchant(id: string): Promise<Merchant> {
    const m = id ? await this.merchants.get(id) : undefined;
    if (!m) throw new ApiError('NOT_FOUND', 'merchant not found');
    return m;
  }
}
