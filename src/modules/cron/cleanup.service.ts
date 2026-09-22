import { OtpModel } from '../admin-auth/otp.model';
import { LockoutModel } from '../security/lockout.model';
import { RateLimitModel } from '../security/rateLimit.model';
import { RefreshTokenModel } from '../users/refreshToken.model';

const DAY = 86_400_000;

/**
 * Housekeeping run by Vercel Cron (NOT by an in-process timer - serverless instances are frozen/killed between requests).
 * Refresh tokens are kept for 1 day after expiry so reuse-detection still recognises recently rotated tokens.
 */
export async function runCleanup(now = new Date()) {
  const [otps, refresh, rate, locks] = await Promise.all([
    OtpModel.deleteMany({ $or: [{ expiresAt: { $lt: now } }, { consumedAt: { $ne: null } }] }),
    RefreshTokenModel.deleteMany({ expiresAt: { $lt: new Date(now.getTime() - DAY) } }),
    RateLimitModel.deleteMany({ resetAt: { $lt: now } }),
    // keep lockout rows for a week after the last failure so exponential-backoff strikes are remembered
    LockoutModel.deleteMany({ updatedAt: { $lt: new Date(now.getTime() - 7 * DAY) }, $or: [{ lockUntil: null }, { lockUntil: { $lt: now } }] }),
  ]);
  return { otps: otps.deletedCount, refreshTokens: refresh.deletedCount, rateLimits: rate.deletedCount, lockouts: locks.deletedCount };
}
