import { Keypair } from '@stellar/stellar-sdk';
import { describe, expect, it } from 'vitest';
import { ApiError } from '../src/common/errors.js';
import { makeWorld } from './helpers.js';

describe('GET /v1/portfolio', () => {
  it('classifies ledger balances; unverified credit gets no value and native is fee-only', async () => {
    const w = makeWorld();
    await w.onboardMerchant();
    const user = await w.newUser();
    const rogue = { code: 'SHOP', issuer: Keypair.random().publicKey() };
    w.gateway.balancesByAccount.set(user.publicKey, [
      { asset: { code: 'XLM', issuer: null }, balance: '9.9999000', isAuthorized: true },
      { asset: w.SHOP, balance: '20.0000000', isAuthorized: true },
      { asset: w.USDC, balance: '72.0000000', isAuthorized: true },
      { asset: rogue, balance: '1000.0000000', isAuthorized: true },
      { asset: { code: 'ZERO', issuer: w.SHOP.issuer }, balance: '0.0000000', isAuthorized: true },
    ]);
    const p = await w.app.portfolio.get(user.actor);
    const by = Object.fromEntries(p.holdings.map((h) => [`${h.asset.code}:${h.asset.issuer.slice(0, 4)}`, h.status]));
    expect(by[`SHOP:${w.SHOP.issuer.slice(0, 4)}`]).toBe('REDEEMABLE');
    expect(by[`USDC:${w.USDC.issuer.slice(0, 4)}`]).toBe('SUPPORTED_ASSET'); // swap target, not a redeemable credit program
    expect(by[`SHOP:${rogue.issuer.slice(0, 4)}`]).toBe('UNVERIFIED');
    expect(p.holdings).toHaveLength(3); // zero balances dropped
    expect(p.native).toEqual([{ wallet: user.publicKey, balance: '9.9999000' }]);
    expect(p.holdings.find((h) => h.status === 'REDEEMABLE')!.program!.unitOfAccount).toMatch(/SHOP/);
    expect(p.holdings.filter((h) => h.status !== 'REDEEMABLE').every((h) => h.program === undefined)).toBe(true);
  });

  it('reflects frozen, suspended and expired states', async () => {
    const w = makeWorld();
    const { merchantRecord } = await w.onboardMerchant();
    const user = await w.newUser();
    w.gateway.balancesByAccount.set(user.publicKey, [{ asset: w.SHOP, balance: '5.0000000', isAuthorized: false }]);
    expect((await w.app.portfolio.get(user.actor)).holdings[0]!.status).toBe('FROZEN');
    w.gateway.balancesByAccount.set(user.publicKey, [{ asset: w.SHOP, balance: '5.0000000', isAuthorized: true }]);
    w.t.ms = Date.parse('2027-12-01T00:00:00Z');
    expect((await w.app.portfolio.get(user.actor)).holdings[0]!.status).toBe('EXPIRED');
    w.t.ms = Date.parse('2026-11-02T12:00:00Z');
    await w.app.issuers.revokeMerchant(w.admin, merchantRecord.id, 'fraud', w.rid());
    expect((await w.app.portfolio.get(user.actor)).holdings[0]!.status).toBe('SUSPENDED');
  });

  it("only shows the caller's own wallets and requires a user session", async () => {
    const w = makeWorld();
    await w.onboardMerchant();
    const a = await w.newUser();
    const b = await w.newUser();
    w.gateway.balancesByAccount.set(a.publicKey, [{ asset: w.SHOP, balance: '1.0000000', isAuthorized: true }]);
    expect((await w.app.portfolio.get(b.actor)).holdings).toEqual([]);
    await expect(w.app.portfolio.get(undefined)).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
    await expect(w.app.portfolio.get(w.admin)).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('a gateway outage becomes a safe API error, not stale or invented balances', async () => {
    const w = makeWorld();
    const user = await w.newUser();
    w.gateway.balanceError = new Error('horizon down: secret-host.internal');
    const err = await w.app.portfolio.get(user.actor).catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err.message).not.toMatch(/internal/);
  });
});
