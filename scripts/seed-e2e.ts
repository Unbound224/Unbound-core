/**
 * Seeds a SQLite file for cross-repo end-to-end tests (used by unbound-site's live-core test).
 * SYNTHETIC ONLY: throwaway keys generated at run time; uses the FakeStellarGateway test adapter.
 * Creates the dev seed plus one holder with two redemptions: one whose return is ledger-confirmed
 * and one whose return outcome is still unknown (RETURN_SUBMITTED).
 */
import { Keypair } from '@stellar/stellar-sdk';
import { createApp } from '../src/app.js';
import { seedDev } from '../src/dev/seed.js';
import { SqliteStorage } from '../src/persistence/storage.js';
import { FakeStellarGateway } from '../src/testing/fake-gateway.js';

const need = (k: string): string => {
  const v = process.env[k];
  if (!v) throw new Error(`missing ${k}`);
  return v;
};

const storage = new SqliteStorage(need('DATABASE_FILE'));
const gateway = new FakeStellarGateway(() => Date.now());
const app = createApp({ gateway, storage });
const r = await seedDev(app, {
  adminEmail: need('BOOTSTRAP_ADMIN_EMAIL'),
  adminPassword: need('BOOTSTRAP_ADMIN_PASSWORD'),
  merchantEmail: need('SEED_MERCHANT_EMAIL'),
  merchantPassword: need('SEED_MERCHANT_PASSWORD'),
});
if (!r.seeded || !r.credit) throw new Error('database was already seeded');

const kp = Keypair.random();
const ch = await app.wallets.createChallenge(kp.publicKey());
const v = await app.wallets.verifyChallenge(ch.challengeId, Buffer.from(kp.sign(Buffer.from(ch.message))).toString('base64'), 'e2e');
const asset = r.credit;

const a = await app.redemption.create(v.actor, { asset, amount: '30', holder: kp.publicKey() }, 'e2e-redeem-ready', 'e2e');
await app.redemption.submitReturn(v.actor, a.id, `SIGNED:${a.unsignedXdr}`, 'e2e'); // fake gateway: confirmed

gateway.submitMode = 'timeout-after-apply';
const b = await app.redemption.create(v.actor, { asset, amount: '5', holder: kp.publicKey() }, 'e2e-redeem-waiting', 'e2e');
await app.redemption.submitReturn(v.actor, b.id, `SIGNED:${b.unsignedXdr}`, 'e2e'); // outcome unknown

console.log(JSON.stringify({ merchantId: r.merchantId, ready: a.id, waiting: b.id }));
storage.close();
