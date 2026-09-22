import { isExhausted, isExpired } from '../../domain/coupon';
import type { CouponDoc } from './coupon.model';

/** Admin shape = the apps' `CouponItem` + the new optional limits. `status` is derived: 'expired' once inactive, past `expiresAt` or out of uses. */
export function toAdminCoupon(c: CouponDoc, now = new Date()) {
  return {
    id: c._id,
    code: c.code,
    discountPercent: c.discountPercent,
    minSpend: c.minOrderAmount,
    status: c.isActive && !isExpired(c, now) && !isExhausted(c) ? ('active' as const) : ('expired' as const),
    usageCount: c.timesUsed,
    isActive: c.isActive,
    ...(c.maxDiscountAmount != null ? { maxDiscountAmount: c.maxDiscountAmount } : {}),
    ...(c.usageLimit != null ? { usageLimit: c.usageLimit } : {}),
    ...(c.expiresAt ? { expiresAt: c.expiresAt.toISOString() } : {}),
    deletedAt: c.deletedAt ? c.deletedAt.toISOString() : null,
    createdAt: c.createdAt.toISOString(),
  };
}
