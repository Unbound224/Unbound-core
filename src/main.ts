import { createApp } from './app.js';
import { createHttpServer } from './http/server.js';
import { parseAllowedOrigins } from './http/cors.js';
import { OutboxMailer } from './common/mailer.js';
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
const mailer = new OutboxMailer((m) => console.log(`[dev-mail, NOT SENT] to=${m.to} subject="${m.subject}"\n${m.text}`));
const resetUrl = process.env.PASSWORD_RESET_URL ?? 'http://localhost:3000/merchant/reset-password';
const app = createApp({ gateway, storage, log: (l) => console.log(l), mail: { mailer, resetUrl }, ...(windowHours >= 1 && windowHours <= 720 ? { escrowWindowSecs: Math.floor(windowHours * 3600) } : {}) });
const adminEmail = process.env.BOOTSTRAP_ADMIN_EMAIL;
const adminPassword = process.env.BOOTSTRAP_ADMIN_PASSWORD;
if (adminEmail && adminPassword && (await app.auth.bootstrapAdmin(adminEmail, adminPassword))) {
  console.log(`bootstrap admin created for ${adminEmail}`);
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
