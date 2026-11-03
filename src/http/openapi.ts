import { z } from 'zod';
import { QuoteRequestSchema } from '../modules/exchange/service.js';
import { RedemptionPolicySchema } from '../modules/issuers/policy.js';
import { ApplySchema } from '../modules/issuers/service.js';
import { ReconciliationEventSchema } from '../modules/reconciliation/contract.js';
import { RedemptionCreateSchema } from '../modules/redemption/service.js';

const ref = (n: string) => ({ $ref: `#/components/schemas/${n}` });
const json = (schema: unknown) => ({ content: { 'application/json': { schema } } });
const err = { description: 'Error', ...json(ref('Error')) };
const idem = { name: 'Idempotency-Key', in: 'header', required: true, schema: { type: 'string', minLength: 8, maxLength: 128 } };
const secured = [{ bearerAuth: [] }];

interface Op {
  summary: string;
  req?: string;
  res?: string;
  status?: string;
  idem?: boolean;
  auth?: boolean;
  extra?: boolean;
}

function op(o: Op) {
  return {
    summary: o.summary + (o.extra ? ' (additive; not in the initial SRD list)' : ''),
    ...(o.auth === false ? {} : { security: secured }),
    ...(o.idem ? { parameters: [idem] } : {}),
    ...(o.req ? { requestBody: { required: true, ...json(ref(o.req)) } } : {}),
    responses: {
      [o.status ?? '200']: { description: 'OK', ...(o.res ? json(ref(o.res)) : {}) },
      default: err,
    },
  };
}

/** OpenAPI 3.1 document for the v1 contract. Schemas come from the same zod objects the server validates with. */
export function buildOpenApi() {
  return {
    openapi: '3.1.0',
    info: {
      title: 'Unbound core API',
      version: '1.0.0-draft',
      description:
        'Testnet-only. Writes that need an on-chain action return a STATEFUL intent, never a fake immediate success. Errors: {"error":{"code","message","requestId"}}.',
    },
    servers: [{ url: 'http://127.0.0.1:3001' }],
    paths: {
      '/v1/merchants/apply': { post: op({ summary: 'Apply as a merchant/issuer', req: 'MerchantApply', status: '201' }) },
      '/v1/assets': { get: op({ summary: 'List eligible redeemable assets (?issuer=)', auth: false }) },
      '/v1/targets': { get: op({ summary: 'Assets a holder may receive in an exchange (not redeemable credit)', auth: false, extra: true }) },
      '/v1/assets/{id}': { get: op({ summary: 'Get an eligible asset and its signed redemption policy', res: 'RedemptionPolicy', auth: false }) },
      '/v1/auth/register': { post: op({ summary: 'Register a merchant account (email + password >= 12 chars). Grants no authority until an admin verifies the merchant', status: '201', auth: false, extra: true }) },
      '/v1/auth/login': { post: op({ summary: 'Log in with email/password; returns a bearer token. Locks the account after repeated failures', auth: false, extra: true }) },
      '/v1/auth/password-reset': { post: op({ summary: 'Request a password-reset email. Always 202, whether or not the account exists. At most 3 per account per hour', status: '202', auth: false, extra: true }) },
      '/v1/auth/password-reset/confirm': { post: op({ summary: 'Set a new password with the single-use token from the email (valid 30 minutes). Ends all sessions of the account', auth: false, extra: true }) },
      '/v1/auth/logout': { post: op({ summary: 'Revoke the current session', extra: true }) },
      '/v1/admin/accounts': { post: op({ summary: 'Admin creates an admin or merchant account', status: '201', extra: true }) },
      '/v1/wallets/challenge': { post: op({ summary: 'Create a one-time wallet challenge', auth: false }) },
      '/v1/wallets/verify': { post: op({ summary: 'Verify a signed challenge and open a session', auth: false }) },
      '/v1/portfolio': { get: op({ summary: 'Ledger balances of the caller\'s bound wallets, classified: only REDEEMABLE credit has usable value' }) },
      '/v1/disputes': { post: op({ summary: 'Open a dispute on your own redemption or exchange (one live dispute per subject)', status: '201', extra: true }), get: op({ summary: 'List disputes visible to the caller', extra: true }) },
      '/v1/disputes/{id}': { get: op({ summary: 'Get a dispute', extra: true }) },
      '/v1/disputes/{id}/messages': { post: op({ summary: 'Add a message (holder, the disputed merchant, or admin)', status: '201', extra: true }) },
      '/v1/disputes/{id}/withdraw': { post: op({ summary: 'Holder withdraws their dispute', extra: true }) },
      '/v1/admin/disputes/{id}/resolve': { post: op({ summary: 'Admin records a ruling. Does not move funds', extra: true }) },
      '/v1/exchange/quote': { post: op({ summary: 'Indicative, expiring quote', req: 'QuoteRequest', status: '201' }) },
      '/v1/exchange/intents': { post: op({ summary: 'Create an exchange intent from a quote', idem: true, status: '201' }) },
      '/v1/exchange/intents/{id}': { get: op({ summary: 'Get intent state' }) },
      '/v1/exchange/intents/{id}/submit': {
        post: op({ summary: 'Submit the user-signed transaction. 200 terminal, 202 in flight (SUBMITTED/RECONCILING)', idem: true, status: '202' }),
      },
      '/v1/redemptions': { post: op({ summary: 'Request redemption of supported credit', req: 'RedemptionCreate', idem: true, status: '201' }) },
      '/v1/redemptions/{id}': { get: op({ summary: 'Get redemption state' }) },
      '/v1/redemptions/{id}/return': { post: op({ summary: 'Submit the user-signed return (burn) payment', status: '202', extra: true }) },
      '/v1/merchants/me/redemptions': { get: op({ summary: "List the calling merchant's redemptions" }) },
      '/v1/merchants/me/redemptions/{id}/confirm': {
        post: op({ summary: 'Merchant confirms fulfilment after the return is ledger-confirmed. NATIVE: 200 FULFILLED. ESCROW: 202 with escrow.pendingXdr (issuer-signed confirm invocation)' }),
      },
      '/v1/merchants/me/redemptions/{id}/reject': {
        post: op({ summary: 'Merchant rejects with a reason. NATIVE: 200 REJECTED with refundDue. ESCROW: 202 with the issuer-signed reject (on-chain refund)', extra: true }),
      },
      '/v1/merchants/me/redemptions/{id}/escrow/submit': { post: op({ summary: 'Submit the issuer-signed escrow confirm/reject transaction', status: '202', extra: true }) },
      '/v1/redemptions/{id}/refund': { post: op({ summary: 'Holder requests the escrow timeout refund (after the deadline); returns escrow.pendingXdr to sign', status: '202', extra: true }) },
      '/v1/redemptions/{id}/escrow/submit': { post: op({ summary: 'Submit the holder-signed escrow timeout refund', status: '202', extra: true }) },
      '/v1/merchants/me/assets': { post: op({ summary: 'Register a credit program with a signed redemption policy', status: '201', extra: true }) },
      '/v1/admin/merchants/{id}/verify': { post: op({ summary: 'Admin verifies a merchant with an evidence reference', extra: true }) },
      '/v1/admin/jobs': { get: op({ summary: 'Admin: status of the scheduled maintenance jobs', extra: true }) },
      '/v1/admin/jobs/{name}/run': { post: op({ summary: 'Admin: run a maintenance job now (never overlaps a running one)', extra: true }) },
      '/v1/admin/ledger-events': { post: op({ summary: 'Ingest a reconciliation event from unbound-stellar', req: 'ReconciliationEvent', status: '201', extra: true }) },
    },
    components: {
      securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer' } },
      schemas: {
        Error: {
          type: 'object',
          required: ['error'],
          properties: {
            error: {
              type: 'object',
              required: ['code', 'message', 'requestId'],
              properties: { code: { type: 'string' }, message: { type: 'string' }, requestId: { type: 'string' } },
            },
          },
        },
        MerchantApply: z.toJSONSchema(ApplySchema),
        QuoteRequest: z.toJSONSchema(QuoteRequestSchema),
        RedemptionCreate: z.toJSONSchema(RedemptionCreateSchema),
        RedemptionPolicy: z.toJSONSchema(RedemptionPolicySchema),
        ReconciliationEvent: z.toJSONSchema(ReconciliationEventSchema),
      },
    },
  };
}

export function openApiJson(): string {
  return JSON.stringify(buildOpenApi(), null, 2) + '\n';
}
