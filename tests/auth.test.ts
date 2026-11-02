import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { createHttpServer } from '../src/http/server.js';
import { LOCK_MS, MAX_FAILURES } from '../src/modules/auth/service.js';
import { makeWorld } from './helpers.js';

const PW = 'correct horse battery staple';
let server: Server | undefined;
afterEach(() => new Promise<void>((r) => (server ? server.close(() => r()) : r())));

describe('credential auth for merchants and admins', () => {
  it('register -> login -> apply -> admin verifies -> merchant context resolves; nothing is granted before verification', async () => {
    const w = makeWorld();
    await w.app.auth.registerMerchant({ email: 'Owner@Example.invalid', password: PW }, 'r');
    const { token } = await w.app.auth.login({ email: 'owner@example.invalid', password: PW }, 'r');
    const actor = (await w.app.authenticate(token))!;
    expect(actor).toMatchObject({ role: 'merchant' });
    expect(actor.merchantId).toBeUndefined();
    const m = await w.app.issuers.apply(actor, { legalName: 'Owner Roasters', jurisdiction: 'Testland', contact: 'o@example.invalid' }, 'r');
    expect((await w.app.authenticate(token))!.merchantId).toBe(m.id);
    // not verified yet: cannot register a credit
    await expect(
      w.app.issuers.registerProgram((await w.app.authenticate(token))!, { assetCode: 'SHOP', issuerPublicKey: w.issuerKp.publicKey(), policy: w.policyFor(w.issuerKp, 'SHOP') }, 'r'),
    ).rejects.toMatchObject({ code: 'MERCHANT_NOT_VERIFIED' });
    await w.app.issuers.verifyMerchant(w.admin, m.id, 'EVIDENCE-1', 'r');
    const program = await w.app.issuers.registerProgram((await w.app.authenticate(token))!, { assetCode: 'SHOP', issuerPublicKey: w.issuerKp.publicKey(), policy: w.policyFor(w.issuerKp, 'SHOP') }, 'r');
    expect(program.status).toBe('ACTIVE');
  });

  it('rejects wrong passwords and unknown emails with the same generic error', async () => {
    const w = makeWorld();
    await w.app.auth.registerMerchant({ email: 'a@example.invalid', password: PW }, 'r');
    const e1 = await w.app.auth.login({ email: 'a@example.invalid', password: 'wrong password 123' }, 'r').catch((e) => e);
    const e2 = await w.app.auth.login({ email: 'nobody@example.invalid', password: 'wrong password 123' }, 'r').catch((e) => e);
    expect([e1.code, e1.message]).toEqual([e2.code, e2.message]);
    expect(e1.code).toBe('UNAUTHENTICATED');
  });

  it('locks an account after repeated failures, even for the right password, then unlocks', async () => {
    const w = makeWorld();
    await w.app.auth.registerMerchant({ email: 'b@example.invalid', password: PW }, 'r');
    for (let i = 0; i < MAX_FAILURES; i++) {
      await expect(w.app.auth.login({ email: 'b@example.invalid', password: 'bad password 12345' }, 'r')).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
    }
    await expect(w.app.auth.login({ email: 'b@example.invalid', password: PW }, 'r')).rejects.toThrow(/too many attempts/);
    w.t.ms += LOCK_MS + 1;
    await expect(w.app.auth.login({ email: 'b@example.invalid', password: PW }, 'r')).resolves.toHaveProperty('token');
  });

  it('enforces the password policy and unique emails; stores no plaintext', async () => {
    const w = makeWorld();
    await expect(w.app.auth.registerMerchant({ email: 'c@example.invalid', password: 'short' }, 'r')).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    await expect(w.app.auth.registerMerchant({ email: 'not-an-email', password: PW }, 'r')).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    await w.app.auth.registerMerchant({ email: 'c@example.invalid', password: PW }, 'r');
    await expect(w.app.auth.registerMerchant({ email: 'C@example.invalid', password: PW }, 'r')).rejects.toMatchObject({ code: 'INVALID_STATE' });
    const dump = JSON.stringify([await w.app.storage.repo('accounts').list(), await w.app.audit.all()]);
    expect(dump).not.toContain(PW);
    expect(dump).toContain('scrypt$');
  });

  it('only admins create accounts; bootstrap admin works once', async () => {
    const w = makeWorld();
    await expect(w.app.auth.createAccount({ id: 'x', role: 'merchant' }, { email: 'd@example.invalid', password: PW }, 'admin', 'r')).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(w.app.auth.createAccount(undefined, { email: 'd@example.invalid', password: PW }, 'admin', 'r')).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
    expect(await w.app.auth.bootstrapAdmin('root@example.invalid', PW)).toBe(true);
    expect(await w.app.auth.bootstrapAdmin('root2@example.invalid', PW)).toBe(false);
    const { token } = await w.app.auth.login({ email: 'root@example.invalid', password: PW }, 'r');
    const admin = (await w.app.authenticate(token))!;
    expect(admin.role).toBe('admin');
    await expect(w.app.auth.createAccount(admin, { email: 'e@example.invalid', password: PW }, 'merchant', 'r')).resolves.toMatchObject({ role: 'merchant' });
  });

  it('logout revokes the session; disabled accounts cannot log in', async () => {
    const w = makeWorld();
    const acct = await w.app.auth.registerMerchant({ email: 'f@example.invalid', password: PW }, 'r');
    const { token } = await w.app.auth.login({ email: 'f@example.invalid', password: PW }, 'r');
    await w.app.auth.logout(token);
    expect(await w.app.authenticate(token)).toBeUndefined();
    await w.app.auth.disable(w.admin, acct.id, 'r');
    await expect(w.app.auth.login({ email: 'f@example.invalid', password: PW }, 'r')).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
  });

  it('works end to end over HTTP', async () => {
    const w = makeWorld();
    server = createHttpServer(w.app);
    await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const post = async (path: string, body: unknown, token?: string) => {
      const res = await fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) });
      return { status: res.status, json: (await res.json()) as Record<string, unknown> };
    };
    expect((await post('/v1/auth/register', { email: 'g@example.invalid', password: PW })).status).toBe(201);
    expect((await post('/v1/auth/login', { email: 'g@example.invalid', password: 'nope nope nope nope' })).status).toBe(401);
    const login = await post('/v1/auth/login', { email: 'g@example.invalid', password: PW });
    const token = login.json.token as string;
    expect((await post('/v1/merchants/apply', { legalName: 'G Shop', jurisdiction: 'Testland', contact: 'g@example.invalid' }, token)).status).toBe(201);
    expect((await post('/v1/admin/accounts', { email: 'h@example.invalid', password: PW, role: 'admin' }, token)).status).toBe(403);
    expect((await post('/v1/auth/logout', {}, token)).status).toBe(200);
    expect((await post('/v1/merchants/apply', { legalName: 'G Shop', jurisdiction: 'Testland', contact: 'g@example.invalid' }, token)).status).toBe(401);
  });
});
