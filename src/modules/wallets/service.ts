import { Keypair, StrKey } from '@stellar/stellar-sdk';
import { createHash, randomBytes } from 'node:crypto';
import type { Actor } from '../../common/auth.js';
import type { AuditLog } from '../../common/audit.js';
import { ApiError } from '../../common/errors.js';
import { newId, type Clock } from '../../common/ids.js';
import { InMemoryRepository, type Repository } from '../../common/repository.js';

export interface WalletBinding {
  id: string;
  userId: string;
  publicKey: string;
  createdAt: string;
  updatedAt: string;
}

interface Challenge {
  id: string;
  nonce: string;
  publicKey: string;
  expiresAt: number;
  used: boolean;
}

const CHALLENGE_TTL_MS = 5 * 60_000;
const SESSION_TTL_MS = 60 * 60_000;

export function challengeMessage(nonce: string, publicKey: string): string {
  return `unbound-auth:v1:TESTNET:${nonce}:${publicKey}`;
}

/**
 * Wallet-ownership proof: the wallet signs a one-time, expiring challenge. The server only ever
 * sees a signature, never a secret. Sessions are random bearer tokens stored as SHA-256 hashes.
 */
export class WalletService {
  readonly bindings: Repository<WalletBinding> = new InMemoryRepository<WalletBinding>();
  private readonly challenges = new Map<string, Challenge>();
  private readonly sessions = new Map<string, { actor: Actor; expiresAt: number }>();

  constructor(
    private readonly clock: Clock,
    private readonly audit: AuditLog,
  ) {}

  createChallenge(publicKey: string): { challengeId: string; message: string; expiresAt: string } {
    if (!StrKey.isValidEd25519PublicKey(publicKey)) throw new ApiError('VALIDATION_FAILED', 'invalid Stellar public key');
    const nonce = randomBytes(24).toString('hex');
    const c: Challenge = { id: newId('chl'), nonce, publicKey, expiresAt: this.clock.now().getTime() + CHALLENGE_TTL_MS, used: false };
    this.challenges.set(c.id, c);
    return { challengeId: c.id, message: challengeMessage(nonce, publicKey), expiresAt: new Date(c.expiresAt).toISOString() };
  }

  async verifyChallenge(challengeId: string, signatureBase64: string, requestId: string): Promise<{ token: string; actor: Actor; binding: WalletBinding }> {
    const c = this.challenges.get(challengeId);
    if (!c || c.used || c.expiresAt <= this.clock.now().getTime()) throw new ApiError('CHALLENGE_INVALID', 'challenge is unknown, used or expired');
    c.used = true; // single use even if the signature turns out wrong
    let ok: boolean;
    try {
      ok = Keypair.fromPublicKey(c.publicKey).verify(Buffer.from(challengeMessage(c.nonce, c.publicKey)), Buffer.from(signatureBase64, 'base64'));
    } catch {
      ok = false;
    }
    if (!ok) throw new ApiError('CHALLENGE_INVALID', 'signature does not match the wallet key');
    const existing = (await this.bindings.find((b) => b.publicKey === c.publicKey))[0];
    const now = this.clock.now().toISOString();
    const binding: WalletBinding = existing ?? { id: newId('wal'), userId: newId('usr'), publicKey: c.publicKey, createdAt: now, updatedAt: now };
    await this.bindings.put(binding);
    const actor: Actor = { id: binding.userId, role: 'user' };
    const token = randomBytes(32).toString('hex');
    this.sessions.set(hash(token), { actor, expiresAt: this.clock.now().getTime() + SESSION_TTL_MS });
    await this.audit.record(actor, 'wallet', 'WALLET_VERIFIED', binding.id, requestId);
    return { token, actor, binding };
  }

  /** DEV/TEST ONLY: mint a session for a non-wallet actor (merchant/admin) without any credentials. */
  mintDevSession(actor: Actor): string {
    const token = randomBytes(32).toString('hex');
    this.sessions.set(hash(token), { actor, expiresAt: this.clock.now().getTime() + SESSION_TTL_MS });
    return token;
  }

  authenticate(token: string | undefined): Actor | undefined {
    if (!token) return undefined;
    const s = this.sessions.get(hash(token));
    if (!s || s.expiresAt <= this.clock.now().getTime()) return undefined;
    return s.actor;
  }

  /** The caller must have proven control of `publicKey`; returns the key to use as source account. */
  async requireBound(userId: string, publicKey: string): Promise<string> {
    const b = (await this.bindings.find((x) => x.userId === userId && x.publicKey === publicKey))[0];
    if (!b) throw new ApiError('FORBIDDEN', 'wallet is not bound to this user');
    return b.publicKey;
  }
}

function hash(t: string): string {
  return createHash('sha256').update(t).digest('hex');
}
