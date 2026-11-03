import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { HttpStellarGateway } from '../src/integrations/stellar-http-gateway.js';
import { GatewayError, mapGatewayError } from '../src/modules/exchange/gateway.js';

const fx = (n: string) => JSON.parse(readFileSync(new URL(`../fixtures/gateway/${n}.json`, import.meta.url), 'utf8')) as Record<string, unknown>;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const gw = (f: typeof fetch, timeoutMs?: number) => new HttpStellarGateway({ baseUrl: 'http://stellar.test/', token: 'svc-token', fetchImpl: f, ...(timeoutMs ? { timeoutMs } : {}) });
const q = { sourceAsset: { code: 'SHOP', issuer: 'G1' }, targetAsset: { code: 'USDC', issuer: 'G2' }, sourceAmount: '80', slippageBps: 100 };

describe('HttpStellarGateway (fixtures follow the gateway contract; no live service)', () => {
  it('quote: sends bearer auth, parses a contract quote', async () => {
    const f = vi.fn().mockResolvedValue(json(fx('quote')));
    const out = await gw(f as unknown as typeof fetch).quote(q);
    expect(out.minDestinationAmount).toBe('71.2800000');
    const [url, init] = f.mock.calls[0]!;
    expect(url).toBe('http://stellar.test/gateway/v1/quote');
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer svc-token');
  });

  it('maps a 422 rejection to a typed GatewayError and then to the public error', async () => {
    const f = vi.fn().mockResolvedValue(json(fx('error-no-route'), 422));
    const err = await gw(f as unknown as typeof fetch).quote(q).catch((e) => e);
    expect(err).toBeInstanceOf(GatewayError);
    expect(err.code).toBe('NO_ROUTE');
    expect(mapGatewayError(err).code).toBe('NO_ROUTE');
  });

  it('rejects responses that violate the contract (fail closed)', async () => {
    const bad = { ...fx('quote'), network: 'PUBLIC' };
    await expect(gw(vi.fn().mockResolvedValue(json(bad)) as unknown as typeof fetch).quote(q)).rejects.toThrow(/contract/);
    const extra = { ...fx('quote'), surprise: 1 };
    await expect(gw(vi.fn().mockResolvedValue(json(extra)) as unknown as typeof fetch).quote(q)).rejects.toThrow(/contract/);
    const noHash = { ...fx('unsigned-settlement'), hash: 'xyz' };
    await expect(gw(vi.fn().mockResolvedValue(json(noHash)) as unknown as typeof fetch).buildRedemptionReturn({ asset: { code: 'SHOP', issuer: 'G1' }, holder: 'G3', amount: '1', idempotencyKey: 'k' })).rejects.toThrow(/contract/);
  });

  it('submit: parses all three verdicts; transport trouble THROWS so core records RECONCILING', async () => {
    for (const [name, state] of [['outcome-confirmed', 'CONFIRMED'], ['outcome-failed', 'FAILED'], ['outcome-reconciling', 'RECONCILING']] as const) {
      const o = await gw(vi.fn().mockResolvedValue(json(fx(name))) as unknown as typeof fetch).submit({ signedXdr: 'x', expectedHash: 'h' });
      expect(o.state).toBe(state);
    }
    await expect(gw(vi.fn().mockRejectedValue(new TypeError('fetch failed')) as unknown as typeof fetch).submit({ signedXdr: 'x', expectedHash: 'h' })).rejects.toThrow();
    await expect(gw(vi.fn().mockResolvedValue(json({}, 502)) as unknown as typeof fetch).submit({ signedXdr: 'x', expectedHash: 'h' })).rejects.toThrow(/502/);
    await expect(gw(vi.fn().mockResolvedValue(new Response('<html>', { status: 200 })) as unknown as typeof fetch).submit({ signedXdr: 'x', expectedHash: 'h' })).rejects.toThrow(/non-JSON/);
  });

  it('submit: times out instead of hanging', async () => {
    const f = vi.fn((_u: string, init: RequestInit) => new Promise<Response>((_r, rej) => init.signal!.addEventListener('abort', () => rej(new Error('aborted')))));
    await expect(gw(f as unknown as typeof fetch, 20).submit({ signedXdr: 'x', expectedHash: 'h' })).rejects.toThrow();
  });

  it('balances and trusted-asset sync', async () => {
    const f = vi.fn().mockResolvedValueOnce(json(fx('balances'))).mockResolvedValueOnce(json({ count: 2 }));
    const g = gw(f as unknown as typeof fetch);
    const b = await g.balances('GACCOUNT');
    expect(b[0]!.asset.issuer).toBeNull();
    expect(f.mock.calls[0]![0]).toBe('http://stellar.test/gateway/v1/accounts/GACCOUNT/balances');
    await g.syncTrustedAssets([{ code: 'SHOP', issuer: 'G1' }]);
    expect(f.mock.calls[1]![1].method).toBe('PUT');
    expect(JSON.parse(f.mock.calls[1]![1].body)).toEqual({ assets: [{ code: 'SHOP', issuer: 'G1' }] });
  });

  it('builds an unsigned settlement through the port', async () => {
    const f = vi.fn().mockResolvedValue(json(fx('unsigned-settlement')));
    const u = await gw(f as unknown as typeof fetch).buildSettlement({ quote: fx('quote') as never, sourceAccount: 'G1', destinationAccount: 'G1', idempotencyKey: 'int_1' });
    expect(u.hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('escrow is absent unless the deployment opts in', () => {
    expect(gw(vi.fn() as unknown as typeof fetch).escrow).toBeUndefined();
  });

  it('escrow: builds and reads through the documented endpoints, validating the shared fixtures', async () => {
    const f = vi.fn().mockImplementation(async (url: string) => json(fx(url.includes('/returns/') ? 'escrow-return' : 'escrow-built')));
    const g = new HttpStellarGateway({ baseUrl: 'http://stellar.test', token: 't', fetchImpl: f as unknown as typeof fetch, escrow: true });
    const built = await g.escrow!.open({ asset: { code: 'SHOP', issuer: 'G1' }, holder: 'G3', amount: '80', redemptionId: 'red_1', deadline: 1 });
    expect(built.fn).toBe('open_return');
    await g.escrow!.confirm({ redemptionId: 'red_1', issuer: 'G1' });
    await g.escrow!.reject({ redemptionId: 'red_1', issuer: 'G1' });
    await g.escrow!.expire({ redemptionId: 'red_1', source: 'G3' });
    const r = await g.escrow!.getReturn('red_fixture0001');
    expect(r.return?.status).toBe('OPEN');
    expect(f.mock.calls.map((c) => c[0])).toEqual([
      'http://stellar.test/gateway/v1/escrow/open',
      'http://stellar.test/gateway/v1/escrow/confirm',
      'http://stellar.test/gateway/v1/escrow/reject',
      'http://stellar.test/gateway/v1/escrow/expire',
      'http://stellar.test/gateway/v1/escrow/returns/red_fixture0001',
    ]);
  });

  it('escrow: ESCROW_UNAVAILABLE becomes a typed GatewayError; a malformed body fails closed', async () => {
    const unavailable = { error: { code: 'ESCROW_UNAVAILABLE', message: 'not configured' } };
    const g = new HttpStellarGateway({ baseUrl: 'http://s', token: 't', fetchImpl: vi.fn().mockResolvedValue(json(unavailable, 422)) as unknown as typeof fetch, escrow: true });
    const e = await g.escrow!.open({ asset: { code: 'SHOP', issuer: 'G1' }, holder: 'G3', amount: '1', redemptionId: 'red_1', deadline: 1 }).catch((x) => x);
    expect(e).toBeInstanceOf(GatewayError);
    expect(e.code).toBe('ESCROW_UNAVAILABLE');
    const bad = { ...fx('escrow-built'), fn: 'drain' };
    const g2 = new HttpStellarGateway({ baseUrl: 'http://s', token: 't', fetchImpl: vi.fn().mockResolvedValue(json(bad)) as unknown as typeof fetch, escrow: true });
    await expect(g2.escrow!.confirm({ redemptionId: 'red_1', issuer: 'G1' })).rejects.toThrow(/contract/);
  });
});
