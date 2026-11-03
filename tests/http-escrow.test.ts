/* eslint-disable @typescript-eslint/no-explicit-any */
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { createHttpServer } from '../src/http/server.js';
import { DEFAULT_ESCROW_WINDOW_SECS } from '../src/modules/redemption/service.js';
import { makeWorld } from './helpers.js';

let server: Server | undefined;
afterEach(() => new Promise<void>((r) => (server ? server.close(() => r()) : r())));

async function boot() {
  const w = makeWorld();
  w.gateway.enableEscrow();
  const { merchant } = await w.onboardMerchant();
  const merchantToken = await w.app.wallets.openSession({ id: merchant.id, role: 'merchant' });
  const user = await w.newUser();
  server = createHttpServer(w.app);
  await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = async (method: string, path: string, opts: { token?: string; body?: unknown; key?: string } = {}) => {
    const res = await fetch(base + path, {
      method,
      headers: { 'content-type': 'application/json', ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}), ...(opts.key ? { 'idempotency-key': opts.key } : {}) },
      ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
    });
    return { status: res.status, json: (await res.json()) as Record<string, any> };
  };
  const held = async (key = 'http-redeem-01') => {
    const c = await call('POST', '/v1/redemptions', { token: user.token, key, body: { asset: w.SHOP, amount: '25', holder: user.publicKey } });
    expect(c.status).toBe(201);
    const s = await call('POST', `/v1/redemptions/${c.json.id}/return`, { token: user.token, body: { signedXdr: w.signFake(c.json.unsignedXdr) } });
    expect(s.json.state).toBe('RETURN_CONFIRMED');
    return s.json;
  };
  return { w, call, user, merchantToken, held };
}

describe('HTTP: escrowed redemptions', () => {
  it('exposes mode and escrow state; merchant confirm is 202 until the issuer transaction lands', async () => {
    const { w, call, merchantToken, held } = await boot();
    const r = await held();
    expect(r).toMatchObject({ mode: 'ESCROW', escrow: { state: 'HELD', refundAvailable: false, pendingAction: null } });
    expect(Date.parse(r.escrow.deadline)).toBe(w.t.ms + DEFAULT_ESCROW_WINDOW_SECS * 1000);
    const c = await call('POST', `/v1/merchants/me/redemptions/${r.id}/confirm`, { token: merchantToken });
    expect(c.status).toBe(202);
    expect(c.json.escrow).toMatchObject({ pendingAction: 'CONFIRM', pendingXdr: expect.any(String), pendingTxHash: expect.stringMatching(/^[0-9a-f]{64}$/) });
    const done = await call('POST', `/v1/merchants/me/redemptions/${r.id}/escrow/submit`, { token: merchantToken, body: { signedXdr: w.signFake(c.json.escrow.pendingXdr) } });
    expect(done.json).toMatchObject({ state: 'FULFILLED', escrow: { state: 'RELEASED', pendingXdr: null } });
  });

  it('merchant reject over HTTP needs a reason and refunds on-chain', async () => {
    const { w, call, merchantToken, held } = await boot();
    const r = await held();
    expect((await call('POST', `/v1/merchants/me/redemptions/${r.id}/reject`, { token: merchantToken, body: {} })).status).toBe(400);
    const p = await call('POST', `/v1/merchants/me/redemptions/${r.id}/reject`, { token: merchantToken, body: { reason: 'out of stock' } });
    expect(p.status).toBe(202);
    const done = await call('POST', `/v1/merchants/me/redemptions/${r.id}/escrow/submit`, { token: merchantToken, body: { signedXdr: w.signFake(p.json.escrow.pendingXdr) } });
    expect(done.json).toMatchObject({ state: 'REJECTED', refundDue: false, rejectionReason: 'out of stock', escrow: { state: 'REFUNDED' } });
  });

  it('after the deadline the holder sees refundAvailable and claims the refund', async () => {
    const { w, call, user, held } = await boot();
    const r = await held();
    expect((await call('POST', `/v1/redemptions/${r.id}/refund`, { token: user.token })).status).toBe(409);
    w.t.ms += DEFAULT_ESCROW_WINDOW_SECS * 1000;
    const token = await w.app.wallets.openSession(user.actor); // the old session expired meanwhile
    expect((await call('GET', `/v1/redemptions/${r.id}`, { token })).json.escrow.refundAvailable).toBe(true);
    const p = await call('POST', `/v1/redemptions/${r.id}/refund`, { token });
    expect(p.json.escrow.pendingAction).toBe('EXPIRE');
    const done = await call('POST', `/v1/redemptions/${r.id}/escrow/submit`, { token, body: { signedXdr: w.signFake(p.json.escrow.pendingXdr) } });
    expect(done.json).toMatchObject({ state: 'EXPIRED', escrow: { state: 'EXPIRED_REFUNDED', refundAvailable: false } });
  });

  it('native redemptions report mode NATIVE and escrow null; merchant reject keeps refundDue', async () => {
    const { w, call, user, merchantToken } = await boot();
    w.gateway.escrow!.unavailable = true;
    const c = await call('POST', '/v1/redemptions', { token: user.token, key: 'http-redeem-09', body: { asset: w.SHOP, amount: '25', holder: user.publicKey } });
    expect(c.json).toMatchObject({ mode: 'NATIVE', escrow: null });
    await call('POST', `/v1/redemptions/${c.json.id}/return`, { token: user.token, body: { signedXdr: w.signFake(c.json.unsignedXdr) } });
    const rej = await call('POST', `/v1/merchants/me/redemptions/${c.json.id}/reject`, { token: merchantToken, body: { reason: 'out of stock' } });
    expect(rej.status).toBe(200);
    expect(rej.json).toMatchObject({ state: 'REJECTED', refundDue: true });
  });
});
