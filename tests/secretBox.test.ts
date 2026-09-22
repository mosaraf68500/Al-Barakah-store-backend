import crypto from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { parseEnv, resetEnvCacheForTests } from '../src/config/env';
import { decryptField, encryptField, isCurrentKey, looksMasked, maskSecret } from '../src/utils/secretBox';

const KEY_A = process.env.SETTINGS_ENCRYPTION_KEY!;
const KEY_B = crypto.randomBytes(32).toString('hex');
const setKeys = (cur: string, prev?: string) => {
  process.env.SETTINGS_ENCRYPTION_KEY = cur;
  if (prev) process.env.SETTINGS_ENCRYPTION_KEY_PREVIOUS = prev; else delete process.env.SETTINGS_ENCRYPTION_KEY_PREVIOUS;
  resetEnvCacheForTests();
};
afterEach(() => setKeys(KEY_A));

describe('AES-256-GCM secret box', () => {
  it('round-trips arbitrary text (incl. unicode) and never stores plaintext in the envelope', () => {
    for (const s of ['bot123456:AAH-secret_token', 'পাসওয়ার্ড-১২৩৪৫', 'x'.repeat(500)]) {
      const env = encryptField(s, 'settings:a');
      expect(env).toMatch(/^v1\.[a-f0-9]{8}\.[\w-]+\.[\w-]+\.[\w-]+$/);
      expect(env).not.toContain(s.slice(0, 8));
      expect(decryptField(env, 'settings:a')).toBe(s);
    }
  });

  it('uses a fresh IV every time (same plaintext -> different ciphertext)', () => {
    expect(encryptField('same', 'settings:a')).not.toBe(encryptField('same', 'settings:a'));
  });

  it('detects tampering (ciphertext, tag, IV), wrong AAD (field swap) and wrong key', () => {
    const env = encryptField('top-secret', 'settings:a');
    const [v, id, iv, tag, ct] = env.split('.');
    const flip = (s: string) => (s[0] === 'A' ? 'B' : 'A') + s.slice(1);
    expect(() => decryptField([v, id, iv, tag, flip(ct)].join('.'), 'settings:a')).toThrow();
    expect(() => decryptField([v, id, iv, flip(tag), ct].join('.'), 'settings:a')).toThrow();
    expect(() => decryptField([v, id, flip(iv), tag, ct].join('.'), 'settings:a')).toThrow();
    expect(() => decryptField(env, 'settings:b')).toThrow(); // ciphertext cannot be moved to another field
    expect(() => decryptField('garbage', 'settings:a')).toThrow(/Malformed/);
    setKeys(KEY_B);
    expect(() => decryptField(env, 'settings:a')).toThrow(/No encryption key/);
  });

  it('supports key rotation through SETTINGS_ENCRYPTION_KEY_PREVIOUS', () => {
    const old = encryptField('rotate-me', 'settings:a');
    setKeys(KEY_B, KEY_A);
    expect(decryptField(old, 'settings:a')).toBe('rotate-me');
    expect(isCurrentKey(old)).toBe(false);
    const fresh = encryptField('rotate-me', 'settings:a');
    expect(isCurrentKey(fresh)).toBe(true);
    setKeys(KEY_B);
    expect(decryptField(fresh, 'settings:a')).toBe('rotate-me');
  });

  it('masks secrets without revealing short ones', () => {
    expect(maskSecret('')).toBe('');
    expect(maskSecret('short')).toBe('••••');
    expect(maskSecret('1234567890abcdef')).toBe('••••cdef');
    expect(looksMasked('••••cdef')).toBe(true);
    expect(looksMasked('__keep__')).toBe(true);
    expect(looksMasked('real-value')).toBe(false);
  });

  it('env validation: the key must be 32 bytes (64 hex chars or base64)', () => {
    expect(() => parseEnv({ ...process.env, SETTINGS_ENCRYPTION_KEY: 'too-short' })).toThrow(/32 bytes/);
    expect(() => parseEnv({ ...process.env, SETTINGS_ENCRYPTION_KEY: crypto.randomBytes(32).toString('base64url') })).not.toThrow();
    expect(() => parseEnv({ ...process.env, SETTINGS_ENCRYPTION_KEY_PREVIOUS: 'bad' })).toThrow(/32 bytes/);
    const { SETTINGS_ENCRYPTION_KEY: _k, ...noKey } = process.env;
    expect(() => parseEnv(noKey)).toThrow(/SETTINGS_ENCRYPTION_KEY/);
  });
});
