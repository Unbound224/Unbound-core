import { ApiError } from './errors.js';

const UNIT = 10_000_000n;
export const MAX_AMOUNT = 9223372036854775807n;

/** 7-dp decimal string -> integer base units. Never floats. */
export function parseAmount(text: string, opts: { allowZero?: boolean } = {}): bigint {
  if (typeof text !== 'string' || !/^\d+(\.\d{1,7})?$/.test(text)) {
    throw new ApiError('VALIDATION_FAILED', 'amount must be a non-negative decimal with at most 7 decimal places');
  }
  const [w = '0', f = ''] = text.split('.');
  const v = BigInt(w) * UNIT + BigInt(f.padEnd(7, '0'));
  if (v > MAX_AMOUNT) throw new ApiError('VALIDATION_FAILED', 'amount exceeds ledger maximum');
  if (v === 0n && !opts.allowZero) throw new ApiError('VALIDATION_FAILED', 'amount must be greater than zero');
  return v;
}

export function formatAmount(units: bigint): string {
  return `${units / UNIT}.${(units % UNIT).toString().padStart(7, '0')}`;
}
