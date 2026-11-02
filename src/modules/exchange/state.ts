import { ApiError } from '../../common/errors.js';

/** SRD lifecycle: DRAFT -> VERIFIED -> AWAITING_SIGNATURE -> SUBMITTED -> CONFIRMED; failures FAILED / RECONCILING. */
export type IntentState =
  | 'DRAFT'
  | 'VERIFIED'
  | 'AWAITING_SIGNATURE'
  | 'SUBMITTED'
  | 'RECONCILING'
  | 'CONFIRMED'
  | 'FAILED'
  | 'CANCELLED';

export const TERMINAL: ReadonlySet<IntentState> = new Set(['CONFIRMED', 'FAILED', 'CANCELLED']);

/**
 * Allowed transitions. SUBMITTED may never go back; RECONCILING may only resolve to a ledger
 * verdict; CONFIRMED/FAILED/CANCELLED are terminal. A chain-confirmed settlement that arrives for
 * an intent we had marked FAILED is NOT a transition: it is a discrepancy (see reconciliation).
 */
const NEXT: Record<IntentState, readonly IntentState[]> = {
  DRAFT: ['VERIFIED', 'FAILED', 'CANCELLED'],
  VERIFIED: ['AWAITING_SIGNATURE', 'FAILED', 'CANCELLED'],
  AWAITING_SIGNATURE: ['SUBMITTED', 'FAILED', 'CANCELLED'],
  SUBMITTED: ['CONFIRMED', 'FAILED', 'RECONCILING'],
  RECONCILING: ['CONFIRMED', 'FAILED'],
  CONFIRMED: [],
  FAILED: [],
  CANCELLED: [],
};

export function canTransition(from: IntentState, to: IntentState): boolean {
  return NEXT[from].includes(to);
}

export function assertTransition(from: IntentState, to: IntentState): void {
  if (!canTransition(from, to)) throw new ApiError('INVALID_STATE', `illegal transition ${from} -> ${to}`);
}
