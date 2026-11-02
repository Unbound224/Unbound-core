import { createApp } from './app.js';
import { createHttpServer } from './http/server.js';
import { InMemoryStorage, SqliteStorage } from './persistence/storage.js';
import { FakeStellarGateway } from './testing/fake-gateway.js';

/**
 * LOCAL DEVELOPMENT ENTRYPOINT ONLY. There is no unbound-stellar gateway implementation wired in
 * yet, so this runs with the labeled FakeStellarGateway: quotes and "transactions" are NOT real.
 * Storage is in-memory. Do not deploy.
 */
if ((process.env.APP_ENV ?? 'development') !== 'development') {
  console.error('Refusing to start: only APP_ENV=development is supported (no real gateway, in-memory storage).');
  process.exit(1);
}
const dbPath = process.env.DATABASE_FILE;
const storage = dbPath ? new SqliteStorage(dbPath) : new InMemoryStorage();
const app = createApp({ gateway: new FakeStellarGateway(() => Date.now()), storage });
const adminEmail = process.env.BOOTSTRAP_ADMIN_EMAIL;
const adminPassword = process.env.BOOTSTRAP_ADMIN_PASSWORD;
if (adminEmail && adminPassword && (await app.auth.bootstrapAdmin(adminEmail, adminPassword))) {
  console.log(`bootstrap admin created for ${adminEmail}`);
}
const port = Number(process.env.PORT ?? 3001);
createHttpServer(app).listen(port, '127.0.0.1', () => {
  console.log(`unbound-core DEV server on http://127.0.0.1:${port} (FakeStellarGateway, ${dbPath ? `SQLite ${dbPath}` : 'in-memory storage'})`);
});
