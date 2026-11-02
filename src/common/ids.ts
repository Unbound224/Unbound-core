import { randomUUID } from 'node:crypto';

/** Opaque public reference: prefix + random UUID. Carries no information. */
export function newId(prefix: string): string {
  return `${prefix}_${randomUUID().replaceAll('-', '')}`;
}

export interface Clock {
  now(): Date;
}
export const systemClock: Clock = { now: () => new Date() };
