import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { z } from 'zod';
import type { AuditLog } from '../../common/audit.js';
import { requireRole, type Actor, type Role } from '../../common/auth.js';
import { ApiError } from '../../common/errors.js';
import { newId, type Clock } from '../../common/ids.js';
import type { Repository } from '../../common/repository.js';
import { KeyedMutex } from '../../common/repository.js';
import type { Storage } from '../../persistence/storage.js';
import type { WalletService } from '../wallets/service.js';

const scryptAsync = promisify(scrypt) as (pw: string, salt: Buffer, len: number) => Promise<Buffer>;

export interface Account {
  id: string;
  email: string;
  role: Exclude<Role, 'user'>;
  /** scrypt$<salt hex>$<hash hex>. Plain passwords are never stored or logged. */
  passwordHash: string;
  disabled: boolean;
  createdAt: string;
}

interface LoginState {
  /** normalized email */
  id: string;
  failures: number;
  lockedUntil: number;
}

export const MAX_FAILURES = 5;
export const LOCK_MS = 15 * 60_000;

const Credentials = z
  .object({
    email: z.string().trim().toLowerCase().email().max(200),
    password: z.string().min(12, 'password must be at least 12 characters').max(200),
  })
  .strict();

async function hashPassword(pw: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await scryptAsync(pw, salt, 32);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

async function verifyPassword(pw: string, stored: string): Promise<boolean> {
  const [alg, saltHex, hashHex] = stored.split('$');
  if (alg !== 'scrypt' || !saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, 'hex');
  const actual = await scryptAsync(pw, Buffer.from(saltHex, 'hex'), expected.length);
  return timingSafeEqual(actual, expected);
}

// Verified against this when the email is unknown, so timing does not reveal which emails exist.
const DUMMY_HASH = `scrypt$${'00'.repeat(16)}$${'00'.repeat(32)}`;

/** Credential auth for merchants and admins (consumers authenticate with their wallet instead). */
export class AuthService {
  private readonly accounts: Repository<Account>;
  private readonly logins: Repository<LoginState>;
  private readonly lock = new KeyedMutex();

  constructor(
    private readonly clock: Clock,
    private readonly audit: AuditLog,
    private readonly wallets: WalletService,
    storage: Storage,
  ) {
    this.accounts = storage.repo<Account>('accounts');
    this.logins = storage.repo<LoginState>('login_state');
  }

  /** Public self-registration creates a MERCHANT account only; it has no authority until an admin verifies the merchant. */
  async registerMerchant(input: unknown, requestId: string): Promise<{ id: string; email: string }> {
    const c = this.parse(input);
    return this.create(c.email, c.password, 'merchant', { id: 'anonymous', role: 'user' }, requestId);
  }

  async createAccount(actor: Actor | undefined, input: unknown, role: Account['role'], requestId: string): Promise<{ id: string; email: string; role: string }> {
    const admin = requireRole(actor, 'admin');
    const c = this.parse(input);
    const a = await this.create(c.email, c.password, role, admin, requestId);
    return { ...a, role };
  }

  /** Used once at startup from environment-provided credentials (never committed). */
  async bootstrapAdmin(email: string, password: string): Promise<boolean> {
    const c = this.parse({ email, password });
    if ((await this.accounts.find((a) => a.role === 'admin')).length > 0) return false;
    await this.create(c.email, c.password, 'admin', { id: 'system', role: 'admin' }, 'bootstrap');
    return true;
  }

  async login(input: unknown, requestId: string): Promise<{ token: string; role: Role; accountId: string }> {
    const parsed = Credentials.safeParse(input);
    if (!parsed.success) throw new ApiError('UNAUTHENTICATED', 'invalid credentials');
    const { email, password } = parsed.data;
    return this.lock.run(`login:${email}`, async () => {
      const now = this.clock.now().getTime();
      const state = (await this.logins.get(email)) ?? { id: email, failures: 0, lockedUntil: 0 };
      if (state.lockedUntil > now) throw new ApiError('UNAUTHENTICATED', 'too many attempts; try again later');
      const account = (await this.accounts.find((a) => a.email === email))[0];
      const ok = await verifyPassword(password, account?.passwordHash ?? DUMMY_HASH);
      if (!account || account.disabled || !ok) {
        state.failures += 1;
        if (state.failures >= MAX_FAILURES) {
          state.lockedUntil = now + LOCK_MS;
          state.failures = 0;
        }
        await this.logins.put(state);
        await this.audit.record({ id: account?.id ?? 'unknown', role: 'anonymous' }, 'auth', 'LOGIN_FAILED', account?.id ?? 'unknown', requestId);
        throw new ApiError('UNAUTHENTICATED', 'invalid credentials');
      }
      await this.logins.put({ id: email, failures: 0, lockedUntil: 0 });
      const actor: Actor = { id: account.id, role: account.role };
      const token = await this.wallets.openSession(actor);
      await this.audit.record(actor, 'auth', 'LOGIN_OK', account.id, requestId);
      return { token, role: account.role, accountId: account.id };
    });
  }

  async logout(token: string | undefined): Promise<void> {
    if (token) await this.wallets.revokeSession(token);
  }

  async disable(actor: Actor | undefined, accountId: string, requestId: string): Promise<void> {
    const admin = requireRole(actor, 'admin');
    const a = await this.accounts.get(accountId);
    if (!a) throw new ApiError('NOT_FOUND', 'account not found');
    await this.accounts.put({ ...a, disabled: true });
    await this.audit.record(admin, 'auth', 'ACCOUNT_DISABLED', accountId, requestId);
  }

  private parse(input: unknown) {
    const p = Credentials.safeParse(input);
    if (!p.success) throw new ApiError('VALIDATION_FAILED', 'invalid email or password (min 12 characters)', p.error.issues.map((i) => i.path.join('.')));
    return p.data;
  }

  private async create(email: string, password: string, role: Account['role'], by: { id: string; role: string }, requestId: string) {
    return this.lock.run(`create:${email}`, async () => {
      if ((await this.accounts.find((a) => a.email === email)).length > 0) throw new ApiError('INVALID_STATE', 'an account with this email already exists');
      const acct: Account = {
        id: newId('acc'),
        email,
        role,
        passwordHash: await hashPassword(password),
        disabled: false,
        createdAt: this.clock.now().toISOString(),
      };
      await this.accounts.put(acct);
      await this.audit.record(by, 'auth', 'ACCOUNT_CREATED', acct.id, requestId, { role });
      return { id: acct.id, email };
    });
  }
}
