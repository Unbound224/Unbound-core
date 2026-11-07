import type { Mail, Mailer } from '../common/mailer.js';

/**
 * Real email adapter for the Resend HTTP API (https://resend.com/docs/api-reference/emails/send-email).
 * The owner chooses and pays for the provider; this adapter only needs RESEND_API_KEY and MAIL_FROM from the
 * environment. The key is never logged or included in errors. UNVERIFIED against the live provider (no account was
 * created by the build): the request shape follows the provider's documentation and is covered by a mocked-fetch test.
 */
export class ResendMailer implements Mailer {
  constructor(
    private readonly opts: { apiKey: string; from: string; endpoint?: string; fetchImpl?: typeof fetch; timeoutMs?: number },
  ) {
    if (!opts.apiKey) throw new Error('ResendMailer needs RESEND_API_KEY');
    if (!/^[^<>\s]+@[^<>\s]+$|^[^<>]+<[^<>\s]+@[^<>\s]+>$/.test(opts.from)) throw new Error('ResendMailer needs MAIL_FROM like "Unbound <no-reply@your-domain>"');
  }

  async send(mail: Mail): Promise<void> {
    const res = await (this.opts.fetchImpl ?? fetch)(this.opts.endpoint ?? 'https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${this.opts.apiKey}` },
      body: JSON.stringify({ from: this.opts.from, to: [mail.to], subject: mail.subject, text: mail.text }),
      signal: AbortSignal.timeout(this.opts.timeoutMs ?? 10_000),
    });
    if (!res.ok) {
      const detail = (await res.text().catch(() => '')).slice(0, 200);
      throw new Error(`email provider refused the message (HTTP ${res.status}) ${detail}`.trim());
    }
  }
}

/** Picks the mailer from the environment: the real provider when configured, otherwise the dev console outbox. */
export function mailerFromEnv(env: NodeJS.ProcessEnv, devFallback: Mailer): { mailer: Mailer; real: boolean } {
  if (env.MAIL_PROVIDER === 'resend') {
    return { mailer: new ResendMailer({ apiKey: env.RESEND_API_KEY ?? '', from: env.MAIL_FROM ?? '' }), real: true };
  }
  if (env.MAIL_PROVIDER && env.MAIL_PROVIDER !== 'console') throw new Error(`unknown MAIL_PROVIDER "${env.MAIL_PROVIDER}" (use "resend" or leave unset for the dev console outbox)`);
  return { mailer: devFallback, real: false };
}
