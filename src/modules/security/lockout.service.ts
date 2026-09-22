import { LOCKOUT } from '../../config/constants';
import { ApiError } from '../../utils/ApiError';
import { LockoutModel } from './lockout.model';

/**
 * Consecutive-failure lockout with exponential backoff, stored in MongoDB.
 * `threshold` failures -> locked for baseMs * 2^strikes (15 min, 30 min, 1 h, then capped at 1 h). A success resets everything.
 * Unknown identifiers are counted too, so the lock cannot be used to tell registered accounts from unregistered ones.
 */
export async function assertNotLocked(key: string): Promise<void> {
  const doc = await LockoutModel.findOne({ key }).lean();
  if (doc?.lockUntil && doc.lockUntil.getTime() > Date.now()) {
    const retry = Math.ceil((doc.lockUntil.getTime() - Date.now()) / 1000);
    throw ApiError.tooMany('ACCOUNT_LOCKED', 'Too many failed attempts. Try again later.', retry, { retryAfterSeconds: retry });
  }
}

export async function recordFailure(key: string): Promise<{ locked: boolean; remaining: number; retryAfterSeconds?: number }> {
  const now = new Date();
  // An expired lock starts a fresh counting round (strikes are kept so the next lock is longer).
  await LockoutModel.updateOne({ key, lockUntil: { $lte: now } }, { $set: { failedCount: 0, lockUntil: null } });
  const doc = await LockoutModel.findOneAndUpdate({ key }, { $inc: { failedCount: 1 }, $set: { updatedAt: now } }, { upsert: true, new: true });
  if (doc.failedCount >= LOCKOUT.threshold) {
    const ms = Math.min(LOCKOUT.baseMs * 2 ** doc.strikes, LOCKOUT.maxMs);
    const lockUntil = new Date(now.getTime() + ms);
    await LockoutModel.updateOne({ key }, { $set: { lockUntil, failedCount: 0 }, $inc: { strikes: 1 } });
    return { locked: true, remaining: 0, retryAfterSeconds: Math.ceil(ms / 1000) };
  }
  return { locked: false, remaining: LOCKOUT.threshold - doc.failedCount };
}

export async function clearFailures(key: string): Promise<void> {
  await LockoutModel.deleteOne({ key });
}
