import { Keypair } from '@stellar/stellar-sdk';
import type { App } from '../app.js';
import type { Actor } from '../common/auth.js';
import { canonicalPolicyBytes, type RedemptionPolicy, type UnsignedPolicy } from '../modules/issuers/policy.js';

/**
 * DEV SEED with SYNTHETIC data only. Generates throwaway keys at run time (nothing secret is
 * committed or printed). Credentials come from the caller. Idempotent: does nothing if a merchant
 * named SEED_MERCHANT_NAME already exists.
 */
export const SEED_MERCHANT_NAME = 'Example Coffee Roasters Ltd (SYNTHETIC)';

export interface SeedResult {
  seeded: boolean;
  merchantId: string;
  credit?: { code: string; issuer: string };
  target?: { code: string; issuer: string };
}

export async function seedDev(app: App, creds: { adminEmail: string; adminPassword: string; merchantEmail: string; merchantPassword: string }): Promise<SeedResult> {
  const existing = (await app.issuers.merchants.find((m) => m.legalName === SEED_MERCHANT_NAME))[0];
  if (existing) return { seeded: false, merchantId: existing.id };

  await app.auth.bootstrapAdmin(creds.adminEmail, creds.adminPassword);
  const admin: Actor = (await app.authenticate((await app.auth.login({ email: creds.adminEmail, password: creds.adminPassword }, 'seed')).token))!;
  await app.auth.registerMerchant({ email: creds.merchantEmail, password: creds.merchantPassword }, 'seed');
  const mActor = (await app.authenticate((await app.auth.login({ email: creds.merchantEmail, password: creds.merchantPassword }, 'seed')).token))!;

  const merchant = await app.issuers.apply(mActor, { legalName: SEED_MERCHANT_NAME, jurisdiction: 'Testland', contact: 'redemptions@example.invalid' }, 'seed');
  await app.issuers.verifyMerchant(admin, merchant.id, 'SEED-EVIDENCE-SYNTHETIC', 'seed');
  const merchantActor: Actor = { ...mActor, merchantId: merchant.id };

  const issuerKp = Keypair.random();
  const targetKp = Keypair.random();
  const unsigned: UnsignedPolicy = {
    schemaVersion: '1.0',
    legalIdentity: { legalName: SEED_MERCHANT_NAME, registrationRef: 'SYNTHETIC-0001' },
    assetCode: 'SHOP',
    issuerPublicKey: issuerKp.publicKey(),
    unitOfAccount: '1 SHOP = 1 USD of store credit (synthetic)',
    faceValue: { amountPerUnit: '1.0000000', currency: 'USD' },
    redemptionLimits: { minUnits: '1', maxUnitsPerRequest: '500' },
    expiresAt: new Date(app.clock.now().getTime() + 365 * 86_400_000).toISOString(),
    jurisdiction: 'Testland',
    refundPolicy: 'Synthetic demo: unredeemed credit is refundable within 30 days of rejection.',
    contact: 'redemptions@example.invalid',
    kycRequirements: 'None for the Testnet demo',
    tokenizationAuthorized: true,
    transferAllowed: true,
  };
  const policy: RedemptionPolicy = { ...unsigned, signature: Buffer.from(issuerKp.sign(canonicalPolicyBytes(unsigned))).toString('base64') };
  await app.issuers.registerProgram(merchantActor, { assetCode: 'SHOP', issuerPublicKey: issuerKp.publicKey(), policy }, 'seed');
  const target = { code: 'USDC', issuer: targetKp.publicKey() };
  await app.issuers.addSupportedTarget(admin, target, 'seed');
  return { seeded: true, merchantId: merchant.id, credit: { code: 'SHOP', issuer: issuerKp.publicKey() }, target };
}
