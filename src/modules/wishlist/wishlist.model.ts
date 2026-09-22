import { Schema, model, models, type Model, type Types } from 'mongoose';

export interface WishlistItemDoc {
  _id: Types.ObjectId;
  userId: string;
  productId: string;
  createdAt: Date;
}
const schema = new Schema<WishlistItemDoc>(
  { userId: { type: String, required: true }, productId: { type: String, required: true } },
  { timestamps: { createdAt: true, updatedAt: false } },
);
schema.index({ userId: 1, productId: 1 }, { unique: true });
schema.index({ userId: 1, createdAt: -1 });
export const WishlistItemModel: Model<WishlistItemDoc> = (models.WishlistItem as Model<WishlistItemDoc>) ?? model<WishlistItemDoc>('WishlistItem', schema);
