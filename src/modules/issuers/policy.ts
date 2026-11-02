import { Keypair, StrKey } from '@stellar/stellar-sdk';
import { z } from 'zod';
import { parseAmount } from '../../common/money.js';

export const POLICY_SCHEMA_VERSION = '1.0';

const stellarKey = z.string().refine((k) => StrKey.isValidEd25519PublicKey(k), 'invalid Stellar public key');

/**
 * Human-readable redemption policy published by the issuer (docs/STELLAR_PROTOCOL.md "Mandatory
 * issuer contract"). The issuer's affirmative permission to tokenize AND transfer is literal `true`
 * and the whole document is signed by the asset's issuer key. A Stellar asset on its own is not
 * evidence that a shop will redeem it.
 */
export const RedemptionPolicySchema = z
  .object({
    schemaVersion: z.literal(POLICY_SCHEMA_VERSION),
    legalIdentity: z.object({ legalName: z.string().min(2).max(200), registrationRef: z.string().min(1).max(100) }).strict(),
    assetCode: z.string().regex(/^[A-Za-z0-9]{1,12}$/),
    issuerPublicKey: stellarKey,
    unitOfAccount: z.string().min(2).max(100),
    faceValue: z.object({ amountPerUnit: z.string().regex(/^\d+(\.\d{1,7})?$/), currency: z.string().regex(/^[A-Z]{3}$/) }).strict(),
    redemptionLimits: z
      .object({
        minUnits: z.string().regex(/^\d+(\.\d{1,7})?$/).optional(),
        maxUnitsPerRequest: z.string().regex(/^\d+(\.\d{1,7})?$/).optional(),
      })
      .strict(),
    expiresAt: z.iso.datetime(),
    jurisdiction: z.string().min(2).max(100),
    refundPolicy: z.string().min(5).max(2000),
    contact: z.string().min(3).max(200),
    kycRequirements: z.string().min(2).max(1000),
    tokenizationAuthorized: z.literal(true),
    transferAllowed: z.literal(true),
    /** base64 ed25519 signature by issuerPublicKey over canonicalPolicyBytes(policy sans signature) */
    signature: z.string().min(8),
  })
  .strict();

export type RedemptionPolicy = z.infer<typeof RedemptionPolicySchema>;
export type UnsignedPolicy = Omit<RedemptionPolicy, 'signature'>;

/** Deterministic JSON: keys sorted recursively, no whitespace. */
export function canonicalJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o)
      .filter((k) => o[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(v);
}

export function canonicalPolicyBytes(p: UnsignedPolicy | RedemptionPolicy): Buffer {
  const rest: Record<string, unknown> = { ...p };
  delete rest.signature;
  return Buffer.from(canonicalJson(rest), 'utf8');
}

export type PolicyProblem =
  | 'SCHEMA_INVALID'
  | 'SIGNATURE_INVALID'
  | 'ISSUER_KEY_MISMATCH'
  | 'ASSET_CODE_MISMATCH'
  | 'EXPIRED'
  | 'LIMITS_INCONSISTENT';

export interface PolicyCheck {
  ok: boolean;
  problems: PolicyProblem[];
  policy?: RedemptionPolicy;
}

/** Pure validation. Fails closed: any problem means the policy cannot activate an AssetProgram. */
export function validatePolicy(
  raw: unknown,
  expected: { assetCode: string; issuerPublicKey: string },
  now: Date,
): PolicyCheck {
  const parsed = RedemptionPolicySchema.safeParse(raw);
  if (!parsed.success) return { ok: false, problems: ['SCHEMA_INVALID'] };
  const p = parsed.data;
  const problems: PolicyProblem[] = [];
  if (p.issuerPublicKey !== expected.issuerPublicKey) problems.push('ISSUER_KEY_MISMATCH');
  if (p.assetCode !== expected.assetCode) problems.push('ASSET_CODE_MISMATCH');
  if (Date.parse(p.expiresAt) <= now.getTime()) problems.push('EXPIRED');
  const { minUnits, maxUnitsPerRequest } = p.redemptionLimits;
  if (minUnits !== undefined && maxUnitsPerRequest !== undefined && parseAmount(minUnits, { allowZero: true }) > parseAmount(maxUnitsPerRequest, { allowZero: true })) {
    problems.push('LIMITS_INCONSISTENT');
  }
  let sigOk: boolean;
  try {
    sigOk = Keypair.fromPublicKey(p.issuerPublicKey).verify(canonicalPolicyBytes(p), Buffer.from(p.signature, 'base64'));
  } catch {
    sigOk = false;
  }
  if (!sigOk) problems.push('SIGNATURE_INVALID');
  return { ok: problems.length === 0, problems, policy: p };
}
