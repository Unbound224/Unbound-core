import { createCipheriv, createDecipheriv, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/** RFC 4648 base32 without padding, the format authenticator apps expect for TOTP secrets. */
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(s: string): Buffer {
  const clean = s.replace(/=+$/u, '').toUpperCase();
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const idx = ALPHABET.indexOf(ch);
    if (idx < 0) throw new Error('invalid base32');
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

export const TOTP_STEP_SECONDS = 30;

/** RFC 6238 (HMAC-SHA1) code for a counter step. */
export function totpAt(secret: Buffer, step: number, digits = 6): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const h = createHmac('sha1', secret).update(counter).digest();
  const off = h[h.length - 1]! & 0xf;
  const bin = ((h[off]! & 0x7f) << 24) | (h[off + 1]! << 16) | (h[off + 2]! << 8) | h[off + 3]!;
  return String(bin % 10 ** digits).padStart(digits, '0');
}

export const stepFor = (ms: number): number => Math.floor(ms / 1000 / TOTP_STEP_SECONDS);

/**
 * Checks a code against the current step and one step either side (clock drift). Returns the matching step so the
 * caller can refuse a replay of the same or an earlier step, or null when no step matches.
 */
export function verifyTotp(secret: Buffer, code: string, nowMs: number): number | null {
  if (!/^[0-9]{6}$/u.test(code)) return null;
  const now = stepFor(nowMs);
  let hit: number | null = null;
  for (const step of [now - 1, now, now + 1]) {
    const expected = Buffer.from(totpAt(secret, step));
    const got = Buffer.from(code);
    if (timingSafeEqual(expected, got) && hit === null) hit = step; // evaluate every step: no early exit on a match
  }
  return hit;
}

export function otpauthUri(issuer: string, account: string, secretBase32: string): string {
  const label = encodeURIComponent(`${issuer}:${account}`);
  return `otpauth://totp/${label}?secret=${secretBase32}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=${TOTP_STEP_SECONDS}`;
}

export const newTotpSecret = (): Buffer => randomBytes(20);

/** AES-256-GCM sealing of the stored secret with a key from the environment (64 hex chars). */
export function sealSecret(plain: string, key: Buffer): string {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return `gcm$${iv.toString('hex')}$${c.getAuthTag().toString('hex')}$${enc.toString('hex')}`;
}

export function openSecret(sealed: string, key: Buffer): string {
  const [alg, iv, tag, data] = sealed.split('$');
  if (alg !== 'gcm' || !iv || !tag || !data) throw new Error('unsealed or malformed secret');
  const d = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'hex'));
  d.setAuthTag(Buffer.from(tag, 'hex'));
  return Buffer.concat([d.update(Buffer.from(data, 'hex')), d.final()]).toString('utf8');
}
