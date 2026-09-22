import { Schema, model, models, type Model } from 'mongoose';
import type { ImageRef } from '../media/media.lookup';

export interface LandingVariant { id: string; label: string; size: string; price: number; originalPrice?: number; isPopular?: boolean; freeDelivery?: boolean }
export interface LandingPage {
  enabled?: boolean; headline?: string; subheadline?: string; highlightBadge?: string; videoUrl?: string; bannerNote?: string;
  keyBenefits?: string[]; variants?: LandingVariant[]; guaranteeTitle?: string; guaranteeText?: string; trustPoints?: string[];
  faqs?: { question: string; answer: string }[]; customerHelpline?: string;
}
export interface ProductDoc {
  _id: string;
  name: string;
  slug: string;
  categoryId: string;
  subcategory?: string;
  brand?: string; origin?: string; weight?: string; sku?: string;
  isHot?: boolean;
  /** API name: `isNew` (`isNew` is reserved by Mongoose, so it is stored as `flagNew`). */
  flagNew?: boolean;
  description: string;
  price: number;
  originalPrice?: number;
  /** Purchase price - admin only. `select:false`: never loaded unless an admin query asks for it. */
  costPrice?: number;
  stockCount: number;
  inStock: boolean;
  badge?: 'BESTSELLER' | 'HOT' | 'SALE' | 'NEW' | null;
  image?: ImageRef | null;
  images: ImageRef[];
  colors: { name: string; hex: string }[];
  sizes: string[];
  features: string[];
  tags: string[];
  rating: number;
  reviewCount: number;
  landingPage?: LandingPage;
  deletedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}
const imageRef = new Schema<ImageRef>({ url: { type: String, required: true }, publicId: { type: String, required: true } }, { _id: false });
const schema = new Schema<ProductDoc>(
  {
    _id: { type: String },
    name: { type: String, required: true, trim: true },
    slug: { type: String, required: true },
    categoryId: { type: String, required: true, ref: 'Category' },
    subcategory: String,
    brand: String, origin: String, weight: String, sku: String,
    isHot: Boolean, flagNew: Boolean,
    description: { type: String, default: '' },
    price: { type: Number, required: true, min: 0 },
    originalPrice: Number,
    costPrice: { type: Number, select: false },
    stockCount: { type: Number, default: 0, min: 0 },
    inStock: { type: Boolean, default: false },
    badge: { type: String, enum: ['BESTSELLER', 'HOT', 'SALE', 'NEW', null], default: null },
    image: { type: imageRef, default: null },
    images: { type: [imageRef], default: [] },
    colors: { type: [{ _id: false, name: String, hex: String }], default: [] },
    sizes: { type: [String], default: [] },
    features: { type: [String], default: [] },
    tags: { type: [String], default: [] },
    rating: { type: Number, default: 5 },
    reviewCount: { type: Number, default: 0 },
    landingPage: { type: Schema.Types.Mixed },
    deletedAt: { type: Date, default: null },
  },
  { timestamps: true },
);
// slugs stay reserved even for archived products (a QR code / old link must 404, never show a different product)
schema.index({ slug: 1 }, { unique: true });
schema.index({ categoryId: 1 });
schema.index({ deletedAt: 1, createdAt: -1 });
schema.index({ inStock: 1 });
// search: word-based text index; language 'none' = no English stemming/stop-words, so Bengali and English tokens behave the same
schema.index({ name: 'text', tags: 'text', subcategory: 'text', description: 'text' }, { weights: { name: 10, tags: 5, subcategory: 3, description: 1 }, default_language: 'none', name: 'product_search' });
export const ProductModel: Model<ProductDoc> = (models.Product as Model<ProductDoc>) ?? model<ProductDoc>('Product', schema);
