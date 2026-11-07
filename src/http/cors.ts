/**
 * CORS for browser clients (the unbound-site merchant console, a hosted docs playground). Off by
 * default: with no allowed origins configured no CORS headers are sent and browsers keep the
 * same-origin policy. Origins are matched exactly (scheme + host + port). Bearer tokens travel in the
 * Authorization header, never in cookies, so `Access-Control-Allow-Credentials` is never sent.
 */
export interface CorsPolicy {
  /** exact origins such as https://console.example.org; ['*'] allows any origin (public, read-mostly APIs only) */
  readonly allowedOrigins: readonly string[];
}

export const CORS_ALLOWED_METHODS = 'GET, POST, PUT, OPTIONS';
export const CORS_ALLOWED_HEADERS = 'authorization, content-type, idempotency-key, x-request-id';
export const CORS_MAX_AGE_SECS = 600;

/** Parses CORS_ALLOWED_ORIGINS ("https://a.example, http://localhost:3000"). Throws on anything that is not a bare origin. */
export function parseAllowedOrigins(raw: string | undefined): string[] {
  if (!raw || !raw.trim()) return [];
  const out: string[] = [];
  for (const part of raw.split(',').map((p) => p.trim()).filter(Boolean)) {
    if (part === '*') {
      out.push('*');
      continue;
    }
    let u: URL;
    try {
      u = new URL(part);
    } catch {
      throw new Error(`CORS_ALLOWED_ORIGINS: "${part}" is not a URL`);
    }
    if ((u.protocol !== 'https:' && u.protocol !== 'http:') || u.origin !== part.replace(/\/$/, '').toLowerCase() || u.pathname !== '/' || u.search || u.hash || u.username) {
      throw new Error(`CORS_ALLOWED_ORIGINS: "${part}" must be a bare origin like https://console.example.org`);
    }
    out.push(u.origin);
  }
  return [...new Set(out)];
}

/** Returns the value for Access-Control-Allow-Origin, or undefined when the origin is not allowed. */
export function allowOrigin(policy: CorsPolicy | undefined, origin: string | undefined): string | undefined {
  if (!policy || !origin || origin === 'null') return undefined;
  if (policy.allowedOrigins.includes('*')) return '*';
  let normalized: string;
  try {
    normalized = new URL(origin).origin;
  } catch {
    return undefined;
  }
  return normalized === origin.toLowerCase() && policy.allowedOrigins.includes(normalized) ? origin : undefined;
}
