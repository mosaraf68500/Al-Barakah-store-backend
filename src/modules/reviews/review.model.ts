import { Schema, model, models, type Model } from 'mongoose';

export interface ReviewDoc {
  _id: string; // rev-…
  productId: string;
  productName: string;
  userId: string; // customer auth is required (Module 6 deviation from legacy's anonymous form - see MODULE_6_REPORT.md)
  customerName: string;
  rating: number; // 1-5
  comment: string;
  city?: string;
  /** Computed server-side from the customer's own order history - never trusted from the client (legacy always faked `true`). */
  verifiedPurchase: boolean;
  /** Default true, matching legacy (every review was visible immediately). The only moderation action any audited UI has is delete. */
  approved: boolean;
  deletedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}
const schema = new Schema<ReviewDoc>(
  {
    _id: { type: String },
    productId: { type: String, required: true },
    productName: { type: String, required: true },
    userId: { type: String, required: true },
    customerName: { type: String, required: true, trim: true },
    rating: { type: Number, required: true, min: 1, max: 5 },
    comment: { type: String, required: true, trim: true, maxlength: 2000 },
    city: String,
    verifiedPurchase: { type: Boolean, default: false },
    approved: { type: Boolean, default: true },
    deletedAt: { type: Date, default: null },
  },
  { timestamps: true },
);
schema.index({ productId: 1, createdAt: -1 });
// One review per customer per product WHILE LIVE - a soft-deleted (moderated-away) review frees the slot so they can write a new one.
schema.index({ productId: 1, userId: 1 }, { unique: true, partialFilterExpression: { deletedAt: { $type: 'null' } } });
schema.index({ deletedAt: 1 });
export const ReviewModel: Model<ReviewDoc> = (models.Review as Model<ReviewDoc>) ?? model<ReviewDoc>('Review', schema);
