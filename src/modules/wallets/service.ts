import { Keypair, StrKey } from '@stellar/stellar-sdk';
import { createHash, randomBytes } from 'node:crypto';
import type { Actor } from '../../common/auth.js';
import type { AuditLog } from '../../common/audit.js';
import { ApiError } from '../../common/errors.js';
import { newId, type Clock } from '../../common/ids.js';
import type { Repository } from '../../common/repository.js';
import type { Storage } from '../../persistence/storage.js';

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

interface Session {
  /** SHA-256 of the bearer token; the token itself is never stored */
  id: string;
  actor: Actor;
  expiresAt: number;
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
  readonly bindings: Repository<WalletBinding>;
  private readonly challenges: Repository<Challenge>;
  private readonly sessions: Repository<Session>;

  constructor(
    private readonly clock: Clock,
    private readonly audit: AuditLog,
    storage: Storage,
  ) {
    this.bindings = storage.repo<WalletBinding>('wallet_bindings');
    this.challenges = storage.repo<Challenge>('wallet_challenges');
    this.sessions = storage.repo<Session>('sessions');
  }

  async createChallenge(publicKey: string): Promise<{ challengeId: string; message: string; expiresAt: string }> {
    if (!StrKey.isValidEd25519PublicKey(publicKey)) throw new ApiError('VALIDATION_FAILED', 'invalid Stellar public key');
    const nonce = randomBytes(24).toString('hex');
    const c: Challenge = { id: newId('chl'), nonce, publicKey, expiresAt: this.clock.now().getTime() + CHALLENGE_TTL_MS, used: false };
    await this.challenges.put(c);
    return { challengeId: c.id, message: challengeMessage(nonce, publicKey), expiresAt: new Date(c.expiresAt).toISOString() };
  }

  async verifyChallenge(challengeId: string, signatureBase64: string, requestId: string): Promise<{ token: string; actor: Actor; binding: WalletBinding }> {
    const c = await this.challenges.get(challengeId);
    if (!c || c.used || c.expiresAt <= this.clock.now().getTime()) throw new ApiError('CHALLENGE_INVALID', 'challenge is unknown, used or expired');
    c.used = true; // single use even if the signature turns out wrong
    await this.challenges.put(c);
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
    await this.sessions.put({ id: hash(token), actor, expiresAt: this.clock.now().getTime() + SESSION_TTL_MS });
    await this.audit.record(actor, 'wallet', 'WALLET_VERIFIED', binding.id, requestId);
    return { token, actor, binding };
  }

  /** DEV/TEST ONLY: mint a session for a non-wallet actor (merchant/admin) without any credentials. */
  async mintDevSession(actor: Actor): Promise<string> {
    const token = randomBytes(32).toString('hex');
    await this.sessions.put({ id: hash(token), actor, expiresAt: this.clock.now().getTime() + SESSION_TTL_MS });
    return token;
  }

  async authenticate(token: string | undefined): Promise<Actor | undefined> {
    if (!token) return undefined;
    const s = await this.sessions.get(hash(token));
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
