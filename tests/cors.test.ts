import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { allowOrigin, parseAllowedOrigins } from '../src/http/cors.js';
import { createHttpServer, type HttpServerOptions } from '../src/http/server.js';
import { makeWorld } from './helpers.js';

let server: Server | undefined;
afterEach(() => new Promise<void>((r) => (server ? server.close(() => r()) : r())));

async function boot(opts: HttpServerOptions) {
  const w = makeWorld();
  server = createHttpServer(w.app, opts);
  await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return (method: string, path: string, headers: Record<string, string> = {}) => fetch(base + path, { method, headers });
}

const CONSOLE = 'https://console.example.org';

describe('CORS', () => {
  it('parses a comma-separated origin list and refuses anything that is not a bare origin', () => {
    expect(parseAllowedOrigins(undefined)).toEqual([]);
    expect(parseAllowedOrigins(' ')).toEqual([]);
    expect(parseAllowedOrigins(`${CONSOLE}, http://localhost:3000/, ${CONSOLE}`)).toEqual([CONSOLE, 'http://localhost:3000']);
    expect(parseAllowedOrigins('*')).toEqual(['*']);
    expect(parseAllowedOrigins('HTTPS://X.Example')).toEqual(['https://x.example']);
    for (const bad of ['console.example.org', 'https://console.example.org/app', 'ftp://x.example', 'https://u:p@x.example', 'https://x.example?a=1']) {
      expect(() => parseAllowedOrigins(bad), bad).toThrow(/CORS_ALLOWED_ORIGINS/);
    }
  });

  it('matches origins exactly', () => {
    const p = { allowedOrigins: [CONSOLE] };
    expect(allowOrigin(p, CONSOLE)).toBe(CONSOLE);
    expect(allowOrigin(p, 'https://console.example.org.evil.test')).toBeUndefined();
    expect(allowOrigin(p, 'http://console.example.org')).toBeUndefined();
    expect(allowOrigin(p, 'https://console.example.org:8443')).toBeUndefined();
    expect(allowOrigin(p, 'null')).toBeUndefined();
    expect(allowOrigin(p, 'not a url')).toBeUndefined();
    expect(allowOrigin(undefined, CONSOLE)).toBeUndefined();
    expect(allowOrigin({ allowedOrigins: ['*'] }, 'https://anything.test')).toBe('*');
  });

  it('answers an allowed preflight with 204 and the allowed methods/headers, never credentials', async () => {
    const call = await boot({ cors: { allowedOrigins: [CONSOLE] } });
    const res = await call('OPTIONS', '/v1/merchants/me/redemptions', { origin: CONSOLE, 'access-control-request-method': 'POST', 'access-control-request-headers': 'authorization, idempotency-key' });
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-origin')).toBe(CONSOLE);
    expect(res.headers.get('access-control-allow-methods')).toContain('POST');
    expect(res.headers.get('access-control-allow-headers')).toContain('idempotency-key');
    expect(res.headers.get('access-control-max-age')).toBe('600');
    expect(res.headers.get('access-control-allow-credentials')).toBeNull();
    expect(res.headers.get('vary')).toBe('Origin');
  });

  it('refuses a preflight from another origin and sends no allow-origin on its requests', async () => {
    const call = await boot({ cors: { allowedOrigins: [CONSOLE] } });
    const pre = await call('OPTIONS', '/v1/assets', { origin: 'https://evil.test', 'access-control-request-method': 'GET' });
    expect(pre.status).toBe(403);
    expect(pre.headers.get('access-control-allow-origin')).toBeNull();
    const get = await call('GET', '/v1/assets', { origin: 'https://evil.test' });
    expect(get.status).toBe(200); // the server answers; the browser withholds it from the page
    expect(get.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('adds allow-origin and exposes x-request-id on actual responses, including errors', async () => {
    const call = await boot({ cors: { allowedOrigins: [CONSOLE] } });
    const ok = await call('GET', '/v1/assets', { origin: CONSOLE });
    expect(ok.headers.get('access-control-allow-origin')).toBe(CONSOLE);
    expect(ok.headers.get('access-control-expose-headers')).toBe('x-request-id');
    const err = await call('GET', '/v1/portfolio', { origin: CONSOLE });
    expect(err.status).toBe(401);
    expect(err.headers.get('access-control-allow-origin')).toBe(CONSOLE);
  });

  it('is off by default: no CORS headers at all', async () => {
    const call = await boot({});
    const res = await call('GET', '/v1/assets', { origin: CONSOLE });
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
    expect(res.headers.get('vary')).toBeNull();
    expect((await call('OPTIONS', '/v1/assets', { origin: CONSOLE })).status).toBe(403);
  });
});
