/* eslint-disable @typescript-eslint/no-explicit-any */
import { readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { createHttpServer } from '../src/http/server.js';
import { openApiJson } from '../src/http/openapi.js';
import { makeWorld } from './helpers.js';
import type { Server } from 'node:http';

let server: Server | undefined;
afterEach(() => new Promise<void>((r) => (server ? server.close(() => r()) : r())));

async function boot() {
  const w = makeWorld();
  server = createHttpServer(w.app);
  await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = async (method: string, path: string, opts: { token?: string; body?: unknown; key?: string; raw?: string } = {}) => {
    const res = await fetch(base + path, {
      method,
      headers: {
        'content-type': 'application/json',
        ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
        ...(opts.key ? { 'idempotency-key': opts.key } : {}),
      },
      ...(opts.raw !== undefined ? { body: opts.raw } : opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
    });
    return { status: res.status, json: (await res.json()) as Record<string, any>, requestId: res.headers.get('x-request-id') };
  };
  return { w, call };
}

describe('HTTP v1 (in-process server, FakeStellarGateway)', () => {
  it('runs the whole exchange journey through the public API', async () => {
    const { w, call } = await boot();
    await w.onboardMerchant();
    const user = await w.newUser();
    const assets = await call('GET', `/v1/assets?issuer=${w.SHOP.issuer}`);
    expect(assets.json.assets[0]).toMatchObject({ assetCode: 'SHOP', status: 'ACTIVE' });

    const q = await call('POST', '/v1/exchange/quote', {
      token: user.token,
      body: { schemaVersion: '1.0', sourceAsset: w.SHOP, targetAsset: w.USDC, sourceAmount: '80', slippageBps: 100, destinationAccount: user.publicKey, network: 'TESTNET' },
    });
    expect(q.status).toBe(201);
    const i = await call('POST', '/v1/exchange/intents', { token: user.token, key: 'http-key-0001', body: { quoteId: q.json.quote.quoteId } });
    expect(i.status).toBe(201);
    expect(i.json.state).toBe('AWAITING_SIGNATURE');
    const again = await call('POST', '/v1/exchange/intents', { token: user.token, key: 'http-key-0001', body: { quoteId: q.json.quote.quoteId } });
    expect(again.json.id).toBe(i.json.id);

    const sub = await call('POST', `/v1/exchange/intents/${i.json.id}/submit`, { token: user.token, key: 'http-submit-01', body: { signedXdr: w.signFake(i.json.unsignedXdr) } });
    expect(sub.status).toBe(200);
    expect(sub.json.state).toBe('CONFIRMED');
    const got = await call('GET', `/v1/exchange/intents/${i.json.id}`, { token: user.token });
    expect(got.json).toMatchObject({ state: 'CONFIRMED', unsignedXdr: null });
  });

  it('answers an unknown submit outcome with 202 RECONCILING, not a fake success', async () => {
    const { w, call } = await boot();
    await w.onboardMerchant();
    const user = await w.newUser();
    const { intent } = await w.readyIntent(user);
    w.gateway.submitMode = 'timeout-after-apply';
    const sub = await call('POST', `/v1/exchange/intents/${intent.id}/submit`, { token: user.token, key: 'http-submit-02', body: { signedXdr: w.signFake(intent.unsignedXdr!) } });
    expect(sub.status).toBe(202);
    expect(sub.json.state).toBe('RECONCILING');
  });

  it('uses the standard error schema with requestId for every failure class', async () => {
    const { w, call } = await boot();
    const unauth = await call('POST', '/v1/exchange/quote', { body: {} });
    expect(unauth).toMatchObject({ status: 401, json: { error: { code: 'UNAUTHENTICATED' } } });
    expect(unauth.json.error.requestId).toBe(unauth.requestId);
    const user = await w.newUser();
    expect((await call('POST', '/v1/exchange/quote', { token: user.token, body: { nope: 1 } })).status).toBe(400);
    expect((await call('POST', '/v1/exchange/quote', { token: user.token, raw: '{not json' })).json.error.code).toBe('VALIDATION_FAILED');
    expect((await call('GET', '/v1/nothing')).status).toBe(404);
    expect((await call('GET', '/v1/assets/ast_missing')).json.error.code).toBe('NOT_FOUND');
    expect((await call('POST', '/v1/admin/ledger-events', { token: user.token, body: {} })).status).toBe(403);
    const missingKey = await call('POST', '/v1/exchange/intents', { token: user.token, body: { quoteId: 'q' } });
    expect(missingKey.json.error.code).toBe('VALIDATION_FAILED');
  });

  it('rejects oversized bodies and never leaks internals on unexpected errors', async () => {
    const { w, call } = await boot();
    const user = await w.newUser();
    const big = await call('POST', '/v1/exchange/quote', { token: user.token, raw: JSON.stringify({ pad: 'x'.repeat(70_000) }) });
    expect(big.status).toBe(413);
    w.app.exchange.quote = async () => {
      throw new Error('db password=hunter2 at /srv/internal/path');
    };
    const boom = await call('POST', '/v1/exchange/quote', { token: user.token, body: {} });
    expect(boom.status).toBe(500);
    expect(JSON.stringify(boom.json)).not.toMatch(/hunter2|\/srv/);
  });

  it('admin ingests reconciliation events over HTTP, idempotently', async () => {
    const { w, call } = await boot();
    await w.onboardMerchant();
    const user = await w.newUser();
    const { intent } = await w.readyIntent(user);
    w.gateway.submitMode = 'timeout-after-apply';
    await call('POST', `/v1/exchange/intents/${intent.id}/submit`, { token: user.token, key: 'http-submit-03', body: { signedXdr: w.signFake(intent.unsignedXdr!) } });
    const adminToken = await w.app.wallets.mintDevSession(w.admin);
    const ev = w.eventFor(intent.txHash!, 'CONFIRMED');
    const first = await call('POST', '/v1/admin/ledger-events', { token: adminToken, body: ev });
    const second = await call('POST', '/v1/admin/ledger-events', { token: adminToken, body: ev });
    expect([first.status, first.json.outcome, second.status, second.json.duplicate]).toEqual([201, 'APPLIED', 200, true]);
    expect((await call('GET', `/v1/exchange/intents/${intent.id}`, { token: user.token })).json.state).toBe('CONFIRMED');
  });

  it('wallet challenge/verify and merchant redemption flow over HTTP', async () => {
    const { w, call } = await boot();
    const { merchant } = await w.onboardMerchant();
    const user = await w.newUser();
    const merchantToken = await w.app.wallets.mintDevSession(merchant);
    const red = await call('POST', '/v1/redemptions', { token: user.token, key: 'http-redeem-01', body: { asset: w.SHOP, amount: '10', holder: user.publicKey } });
    expect(red.status).toBe(201);
    const ret = await call('POST', `/v1/redemptions/${red.json.id}/return`, { token: user.token, body: { signedXdr: w.signFake(red.json.unsignedXdr) } });
    expect(ret.json.state).toBe('RETURN_CONFIRMED');
    const list = await call('GET', '/v1/merchants/me/redemptions', { token: merchantToken });
    expect(list.json.redemptions).toHaveLength(1);
    const conf = await call('POST', `/v1/merchants/me/redemptions/${red.json.id}/confirm`, { token: merchantToken });
    expect(conf.json.state).toBe('FULFILLED');
    expect((await call('POST', `/v1/merchants/me/redemptions/${red.json.id}/confirm`, { token: user.token })).status).toBe(403);
    expect((await call('GET', '/healthz')).json.status).toBe('ok');
  });

  it('checked-in OpenAPI document matches the code (regenerate with npm run openapi)', () => {
    expect(readFileSync(new URL('../openapi/openapi.json', import.meta.url), 'utf8').replace(/\r\n/g, '\n')).toBe(openApiJson());
  });
});

describe('GET /v1/targets', () => {
  it('lists admin-curated swap targets publicly and nothing else', async () => {
    const { w, call } = await boot();
    expect((await call('GET', '/v1/targets')).json.targets).toEqual([]);
    await w.onboardMerchant();
    const r = await call('GET', '/v1/targets');
    expect(r.status).toBe(200);
    expect(r.json.targets).toEqual([w.USDC]);
  });
});
