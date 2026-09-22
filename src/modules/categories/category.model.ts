import { Schema, model, models, type Model } from 'mongoose';
import type { ImageRef } from '../media/media.lookup';

export interface CategoryDoc {
  _id: string;
  name: string;
  slug: string;
  image?: ImageRef | null;
  enabled: boolean;
  badge?: string;
  order: number;
  description?: string;
  createdAt: Date;
  updatedAt: Date;
}
const imageRef = new Schema<ImageRef>({ url: { type: String, required: true }, publicId: { type: String, required: true } }, { _id: false });
const schema = new Schema<CategoryDoc>(
  {
    _id: { type: String },
    name: { type: String, required: true, trim: true },
    slug: { type: String, required: true, trim: true },
    image: { type: imageRef, default: null },
    enabled: { type: Boolean, default: true },
    badge: String,
    order: { type: Number, default: 0 },
    description: String,
  },
  { timestamps: true },
);
schema.index({ slug: 1 }, { unique: true });
schema.index({ name: 1 }, { unique: true, collation: { locale: 'en', strength: 2 } }); // case-insensitive unique name
schema.index({ order: 1 });
export const CategoryModel: Model<CategoryDoc> = (models.Category as Model<CategoryDoc>) ?? model<CategoryDoc>('Category', schema);
