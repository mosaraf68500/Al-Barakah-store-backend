import { CacheIndex, CacheKeys } from './keys';
import { cacheDel, cacheInvalidateIndex } from './cacheAside';

/** Wipe all public product list + detail caches (admin CRUD, stock, ratings). */
export async function invalidateProductCaches(): Promise<void> {
  await Promise.all([cacheInvalidateIndex(CacheIndex.productListKeys), cacheInvalidateIndex(CacheIndex.productDetailKeys)]);
}

/** Wipe one product detail key variants (id + slug) plus every list. */
export async function invalidateProductCachesFor(keys: string[]): Promise<void> {
  const detailKeys = keys.filter(Boolean).map((k) => CacheKeys.productByKey(k));
  await Promise.all([cacheInvalidateIndex(CacheIndex.productListKeys), cacheDel(...detailKeys), cacheInvalidateIndex(CacheIndex.productDetailKeys)]);
}

export async function invalidateCategoryCaches(): Promise<void> {
  // Category rename changes product.category name in public product payloads.
  await Promise.all([cacheDel(CacheKeys.categories()), invalidateProductCaches()]);
}

export async function invalidateSettingsCaches(): Promise<void> {
  await cacheDel(CacheKeys.settingsPublic());
}

export async function invalidateReviewCaches(): Promise<void> {
  // Reviews also bump product rating/reviewCount → clear product caches too.
  await Promise.all([cacheInvalidateIndex(CacheIndex.reviewListKeys), invalidateProductCaches()]);
}
