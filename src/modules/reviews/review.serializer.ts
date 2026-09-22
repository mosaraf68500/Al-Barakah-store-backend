import type { ReviewDoc } from './review.model';

/** Public shape = the apps' `ProductReview` (no `userId`, no `approved`/`deletedAt` - moderation state is never exposed to a browser). */
export function toPublicReview(r: ReviewDoc) {
  return {
    id: r._id,
    productId: r.productId,
    productName: r.productName,
    customerName: r.customerName,
    rating: r.rating,
    comment: r.comment,
    ...(r.city ? { city: r.city } : {}),
    verifiedPurchase: r.verifiedPurchase,
    createdAt: r.createdAt.toISOString(),
  };
}

/** Admin output = public + who wrote it and its moderation state. */
export function toAdminReview(r: ReviewDoc) {
  return { ...toPublicReview(r), userId: r.userId, approved: r.approved, deletedAt: r.deletedAt ? r.deletedAt.toISOString() : null };
}
