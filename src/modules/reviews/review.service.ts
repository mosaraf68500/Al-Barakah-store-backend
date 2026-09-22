import type { Request } from 'express';
import { addReviewToProductRating, removeReviewFromProductRating } from '../products/product.service';
import { ProductModel } from '../products/product.model';
import { OrderModel } from '../orders/order.model';
import { ApiError } from '../../utils/ApiError';
import { withTransaction } from '../../utils/transaction';
import { recordAudit } from '../audit/audit.service';
import { getPublicSettings } from '../settings/settings.service';
import type { UserDocument } from '../users/user.model';
import { ReviewModel, type ReviewDoc } from './review.model';
import { toAdminReview, toPublicReview } from './review.serializer';
import type { CreateReviewInput } from './review.validation';

const actorOf = (u: UserDocument) => ({ id: u._id, email: u.email, role: u.role });
const newId = () => `rev-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
const isDup = (e: unknown) => (e as { code?: number })?.code === 11000;

/* ------------------------------------------------------------------ public reads */

export interface ReviewListQuery { productId?: string; page?: number; limit?: number }

/** `GET /reviews[?productId][&page&limit]` - approved, non-deleted only, newest first. A plain array unless both `page` and `limit` are given (same pattern as `/products`). */
export async function listPublicReviews(q: ReviewListQuery) {
  const filter = { approved: true, deletedAt: null, ...(q.productId ? { productId: q.productId } : {}) };
  const base = ReviewModel.find(filter).sort({ createdAt: -1, _id: 1 });
  if (q.page !== undefined && q.limit !== undefined) {
    const [rows, total] = await Promise.all([base.skip((q.page - 1) * q.limit).limit(q.limit).lean(), ReviewModel.countDocuments(filter)]);
    return { items: rows.map(toPublicReview), total, page: q.page, limit: q.limit, totalPages: Math.ceil(total / q.limit) };
  }
  return (await base.lean()).map(toPublicReview);
}

/* ------------------------------------------------------------------ create */

/**
 * A logged-in customer's review of a product (customer auth is REQUIRED - a deviation from the legacy anonymous free-text form,
 * matching the Phase 4 contract change already noted in BACKEND_PLAN Q22 "reviews require login"). One review per customer per
 * product while it is live (unique index; a moderated-away review frees the slot). `verifiedPurchase` is computed from the
 * customer's own DELIVERED orders - never trusted from the client (legacy always faked it `true`). Runs in one transaction with
 * the atomic rating-aggregate update (domain/rating.ts, Module 3), so a review can never exist without its rating effect applied.
 */
export async function createReview(actor: UserDocument, input: CreateReviewInput, req: Request) {
  if (!(await getPublicSettings()).enableCustomerReviews) throw ApiError.forbidden('REVIEWS_DISABLED', 'Customer reviews are currently turned off');

  const product = await ProductModel.findOne({ _id: input.productId, deletedAt: null }).select('_id name').lean();
  if (!product) throw ApiError.notFound('PRODUCT_NOT_FOUND');

  const verifiedPurchase = await OrderModel.exists({ userId: String(actor._id), status: 'delivered', deletedAt: null, 'items.productId': input.productId }).then(Boolean);

  const id = newId();
  try {
    const doc = await withTransaction(async (session) => {
      const [created] = await ReviewModel.create(
        [{ _id: id, productId: product._id, productName: product.name, userId: String(actor._id), customerName: actor.name, rating: input.rating, comment: input.comment, city: input.city, verifiedPurchase, approved: true }],
        { session },
      );
      await addReviewToProductRating(product._id, input.rating, session);
      return created;
    });
    await recordAudit({ actor: actorOf(actor), action: 'review.create', entity: 'Review', entityId: id, details: { productId: product._id, rating: input.rating }, req });
    return toPublicReview(doc);
  } catch (e) {
    if (isDup(e)) throw ApiError.conflict('ALREADY_REVIEWED', 'You have already reviewed this product');
    throw e;
  }
}

/* ------------------------------------------------------------------ admin (moderation) */

/** `GET /admin/reviews[?deleted=]` - the only moderation the audited admin app has beyond delete is a global on/off flag (settings.enableCustomerReviews, Module 2); reviews are approved automatically, same as legacy. */
export async function listAdminReviews(deleted: 'include' | 'exclude' | 'only' = 'exclude') {
  const filter = deleted === 'exclude' ? { deletedAt: null } : deleted === 'only' ? { deletedAt: { $ne: null } } : {};
  return (await ReviewModel.find(filter).sort({ createdAt: -1, _id: 1 }).lean()).map(toAdminReview);
}

/** Soft delete: un-does the review's contribution to the product's rating (the exact inverse of `addReviewToProductRating`, domain/rating.ts) in the same transaction, so the aggregate never includes a moderated-away review. */
export async function softDeleteReview(actor: UserDocument, id: string, req: Request) {
  const review = await withTransaction(async (session) => {
    const r = await ReviewModel.findOneAndUpdate({ _id: id, deletedAt: null }, { $set: { deletedAt: new Date() } }, { session, new: true });
    if (!r) throw ApiError.notFound('REVIEW_NOT_FOUND');
    if (r.approved) await removeReviewFromProductRating(r.productId, r.rating, session);
    return r;
  });
  await recordAudit({ actor: actorOf(actor), action: 'review.delete', entity: 'Review', entityId: id, details: { productId: review.productId }, req });
  return { ok: true as const };
}

export type { ReviewDoc };
