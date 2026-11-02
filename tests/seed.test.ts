import { describe, expect, it } from 'vitest';
import { seedDev } from '../src/dev/seed.js';
import { makeWorld } from './helpers.js';

const creds = { adminEmail: 'admin@example.invalid', adminPassword: 'seed-admin-pw-123456', merchantEmail: 'shop@example.invalid', merchantPassword: 'seed-shop-pw-1234567' };

describe('dev seed (synthetic)', () => {
  it('creates a verified merchant with a valid signed program, a swap target and usable logins; is idempotent', async () => {
    const w = makeWorld();
    const r = await seedDev(w.app, creds);
    expect(r.seeded).toBe(true);
    expect((await w.app.issuers.eligibility(r.credit!)).eligible).toBe(true);
    expect((await w.app.issuers.eligibility(r.target!)).kind).toBe('SUPPORTED_TARGET');
    const login = await w.app.auth.login({ email: creds.merchantEmail, password: creds.merchantPassword }, 'r');
    expect((await w.app.authenticate(login.token))!.merchantId).toBe(r.merchantId);
    const again = await seedDev(w.app, creds);
    expect(again).toEqual({ seeded: false, merchantId: r.merchantId });
    expect(await w.app.issuers.programs.list()).toHaveLength(1);
  });
  it('contains no key material in stored data', async () => {
    const w = makeWorld();
    await seedDev(w.app, creds);
    const dump = JSON.stringify([await w.app.issuers.programs.list(), await w.app.audit.all()]);
    expect(dump).not.toMatch(/\bS[A-Z2-7]{55}\b/); // no Stellar secret seeds
  });
});
