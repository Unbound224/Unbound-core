import { z } from 'zod';

export const RECONCILIATION_SCHEMA_VERSION = '1.0';

/**
 * Consumer-side copy of unbound-stellar's reconciliation event contract v1.0
 * (docs/ARCHITECTURE.md: {id, sourceRepo, schemaVersion, network, ledgerCursor, entityRef, status,
 * observedAt}). Kept in sync via the golden fixture in fixtures/ and a schema snapshot test.
 * Strict: unknown fields and unknown versions are rejected (fail closed).
 */
export const ReconciliationEventSchema = z
  .object({
    id: z.string().min(1),
    sourceRepo: z.literal('unbound-stellar'),
    schemaVersion: z.literal(RECONCILIATION_SCHEMA_VERSION),
    network: z.literal('TESTNET'),
    ledgerCursor: z.string().min(1),
    entityRef: z.object({ type: z.literal('transaction'), ref: z.string().regex(/^[0-9a-f]{64}$/) }).strict(),
    status: z.enum(['CONFIRMED', 'FAILED', 'RECONCILING']),
    observedAt: z.iso.datetime(),
    ledger: z.number().int().nonnegative().optional(),
    amountOutActual: z.string().regex(/^\d+\.\d{7}$/).optional(),
  })
  .strict();

export type ReconciliationEvent = z.infer<typeof ReconciliationEventSchema>;
