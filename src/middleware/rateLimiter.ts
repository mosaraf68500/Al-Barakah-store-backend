import type { RequestHandler } from 'express';
import rateLimit from 'express-rate-limit';
import { MongoRateLimitStore } from '../modules/security/rateLimit.service';

export interface LimiterOptions { name: string; windowMs: number; limit: number }

/** IP-based limiter on the DB-backed store. `enabled:false` (tests) returns a pass-through. */
export function makeLimiter(o: LimiterOptions, enabled: boolean): RequestHandler {
  if (!enabled) return (_req, _res, next) => next();
  return rateLimit({
    windowMs: o.windowMs,
    limit: o.limit,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    store: new MongoRateLimitStore(o.name),
    handler: (_req, res) => {
      res.status(429).json({ error: 'TOO_MANY_REQUESTS' });
    },
    // fail closed if the store is down would lock everyone out; fail open is the documented express-rate-limit default
    passOnStoreError: true,
  });
}

/** The limits proposed in BACKEND_PLAN §4 for the auth surface. */
export const LIMITS = {
  customerLogin: { name: 'cust-login', windowMs: 15 * 60_000, limit: 10 },
  customerRegister: { name: 'cust-register', windowMs: 60 * 60_000, limit: 10 },
  customerRefresh: { name: 'cust-refresh', windowMs: 15 * 60_000, limit: 60 },
  adminLoginIp: { name: 'admin-login-ip', windowMs: 15 * 60_000, limit: 30 },
  adminOtpIp: { name: 'admin-otp-ip', windowMs: 15 * 60_000, limit: 30 },
  adminRefresh: { name: 'admin-refresh', windowMs: 15 * 60_000, limit: 120 },
  couponValidate: { name: 'coupon-validate', windowMs: 15 * 60_000, limit: 30 },
  orderCreateIp: { name: 'order-create-ip', windowMs: 60 * 60_000, limit: 30 },
  orderTracking: { name: 'order-track-ip', windowMs: 15 * 60_000, limit: 30 },
  adminSetPassword: { name: 'admin-setpw', windowMs: 60 * 60_000, limit: 20 },
} as const;
