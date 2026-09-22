export const API_PREFIX = '/v1';

export const ROLES = ['customer', 'admin', 'super_admin'] as const;
export type Role = (typeof ROLES)[number];
export type Audience = 'customer' | 'admin';

/** Failed-attempt lockout: after `threshold` consecutive failures the key is locked for baseMs * 2^strikes, capped at 1 hour (limits lock-out abuse). */
export const LOCKOUT = { threshold: 5, baseMs: 15 * 60 * 1000, maxMs: 60 * 60 * 1000 } as const;

export const OTP = { digits: 6, ttlMs: 5 * 60 * 1000, maxAttempts: 5, resendCooldownMs: 30 * 1000, maxSendsPerHour: 5 } as const;

export const REFRESH_COOKIE = { customer: 'abp_rt_customer', admin: 'abp_rt_admin' } as const;
export const REFRESH_COOKIE_PATH = { customer: '/v1/auth', admin: '/v1/admin-auth' } as const;
export const CSRF_HEADER = 'x-abp-client';

/** Secondary, IP-independent throttle on the login endpoints: the SAME account tried from many IPs is slowed too. */
export const ACCOUNT_LOGIN_LIMIT = { limit: 20, windowMs: 15 * 60 * 1000 } as const;
