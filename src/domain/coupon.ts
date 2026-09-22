/**
 * Coupon rules (BACKEND_PLAN B6), pure so the validate endpoint and the future order redemption share ONE implementation.
 * Order of checks: active -> not expired -> usage limit -> minimum spend -> discount (percent, capped).
 */
export interface CouponRule {
  isActive: boolean;
  discountPercent: number;
  minOrderAmount: number;
  maxDiscountAmount?: number | null;
  usageLimit?: number | null;
  timesUsed: number;
  expiresAt?: Date | null;
}
export type CouponFailure = 'INVALID_COUPON' | 'COUPON_EXPIRED' | 'COUPON_LIMIT' | 'MIN_SPEND';
export type CouponEvaluation = { ok: true; discountAmount: number } | { ok: false; reason: CouponFailure; minSpend?: number };

/** Codes are compared upper-case with ALL whitespace removed (same as the legacy cart). */
export const normalizeCouponCode = (raw: string) => raw.replace(/\s+/g, '').toUpperCase();

const money = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

/** percent of the subtotal, capped by `maxDiscountAmount`, never more than the subtotal, rounded to 2 decimals. */
export function computeDiscount(subtotal: number, percent: number, maxDiscountAmount?: number | null): number {
  let d = (subtotal * percent) / 100;
  if (maxDiscountAmount != null && maxDiscountAmount > 0) d = Math.min(d, maxDiscountAmount);
  return money(Math.max(0, Math.min(d, subtotal)));
}

export const isExpired = (c: Pick<CouponRule, 'expiresAt'>, now: Date) => Boolean(c.expiresAt && c.expiresAt.getTime() <= now.getTime());
export const isExhausted = (c: Pick<CouponRule, 'usageLimit' | 'timesUsed'>) => c.usageLimit != null && c.timesUsed >= c.usageLimit;

export function evaluateCoupon(c: CouponRule, subtotal: number, now = new Date()): CouponEvaluation {
  if (!c.isActive) return { ok: false, reason: 'INVALID_COUPON' };
  if (isExpired(c, now)) return { ok: false, reason: 'COUPON_EXPIRED' };
  if (isExhausted(c)) return { ok: false, reason: 'COUPON_LIMIT' };
  if (c.minOrderAmount > 0 && subtotal < c.minOrderAmount) return { ok: false, reason: 'MIN_SPEND', minSpend: c.minOrderAmount };
  return { ok: true, discountAmount: computeDiscount(subtotal, c.discountPercent, c.maxDiscountAmount) };
}
