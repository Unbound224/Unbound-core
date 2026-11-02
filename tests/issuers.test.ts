import { Keypair } from '@stellar/stellar-sdk';
import { describe, expect, it } from 'vitest';
import { canonicalJson, validatePolicy } from '../src/modules/issuers/policy.js';
import { makeWorld } from './helpers.js';

describe('redemption policy validation', () => {
  const now = new Date('2026-11-02T12:00:00Z');
  it('accepts a correctly signed, unexpired policy', () => {
    const w = makeWorld();
    const p = w.policyFor(w.issuerKp, 'SHOP');
    const r = validatePolicy(p, { assetCode: 'SHOP', issuerPublicKey: w.issuerKp.publicKey() }, now);
    expect(r).toMatchObject({ ok: true, problems: [] });
  });
  it('detects any tampering after signing', () => {
    const w = makeWorld();
    const p = { ...w.policyFor(w.issuerKp, 'SHOP'), refundPolicy: 'No refunds, ever.' };
    expect(validatePolicy(p, { assetCode: 'SHOP', issuerPublicKey: w.issuerKp.publicKey() }, now).problems).toContain('SIGNATURE_INVALID');
  });
  it('rejects a policy signed by someone other than the issuer key', () => {
    const w = makeWorld();
    const impostor = Keypair.random();
    const p = { ...w.policyFor(impostor, 'SHOP'), issuerPublicKey: w.issuerKp.publicKey() };
    expect(validatePolicy(p, { assetCode: 'SHOP', issuerPublicKey: w.issuerKp.publicKey() }, now).problems).toContain('SIGNATURE_INVALID');
  });
  it('rejects key/code mismatch, expiry and inconsistent limits', () => {
    const w = makeWorld();
    const other = Keypair.random().publicKey();
    expect(validatePolicy(w.policyFor(w.issuerKp, 'SHOP'), { assetCode: 'SHOP', issuerPublicKey: other }, now).problems).toContain('ISSUER_KEY_MISMATCH');
    expect(validatePolicy(w.policyFor(w.issuerKp, 'SHOP'), { assetCode: 'OTHR', issuerPublicKey: w.issuerKp.publicKey() }, now).problems).toContain('ASSET_CODE_MISMATCH');
    const expired = w.policyFor(w.issuerKp, 'SHOP', { expiresAt: '2026-01-01T00:00:00.000Z' });
    expect(validatePolicy(expired, { assetCode: 'SHOP', issuerPublicKey: w.issuerKp.publicKey() }, now).problems).toContain('EXPIRED');
    const bad = w.policyFor(w.issuerKp, 'SHOP', { redemptionLimits: { minUnits: '10', maxUnitsPerRequest: '5' } });
    expect(validatePolicy(bad, { assetCode: 'SHOP', issuerPublicKey: w.issuerKp.publicKey() }, now).problems).toContain('LIMITS_INCONSISTENT');
  });
  it('requires affirmative tokenization and transfer permission (schema level)', () => {
    const w = makeWorld();
    const p = { ...w.policyFor(w.issuerKp, 'SHOP'), transferAllowed: false };
    expect(validatePolicy(p, { assetCode: 'SHOP', issuerPublicKey: w.issuerKp.publicKey() }, now).problems).toEqual(['SCHEMA_INVALID']);
    const q = { ...w.policyFor(w.issuerKp, 'SHOP'), surprise: 1 };
    expect(validatePolicy(q, { assetCode: 'SHOP', issuerPublicKey: w.issuerKp.publicKey() }, now).problems).toEqual(['SCHEMA_INVALID']);
  });
  it('canonical JSON is key-order independent', () => {
    expect(canonicalJson({ b: 1, a: { d: [2, { z: 1, y: 2 }], c: null } })).toBe(canonicalJson({ a: { c: null, d: [2, { y: 2, z: 1 }] }, b: 1 }));
  });
});

describe('issuer lifecycle and eligibility', () => {
  it('walks apply -> verify -> register and exposes only eligible assets', async () => {
    const w = makeWorld();
    const { program } = await w.onboardMerchant();
    expect(program.status).toBe('ACTIVE');
    expect((await w.app.issuers.eligibility(w.SHOP)).eligible).toBe(true);
    expect((await w.app.issuers.listAssets()).map((p) => p.assetCode)).toEqual(['SHOP']);
    expect(await w.app.issuers.trustedAssets()).toEqual(expect.arrayContaining([w.SHOP, w.USDC]));
  });
  it('unknown assets are not eligible (fail closed)', async () => {
    const w = makeWorld();
    const e = await w.app.issuers.eligibility({ code: 'FAKE', issuer: Keypair.random().publicKey() });
    expect(e).toMatchObject({ eligible: false, reasons: ['ASSET_UNKNOWN'] });
    await expect(w.app.issuers.assertEligible({ code: 'FAKE', issuer: Keypair.random().publicKey() })).rejects.toMatchObject({ code: 'ASSET_NOT_ELIGIBLE' });
  });
  it('an unverified merchant cannot register a credit program', async () => {
    const w = makeWorld();
    const owner = { id: 'usr_m', role: 'merchant' as const };
    const m = await w.app.issuers.apply(owner, { legalName: 'Shady Shop', jurisdiction: 'Testland', contact: 'x@example.invalid' }, w.rid());
    await expect(
      w.app.issuers.registerProgram({ ...owner, merchantId: m.id }, { assetCode: 'SHOP', issuerPublicKey: w.issuerKp.publicKey(), policy: w.policyFor(w.issuerKp, 'SHOP') }, w.rid()),
    ).rejects.toMatchObject({ code: 'MERCHANT_NOT_VERIFIED' });
  });
  it('only admins verify; merchants cannot self-verify', async () => {
    const w = makeWorld();
    const owner = { id: 'usr_m', role: 'merchant' as const };
    const m = await w.app.issuers.apply(owner, { legalName: 'Shady Shop', jurisdiction: 'Testland', contact: 'x@example.invalid' }, w.rid());
    await expect(w.app.issuers.verifyMerchant(owner, m.id, 'EVIDENCE', w.rid())).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(w.app.issuers.verifyMerchant(undefined, m.id, 'EVIDENCE', w.rid())).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
    await expect(w.app.issuers.verifyMerchant(w.admin, m.id, '', w.rid())).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });
  it('rejects a program whose policy is invalid or duplicated, and a merchant acting for another merchant', async () => {
    const w = makeWorld();
    const { merchant } = await w.onboardMerchant();
    const other = Keypair.random();
    await expect(
      w.app.issuers.registerProgram(merchant, { assetCode: 'MINE', issuerPublicKey: other.publicKey(), policy: { ...w.policyFor(other, 'MINE'), contact: 'tampered' } }, w.rid()),
    ).rejects.toMatchObject({ code: 'POLICY_INVALID' });
    await expect(
      w.app.issuers.registerProgram(merchant, { assetCode: 'SHOP', issuerPublicKey: w.issuerKp.publicKey(), policy: w.policyFor(w.issuerKp, 'SHOP') }, w.rid()),
    ).rejects.toMatchObject({ code: 'INVALID_STATE' });
    await expect(
      w.app.issuers.registerProgram({ ...merchant, id: 'usr_someone_else' }, { assetCode: 'X', issuerPublicKey: other.publicKey(), policy: w.policyFor(other, 'X') }, w.rid()),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
  it('revocation immediately suspends programs and removes them from the trusted list', async () => {
    const w = makeWorld();
    const { merchantRecord } = await w.onboardMerchant();
    await w.app.issuers.revokeMerchant(w.admin, merchantRecord.id, 'fraud report FR-9', w.rid());
    const e = await w.app.issuers.eligibility(w.SHOP);
    expect(e.eligible).toBe(false);
    expect(e.reasons).toEqual(expect.arrayContaining(['PROGRAM_SUSPENDED', 'MERCHANT_NOT_VERIFIED']));
    expect(await w.app.issuers.trustedAssets()).not.toContainEqual(w.SHOP);
    expect(await w.app.issuers.listAssets()).toEqual([]);
    await expect(w.app.issuers.verifyMerchant(w.admin, merchantRecord.id, 'EVIDENCE', w.rid())).rejects.toMatchObject({ code: 'INVALID_STATE' });
  });
  it('a program becomes ineligible when its policy expires', async () => {
    const w = makeWorld();
    await w.onboardMerchant();
    w.t.ms = Date.parse('2027-11-03T00:00:00Z');
    expect((await w.app.issuers.eligibility(w.SHOP)).reasons).toContain('POLICY_EXPIRED');
  });
  it('validates merchant applications', async () => {
    const w = makeWorld();
    await expect(w.app.issuers.apply({ id: 'u', role: 'merchant' }, { legalName: 'x' }, w.rid())).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    await expect(w.app.issuers.apply({ id: 'u', role: 'merchant' }, { legalName: 'Okay Name', jurisdiction: 'TL', contact: 'abc', isAdmin: true }, w.rid())).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });
});
