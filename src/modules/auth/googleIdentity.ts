import { OAuth2Client } from 'google-auth-library';
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
/** Tests supply a verified payload. Production always uses google-auth-library. */
export const __setGoogleVerifierForTests = (verifier?: Verifier) => {
  override = verifier;
};

let client: OAuth2Client | undefined;
const oauthClient = () => (client ??= new OAuth2Client());

/**
 * Checks the ID token's signature, expiry, issuer, and audience (`GOOGLE_CLIENT_ID`).
 * `email_verified` is returned for the caller to require. The client secret is not used.
 */
export async function verifyGoogleIdToken(idToken: string): Promise<GoogleIdentity> {
  const audience = getEnv().GOOGLE_CLIENT_ID;
  if (override) return override(idToken, audience);
  try {
    const ticket = await oauthClient().verifyIdToken({ idToken, audience });
    const payload = ticket.getPayload();
    if (!payload?.sub || !payload.email) throw ApiError.unauthorized('INVALID_GOOGLE_TOKEN', 'Google sign-in could not be verified.');
    const name = (payload.name || payload.email.split('@')[0] || 'Customer').trim().slice(0, 120);
    return {
      sub: payload.sub,
      email: payload.email.trim().toLowerCase(),
      name: name || 'Customer',
      ...(payload.picture ? { picture: payload.picture } : {}),
      emailVerified: payload.email_verified === true,
    };
  } catch (err) {
    if (err instanceof ApiError) throw err;
    logger.warn({ reason: (err as Error).message }, 'google id token rejected');
    throw ApiError.unauthorized('INVALID_GOOGLE_TOKEN', 'Google sign-in could not be verified.');
  }
}
