import type { Request } from 'express';
import type { ClientSession } from 'mongoose';
import { evaluateCoupon, normalizeCouponCode, type CouponFailure } from '../../domain/coupon';
import { ApiError } from '../../utils/ApiError';
import { recordAudit } from '../audit/audit.service';
import { getPublicSettings } from '../settings/settings.service';
import type { UserDocument } from '../users/user.model';
import { CouponModel, type CouponDoc } from './coupon.model';
import { toAdminCoupon } from './coupon.serializer';
import type { CouponInput, CouponPatch } from './coupon.validation';

const actorOf = (u: UserDocument) => ({ id: u._id, email: u.email, role: u.role });
const newId = () => `cpn-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
const isDup = (e: unknown) => (e as { code?: number })?.code === 11000;

/* ------------------------------------------------------------------ admin CRUD */

export async function listAdminCoupons(deleted: 'include' | 'exclude' | 'only' = 'exclude') {
  const filter = deleted === 'exclude' ? { deletedAt: null } : deleted === 'only' ? { deletedAt: { $ne: null } } : {};
  return (await CouponModel.find(filter).sort({ createdAt: -1, _id: 1 }).lean()).map((c) => toAdminCoupon(c));
}

async function getDoc(id: string) {
  const c = await CouponModel.findById(id);
  if (!c) throw ApiError.notFound('COUPON_NOT_FOUND');
  return c;
}

export async function createCoupon(actor: UserDocument, input: CouponInput, req: Request) {
  const id = input.id ?? newId();
  if (await CouponModel.exists({ _id: id })) throw ApiError.conflict('COUPON_ID_TAKEN');
  try {
    const doc = await CouponModel.create({
      _id: id, code: input.code, discountPercent: input.discountPercent, minOrderAmount: input.minSpend,
      maxDiscountAmount: input.maxDiscountAmount ?? null, usageLimit: input.usageLimit ?? null, expiresAt: input.expiresAt ?? null, isActive: input.isActive,
    });
    await recordAudit({ actor: actorOf(actor), action: 'coupon.create', entity: 'Coupon', entityId: id, details: { code: input.code, discountPercent: input.discountPercent }, req });
    return toAdminCoupon(doc);
  } catch (e) {
    if (isDup(e)) throw ApiError.conflict('COUPON_CODE_TAKEN', 'A coupon with this code already exists');
    throw e;
  }
}

export async function updateCoupon(actor: UserDocument, id: string, patch: CouponPatch, req: Request) {
  const c = await getDoc(id);
  if (c.deletedAt) throw ApiError.conflict('COUPON_ARCHIVED', 'Restore the coupon before editing it');
  if (patch.code !== undefined && patch.code !== c.code) {
    // orders keep the code text; renaming a coupon that has been used would make the history ambiguous
    if (c.timesUsed > 0) throw ApiError.conflict('COUPON_CODE_LOCKED', 'The code of a coupon that has been used cannot be changed');
    c.code = patch.code;
  }
  if (patch.discountPercent !== undefined) c.discountPercent = patch.discountPercent;
  if (patch.minSpend !== undefined) c.minOrderAmount = patch.minSpend;
  if (patch.maxDiscountAmount !== undefined) c.maxDiscountAmount = patch.maxDiscountAmount;
  if (patch.usageLimit !== undefined) c.usageLimit = patch.usageLimit;
  if (patch.expiresAt !== undefined) c.expiresAt = patch.expiresAt;
  if (patch.isActive !== undefined) c.isActive = patch.isActive;
  try {
    await c.save();
  } catch (e) {
    if (isDup(e)) throw ApiError.conflict('COUPON_CODE_TAKEN', 'A coupon with this code already exists');
    throw e;
  }
  await recordAudit({ actor: actorOf(actor), action: 'coupon.update', entity: 'Coupon', entityId: id, details: { code: c.code, fields: Object.keys(patch) }, req });
  return toAdminCoupon(c);
}

/** Soft delete: the row (and its `timesUsed` history) stays; the coupon stops validating and its code becomes reusable. */
export async function softDeleteCoupon(actor: UserDocument, id: string, req: Request) {
  const r = await CouponModel.findOneAndUpdate({ _id: id, deletedAt: null }, { $set: { deletedAt: new Date() } }, { new: true });
  if (!r) throw ApiError.notFound('COUPON_NOT_FOUND');
  await recordAudit({ actor: actorOf(actor), action: 'coupon.delete', entity: 'Coupon', entityId: id, details: { code: r.code }, req });
  return { ok: true as const };
}

export async function restoreCoupon(actor: UserDocument, id: string, req: Request) {
  const c = await CouponModel.findOne({ _id: id, deletedAt: { $ne: null } });
  if (!c) throw ApiError.notFound('COUPON_NOT_FOUND');
  c.deletedAt = null;
  try {
    await c.save();
  } catch (e) {
    if (isDup(e)) throw ApiError.conflict('COUPON_CODE_TAKEN', 'A live coupon already uses this code');
    throw e;
  }
  await recordAudit({ actor: actorOf(actor), action: 'coupon.restore', entity: 'Coupon', entityId: id, details: { code: c.code }, req });
  return toAdminCoupon(c);
}

/* ------------------------------------------------------------------ validation + redemption */

function failure(reason: CouponFailure, minSpend?: number): ApiError {
  // The error CODE is what the storefront already understands (`INVALID_COUPON`, `MIN_SPEND:<n>`, ...); details carry the number for new code.
  if (reason === 'MIN_SPEND') return ApiError.badRequest(`MIN_SPEND:${minSpend}`, undefined, { minSpend });
  return ApiError.badRequest(reason);
}

async function loadLive(rawCode: string): Promise<CouponDoc> {
  const code = normalizeCouponCode(rawCode);
  // feature flag OFF behaves exactly like "no such coupon" (nothing about coupons is disclosed)
  if (!code || !(await getPublicSettings()).enableCoupons) throw failure('INVALID_COUPON');
  const c = await CouponModel.findOne({ code, deletedAt: null }).lean();
  if (!c) throw failure('INVALID_COUPON');
  return c;
}

export interface CouponQuote { code: string; discountPercent: number; minSpend: number; maxDiscountAmount?: number; discountAmount: number }
const quote = (c: CouponDoc, discountAmount: number): CouponQuote => ({
  code: c.code, discountPercent: c.discountPercent, minSpend: c.minOrderAmount, ...(c.maxDiscountAmount != null ? { maxDiscountAmount: c.maxDiscountAmount } : {}), discountAmount,
});

/** Public, read-only check (does NOT consume a use). */
export async function validateCoupon(rawCode: string, subtotal: number, now = new Date()): Promise<CouponQuote> {
  const c = await loadLive(rawCode);
  const r = evaluateCoupon(c, subtotal, now);
  if (!r.ok) throw failure(r.reason, r.minSpend);
  return quote(c, r.discountAmount);
}

/**
 * REDEMPTION - consumes one use. Called by order creation (Module 5b) INSIDE the order's own transaction (`session`), so a coupon
 * use is only ever actually consumed together with the order it belongs to: if anything later in that transaction fails (stock,
 * the insert itself), the whole transaction aborts and this increment is rolled back with it - no separate compensation needed.
 * Re-validates everything, then increments `timesUsed` in ONE guarded update (`timesUsed < usageLimit` is part of the update
 * filter), so concurrent orders can never exceed `usageLimit`.
 */
export async function redeemCoupon(rawCode: string, subtotal: number, now = new Date(), session?: ClientSession): Promise<CouponQuote> {
  const c = await loadLive(rawCode);
  const pre = evaluateCoupon(c, subtotal, now);
  if (!pre.ok) throw failure(pre.reason, pre.minSpend);
  const updated = await CouponModel.findOneAndUpdate(
    {
      _id: c._id, deletedAt: null, isActive: true,
      $and: [
        { $or: [{ expiresAt: null }, { expiresAt: { $gt: now } }] },
        { $or: [{ usageLimit: null }, { $expr: { $lt: ['$timesUsed', '$usageLimit'] } }] },
      ],
    },
    { $inc: { timesUsed: 1 } },
    { new: true, session },
  ).lean();
  if (!updated) {
    // lost a race (last use taken / deactivated / expired between the read and the write): report the real reason
    const now2 = await CouponModel.findOne({ _id: c._id, deletedAt: null }).session(session ?? null).lean();
    const again = now2 ? evaluateCoupon(now2, subtotal, now) : null;
    throw failure(again && !again.ok ? again.reason : 'COUPON_LIMIT', again && !again.ok ? again.minSpend : undefined);
  }
  return quote(updated, pre.discountAmount);
}

/**
 * Gives a use back. Confirmed policy (Module 5a Q5 / Module 5b): with redemption happening inside the order's own transaction,
 * a failed order placement never commits the increment in the first place, so this is NOT needed for that case. It stays unused
 * for now - Module 5c must NOT call it from admin cancellation (confirmed: cancelling a placed order does not free the coupon,
 * to discourage use-then-cancel abuse). Never goes below 0.
 */
export async function releaseCoupon(rawCode: string, session?: ClientSession): Promise<boolean> {
  const r = await CouponModel.findOneAndUpdate({ code: normalizeCouponCode(rawCode), timesUsed: { $gt: 0 } }, { $inc: { timesUsed: -1 } }, { session });
  return Boolean(r);
}
