import { Schema, model, models, type Model } from 'mongoose';

export interface CouponDoc {
  _id: string;
  code: string; // upper-case, no whitespace
  discountPercent: number;
  maxDiscountAmount?: number | null;
  minOrderAmount: number;
  usageLimit?: number | null;
  timesUsed: number;
  isActive: boolean;
  expiresAt?: Date | null;
  deletedAt?: Date | null;
  createdAt: Date;
  updatedAt: Date;
}
const schema = new Schema<CouponDoc>(
  {
    _id: { type: String },
    code: { type: String, required: true, trim: true, uppercase: true },
    discountPercent: { type: Number, required: true, min: 0.01, max: 100 },
    maxDiscountAmount: { type: Number, default: null, min: 0 },
    minOrderAmount: { type: Number, default: 0, min: 0 },
    usageLimit: { type: Number, default: null, min: 1 },
    timesUsed: { type: Number, default: 0, min: 0 },
    isActive: { type: Boolean, default: true },
    expiresAt: { type: Date, default: null },
    deletedAt: { type: Date, default: null },
  },
  { timestamps: true },
);
// A code is unique among LIVE coupons; a soft-deleted coupon frees its code so it can be re-created (restoring it then conflicts if the code was reused).
schema.index({ code: 1 }, { unique: true, partialFilterExpression: { deletedAt: { $type: 'null' } } });
schema.index({ deletedAt: 1, createdAt: -1 });
export const CouponModel: Model<CouponDoc> = (models.Coupon as Model<CouponDoc>) ?? model<CouponDoc>('Coupon', schema);
