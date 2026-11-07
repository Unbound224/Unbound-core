export type ApiErrorCode =
  | 'VALIDATION_FAILED'
  | 'UNAUTHENTICATED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'INVALID_STATE'
  | 'IDEMPOTENCY_CONFLICT'
  | 'ASSET_NOT_ELIGIBLE'
  | 'MERCHANT_NOT_VERIFIED'
  | 'POLICY_INVALID'
  | 'QUOTE_EXPIRED'
  | 'NO_ROUTE'
  | 'GATEWAY_REJECTED'
  | 'UNKNOWN_NETWORK'
  | 'SENSITIVE_ACTIONS_PAUSED'
  | 'REDEMPTION_UNAVAILABLE'
  | 'CHALLENGE_INVALID'
  | 'MFA_REQUIRED'
  | 'PAYLOAD_TOO_LARGE'
  | 'INTERNAL';

const STATUS: Record<ApiErrorCode, number> = {
  VALIDATION_FAILED: 400,
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  INVALID_STATE: 409,
  IDEMPOTENCY_CONFLICT: 409,
  ASSET_NOT_ELIGIBLE: 422,
  MERCHANT_NOT_VERIFIED: 422,
  POLICY_INVALID: 422,
  QUOTE_EXPIRED: 410,
  NO_ROUTE: 422,
  GATEWAY_REJECTED: 422,
  UNKNOWN_NETWORK: 422,
  SENSITIVE_ACTIONS_PAUSED: 423,
  REDEMPTION_UNAVAILABLE: 422,
  CHALLENGE_INVALID: 401,
  MFA_REQUIRED: 401,
  PAYLOAD_TOO_LARGE: 413,
  INTERNAL: 500,
};

/** Safe, client-presentable error. `message` must never contain secrets or internals. */
export class ApiError extends Error {
  readonly httpStatus: number;
  constructor(
    readonly code: ApiErrorCode,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
    this.httpStatus = STATUS[code];
  }
}
