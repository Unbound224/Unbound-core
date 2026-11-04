import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { base32Decode, base32Encode, openSecret, sealSecret, stepFor, totpAt, verifyTotp } from '../src/common/totp.js';
import { InMemoryStorage } from '../src/persistence/storage.js';
import { FakeStellarGateway } from '../src/testing/fake-gateway.js';

const EMAIL = 'admin@example.invalid';
const PASSWORD = 'correct horse battery staple';

function world(mfaKey?: Buffer) {
  const t = { ms: Date.parse('2026-11-04T12:00:00Z') };
  const storage = new InMemoryStorage();
  const app = createApp({ gateway: new FakeStellarGateway(() => t.ms), clock: { now: () => new Date(t.ms) }, storage, ...(mfaKey ? { mfaKey } : {}) });
  return { t, app, storage };
}

async function adminSession(w: ReturnType<typeof world>) {
  await w.app.auth.bootstrapAdmin(EMAIL, PASSWORD);
  const login = await w.app.auth.login({ email: EMAIL, password: PASSWORD }, 'r');
  return (await w.app.authenticate(login.token))!;
}

const codeNow = (secretB32: string, ms: number, stepOffset = 0) => totpAt(base32Decode(secretB32), stepFor(ms) + stepOffset);

describe('TOTP (RFC 6238 vectors, SHA-1, secret "12345678901234567890")', () => {
  const secret = Buffer.from('12345678901234567890');
  it('matches the published test vectors (6 digit truncation)', () => {
    expect(totpAt(secret, stepFor(59_000))).toBe('287082');
    expect(totpAt(secret, stepFor(1_111_111_109_000))).toBe('081804');
    expect(totpAt(secret, stepFor(1_234_567_890_000))).toBe('005924');
    expect(totpAt(secret, stepFor(2_000_000_000_000))).toBe('279037');
  });
  it('base32 round-trips and verifyTotp accepts one step of drift but not two', () => {
    expect(base32Decode(base32Encode(secret)).equals(secret)).toBe(true);
    const now = 1_111_111_109_000;
    expect(verifyTotp(secret, '081804', now)).toBe(stepFor(now));
    expect(verifyTotp(secret, '081804', now + 30_000)).toBe(stepFor(now));
    expect(verifyTotp(secret, '081804', now + 90_000)).toBeNull();
    expect(verifyTotp(secret, 'abcdef', now)).toBeNull();
  });
  it('seals and opens a secret and refuses a tampered one', () => {
    const key = Buffer.alloc(32, 7);
    const sealed = sealSecret('JBSWY3DPEHPK3PXP', key);
    expect(sealed).not.toContain('JBSWY3DPEHPK3PXP');
    expect(openSecret(sealed, key)).toBe('JBSWY3DPEHPK3PXP');
    expect(() => openSecret(sealed.slice(0, -2) + '00', key)).toThrow();
  });
});

describe('admin MFA', () => {
  it('is not required until activated; then login needs a fresh valid code', async () => {
    const w = world();
    const admin = await adminSession(w);
    const enroll = await w.app.auth.enrollMfa(admin, 'r');
    expect(enroll.otpauthUri).toMatch(/^otpauth:\/\/totp\/Unbound%3Aadmin%40example\.invalid\?secret=/);
    // enrolled but not activated: password alone still works
    await expect(w.app.auth.login({ email: EMAIL, password: PASSWORD }, 'r')).resolves.toMatchObject({ role: 'admin' });
    await expect(w.app.auth.activateMfa(admin, { code: '000000' }, 'r')).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
    await w.app.auth.activateMfa(admin, { code: codeNow(enroll.secret, w.t.ms) }, 'r');

    await expect(w.app.auth.login({ email: EMAIL, password: PASSWORD }, 'r')).rejects.toMatchObject({ code: 'MFA_REQUIRED' });
    w.t.ms += 30_000; // a step later: the activation code cannot be replayed
    await expect(w.app.auth.login({ email: EMAIL, password: PASSWORD, code: codeNow(enroll.secret, w.t.ms, -1) }, 'r')).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
    await expect(w.app.auth.login({ email: EMAIL, password: PASSWORD, code: '123456' }, 'r')).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
    const ok = await w.app.auth.login({ email: EMAIL, password: PASSWORD, code: codeNow(enroll.secret, w.t.ms) }, 'r');
    expect(ok.role).toBe('admin');
    // the same code cannot be used twice
    await expect(w.app.auth.login({ email: EMAIL, password: PASSWORD, code: codeNow(enroll.secret, w.t.ms) }, 'r')).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
    // a wrong password never reaches the code check
    await expect(w.app.auth.login({ email: EMAIL, password: 'definitely wrong password', code: codeNow(enroll.secret, w.t.ms + 30_000) }, 'r')).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
  });

  it('wrong codes count toward the lockout like wrong passwords', async () => {
    const w = world();
    const admin = await adminSession(w);
    const enroll = await w.app.auth.enrollMfa(admin, 'r');
    await w.app.auth.activateMfa(admin, { code: codeNow(enroll.secret, w.t.ms) }, 'r');
    for (let i = 0; i < 5; i++) await expect(w.app.auth.login({ email: EMAIL, password: PASSWORD, code: '111111' }, 'r')).rejects.toBeDefined();
    w.t.ms += 30_000;
    await expect(w.app.auth.login({ email: EMAIL, password: PASSWORD, code: codeNow(enroll.secret, w.t.ms) }, 'r')).rejects.toMatchObject({ message: expect.stringMatching(/too many attempts/) });
  });

  it('only a valid code turns MFA off, and only admins can enrol', async () => {
    const w = world();
    const admin = await adminSession(w);
    await expect(w.app.auth.enrollMfa({ id: 'x', role: 'merchant' }, 'r')).rejects.toMatchObject({ code: 'FORBIDDEN' });
    const enroll = await w.app.auth.enrollMfa(admin, 'r');
    await w.app.auth.activateMfa(admin, { code: codeNow(enroll.secret, w.t.ms) }, 'r');
    await expect(w.app.auth.disableMfa(admin, { code: '000000' }, 'r')).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
    w.t.ms += 30_000;
    await w.app.auth.disableMfa(admin, { code: codeNow(enroll.secret, w.t.ms) }, 'r');
    await expect(w.app.auth.login({ email: EMAIL, password: PASSWORD }, 'r')).resolves.toMatchObject({ role: 'admin' });
  });

  it('with MFA_ENCRYPTION_KEY the stored secret is sealed, and login still works', async () => {
    const w = world(Buffer.alloc(32, 9));
    const admin = await adminSession(w);
    const enroll = await w.app.auth.enrollMfa(admin, 'r');
    const stored = JSON.stringify(await w.storage.repo('accounts').find(() => true));
    expect(stored).not.toContain(enroll.secret);
    await w.app.auth.activateMfa(admin, { code: codeNow(enroll.secret, w.t.ms) }, 'r');
    w.t.ms += 30_000;
    await expect(w.app.auth.login({ email: EMAIL, password: PASSWORD, code: codeNow(enroll.secret, w.t.ms) }, 'r')).resolves.toMatchObject({ role: 'admin' });
  });
});
