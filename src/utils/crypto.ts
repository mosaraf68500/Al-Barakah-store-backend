import crypto from 'node:crypto';

export const sha256 = (v: string) => crypto.createHash('sha256').update(v).digest('hex');
export const hmacSha256 = (secret: string, v: string) => crypto.createHmac('sha256', secret).update(v).digest('hex');
export const randomToken = (bytes = 32) => crypto.randomBytes(bytes).toString('base64url');
export const randomId = () => crypto.randomUUID();

/** Constant-time string comparison (never `===` on secrets). */
export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) {
    crypto.timingSafeEqual(ab, ab); // keep timing roughly independent of the mismatch
    return false;
  }
  return crypto.timingSafeEqual(ab, bb);
}

/** Uniform 6-digit code from a CSPRNG. */
export const randomDigits = (n: number) => crypto.randomInt(0, 10 ** n).toString().padStart(n, '0');
