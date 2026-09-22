import type { Options, Store, IncrementResponse } from 'express-rate-limit';
import { RateLimitModel } from './rateLimit.model';

/** Atomically add 1 to the window counter for `key` (creating / rolling the window when expired). */
export async function incrementWindow(key: string, windowMs: number): Promise<{ count: number; resetAt: Date }> {
  const now = new Date();
  const newReset = new Date(now.getTime() + windowMs);
  const run = () =>
    RateLimitModel.findOneAndUpdate(
      { key },
      [
        {
          $set: {
            count: { $cond: [{ $lt: [{ $ifNull: ['$resetAt', new Date(0)] }, now] }, 1, { $add: [{ $ifNull: ['$count', 0] }, 1] }] },
            resetAt: { $cond: [{ $lt: [{ $ifNull: ['$resetAt', new Date(0)] }, now] }, newReset, '$resetAt'] },
          },
        },
      ],
      { upsert: true, new: true, lean: true },
    );
  let doc;
  try {
    doc = await run();
  } catch (e) {
    if ((e as { code?: number }).code === 11000) doc = await run(); // concurrent first insert - retry once
    else throw e;
  }
  return { count: doc!.count, resetAt: doc!.resetAt };
}

/** Service-level limit (e.g. "5 OTP e-mails per hour per address"). Returns retry info when the limit is exceeded. */
export async function consumeLimit(key: string, limit: number, windowMs: number): Promise<{ allowed: boolean; retryAfterSeconds: number }> {
  const { count, resetAt } = await incrementWindow(key, windowMs);
  return { allowed: count <= limit, retryAfterSeconds: Math.max(1, Math.ceil((resetAt.getTime() - Date.now()) / 1000)) };
}

/** `express-rate-limit` store backed by MongoDB (replaces the default in-process Map - SECURITY_RISKS #23). */
export class MongoRateLimitStore implements Store {
  private windowMs = 60_000;
  constructor(private readonly keyPrefix = 'ip') {}
  init(options: Options) {
    this.windowMs = options.windowMs;
  }
  private k(key: string) {
    return `${this.keyPrefix}:${key}`;
  }
  async increment(key: string): Promise<IncrementResponse> {
    const { count, resetAt } = await incrementWindow(this.k(key), this.windowMs);
    return { totalHits: count, resetTime: resetAt };
  }
  async decrement(key: string): Promise<void> {
    await RateLimitModel.updateOne({ key: this.k(key), count: { $gt: 0 } }, { $inc: { count: -1 } });
  }
  async resetKey(key: string): Promise<void> {
    await RateLimitModel.deleteOne({ key: this.k(key) });
  }
}
