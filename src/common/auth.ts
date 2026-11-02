import { ApiError } from './errors.js';

export type Role = 'user' | 'merchant' | 'admin';

export interface Actor {
  id: string;
  role: Role;
  /** set for role=merchant */
  merchantId?: string;
}

export function requireRole(actor: Actor | undefined, ...roles: Role[]): Actor {
  if (!actor) throw new ApiError('UNAUTHENTICATED', 'authentication required');
  if (!roles.includes(actor.role)) throw new ApiError('FORBIDDEN', 'your role cannot perform this action');
  return actor;
}
