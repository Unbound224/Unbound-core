/* eslint-disable @typescript-eslint/no-explicit-any */
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { OutboxMailer } from '../src/common/mailer.js';
import { createHttpServer } from '../src/http/server.js';
import { RESET_MAX_PER_HOUR, RESET_TTL_MS } from '../src/modules/auth/service.js';
import { FakeStellarGateway } from '../src/testing/fake-gateway.js';

const EMAIL = 'owner@shop.example';
const OLD = 'old-password-0001';
const NEW = 'brand-new-password-0002';

async function world() {
  const t = { ms: Date.UTC(2026, 10, 3, 9) };
  const clock = { now: () => new Date(t.ms) };
  const mailer = new OutboxMailer();
  const app = createApp({ gateway: new FakeStellarGateway(() => t.ms), clock, mail: { mailer, resetUrl: 'https://console.example/reset-password' } });
  await app.auth.registerMerchant({ email: EMAIL, password: OLD }, 'r');
  const tokenFromMail = () => new URL(/https:\S+/.exec(mailer.sent.at(-1)!.text)![0]).searchParams.get('token')!;
  return { t, app, mailer, tokenFromMail };
}

describe('password reset', () => {
  it('emails a single-use link; the new password works, the old one does not, and sessions end', async () => {
    const { app, mailer, tokenFromMail } = await world();
    const session = await app.auth.login({ email: EMAIL, password: OLD }, 'r');
    expect(await app.auth.requestPasswordReset({ email: ' Owner@Shop.example ' }, 'r')).toEqual({ accepted: true });
    expect(mailer.sent).toHaveLength(1);
    expect(mailer.sent[0]).toMatchObject({ to: EMAIL, subject: expect.stringContaining('Reset') });
    const token = tokenFromMail();
    expect(token).toMatch(/^[\w-]{40,}$/);
    await app.auth.confirmPasswordReset({ token, password: NEW }, 'r');
    await expect(app.auth.login({ email: EMAIL, password: OLD }, 'r')).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
    expect((await app.auth.login({ email: EMAIL, password: NEW }, 'r')).role).toBe('merchant');
    expect(await app.authenticate(session.token)).toBeUndefined();
    await expect(app.auth.confirmPasswordReset({ token, password: 'another-password-03' }, 'r')).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
  });

  it('answers identically for unknown emails and sends nothing', async () => {
    const { app, mailer } = await world();
    expect(await app.auth.requestPasswordReset({ email: 'nobody@nowhere.example' }, 'r')).toEqual({ accepted: true });
    expect(mailer.sent).toHaveLength(0);
    await expect(app.auth.requestPasswordReset({ email: 'not-an-email' }, 'r')).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it('links expire after 30 minutes', async () => {
    const { t, app, tokenFromMail } = await world();
    await app.auth.requestPasswordReset({ email: EMAIL }, 'r');
    const token = tokenFromMail();
    t.ms += RESET_TTL_MS;
    await expect(app.auth.confirmPasswordReset({ token, password: NEW }, 'r')).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
  });

  it('using one link burns every other outstanding link for the account', async () => {
    const { app, tokenFromMail } = await world();
    await app.auth.requestPasswordReset({ email: EMAIL }, 'r');
    const first = tokenFromMail();
    await app.auth.requestPasswordReset({ email: EMAIL }, 'r');
    const second = tokenFromMail();
    await app.auth.confirmPasswordReset({ token: second, password: NEW }, 'r');
    await expect(app.auth.confirmPasswordReset({ token: first, password: 'another-password-03' }, 'r')).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
  });

  it('throttles reset emails per account per hour without telling the caller', async () => {
    const { t, app, mailer } = await world();
    for (let i = 0; i < RESET_MAX_PER_HOUR + 2; i++) expect(await app.auth.requestPasswordReset({ email: EMAIL }, 'r')).toEqual({ accepted: true });
    expect(mailer.sent).toHaveLength(RESET_MAX_PER_HOUR);
    t.ms += 3_600_001;
    await app.auth.requestPasswordReset({ email: EMAIL }, 'r');
    expect(mailer.sent).toHaveLength(RESET_MAX_PER_HOUR + 1);
  });

  it('rejects weak passwords and unknown tokens; clears a login lockout on success', async () => {
    const { app, tokenFromMail } = await world();
    for (let i = 0; i < 5; i++) await app.auth.login({ email: EMAIL, password: 'wrong-password-xx' }, 'r').catch(() => undefined);
    await expect(app.auth.login({ email: EMAIL, password: OLD }, 'r')).rejects.toThrow(/too many/);
    await app.auth.requestPasswordReset({ email: EMAIL }, 'r');
    const token = tokenFromMail();
    await expect(app.auth.confirmPasswordReset({ token, password: 'short' }, 'r')).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    await expect(app.auth.confirmPasswordReset({ token: 'x'.repeat(43), password: NEW }, 'r')).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
    await app.auth.confirmPasswordReset({ token, password: NEW }, 'r');
    expect((await app.auth.login({ email: EMAIL, password: NEW }, 'r')).role).toBe('merchant');
  });

  it('the audit trail records the reset without the token', async () => {
    const { app, tokenFromMail } = await world();
    await app.auth.requestPasswordReset({ email: EMAIL }, 'r');
    const token = tokenFromMail();
    await app.auth.confirmPasswordReset({ token, password: NEW }, 'r');
    const all = JSON.stringify(await app.audit.all());
    expect(all).toContain('PASSWORD_RESET_COMPLETED');
    expect(all).not.toContain(token);
  });

  describe('over HTTP', () => {
    let server: Server | undefined;
    afterEach(() => new Promise<void>((r) => (server ? server.close(() => r()) : r())));
    it('202 for any email, then confirm', async () => {
      const { app, tokenFromMail } = await world();
      server = createHttpServer(app);
      await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
      const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      const post = async (path: string, body: unknown) => {
        const res = await fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
        return { status: res.status, json: (await res.json()) as any };
      };
      expect((await post('/v1/auth/password-reset', { email: 'ghost@nowhere.example' })).status).toBe(202);
      expect((await post('/v1/auth/password-reset', { email: EMAIL })).json).toEqual({ accepted: true });
      expect((await post('/v1/auth/password-reset/confirm', { token: tokenFromMail(), password: NEW })).json).toEqual({ ok: true });
      expect((await post('/v1/auth/login', { email: EMAIL, password: NEW })).status).toBe(200);
    });
  });
});
