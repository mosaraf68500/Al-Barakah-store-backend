import jwt from 'jsonwebtoken';
import { getEnv } from '../../config/env';
import { ApiError } from '../../utils/ApiError';
import { logger } from '../../utils/logger';

export interface GoogleIdentity {
  sub: string;
  email: string;
  name: string;
  picture?: string;
  emailVerified: boolean;
}

type Verifier = (idToken: string, audience: string) => Promise<GoogleIdentity>;

let override: Verifier | undefined;
/** Tests supply a verified payload. Production always verifies a Firebase ID token. */
export const __setGoogleVerifierForTests = (verifier?: Verifier) => {
  override = verifier;
};

type CertCache = { keys: Record<string, string>; fetchedAt: number };
let certCache: CertCache | undefined;

async function firebaseCerts(): Promise<Record<string, string>> {
  const now = Date.now();
  if (certCache && now - certCache.fetchedAt < 60 * 60 * 1000) return certCache.keys;
  const res = await fetch('https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com');
  if (!res.ok) throw new Error(`firebase certs HTTP ${res.status}`);
  const keys = (await res.json()) as Record<string, string>;
  certCache = { keys, fetchedAt: now };
  return keys;
}

interface FirebasePayload extends jwt.JwtPayload {
  email?: string;
  email_verified?: boolean;
  name?: string;
  picture?: string;
  firebase?: { identities?: Record<string, string[]>; sign_in_provider?: string };
}

/**
 * Verifies a Firebase Auth ID token (audience + issuer = `FIREBASE_PROJECT_ID`).
 * Prefer the Google provider subject when present so accounts stay stable across auth backends.
 */
export async function verifyGoogleIdToken(idToken: string): Promise<GoogleIdentity> {
  const projectId = getEnv().FIREBASE_PROJECT_ID;
  if (override) return override(idToken, projectId);
  try {
    const decoded = jwt.decode(idToken, { complete: true });
    if (!decoded || typeof decoded === 'string' || !decoded.header.kid) {
      throw ApiError.unauthorized('INVALID_GOOGLE_TOKEN', 'Google sign-in could not be verified.');
    }
    const cert = (await firebaseCerts())[decoded.header.kid];
    if (!cert) throw ApiError.unauthorized('INVALID_GOOGLE_TOKEN', 'Google sign-in could not be verified.');

    const payload = jwt.verify(idToken, cert, {
      algorithms: ['RS256'],
      audience: projectId,
      issuer: `https://securetoken.google.com/${projectId}`,
    }) as FirebasePayload;

    if (!payload.sub || !payload.email) throw ApiError.unauthorized('INVALID_GOOGLE_TOKEN', 'Google sign-in could not be verified.');

    const googleSubs = payload.firebase?.identities?.['google.com'];
    const sub = googleSubs?.[0] || payload.sub;
    const name = (payload.name || payload.email.split('@')[0] || 'Customer').trim().slice(0, 120);
    return {
      sub,
      email: payload.email.trim().toLowerCase(),
      name: name || 'Customer',
      ...(payload.picture ? { picture: payload.picture } : {}),
      emailVerified: payload.email_verified === true,
    };
  } catch (err) {
    if (err instanceof ApiError) throw err;
    logger.warn({ reason: (err as Error).message }, 'firebase id token rejected');
    throw ApiError.unauthorized('INVALID_GOOGLE_TOKEN', 'Google sign-in could not be verified.');
  }
}
