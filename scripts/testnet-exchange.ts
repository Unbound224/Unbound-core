/**
 * LIVE exchange run: core (HTTP) -> Stellar gateway -> Stellar Testnet DEX. Testnet and synthetic data only.
 * Preconditions (see Unbound-stellar/docs/DEPLOYMENT.md): the SHOP program is registered in core, the consumer holds SHOP,
 * a second asset (USDC from the `unbound-usdc-issuer` alias) exists with a Testnet DEX offer selling it for SHOP, and the
 * consumer has a USDC trustline. The consumer key is read in memory from the local stellar-cli keystore and never printed.
 *
 *   node --env-file=.env --import tsx scripts/testnet-exchange.ts
 */
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { Keypair, Networks, TransactionBuilder } from '@stellar/stellar-sdk';

const CORE = process.env.CORE_URL ?? 'http://127.0.0.1:3001';
const OUT = process.env.E2E_OUT ?? '../Unbound-stellar/contracts/deployments/testnet-exchange.json';
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const cli = (args: string[]): string => {
  const r = spawnSync('stellar', args, { encoding: 'utf8', cwd: tmpdir() });
  if (r.status !== 0) throw new Error(`stellar ${args[0]} ${args[1]} failed`);
  return r.stdout.trim();
};
function need(c: unknown, m: string, ctx?: unknown): asserts c {
  if (!c) throw new Error(`EXCHANGE E2E FAILED: ${m}${ctx !== undefined ? `\n${JSON.stringify(ctx, null, 2).slice(0, 1200)}` : ''}`);
}
async function call(method: string, path: string, o: { token?: string; body?: unknown; key?: string } = {}) {
  const res = await fetch(CORE + path, {
    method,
    headers: { 'content-type': 'application/json', ...(o.token ? { authorization: `Bearer ${o.token}` } : {}), ...(o.key ? { 'idempotency-key': o.key } : {}) },
    ...(o.body !== undefined ? { body: JSON.stringify(o.body) } : {}),
  });
  return { status: res.status, json: (await res.json()) as Json };
}
const login = async (email: string, password: string): Promise<string> => {
  const r = await call('POST', '/v1/auth/login', { body: { email, password } });
  need(r.json.token, 'login', r.json.error);
  return r.json.token as string;
};

async function main(): Promise<void> {
  const consumer = Keypair.fromSecret(cli(['keys', 'show', process.env.CONSUMER_ALIAS ?? 'unbound-consumer']));
  const issuer = cli(['keys', 'address', process.env.ISSUER_ALIAS ?? 'unbound-issuer']);
  const usdcIssuer = cli(['keys', 'address', process.env.TARGET_ISSUER_ALIAS ?? 'unbound-usdc-issuer']);
  const SHOP = { code: 'SHOP', issuer };
  const USDC = { code: 'USDC', issuer: usdcIssuer };

  const admin = await login(process.env.BOOTSTRAP_ADMIN_EMAIL!, process.env.BOOTSTRAP_ADMIN_PASSWORD!);
  const t = await call('POST', '/v1/admin/targets', { token: admin, body: USDC });
  need(t.status === 201, 'register the USDC swap target', t.json);
  need((await call('POST', '/v1/admin/jobs/sync-trusted-assets/run', { token: admin })).status === 200, 'trusted-asset sync');

  const ch = await call('POST', '/v1/wallets/challenge', { body: { publicKey: consumer.publicKey() } });
  const signature = Buffer.from(consumer.sign(Buffer.from(ch.json.message as string))).toString('base64');
  const v = await call('POST', '/v1/wallets/verify', { body: { challengeId: ch.json.challengeId, signature } });
  const token = v.json.token as string;
  need(token, 'wallet session', v.json);

  const q = await call('POST', '/v1/exchange/quote', {
    token,
    body: { schemaVersion: '1.0', requestId: `ex-${Date.now()}`, sourceAsset: SHOP, targetAsset: USDC, sourceAmount: '5.0000000', slippageBps: 100, destinationAccount: consumer.publicKey(), network: 'TESTNET' },
  });
  need(q.status === 201 && q.json.quote?.quoteId, 'quote from real Testnet DEX paths', q.json);
  const quote = q.json.quote as Json;
  console.log('quote issued', quote.issuedAt, 'expires', quote.expiresAt, 'local now', new Date().toISOString());
  const intent = await call('POST', '/v1/exchange/intents', { token, key: `ex-intent-${Date.now()}`, body: { quoteId: quote.quoteId } });
  need(intent.status === 201 && intent.json.unsignedXdr, 'intent with an unsigned settlement transaction', intent.json);
  const tx = TransactionBuilder.fromXDR(intent.json.unsignedXdr, Networks.TESTNET);
  tx.sign(consumer);
  console.log('signed at', new Date().toISOString());
  const sub = await call('POST', `/v1/exchange/intents/${intent.json.id}/submit`, { token, key: `ex-submit-${Date.now()}`, body: { signedXdr: tx.toXDR() } });
  need(sub.status === 200 || sub.status === 202, 'submit signed settlement', sub.json);
  let cur = sub.json;
  for (let i = 0; i < 30 && cur.state !== 'CONFIRMED' && cur.state !== 'FAILED'; i++) {
    await new Promise((r) => setTimeout(r, 4000));
    cur = (await call('GET', `/v1/exchange/intents/${intent.json.id}`, { token })).json;
  }
  need(cur.state === 'CONFIRMED', `intent confirmed (state ${cur.state})`, cur);
  const out = { network: 'testnet', startedAt: new Date().toISOString(), sourceAsset: `${SHOP.code}:${SHOP.issuer}`, targetAsset: `${USDC.code}:${USDC.issuer}`, holder: consumer.publicKey(), quote: { id: quote.quoteId, sourceAmount: quote.sourceAmount, expectedDestinationAmount: quote.expectedDestinationAmount, minDestinationAmount: quote.minDestinationAmount }, intent: { id: cur.id, state: cur.state, txHash: cur.txHash, ledger: cur.ledger, amountOutActual: cur.amountOutActual } };
  writeFileSync(OUT, JSON.stringify(out, null, 2) + '\n');
  console.log(`OK exchange CONFIRMED tx ${cur.txHash} ledger ${cur.ledger} out ${cur.amountOutActual}`);
}
main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
