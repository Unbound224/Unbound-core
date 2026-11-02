import { createApp } from '../src/app.js';
import { seedDev } from '../src/dev/seed.js';
import { SqliteStorage } from '../src/persistence/storage.js';
import { FakeStellarGateway } from '../src/testing/fake-gateway.js';

const need = (k: string): string => {
  const v = process.env[k];
  if (!v) {
    console.error(`missing ${k} (set dev-only credentials in your shell; never commit them)`);
    process.exit(1);
  }
  return v;
};

const storage = new SqliteStorage(need('DATABASE_FILE'));
const app = createApp({ gateway: new FakeStellarGateway(() => Date.now()), storage });
const r = await seedDev(app, {
  adminEmail: need('BOOTSTRAP_ADMIN_EMAIL'),
  adminPassword: need('BOOTSTRAP_ADMIN_PASSWORD'),
  merchantEmail: need('SEED_MERCHANT_EMAIL'),
  merchantPassword: need('SEED_MERCHANT_PASSWORD'),
});
console.log(r.seeded ? `seeded merchant ${r.merchantId}; credit ${r.credit?.code}:${r.credit?.issuer}; target ${r.target?.code}:${r.target?.issuer}` : `already seeded (merchant ${r.merchantId})`);
storage.close();
