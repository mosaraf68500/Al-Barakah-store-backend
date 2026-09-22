import crypto from 'node:crypto';
import { getEnv } from '../config/env';

/**
 * Field-level encryption for integration secrets stored in MongoDB: AES-256-GCM (authenticated encryption).
 *  - key: SETTINGS_ENCRYPTION_KEY (32 bytes) from the environment, never from the database;
 *  - fresh random 96-bit IV per encryption, 128-bit auth tag;
 *  - AAD = the field name: a ciphertext copied into a different field fails authentication;
 *  - key id (first 4 bytes of sha-256 of the key) in the envelope so keys can be ROTATED: SETTINGS_ENCRYPTION_KEY_PREVIOUS keeps
 *    old ciphertexts readable until `reencryptSecrets()` rewrites them under the current key.
 * Envelope: `v1.<keyId>.<iv>.<tag>.<ciphertext>` (base64url segments).
 */
const kid = (key: Buffer) => crypto.createHash('sha256').update(key).digest('hex').slice(0, 8);

export function encryptField(plain: string, aad: string): string {
  const key = getEnv().settingsKeys[0];
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  c.setAAD(Buffer.from(aad));
  const ct = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return ['v1', kid(key), iv.toString('base64url'), c.getAuthTag().toString('base64url'), ct.toString('base64url')].join('.');
}

export function decryptField(envelope: string, aad: string): string {
  const [v, id, iv, tag, ct] = envelope.split('.');
  if (v !== 'v1' || !id || !iv || !tag || ct === undefined) throw new Error('Malformed secret envelope');
  const key = getEnv().settingsKeys.find((k) => kid(k) === id);
  if (!key) throw new Error('No encryption key available for this secret (was the key rotated without SETTINGS_ENCRYPTION_KEY_PREVIOUS?)');
  const d = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'));
  d.setAAD(Buffer.from(aad));
  d.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([d.update(Buffer.from(ct, 'base64url')), d.final()]).toString('utf8');
}

export const isCurrentKey = (envelope: string) => envelope.split('.')[1] === kid(getEnv().settingsKeys[0]);

/** `••••1234` for long values, `••••` for short ones (never reveal a meaningful part of a short secret). */
export const MASK_CHAR = '•';
export function maskSecret(plain: string): string {
  if (!plain) return '';
  return plain.length >= 12 ? `${MASK_CHAR.repeat(4)}${plain.slice(-4)}` : MASK_CHAR.repeat(4);
}
export const looksMasked = (v: string) => v.startsWith(MASK_CHAR.repeat(4)) || v === '__keep__';
