import { createApp } from './app.js';
import { createHttpServer } from './http/server.js';
import { parseAllowedOrigins } from './http/cors.js';
import { OutboxMailer } from './common/mailer.js';
import { mailerFromEnv } from './integrations/resend-mailer.js';
import { SqliteJobLock } from './jobs/lock.js';
import { randomUUID } from 'node:crypto';
import { InMemoryStorage, SqliteStorage } from './persistence/storage.js';
import { HttpStellarGateway } from './integrations/stellar-http-gateway.js';
import { FakeStellarGateway } from './testing/fake-gateway.js';

/**
 * LOCAL DEVELOPMENT ENTRYPOINT ONLY. With STELLAR_GATEWAY_URL + STELLAR_GATEWAY_TOKEN set it talks to an
 * unbound-stellar gateway service; otherwise it runs with the labeled FakeStellarGateway (quotes and
 * "transactions" are NOT real). Do not deploy.
 */
if ((process.env.APP_ENV ?? 'development') !== 'development') {
  console.error('Refusing to start: only APP_ENV=development is supported (no real gateway, in-memory storage).');
  process.exit(1);
}
const dbPath = process.env.DATABASE_FILE;
const storage = dbPath ? new SqliteStorage(dbPath) : new InMemoryStorage();
const gatewayUrl = process.env.STELLAR_GATEWAY_URL;
const gatewayToken = process.env.STELLAR_GATEWAY_TOKEN;
// Soroban redemption escrow (ADR 0002): opt in per deployment; without it every redemption uses the native return.
const escrowEnabled = process.env.STELLAR_ESCROW_ENABLED === 'true';
const gateway =
  gatewayUrl && gatewayToken
    ? new HttpStellarGateway({ baseUrl: gatewayUrl, token: gatewayToken, escrow: escrowEnabled })
    : (() => {
        const fake = new FakeStellarGateway(() => Date.now());
        if (escrowEnabled) fake.enableEscrow();
        return fake;
      })();
const windowHours = Number(process.env.ESCROW_WINDOW_HOURS ?? 0);
// DEV ONLY: no email provider exists yet; reset emails are printed here instead of being sent.
const { mailer, real: realMail } = mailerFromEnv(process.env, new OutboxMailer((m) => console.log(`[dev-mail, NOT SENT] to=${m.to} subject="${m.subject}"\n${m.text}`)));
if (realMail) console.log('email: real provider configured (MAIL_PROVIDER)');
const resetUrl = process.env.PASSWORD_RESET_URL ?? 'http://localhost:3000/merchant/reset-password';
// Several core processes may share one SQLite file: a lease per job keeps each job single-flight across them.
const jobLock = storage instanceof SqliteStorage ? new SqliteJobLock(storage.db, `core-${process.pid}-${randomUUID().slice(0, 8)}`) : undefined;
// TOTP secrets are sealed at rest with MFA_ENCRYPTION_KEY (64 hex chars = 32 bytes). Without it they are stored unsealed: dev only.
const mfaKeyHex = process.env.MFA_ENCRYPTION_KEY;
if (mfaKeyHex !== undefined && !/^[0-9a-fA-F]{64}$/u.test(mfaKeyHex)) throw new Error('MFA_ENCRYPTION_KEY must be 64 hex characters (32 bytes)');
const mfaKey = mfaKeyHex ? Buffer.from(mfaKeyHex, 'hex') : undefined;
const app = createApp({ gateway, storage, ...(jobLock ? { jobLock } : {}), ...(mfaKey ? { mfaKey } : {}), log: (l) => console.log(l), mail: { mailer, resetUrl }, ...(windowHours >= 1 && windowHours <= 720 ? { escrowWindowSecs: Math.floor(windowHours * 3600) } : {}) });
const adminEmail = process.env.BOOTSTRAP_ADMIN_EMAIL;
const adminPassword = process.env.BOOTSTRAP_ADMIN_PASSWORD;
if (adminEmail && adminPassword) {
  try {
    if (await app.auth.bootstrapAdmin(adminEmail, adminPassword)) console.log(`bootstrap admin created for ${adminEmail}`);
  } catch (e) {
    // Say what is wrong without ever printing the secret: only lengths and whether there is stray whitespace.
    console.error(`BOOTSTRAP_ADMIN_* rejected: password has ${adminPassword.length} characters (needs 12 to 200; leading/trailing whitespace: ${adminPassword !== adminPassword.trim()}); email has ${adminEmail.length} characters (leading/trailing whitespace: ${adminEmail !== adminEmail.trim()}). Fix the environment variables and redeploy.`);
    throw e;
  }
}
const port = Number(process.env.PORT ?? 3001);
const allowedOrigins = parseAllowedOrigins(process.env.CORS_ALLOWED_ORIGINS); // throws on a malformed list
createHttpServer(app, allowedOrigins.length ? { cors: { allowedOrigins } } : {}).listen(port, process.env.HOST ?? '127.0.0.1', () => {
  console.log(`unbound-core DEV server on http://127.0.0.1:${port} (${gatewayUrl ? 'stellar gateway ' + gatewayUrl : 'FakeStellarGateway'}, ${dbPath ? `SQLite ${dbPath}` : 'in-memory storage'})`);
});
if (process.env.JOBS_ENABLED !== 'false') {
  app.jobs.start();
  console.log(`maintenance jobs: ${app.jobs.status().map((j) => j.name).join(', ')}`);
  // push the trusted-asset list to the gateway right away instead of waiting for the first interval
  if (app.jobs.status().some((j) => j.name === 'sync-trusted-assets')) await app.jobs.runNow('sync-trusted-assets');
}
