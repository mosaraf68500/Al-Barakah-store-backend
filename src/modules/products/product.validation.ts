import { z } from 'zod';

const shortText = (max: number) => z.string().trim().max(max);
const money = z.number().min(0).max(10_000_000);
const url = z.string().max(1000);
const variant = z.object({ id: shortText(100), label: shortText(200), size: shortText(100), price: money, originalPrice: money.optional(), isPopular: z.boolean().optional(), freeDelivery: z.boolean().optional() });
const landingPage = z.object({
  enabled: z.boolean().optional(), headline: shortText(500).optional(), subheadline: shortText(1500).optional(), highlightBadge: shortText(300).optional(), videoUrl: shortText(500).optional(),
  bannerNote: shortText(500).optional(), keyBenefits: z.array(shortText(500)).max(30).optional(), variants: z.array(variant).max(30).optional(), guaranteeTitle: shortText(300).optional(),
  guaranteeText: shortText(2000).optional(), trustPoints: z.array(shortText(500)).max(30).optional(), faqs: z.array(z.object({ question: shortText(500), answer: shortText(3000) })).max(50).optional(), customerHelpline: shortText(50).optional(),
});

/** Product as the admin app sends it (`Product`). `inStock`, `rating`, `reviewCount`, `createdAt` are server-owned and ignored on update. */
export const productInput = z.object({
  id: z.string().regex(/^prod-[A-Za-z0-9-]{3,80}$/).optional(),
  name: z.string().trim().min(1, 'name required').max(255),
  slug: shortText(255).optional(),
  category: z.string().trim().min(1, 'category required').max(120),
  subcategory: shortText(120).optional().or(z.literal('')),
  brand: shortText(120).optional(), origin: shortText(120).optional(), weight: shortText(60).optional(), sku: shortText(60).optional(),
  isHot: z.boolean().optional(), isNew: z.boolean().optional(),
  description: z.string().max(20_000).default(''),
  price: money,
  originalPrice: money.optional(),
  costPrice: money.optional(),
  // 0 is a VALID stock value (BUG_FIXES A4)
  stockCount: z.number().int().min(0).max(1_000_000).optional(),
  badge: z.enum(['BESTSELLER', 'HOT', 'SALE', 'NEW']).nullable().optional().or(z.literal('')),
  image: url.optional().or(z.literal('')),
  images: z.array(url).max(10).optional(),
  colors: z.array(z.object({ name: shortText(60), hex: shortText(20) })).max(30).optional(),
  sizes: z.array(shortText(60)).max(50).optional(),
  features: z.array(shortText(300)).max(50).optional(),
  tags: z.array(shortText(60)).max(50).optional(),
  rating: z.number().min(0).max(5).optional(),
  reviewCount: z.number().int().min(0).optional(),
  landingPage: landingPage.optional(),
});
export type ProductInput = z.infer<typeof productInput>;

const num = z.coerce.number().finite();
export const publicListQuery = z.object({
  category: z.string().trim().max(120).optional(),
  search: z.string().trim().max(100).optional(),
  inStockOnly: z.enum(['true', 'false']).optional(),
  minPrice: num.min(0).optional(),
  maxPrice: num.min(0).optional(),
  sort: z.enum(['price-low', 'price-high', 'rating', 'newest']).optional(),
  page: z.coerce.number().int().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});
export const adminListQuery = publicListQuery.extend({ deleted: z.enum(['include', 'exclude', 'only']).default('exclude') });
