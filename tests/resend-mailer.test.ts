import { describe, expect, it, vi } from 'vitest';
import { OutboxMailer } from '../src/common/mailer.js';
import { mailerFromEnv, ResendMailer } from '../src/integrations/resend-mailer.js';

const ok = () => vi.fn().mockResolvedValue({ ok: true, status: 200, text: async () => '{}' });

describe('ResendMailer', () => {
  it('posts the documented request with a bearer key and never puts the key in the body', async () => {
    const f = ok();
    await new ResendMailer({ apiKey: 're_test_key_1234', from: 'Unbound <no-reply@example.invalid>', fetchImpl: f as unknown as typeof fetch }).send({ to: 'a@example.invalid', subject: 'Hi', text: 'Body' });
    const [url, init] = f.mock.calls[0]!;
    expect(url).toBe('https://api.resend.com/emails');
    expect(init.method).toBe('POST');
    expect(init.headers.authorization).toBe('Bearer re_test_key_1234');
    expect(JSON.parse(init.body)).toEqual({ from: 'Unbound <no-reply@example.invalid>', to: ['a@example.invalid'], subject: 'Hi', text: 'Body' });
    expect(init.body).not.toContain('re_test_key_1234');
  });

  it('fails loudly on a provider refusal without leaking the key', async () => {
    const f = vi.fn().mockResolvedValue({ ok: false, status: 403, text: async () => 'domain not verified' });
    const m = new ResendMailer({ apiKey: 're_secret_value', from: 'no-reply@example.invalid', fetchImpl: f as unknown as typeof fetch });
    const err = await m.send({ to: 'a@example.invalid', subject: 's', text: 't' }).catch((e: Error) => e);
    expect((err as Error).message).toMatch(/HTTP 403.*domain not verified/);
    expect((err as Error).message).not.toContain('re_secret_value');
  });

  it('validates its configuration up front', () => {
    expect(() => new ResendMailer({ apiKey: '', from: 'no-reply@example.invalid' })).toThrow(/RESEND_API_KEY/);
    expect(() => new ResendMailer({ apiKey: 'k', from: 'not an address' })).toThrow(/MAIL_FROM/);
  });
});

describe('mailerFromEnv', () => {
  it('keeps the dev console outbox unless a provider is configured', () => {
    const dev = new OutboxMailer();
    expect(mailerFromEnv({}, dev)).toEqual({ mailer: dev, real: false });
    expect(mailerFromEnv({ MAIL_PROVIDER: 'console' }, dev).real).toBe(false);
    expect(mailerFromEnv({ MAIL_PROVIDER: 'resend', RESEND_API_KEY: 'k', MAIL_FROM: 'no-reply@example.invalid' }, dev).real).toBe(true);
    expect(() => mailerFromEnv({ MAIL_PROVIDER: 'sendgrid' }, dev)).toThrow(/unknown MAIL_PROVIDER/);
    expect(() => mailerFromEnv({ MAIL_PROVIDER: 'resend' }, dev)).toThrow(/RESEND_API_KEY/);
  });
});
