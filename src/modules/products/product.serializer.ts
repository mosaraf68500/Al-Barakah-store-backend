import { serializeImage } from '../media/media.lookup';
import type { ProductDoc } from './product.model';

/**
 * API shape = the storefront/admin `Product` type: plain URL strings for images, `category` = the category NAME, no internals.
 * PUBLIC output is a whitelist: `costPrice` and `deletedAt` cannot appear here even if a query forgot to exclude them.
 */
export function toPublicProduct(p: ProductDoc, categoryName: string) {
  return {
    id: p._id,
    name: p.name,
    slug: p.slug,
    category: categoryName,
    ...(p.subcategory ? { subcategory: p.subcategory } : {}),
    ...(p.brand ? { brand: p.brand } : {}), ...(p.origin ? { origin: p.origin } : {}), ...(p.weight ? { weight: p.weight } : {}), ...(p.sku ? { sku: p.sku } : {}),
    ...(p.isHot !== undefined ? { isHot: p.isHot } : {}), ...(p.flagNew !== undefined ? { isNew: p.flagNew } : {}),
    description: p.description,
    price: p.price,
    ...(p.originalPrice !== undefined ? { originalPrice: p.originalPrice } : {}),
    stockCount: p.stockCount,
    inStock: p.inStock,
    ...(p.badge ? { badge: p.badge } : {}),
    image: serializeImage(p.image),
    images: (p.images ?? []).map((i) => i.url),
    colors: p.colors ?? [],
    sizes: p.sizes ?? [],
    features: p.features ?? [],
    tags: p.tags ?? [],
    rating: p.rating,
    reviewCount: p.reviewCount,
    ...(p.landingPage ? { landingPage: p.landingPage } : {}),
    createdAt: p.createdAt.toISOString(),
  };
}

/** Admin output = public + the purchase price and the archive state. */
export function toAdminProduct(p: ProductDoc, categoryName: string) {
  return { ...toPublicProduct(p, categoryName), ...(p.costPrice !== undefined ? { costPrice: p.costPrice } : {}), deletedAt: p.deletedAt ? p.deletedAt.toISOString() : null };
}
