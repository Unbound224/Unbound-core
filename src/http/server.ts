import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import type { App } from '../app.js';
import type { Actor } from '../common/auth.js';
import { ApiError } from '../common/errors.js';
import { requireRole } from '../common/auth.js';
import { allowOrigin, CORS_ALLOWED_HEADERS, CORS_ALLOWED_METHODS, CORS_MAX_AGE_SECS, type CorsPolicy } from './cors.js';

const MAX_BODY = 64 * 1024;

interface Ctx {
  app: App;
  actor: Actor | undefined;
  requestId: string;
  params: string[];
  query: URLSearchParams;
  body: unknown;
  idempotencyKey: string;
  token: string | undefined;
}
type Handler = (c: Ctx) => Promise<{ status: number; body: unknown }>;
interface Route {
  method: string;
  pattern: RegExp;
  handler: Handler;
}

const ok = (body: unknown, status = 200) => ({ status, body });

/** Public projection: no internal fingerprints, keys or unsigned payload bookkeeping beyond what a client needs. */
const publicIntent = (i: Awaited<ReturnType<App['exchange']['getIntent']>>) => ({
  id: i.id,
  schemaVersion: i.schemaVersion,
  requestId: i.requestId,
  state: i.state,
  quoteId: i.quoteId,
  sourceAccount: i.sourceAccount,
  destinationAccount: i.destinationAccount,
  txHash: i.txHash ?? null,
  unsignedXdr: i.state === 'AWAITING_SIGNATURE' ? (i.unsignedXdr ?? null) : null,
  failureReason: i.failureReason ?? null,
  ledger: i.ledger ?? null,
  amountOutActual: i.amountOutActual ?? null,
  createdAt: i.createdAt,
  updatedAt: i.updatedAt,
});

const asObj = (b: unknown): Record<string, unknown> => {
  if (!b || typeof b !== 'object' || Array.isArray(b)) throw new ApiError('VALIDATION_FAILED', 'JSON object body required');
  return b as Record<string, unknown>;
};
const str = (o: Record<string, unknown>, k: string): string => {
  const v = o[k];
  if (typeof v !== 'string') throw new ApiError('VALIDATION_FAILED', `${k} must be a string`);
  return v;
};

const routes: Route[] = [
  { method: 'POST', pattern: /^\/v1\/merchants\/apply$/, handler: async (c) => ok(await c.app.issuers.apply(c.actor, c.body, c.requestId), 201) },
  {
    method: 'GET',
    pattern: /^\/v1\/assets$/,
    handler: async (c) => {
      const issuer = c.query.get('issuer') ?? undefined;
      const list = await c.app.issuers.listAssets(issuer ? { issuer } : {});
      return ok({ assets: list.map(publicAsset) });
    },
  },
  { method: 'GET', pattern: /^\/v1\/targets$/, handler: async (c) => ok({ targets: await c.app.issuers.listTargets() }) },
  { method: 'GET', pattern: /^\/v1\/assets\/([\w-]+)$/, handler: async (c) => ok(publicAsset(await c.app.issuers.getAsset(c.params[0]!))) },
  {
    method: 'POST',
    pattern: /^\/v1\/wallets\/challenge$/,
    handler: async (c) => ok(await c.app.wallets.createChallenge(str(asObj(c.body), 'publicKey'))),
  },
  {
    method: 'POST',
    pattern: /^\/v1\/wallets\/verify$/,
    handler: async (c) => {
      const b = asObj(c.body);
      const v = await c.app.wallets.verifyChallenge(str(b, 'challengeId'), str(b, 'signature'), c.requestId);
      return ok({ token: v.token, userId: v.actor.id, publicKey: v.binding.publicKey });
    },
  },
  { method: 'GET', pattern: /^\/v1\/portfolio$/, handler: async (c) => ok(await c.app.portfolio.get(c.actor)) },
  {
    method: 'POST',
    pattern: /^\/v1\/exchange\/quote$/,
    handler: async (c) => {
      const s = await c.app.exchange.quote(c.actor, c.body, c.requestId);
      return ok({ quote: s.quote, requestId: c.requestId }, 201);
    },
  },
  {
    method: 'POST',
    pattern: /^\/v1\/exchange\/intents$/,
    handler: async (c) => {
      const b = asObj(c.body);
      const i = await c.app.exchange.createIntent(c.actor, { quoteId: str(b, 'quoteId'), idempotencyKey: c.idempotencyKey }, c.requestId);
      return ok(publicIntent(i), 201);
    },
  },
  { method: 'GET', pattern: /^\/v1\/exchange\/intents\/([\w-]+)$/, handler: async (c) => ok(publicIntent(await c.app.exchange.getIntent(c.actor, c.params[0]!))) },
  {
    method: 'POST',
    pattern: /^\/v1\/exchange\/intents\/([\w-]+)\/submit$/,
    handler: async (c) => {
      const i = await c.app.exchange.submit(c.actor, c.params[0]!, { signedXdr: str(asObj(c.body), 'signedXdr'), submitKey: c.idempotencyKey }, c.requestId);
      // SUBMITTED / RECONCILING are honest, in-flight answers (202), never a fake success
      return ok(publicIntent(i), i.state === 'CONFIRMED' || i.state === 'FAILED' ? 200 : 202);
    },
  },
  {
    method: 'POST',
    pattern: /^\/v1\/redemptions$/,
    handler: async (c) => ok(publicRedemption(await c.app.redemption.create(c.actor, c.body, c.idempotencyKey, c.requestId), c.app.clock.now()), 201),
  },
  { method: 'GET', pattern: /^\/v1\/redemptions\/([\w-]+)$/, handler: async (c) => ok(publicRedemption(await c.app.redemption.get(c.actor, c.params[0]!), c.app.clock.now())) },
  {
    method: 'POST',
    pattern: /^\/v1\/redemptions\/([\w-]+)\/return$/,
    handler: async (c) => ok(publicRedemption(await c.app.redemption.submitReturn(c.actor, c.params[0]!, str(asObj(c.body), 'signedXdr'), c.requestId), c.app.clock.now()), 202),
  },
  {
    method: 'GET',
    pattern: /^\/v1\/merchants\/me\/redemptions$/,
    handler: async (c) => ok({ redemptions: (await c.app.redemption.listForMerchant(c.actor)).map((r) => publicRedemption(r, c.app.clock.now())) }),
  },
  {
    method: 'POST',
    pattern: /^\/v1\/merchants\/me\/redemptions\/([\w-]+)\/confirm$/,
    handler: async (c) => {
      const r = await c.app.redemption.merchantConfirm(c.actor, c.params[0]!, c.requestId);
      // escrow mode: 202 with the issuer transaction to sign; FULFILLED only after the ledger confirms it
      return ok(publicRedemption(r, c.app.clock.now()), r.state === 'FULFILLED' ? 200 : 202);
    },
  },
  {
    method: 'POST',
    pattern: /^\/v1\/merchants\/me\/redemptions\/([\w-]+)\/reject$/,
    handler: async (c) => {
      const r = await c.app.redemption.merchantReject(c.actor, c.params[0]!, str(asObj(c.body), 'reason'), c.requestId);
      return ok(publicRedemption(r, c.app.clock.now()), r.state === 'REJECTED' ? 200 : 202);
    },
  },
  {
    method: 'POST',
    pattern: /^\/v1\/merchants\/me\/redemptions\/([\w-]+)\/escrow\/submit$/,
    handler: async (c) => ok(publicRedemption(await c.app.redemption.submitEscrowAction(c.actor, c.params[0]!, str(asObj(c.body), 'signedXdr'), c.requestId), c.app.clock.now()), 202),
  },
  {
    method: 'POST',
    pattern: /^\/v1\/redemptions\/([\w-]+)\/refund$/,
    handler: async (c) => ok(publicRedemption(await c.app.redemption.claimRefund(c.actor, c.params[0]!, c.requestId), c.app.clock.now()), 202),
  },
  {
    method: 'POST',
    pattern: /^\/v1\/redemptions\/([\w-]+)\/escrow\/submit$/,
    handler: async (c) => ok(publicRedemption(await c.app.redemption.submitEscrowAction(c.actor, c.params[0]!, str(asObj(c.body), 'signedXdr'), c.requestId), c.app.clock.now()), 202),
  },
  {
    method: 'POST',
    pattern: /^\/v1\/auth\/register$/,
    handler: async (c) => ok(await c.app.auth.registerMerchant(c.body, c.requestId), 201),
  },
  { method: 'POST', pattern: /^\/v1\/auth\/password-reset$/, handler: async (c) => ok(await c.app.auth.requestPasswordReset(c.body, c.requestId), 202) },
  { method: 'POST', pattern: /^\/v1\/auth\/password-reset\/confirm$/, handler: async (c) => ok(await c.app.auth.confirmPasswordReset(c.body, c.requestId)) },
  { method: 'POST', pattern: /^\/v1\/auth\/login$/, handler: async (c) => ok(await c.app.auth.login(c.body, c.requestId)) },
  { method: 'POST', pattern: /^\/v1\/auth\/mfa\/enroll$/, handler: async (c) => ok(await c.app.auth.enrollMfa(c.actor, c.requestId), 201) },
  { method: 'POST', pattern: /^\/v1\/auth\/mfa\/activate$/, handler: async (c) => ok(await c.app.auth.activateMfa(c.actor, c.body, c.requestId)) },
  { method: 'POST', pattern: /^\/v1\/auth\/mfa\/disable$/, handler: async (c) => ok(await c.app.auth.disableMfa(c.actor, c.body, c.requestId)) },
  {
    method: 'POST',
    pattern: /^\/v1\/auth\/logout$/,
    handler: async (c) => {
      await c.app.auth.logout(c.token);
      return ok({ ok: true });
    },
  },
  {
    method: 'POST',
    pattern: /^\/v1\/admin\/accounts$/,
    handler: async (c) => {
      const b = asObj(c.body);
      const role = b.role === 'admin' ? 'admin' : b.role === 'merchant' ? 'merchant' : undefined;
      if (!role) throw new ApiError('VALIDATION_FAILED', 'role must be admin or merchant');
      return ok(await c.app.auth.createAccount(c.actor, { email: b.email, password: b.password }, role, c.requestId), 201);
    },
  },
  { method: 'POST', pattern: /^\/v1\/disputes$/, handler: async (c) => ok(await c.app.disputes.open(c.actor, c.body, c.requestId), 201) },
  { method: 'GET', pattern: /^\/v1\/disputes$/, handler: async (c) => ok({ disputes: await c.app.disputes.list(c.actor) }) },
  { method: 'GET', pattern: /^\/v1\/disputes\/([\w-]+)$/, handler: async (c) => ok(await c.app.disputes.get(c.actor, c.params[0]!)) },
  { method: 'POST', pattern: /^\/v1\/disputes\/([\w-]+)\/messages$/, handler: async (c) => ok(await c.app.disputes.addMessage(c.actor, c.params[0]!, c.body, c.requestId), 201) },
  { method: 'POST', pattern: /^\/v1\/disputes\/([\w-]+)\/withdraw$/, handler: async (c) => ok(await c.app.disputes.withdraw(c.actor, c.params[0]!, c.requestId)) },
  { method: 'POST', pattern: /^\/v1\/admin\/disputes\/([\w-]+)\/resolve$/, handler: async (c) => ok(await c.app.disputes.resolve(c.actor, c.params[0]!, c.body, c.requestId)) },
  // --- additive endpoints (not in the initial SRD list; documented in openapi) ---
  {
    method: 'POST',
    pattern: /^\/v1\/merchants\/me\/assets$/,
    handler: async (c) => {
      const b = asObj(c.body);
      const p = await c.app.issuers.registerProgram(c.actor, { assetCode: str(b, 'assetCode'), issuerPublicKey: str(b, 'issuerPublicKey'), policy: b.policy }, c.requestId);
      return ok(publicAsset(p), 201);
    },
  },
  {
    method: 'GET',
    pattern: /^\/v1\/admin\/merchants$/,
    handler: async (c) => ok({ merchants: (await c.app.issuers.listMerchants(c.actor)).map((m) => ({ id: m.id, legalName: m.legalName, jurisdiction: m.jurisdiction, contact: m.contact, status: m.status, createdAt: m.createdAt, updatedAt: m.updatedAt })) }),
  },
  {
    method: 'POST',
    pattern: /^\/v1\/admin\/merchants\/([\w-]+)\/revoke$/,
    handler: async (c) => {
      await c.app.issuers.revokeMerchant(c.actor, c.params[0]!, str(asObj(c.body), 'reason'), c.requestId);
      return ok({ ok: true });
    },
  },
  {
    method: 'POST',
    pattern: /^\/v1\/admin\/targets$/,
    handler: async (c) => {
      const b = asObj(c.body);
      const code = str(b, 'code');
      const issuer = str(b, 'issuer');
      if (!/^[A-Za-z0-9]{1,12}$/.test(code) || !/^G[A-Z2-7]{55}$/.test(issuer)) throw new ApiError('VALIDATION_FAILED', 'code must be 1-12 alphanumerics and issuer a Stellar public key');
      await c.app.issuers.addSupportedTarget(c.actor, { code, issuer }, c.requestId);
      return ok({ code, issuer }, 201);
    },
  },
  {
    method: 'POST',
    pattern: /^\/v1\/admin\/merchants\/([\w-]+)\/verify$/,
    handler: async (c) => ok(await c.app.issuers.verifyMerchant(c.actor, c.params[0]!, str(asObj(c.body), 'evidenceRef'), c.requestId)),
  },
  {
    method: 'GET',
    pattern: /^\/v1\/admin\/jobs$/,
    handler: async (c) => {
      requireRole(c.actor, 'admin');
      return ok({ jobs: c.app.jobs.status() });
    },
  },
  {
    method: 'POST',
    pattern: /^\/v1\/admin\/jobs\/([a-z0-9-]+)\/run$/,
    handler: async (c) => {
      const admin = requireRole(c.actor, 'admin');
      if (!c.app.jobs.has(c.params[0]!)) throw new ApiError('NOT_FOUND', 'unknown job');
      const s = await c.app.jobs.runNow(c.params[0]!);
      await c.app.audit.record(admin, 'jobs', 'JOB_RUN_REQUESTED', s.name, c.requestId);
      return ok(s);
    },
  },
  {
    method: 'POST',
    pattern: /^\/v1\/admin\/ledger-events$/,
    handler: async (c) => {
      requireRole(c.actor, 'admin');
      const r = await c.app.reconciliation.ingest(c.body, c.requestId);
      return ok({ duplicate: r.duplicate, outcome: r.observation.outcome }, r.duplicate ? 200 : 201);
    },
  },
];

function publicAsset(p: Awaited<ReturnType<App['issuers']['getAsset']>>) {
  return { id: p.id, assetCode: p.assetCode, issuer: p.issuerPublicKey, status: p.status, policy: p.policy };
}

function publicRedemption(r: Awaited<ReturnType<App['redemption']['get']>>, now: Date = new Date()) {
  const e = r.escrow;
  return {
    id: r.id,
    state: r.state,
    asset: r.asset,
    amount: r.amount,
    holder: r.holder,
    returnTxHash: r.returnTxHash ?? null,
    unsignedXdr: r.state === 'AWAITING_RETURN' ? (r.unsignedXdr ?? null) : null,
    refundDue: r.refundDue ?? false,
    rejectionReason: r.rejectionReason ?? null,
    mode: r.mode ?? 'NATIVE',
    escrow: e
      ? {
          contractId: e.contractId,
          deadline: new Date(e.deadline * 1000).toISOString(),
          state: e.state,
          refundAvailable: e.state === 'HELD' && !e.pending && now.getTime() >= e.deadline * 1000,
          pendingAction: e.pending?.action ?? null,
          pendingXdr: e.pending?.xdr ?? null,
          pendingTxHash: e.pending?.hash ?? null,
          closeTxHash: e.closeTxHash ?? null,
          lastFailure: e.lastFailure ?? null,
        }
      : null,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  if (req.method === 'GET' || req.method === 'HEAD') return undefined;
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY) throw new ApiError('PAYLOAD_TOO_LARGE', 'request body too large');
    chunks.push(chunk as Buffer);
  }
  if (size === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new ApiError('VALIDATION_FAILED', 'body is not valid JSON');
  }
}

export interface HttpServerOptions {
  /** CORS for browser clients; omitted = no CORS headers (same-origin only). */
  cors?: CorsPolicy;
}

export function createHttpServer(app: App, opts: HttpServerOptions = {}): Server {
  return createServer((req, res) => void handle(app, req, res, opts));
}

async function handle(app: App, req: IncomingMessage, res: ServerResponse, opts: HttpServerOptions): Promise<void> {
  const inbound = req.headers['x-request-id'];
  const requestId = typeof inbound === 'string' && /^[\w.-]{1,64}$/.test(inbound) ? inbound : `req_${randomUUID().replaceAll('-', '')}`;
  const allowed = allowOrigin(opts.cors, typeof req.headers.origin === 'string' ? req.headers.origin : undefined);
  const cors: Record<string, string> = opts.cors
    ? { vary: 'Origin', ...(allowed ? { 'access-control-allow-origin': allowed, 'access-control-expose-headers': 'x-request-id' } : {}) }
    : {};
  const send = (status: number, body: unknown) => {
    res.writeHead(status, { 'content-type': 'application/json', 'x-request-id': requestId, 'cache-control': 'no-store', ...cors });
    res.end(JSON.stringify(body));
  };
  if (req.method === 'OPTIONS') {
    if (!allowed) return send(403, { error: { code: 'FORBIDDEN', message: 'origin not allowed', requestId } });
    res.writeHead(204, {
      ...cors,
      'access-control-allow-methods': CORS_ALLOWED_METHODS,
      'access-control-allow-headers': CORS_ALLOWED_HEADERS,
      'access-control-max-age': String(CORS_MAX_AGE_SECS),
      'x-request-id': requestId,
    });
    return void res.end();
  }
  try {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (req.method === 'GET' && url.pathname === '/healthz') return send(200, { status: 'ok', paused: await app.guard.isPaused() });
    const matches = routes
      .map((r) => ({ r, m: r.pattern.exec(url.pathname) }))
      .filter((x): x is { r: Route; m: RegExpExecArray } => x.m !== null);
    if (matches.length === 0) throw new ApiError('NOT_FOUND', 'route not found');
    const hit = matches.find((x) => x.r.method === req.method);
    if (!hit) throw new ApiError('VALIDATION_FAILED', 'method not allowed for this route');
    const auth = req.headers.authorization;
    const token = auth?.startsWith('Bearer ') ? auth.slice(7) : undefined;
    const ik = req.headers['idempotency-key'];
    const out = await hit.r.handler({
      app,
      actor: await app.authenticate(token),
      requestId,
      params: hit.m.slice(1),
      query: url.searchParams,
      body: await readBody(req),
      idempotencyKey: typeof ik === 'string' ? ik : '',
      token,
    });
    send(out.status, out.body);
  } catch (e) {
    if (e instanceof ApiError) {
      send(e.httpStatus, { error: { code: e.code, message: e.message, requestId } });
    } else {
      // never leak internals
      send(500, { error: { code: 'INTERNAL', message: 'internal error', requestId } });
    }
  }
}
