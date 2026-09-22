import { z } from 'zod';

const code = z.string().transform((s) => s.replace(/\s+/g, '').toUpperCase()).pipe(z.string().regex(/^[A-Z0-9_-]{2,40}$/, 'code: 2-40 letters, digits, - or _'));
const id = z.string().regex(/^[A-Za-z0-9-]{1,60}$/, 'invalid id');
const money = z.number().finite().min(0).max(100_000_000);
const optionalDate = z.union([z.string().datetime({ offset: true }), z.null()]).transform((v) => (v ? new Date(v) : null));

/** Admin body. Mirrors the admin app's `CouponItem` (`minSpend`) plus the new optional limits. `usageCount`/`status`/`timesUsed` are server-owned and ignored. */
export const couponInput = z.object({
  id: id.optional(),
  code,
  discountPercent: z.number().finite().gt(0).max(100),
  minSpend: money.default(0),
  maxDiscountAmount: money.gt(0).nullable().optional(),
  usageLimit: z.number().int().min(1).max(10_000_000).nullable().optional(),
  expiresAt: optionalDate.optional(),
  isActive: z.boolean().default(true),
});
export type CouponInput = z.infer<typeof couponInput>;
export const couponPatch = couponInput.omit({ id: true }).partial();
export type CouponPatch = z.infer<typeof couponPatch>;

export const validateBodySchema = z.object({
  code: z.string().min(1).max(60),
  subtotal: z.number().finite().min(0).max(100_000_000),
});
export const adminCouponListQuery = z.object({ deleted: z.enum(['include', 'exclude', 'only']).default('exclude') });
