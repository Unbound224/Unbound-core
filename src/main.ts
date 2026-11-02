import { createApp } from './app.js';
import { createHttpServer } from './http/server.js';
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
const app = createApp({ gateway: new FakeStellarGateway(() => Date.now()) });
const port = Number(process.env.PORT ?? 3001);
createHttpServer(app).listen(port, '127.0.0.1', () => {
  console.log(`unbound-core DEV server on http://127.0.0.1:${port} (FakeStellarGateway, in-memory storage)`);
});
