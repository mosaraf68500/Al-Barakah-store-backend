/** Redis key namespace + TTLs for public read caches (cache-aside). */
export const CacheKeys = {
  productsList: (queryHash: string) => `abp:products:list:${queryHash}`,
  productByKey: (key: string) => `abp:products:one:${encodeURIComponent(key.toLowerCase())}`,
  categories: () => 'abp:categories:all',
  settingsPublic: () => 'abp:settings:public',
  reviewsList: (queryHash: string) => `abp:reviews:list:${queryHash}`,
} as const;

/** Default TTLs (seconds). Stock/rating invalidation clears early; TTL is a safety net. */
export const CacheTtl = {
  products: 60 * 60, // 1 hour
  product: 60 * 60,
  categories: 60 * 60,
  settings: 60 * 60,
  reviews: 60 * 60,
} as const;

/** Prefixes wiped on related writes (SCAN-free: we track list keys via a set membership). */
export const CacheIndex = {
  productListKeys: 'abp:products:list:_index',
  productDetailKeys: 'abp:products:one:_index',
  reviewListKeys: 'abp:reviews:list:_index',
} as const;
