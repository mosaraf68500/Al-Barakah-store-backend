import type { Request } from 'express';
import type { ClientSession, FilterQuery } from 'mongoose';
import { ratingRemovalPipeline, ratingUpdatePipeline } from '../../domain/rating';
import { generateSlug } from '../../domain/slug';
import { ApiError } from '../../utils/ApiError';
import { recordAudit } from '../audit/audit.service';
import { CategoryModel } from '../categories/category.model';
import { resolveImages, type ImageRef } from '../media/media.lookup';
import { registerMediaUsageChecker } from '../media/media.service';
import type { UserDocument } from '../users/user.model';
import { ProductModel, type ProductDoc } from './product.model';
import { toAdminProduct, toPublicProduct } from './product.serializer';
import type { ProductInput } from './product.validation';

const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const actorOf = (u: UserDocument) => ({ id: u._id, email: u.email, role: u.role });
const HARD_CAP = 1000; // full-array responses are capped (BACKEND_PLAN Q18)

async function categoryNames(): Promise<Map<string, string>> {
  return new Map((await CategoryModel.find().lean()).map((c) => [c._id, c.name]));
}

/* ------------------------------------------------------------------ public reads */

export interface ListQuery { category?: string; search?: string; inStockOnly?: 'true' | 'false'; minPrice?: number; maxPrice?: number; sort?: 'price-low' | 'price-high' | 'rating' | 'newest'; page?: number; limit?: number; deleted?: 'include' | 'exclude' | 'only' }

/** Word-prefix match: a word in the field STARTS with `word` (start of field or after whitespace/punctuation) - works for Bengali too, unlike \b. */
const wordPrefix = (word: string) => new RegExp(`(?:^|[\\s,;:/()\\[\\]\\-_.])${escapeRegex(word)}`, 'i');
const SEARCH_FIELDS = ['name', 'tags', 'subcategory', 'description'] as const;

/**
 * Search = MongoDB text index (ranked by relevance; whole words, multi-word) UNION a word-prefix fallback so partial / as-you-type
 * queries ("sundar" -> "Sundarban Honey") still work like the legacy substring search. Returns the matching ids in rank order:
 * text hits by score first, then prefix-only hits (newest first). Category-name matches follow.
 */
async function searchIds(search: string): Promise<{ ids: string[]; catIds: string[] }> {
  const words = [...new Set(search.split(/\s+/).filter(Boolean))].slice(0, 8);
  const rx = new RegExp(escapeRegex(search.trim()), 'i');
  const [text, prefix, cats] = await Promise.all([
    ProductModel.find({ $text: { $search: search } }, { score: { $meta: 'textScore' } }).sort({ score: { $meta: 'textScore' } }).select('_id').limit(HARD_CAP).lean(),
    words.length
      ? ProductModel.find({ $or: words.flatMap((w) => SEARCH_FIELDS.map((f) => ({ [f]: wordPrefix(w) }))) }).sort({ createdAt: -1, _id: 1 }).select('_id').limit(HARD_CAP).lean()
      : Promise.resolve([]),
    CategoryModel.find({ name: rx }).select('_id').lean(),
  ]);
  const ids = [...new Set([...text.map((t) => t._id), ...prefix.map((t) => t._id)])];
  return { ids, catIds: cats.map((c) => c._id) };
}

async function buildFilter(q: ListQuery, deleted: 'exclude' | 'include' | 'only', rank?: Map<string, number>): Promise<FilterQuery<ProductDoc> | null> {
  const and: FilterQuery<ProductDoc>[] = [];
  if (deleted === 'exclude') and.push({ deletedAt: null });
  if (deleted === 'only') and.push({ deletedAt: { $ne: null } });

  if (q.category && q.category !== 'All') {
    const rx = new RegExp(`^${escapeRegex(q.category)}$`, 'i');
    const cats = await CategoryModel.find({ $or: [{ _id: q.category }, { name: rx }, { slug: rx }] }).lean();
    if (cats.length === 0) return null; // unknown category -> empty result
    and.push({ categoryId: { $in: cats.map((c) => c._id) } });
  }
  if (q.search) {
    const { ids, catIds } = await searchIds(q.search);
    ids.forEach((id, i) => rank?.set(id, i));
    and.push({ $or: [{ _id: { $in: ids } }, { categoryId: { $in: catIds } }] });
  }
  if (q.inStockOnly === 'true') and.push({ inStock: true, stockCount: { $gt: 0 } });
  if (q.minPrice !== undefined) and.push({ price: { $gte: q.minPrice } });
  if (q.maxPrice !== undefined) and.push({ price: { $lte: q.maxPrice } });
  return and.length ? { $and: and } : {};
}

const SORTS = { 'price-low': { price: 1, _id: 1 }, 'price-high': { price: -1, _id: 1 }, rating: { rating: -1, reviewCount: -1, _id: 1 }, newest: { createdAt: -1, _id: 1 } } as const;

async function list(q: ListQuery, admin: boolean) {
  const rank = new Map<string, number>();
  const filter = await buildFilter(q, admin ? q.deleted ?? 'exclude' : 'exclude', rank);
  const names = await categoryNames();
  const ser = (p: ProductDoc) => (admin ? toAdminProduct(p, names.get(p.categoryId) ?? '') : toPublicProduct(p, names.get(p.categoryId) ?? ''));
  const paged = q.page !== undefined && q.limit !== undefined;
  if (filter === null) return paged ? { items: [], total: 0, page: q.page!, limit: q.limit!, totalPages: 0 } : [];

  // A search with no explicit sort is ordered by relevance (text hits first, then prefix-only hits, then category-name matches); an explicit sort wins.
  const byRelevance = Boolean(q.search) && !q.sort;
  const base = ProductModel.find(filter).sort(SORTS[q.sort ?? 'newest']);
  const query = admin ? base.select('+costPrice') : base; // costPrice is select:false - only admin queries opt in
  if (byRelevance) {
    const rows = (await query.limit(HARD_CAP).lean()).sort((x, y) => (rank.get(x._id) ?? Infinity) - (rank.get(y._id) ?? Infinity));
    if (!paged) return rows.map(ser);
    const start = (q.page! - 1) * q.limit!;
    return { items: rows.slice(start, start + q.limit!).map(ser), total: rows.length, page: q.page!, limit: q.limit!, totalPages: Math.ceil(rows.length / q.limit!) };
  }
  if (paged) {
    const [rows, total] = await Promise.all([query.skip((q.page! - 1) * q.limit!).limit(q.limit!).lean(), ProductModel.countDocuments(filter)]);
    return { items: rows.map(ser), total, page: q.page!, limit: q.limit!, totalPages: Math.ceil(total / q.limit!) };
  }
  return (await query.limit(HARD_CAP).lean()).map(ser);
}
export const listPublicProducts = (q: ListQuery) => list(q, false);
export const listAdminProducts = (q: ListQuery) => list(q, true);

/** Same resolution order as the storefront: id -> slug -> (case-insensitive) id/slug -> name-contains (>= 3 chars). Archived products never resolve. */
export async function getPublicProduct(rawKey: string) {
  const key = decodeURIComponent(rawKey).trim();
  if (!key) throw ApiError.notFound('PRODUCT_NOT_FOUND');
  const rx = new RegExp(`^${escapeRegex(key)}$`, 'i');
  const live = { deletedAt: null };
  const doc =
    (await ProductModel.findOne({ ...live, _id: key }).lean()) ??
    (await ProductModel.findOne({ ...live, slug: key }).lean()) ??
    (await ProductModel.findOne({ ...live, $or: [{ _id: rx }, { slug: rx }] }).lean()) ??
    (key.length >= 3 ? await ProductModel.findOne({ ...live, name: new RegExp(escapeRegex(key), 'i') }).sort({ createdAt: 1, _id: 1 }).lean() : null);
  if (!doc) throw ApiError.notFound('PRODUCT_NOT_FOUND');
  return toPublicProduct(doc, (await categoryNames()).get(doc.categoryId) ?? '');
}

export async function getAdminProduct(id: string) {
  const doc = await ProductModel.findById(id).select('+costPrice').lean();
  if (!doc) throw ApiError.notFound('PRODUCT_NOT_FOUND');
  return toAdminProduct(doc, (await categoryNames()).get(doc.categoryId) ?? '');
}

/* ----------------------------------------------------------------- admin writes */

async function categoryIdFor(name: string): Promise<string> {
  const c = await CategoryModel.findOne({ name: new RegExp(`^${escapeRegex(name)}$`, 'i') }).lean();
  if (!c) throw ApiError.badRequest('CATEGORY_NOT_FOUND', `Category "${name}" does not exist`);
  return c._id;
}

/** image + images -> stored `{url, publicId}` refs; every URL must exist in Media (uploaded through the signed flow). */
async function imagesFor(input: Pick<ProductInput, 'image' | 'images'>): Promise<{ image: ImageRef | null; images: ImageRef[] } | undefined> {
  if (input.image === undefined && input.images === undefined) return undefined; // not sent -> keep what is stored
  const primary = input.image || input.images?.[0] || '';
  const all = [...(input.images ?? [])];
  if (primary && !all.includes(primary)) all.unshift(primary);
  const map = await resolveImages([primary, ...all]);
  return { image: primary ? map.get(primary)! : null, images: all.map((u) => map.get(u)!) };
}

const SLUG_RE = /^[\p{L}\p{N}]+(?:-[\p{L}\p{N}]+)*$/u;
async function uniqueSlug(input: { slug?: string; name: string }, id: string, exceptId?: string): Promise<string> {
  const taken = async (s: string) => {
    const hit = await ProductModel.findOne({ slug: s }).select('_id').lean();
    return Boolean(hit && hit._id !== exceptId);
  };
  if (input.slug?.trim()) {
    const s = input.slug.trim();
    if (!SLUG_RE.test(s)) throw ApiError.badRequest('INVALID_SLUG');
    if (await taken(s)) throw ApiError.conflict('SLUG_TAKEN');
    return s;
  }
  // generated: empty (e.g. Bengali-only name) falls back to the id (BUG_FIXES A14); collisions get a numeric suffix
  const base = generateSlug(input.name) || id;
  let s = base;
  for (let n = 2; await taken(s); n++) s = `${base}-${n}`;
  return s;
}

export async function createProduct(actor: UserDocument, input: ProductInput, req: Request) {
  const id = input.id ?? `prod-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  if (await ProductModel.exists({ _id: id })) throw ApiError.conflict('PRODUCT_ID_TAKEN');
  const categoryId = await categoryIdFor(input.category);
  const imgs = await imagesFor(input);
  const slug = await uniqueSlug(input, id);
  const stock = input.stockCount ?? 0;
  const doc = await ProductModel.create({
    _id: id, name: input.name, slug, categoryId, subcategory: input.subcategory || undefined, brand: input.brand, origin: input.origin, weight: input.weight, sku: input.sku,
    isHot: input.isHot, flagNew: input.isNew, description: input.description, price: input.price, originalPrice: input.originalPrice, costPrice: input.costPrice,
    stockCount: stock, inStock: stock > 0, badge: input.badge || null, image: imgs?.image ?? null, images: imgs?.images ?? [],
    colors: input.colors ?? [], sizes: input.sizes ?? [], features: input.features ?? [], tags: input.tags ?? [],
    // rating/reviewCount are only a starting baseline on creation; afterwards reviews own them
    rating: input.rating ?? 5, reviewCount: input.reviewCount ?? 0, landingPage: input.landingPage,
  });
  await recordAudit({ actor: actorOf(actor), action: 'product.create', entity: 'Product', entityId: id, details: { name: input.name }, req });
  return getAdminProduct(doc._id);
}

/** Full replace of the editable fields. `rating`, `reviewCount`, `createdAt`, `inStock` (derived) are never taken from the client. */
export async function updateProduct(actor: UserDocument, id: string, input: ProductInput, req: Request) {
  const doc = await ProductModel.findById(id).select('+costPrice');
  if (!doc) throw ApiError.notFound('PRODUCT_NOT_FOUND');
  if (doc.deletedAt) throw ApiError.conflict('PRODUCT_ARCHIVED', 'Restore the product before editing it');
  const categoryId = await categoryIdFor(input.category);
  const imgs = await imagesFor(input);
  if (input.slug !== undefined && input.slug.trim() !== doc.slug) doc.slug = await uniqueSlug({ slug: input.slug, name: input.name }, id, id);
  doc.name = input.name;
  doc.categoryId = categoryId;
  doc.subcategory = input.subcategory || undefined;
  doc.brand = input.brand; doc.origin = input.origin; doc.weight = input.weight; doc.sku = input.sku;
  doc.isHot = input.isHot; doc.flagNew = input.isNew;
  doc.description = input.description;
  doc.price = input.price;
  doc.originalPrice = input.originalPrice;
  doc.costPrice = input.costPrice;
  if (input.stockCount !== undefined) doc.stockCount = input.stockCount;
  doc.inStock = doc.stockCount > 0; // derived - 0 is a valid, savable value (BUG_FIXES A4)
  doc.badge = input.badge || null;
  if (imgs) { doc.image = imgs.image; doc.images = imgs.images; }
  if (input.colors) doc.colors = input.colors;
  if (input.sizes) doc.sizes = input.sizes;
  if (input.features) doc.features = input.features;
  if (input.tags) doc.tags = input.tags;
  if (input.landingPage !== undefined) doc.landingPage = input.landingPage;
  await doc.save();
  await recordAudit({ actor: actorOf(actor), action: 'product.update', entity: 'Product', entityId: id, details: { name: input.name }, req });
  return getAdminProduct(id);
}

/** Soft delete (BACKEND_PLAN Q9): hidden from every public read, still visible to admins, restorable. There is no hard-delete endpoint. */
export async function softDeleteProduct(actor: UserDocument, id: string, req: Request) {
  const r = await ProductModel.findOneAndUpdate({ _id: id, deletedAt: null }, { $set: { deletedAt: new Date() } }, { new: true });
  if (!r) throw ApiError.notFound('PRODUCT_NOT_FOUND');
  await recordAudit({ actor: actorOf(actor), action: 'product.delete', entity: 'Product', entityId: id, details: { name: r.name, soft: true }, req });
}
export async function restoreProduct(actor: UserDocument, id: string, req: Request) {
  const r = await ProductModel.findOneAndUpdate({ _id: id, deletedAt: { $ne: null } }, { $set: { deletedAt: null } }, { new: true });
  if (!r) throw ApiError.notFound('PRODUCT_NOT_FOUND');
  await recordAudit({ actor: actorOf(actor), action: 'product.restore', entity: 'Product', entityId: id, details: { name: r.name }, req });
  return getAdminProduct(id);
}

/** Used by the reviews module (Module 6): atomic rating aggregate (domain/rating.ts). Runs inside the review's own transaction. */
export async function addReviewToProductRating(productId: string, rating: number, session?: ClientSession) {
  await ProductModel.updateOne({ _id: productId }, ratingUpdatePipeline(rating), { session });
}
/** The inverse, used when a review is moderated away - keeps the aggregate honest instead of leaving a deleted review's score baked in. */
export async function removeReviewFromProductRating(productId: string, rating: number, session?: ClientSession) {
  await ProductModel.updateOne({ _id: productId }, ratingRemovalPipeline(rating), { session });
}

// A Cloudinary asset used by any product (archived ones too - they can be restored) cannot be deleted.
registerMediaUsageChecker(async (m) => ((await ProductModel.exists({ $or: [{ 'image.publicId': m.publicId }, { 'images.publicId': m.publicId }] })) ? ['products'] : []));
