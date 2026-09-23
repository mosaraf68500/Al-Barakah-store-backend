/**
 * One-time import of the Firestore seed snapshot (products, categories, orders, reviews, settings)
 * into MongoDB. Base64 images are uploaded to Cloudinary and stored as Media rows. Settings secrets
 * are encrypted with the same envelope as PATCH /admin/settings. Coupons and legacy audit logs are
 * not in a shape this database can store; they are reported and skipped.
 *
 * Re-running is safe: an existing `_id` is left alone unless `force` is set. The same image bytes
 * always get the same `publicId`, so a second run does not upload them again.
 */
import crypto from 'node:crypto';
import { getEnv } from '../../config/env';
import { deriveZone } from '../../domain/zone';
import { generateSlug } from '../../domain/slug';
import { normalizeBdMobile, phoneKey } from '../../utils/phone';
import { recordAudit } from '../audit/audit.service';
import { CategoryModel } from '../categories/category.model';
import { MediaModel } from '../media/media.model';
import { MEDIA_FOLDERS, ROOT_FOLDER } from '../media/media.validation';
import { OrderModel, ORDER_STATUSES } from '../orders/order.model';
import { ProductModel } from '../products/product.model';
import { ReviewModel } from '../reviews/review.model';
import { sealImportedSecrets } from '../settings/settings.service';
import { updateSettingsSchema } from '../settings/settings.validation';
import { SETTINGS_ID, SettingsModel } from '../settings/settings.model';
import { UserModel } from '../users/user.model';

const MARK = 'seedimg:';
const BADGES = new Set(['BESTSELLER', 'HOT', 'SALE', 'NEW']);
type MediaFolder = (typeof MEDIA_FOLDERS)[number];

export class SeedImportError extends Error {
  constructor(readonly problems: string[]) {
    super(problems.join('\n'));
    this.name = 'SeedImportError';
  }
}

export interface PlannedImage {
  publicId: string;
  /** Second path segment (`products`, `categories`, `banners`, `seo`, `misc`). */
  folder: MediaFolder;
  format: string;
  bytes: number;
  dataUrl: string;
}

export interface ImageUploader {
  (image: PlannedImage): Promise<{ secureUrl: string; url?: string; format?: string; bytes?: number; width?: number; height?: number }>;
}

export interface SeedFiles {
  products: unknown;
  categories: unknown;
  orders: unknown;
  reviews: unknown;
  settings: unknown;
}

export interface ImportReport {
  dryRun: boolean;
  force: boolean;
  planned: { products: number; categories: number; orders: number; reviews: number; settings: number; media: number; coupons: number };
  images: { unique: number; alreadyInMedia: number; toUpload: number };
  /** Field names only. Values are never included. */
  secrets: { present: string[]; empty: string[] };
  warnings: string[];
  skipped: { coupons: string; auditLogs: string };
  result?: {
    inserted: Record<string, number>;
    skipped: Record<string, number>;
    uploaded: number;
    database: Record<string, number>;
  };
}

interface ImageRef { url: string; publicId: string }

interface SeedPlan {
  categories: Record<string, unknown>[];
  products: Record<string, unknown>[];
  orders: Record<string, unknown>[];
  reviews: Record<string, unknown>[];
  /** `config` still contains `seedimg:<publicId>` marks. Real URLs are substituted at write time, after Zod has accepted the shape. */
  settings: { config: Record<string, unknown>; secrets: Record<string, string> } | null;
  images: PlannedImage[];
  warnings: string[];
  secrets: { present: string[]; empty: string[] };
}

function problemsOrThrow(problems: string[]) {
  if (problems.length) throw new SeedImportError(problems);
}

function asArray(value: unknown, file: string): Record<string, unknown>[] {
  if (!Array.isArray(value)) throw new SeedImportError([`${file} must be a JSON array`]);
  return value.map((row, i) => {
    if (!row || typeof row !== 'object' || Array.isArray(row)) throw new SeedImportError([`${file}[${i}] must be an object`]);
    return row as Record<string, unknown>;
  });
}

function asSettings(value: unknown): Record<string, unknown> {
  const row = Array.isArray(value) ? (value.length === 1 ? value[0] : null) : value;
  if (!row || typeof row !== 'object' || Array.isArray(row)) throw new SeedImportError(['settings.json must be one object (or an array of one object)']);
  return row as Record<string, unknown>;
}

function str(row: Record<string, unknown>, key: string): string {
  const v = row[key];
  return typeof v === 'string' ? v.trim() : '';
}

function parseDataUrl(dataUrl: string): { format: string; bytes: Buffer } | null {
  const m = /^data:(image\/(?:jpeg|jpg|png|webp|gif));base64,([a-z0-9+/=\s]+)$/i.exec(dataUrl.trim());
  if (!m) return null;
  const subtype = m[1].slice('image/'.length).toLowerCase();
  const format = subtype === 'jpeg' ? 'jpg' : subtype;
  const bytes = Buffer.from(m[2].replace(/\s/g, ''), 'base64');
  if (!bytes.length) return null;
  return { format, bytes };
}

class ImageIndex {
  private readonly byHash = new Map<string, PlannedImage>();
  readonly images: PlannedImage[] = [];

  add(dataUrl: string, folder: MediaFolder, where: string, problems: string[]): string | null {
    const parsed = parseDataUrl(dataUrl);
    if (!parsed) {
      problems.push(`${where} is not a base64 jpeg, png, webp or gif`);
      return null;
    }
    const sha1 = crypto.createHash('sha1').update(parsed.bytes).digest('hex');
    const existing = this.byHash.get(sha1);
    if (existing) return existing.publicId;
    const image: PlannedImage = { publicId: `${ROOT_FOLDER}/${folder}/${sha1}`, folder, format: parsed.format, bytes: parsed.bytes.length, dataUrl };
    this.byHash.set(sha1, image);
    this.images.push(image);
    return image.publicId;
  }
}

function rewriteDataUrls(value: unknown, folderFor: (path: string) => MediaFolder, index: ImageIndex, problems: string[], path: string): unknown {
  if (typeof value === 'string') {
    if (!value.startsWith('data:image/')) return value;
    const id = index.add(value, folderFor(path), path, problems);
    return id ? MARK + id : '';
  }
  if (Array.isArray(value)) return value.map((v, i) => rewriteDataUrls(v, folderFor, index, problems, `${path}[${i}]`));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = rewriteDataUrls(v, folderFor, index, problems, path ? `${path}.${k}` : k);
    return out;
  }
  return value;
}

function applyMarks(value: unknown, urlFor: (publicId: string) => string): unknown {
  if (typeof value === 'string') return value.startsWith(MARK) ? urlFor(value.slice(MARK.length)) : value;
  if (Array.isArray(value)) return value.map((v) => applyMarks(v, urlFor));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = applyMarks(v, urlFor);
    return out;
  }
  return value;
}

const PLACEHOLDER_PREFIX = 'https://res.cloudinary.com/seed-import/image/upload/';
function placeholderUrl(publicId: string): string {
  return PLACEHOLDER_PREFIX + publicId;
}
/** Zod sees placeholder https URLs. The plan keeps `seedimg:<publicId>` so the write can swap in the real URL. */
function restoreMarks(value: unknown): Record<string, unknown> {
  const walk = (v: unknown): unknown => {
    if (typeof v === 'string') return v.startsWith(PLACEHOLDER_PREFIX) ? MARK + v.slice(PLACEHOLDER_PREFIX.length) : v;
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, child] of Object.entries(v as Record<string, unknown>)) out[k] = walk(child);
      return out;
    }
    return v;
  };
  return walk(value) as Record<string, unknown>;
}

function settingsFolder(path: string): MediaFolder {
  if (path.includes('ogImage')) return 'seo';
  if (path.includes('heroBanners') || path.includes('topSelling')) return 'banners';
  return 'misc';
}

function imageRef(publicId: string, urlFor: (id: string) => string): ImageRef {
  return { publicId, url: urlFor(publicId) };
}

function takeImage(row: Record<string, unknown>, key: string, folder: MediaFolder, where: string, index: ImageIndex, problems: string[]): string | null {
  const v = row[key];
  if (typeof v !== 'string' || v.trim() === '') return null;
  if (!v.startsWith('data:image/')) {
    problems.push(`${where} is not a base64 image`);
    return null;
  }
  return index.add(v, folder, where, problems);
}

export function buildPlan(files: SeedFiles): SeedPlan {
  const problems: string[] = [];
  const warnings: string[] = [];
  const index = new ImageIndex();
  const categoriesIn = asArray(files.categories, 'categories.json');
  const productsIn = asArray(files.products, 'products.json');
  const ordersIn = asArray(files.orders, 'orders.json');
  const reviewsIn = asArray(files.reviews, 'reviews.json');
  const settingsIn = asSettings(files.settings);

  const categoryIdByName = new Map<string, string>();
  const categories: Record<string, unknown>[] = [];
  const usedCatSlug = new Set<string>();
  for (const row of categoriesIn) {
    const id = str(row, 'id');
    const name = str(row, 'name');
    if (!id || !name) {
      problems.push('a category is missing id or name');
      continue;
    }
    if (categoryIdByName.has(name)) problems.push(`duplicate category name on ${id}`);
    categoryIdByName.set(name, id);
    let slug = str(row, 'slug') || generateSlug(name) || id;
    if (!str(row, 'slug')) warnings.push(`category ${id} had no slug; stored as ${slug}`);
    let n = 2;
    const base = slug;
    while (usedCatSlug.has(slug)) slug = `${base}-${n++}`;
    usedCatSlug.add(slug);
    const publicId = takeImage(row, 'image', 'categories', `category ${id} image`, index, problems);
    categories.push({
      _id: id,
      name,
      slug,
      enabled: row.enabled !== false,
      badge: str(row, 'badge') || undefined,
      order: typeof row.order === 'number' ? row.order : 0,
      description: str(row, 'description') || undefined,
      image: publicId,
    });
  }

  const productIds = new Set<string>();
  const usedSlug = new Set<string>();
  const products: Record<string, unknown>[] = [];
  for (const row of productsIn) {
    const id = str(row, 'id');
    const name = str(row, 'name');
    const categoryName = str(row, 'category');
    if (!id || !name) {
      problems.push('a product is missing id or name');
      continue;
    }
    if (productIds.has(id)) problems.push(`duplicate product id ${id}`);
    productIds.add(id);
    const categoryId = categoryIdByName.get(categoryName);
    if (!categoryId) problems.push(`product ${id} category does not match any category name`);
    if (typeof row.price !== 'number' || row.price < 0) problems.push(`product ${id} has an invalid price`);
    if (typeof row.stockCount !== 'number' || row.stockCount < 0) problems.push(`product ${id} has an invalid stockCount`);
    const givenSlug = str(row, 'slug');
    let slug = givenSlug || generateSlug(name) || id;
    if (!givenSlug) warnings.push(`product ${id} had no slug; stored as ${slug}`);
    let n = 2;
    const base = slug;
    while (usedSlug.has(slug)) slug = `${base}-${n++}`;
    usedSlug.add(slug);
    const badge = str(row, 'badge');
    if (badge && !BADGES.has(badge)) problems.push(`product ${id} has an unknown badge`);
    const primary = takeImage(row, 'image', 'products', `product ${id} image`, index, problems);
    const extra = Array.isArray(row.images) ? row.images : [];
    const gallery: string[] = [];
    extra.forEach((img, i) => {
      if (typeof img !== 'string' || !img.trim()) return;
      if (!img.startsWith('data:image/')) {
        problems.push(`product ${id} images[${i}] is not a base64 image`);
        return;
      }
      const publicId = index.add(img, 'products', `product ${id} images[${i}]`, problems);
      if (publicId && !gallery.includes(publicId)) gallery.push(publicId);
    });
    if (primary && !gallery.includes(primary)) gallery.unshift(primary);
    const stock = typeof row.stockCount === 'number' ? row.stockCount : 0;
    products.push({
      _id: id,
      name,
      slug,
      categoryId: categoryId ?? '',
      subcategory: str(row, 'subcategory') || undefined,
      description: typeof row.description === 'string' ? row.description : '',
      price: row.price,
      originalPrice: typeof row.originalPrice === 'number' ? row.originalPrice : undefined,
      costPrice: typeof row.costPrice === 'number' ? row.costPrice : undefined,
      stockCount: stock,
      inStock: typeof row.inStock === 'boolean' ? row.inStock : stock > 0,
      badge: badge && BADGES.has(badge) ? badge : null,
      image: primary,
      images: gallery,
      colors: [],
      sizes: Array.isArray(row.sizes) ? row.sizes.filter((s) => typeof s === 'string') : [],
      features: Array.isArray(row.features) ? row.features.filter((s) => typeof s === 'string') : [],
      tags: Array.isArray(row.tags) ? row.tags.filter((s) => typeof s === 'string') : [],
      rating: typeof row.rating === 'number' ? row.rating : 5,
      reviewCount: typeof row.reviewCount === 'number' ? row.reviewCount : 0,
      deletedAt: null,
    });
  }

  const hours = getEnv().PENDING_ORDER_TIMEOUT_HOURS;
  const cutoff = Date.now() - hours * 3_600_000;
  const stalePending: string[] = [];
  const orders: Record<string, unknown>[] = [];
  const seenOrder = new Set<string>();
  const seenTrx = new Set<string>();
  for (const row of ordersIn) {
    const id = str(row, 'id');
    const customer = row.customer;
    if (!id || !customer || typeof customer !== 'object' || Array.isArray(customer)) {
      problems.push('an order is missing id or customer');
      continue;
    }
    if (seenOrder.has(id)) problems.push(`duplicate order id ${id}`);
    seenOrder.add(id);
    const c = customer as Record<string, unknown>;
    const fullName = str(c, 'fullName');
    const phone = str(c, 'phone');
    const address = str(c, 'address');
    if (!fullName || !phone || !address) problems.push(`order ${id} is missing customer name, phone or address`);
    const digits = phone.replace(/\D/g, '');
    const normalized = normalizeBdMobile(phone);
    if (!normalized) warnings.push(`order ${id} phone is not a BD mobile; phoneKey is the last 10 digits of whatever was stored`);
    if (digits.length < 10 && !normalized) problems.push(`order ${id} phone has fewer than 10 digits`);
    const createdAt = new Date(str(row, 'createdAt'));
    if (Number.isNaN(createdAt.getTime())) problems.push(`order ${id} has an invalid createdAt`);
    const status = str(row, 'status');
    if (!(ORDER_STATUSES as readonly string[]).includes(status)) problems.push(`order ${id} has an unknown status`);
    const advancePaymentType = str(row, 'advancePaymentType') || 'NONE';
    const deliveryPaymentStatus = str(row, 'deliveryPaymentStatus') || 'COD_PENDING';
    if (!['NONE', 'DELIVERY_ONLY', 'FULL_PAYMENT'].includes(advancePaymentType)) problems.push(`order ${id} has an unknown advancePaymentType`);
    if (!['ADVANCE_PAID', 'ADVANCE_PENDING', 'FULL_PAID', 'COD_PENDING', 'VERIFIED', 'FAKE_SUSPECTED'].includes(deliveryPaymentStatus)) problems.push(`order ${id} has an unknown deliveryPaymentStatus`);
    const itemsIn = Array.isArray(row.items) ? row.items : [];
    if (!itemsIn.length) problems.push(`order ${id} has no items`);
    const items = itemsIn.map((item, i) => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) {
        problems.push(`order ${id} item ${i} is not an object`);
        return null;
      }
      const it = item as Record<string, unknown>;
      const productId = str(it, 'productId');
      if (!productId) warnings.push(`order ${id} item ${i} has no productId`);
      else if (!productIds.has(productId)) warnings.push(`order ${id} item ${i} productId is not in the catalogue`);
      const quantity = it.quantity;
      const price = it.price;
      if (typeof quantity !== 'number' || quantity < 1) problems.push(`order ${id} item ${i} has an invalid quantity`);
      if (typeof price !== 'number' || price < 0) problems.push(`order ${id} item ${i} has an invalid price`);
      let image = '';
      if (typeof it.image === 'string' && it.image.startsWith('data:image/')) {
        image = index.add(it.image, 'misc', `order ${id} item ${i} image`, problems) ?? '';
      }
      return {
        productId: productId || undefined,
        name: str(it, 'name') || 'Item',
        image,
        price,
        quantity,
        selectedSize: str(it, 'selectedSize') || undefined,
        selectedColor: str(it, 'selectedColor') || undefined,
        totalPrice: typeof price === 'number' && typeof quantity === 'number' ? price * quantity : 0,
      };
    });
    const trx = str(row, 'bkashTrxId');
    if (trx) {
      if (seenTrx.has(trx)) problems.push(`order ${id} reuses a bKash TrxID`);
      seenTrx.add(trx);
    }
    const stockDeducted = row.stockDeducted === true;
    if (status === 'pending' && !Number.isNaN(createdAt.getTime()) && createdAt.getTime() < cutoff && !stockDeducted) stalePending.push(id);
    const zone = deriveZone(str(c, 'city'));
    orders.push({
      _id: id,
      userId: null,
      customer: {
        fullName,
        email: str(c, 'email') || undefined,
        phone,
        address,
        city: str(c, 'city'),
        postalCode: str(c, 'postalCode') || undefined,
      },
      phoneKey: normalized ? phoneKey(normalized) : digits.slice(-10),
      items: items.filter(Boolean),
      subtotal: typeof row.subtotal === 'number' ? row.subtotal : 0,
      discount: typeof row.discount === 'number' ? row.discount : 0,
      shipping: typeof row.shipping === 'number' ? row.shipping : 0,
      total: typeof row.total === 'number' ? row.total : 0,
      currency: 'BDT',
      status,
      advancePaymentType,
      advanceAmount: typeof row.advanceAmount === 'number' ? row.advanceAmount : 0,
      dueAmountOnDelivery: typeof row.dueAmountOnDelivery === 'number' ? row.dueAmountOnDelivery : 0,
      deliveryPaymentStatus,
      bkashTrxId: trx || undefined,
      senderBkashNumber: str(row, 'senderBkashNumber') || undefined,
      isFakeSuspected: false,
      stockDeducted,
      notes: str(row, 'notes') || undefined,
      courier: null,
      deliveryZone: zone.zone,
      zoneUncertain: zone.uncertain,
      deletedAt: null,
      createdAt,
      updatedAt: createdAt,
    });
  }
  if (stalePending.length) {
    warnings.push(`${stalePending.length} pending order(s) are older than ${hours}h (${stalePending.join(', ')}). The next admin order list will cancel them. Those rows are not holding stock, so product stock will not change.`);
  }

  const reviews: Record<string, unknown>[] = [];
  for (const row of reviewsIn) {
    const id = str(row, 'id');
    const productId = str(row, 'productId');
    const comment = typeof row.comment === 'string' ? row.comment.trim() : '';
    if (!id || !productId || !str(row, 'customerName') || !comment) {
      problems.push('a review is missing id, productId, customerName or comment');
      continue;
    }
    if (!productIds.has(productId)) warnings.push(`review ${id} references ${productId}, which is not in the catalogue`);
    const rating = row.rating;
    if (typeof rating !== 'number' || rating < 1 || rating > 5) problems.push(`review ${id} has an invalid rating`);
    if (comment.length > 2000) problems.push(`review ${id} comment is longer than 2000 characters`);
    const createdAt = new Date(str(row, 'createdAt'));
    if (Number.isNaN(createdAt.getTime())) problems.push(`review ${id} has an invalid createdAt`);
    reviews.push({
      _id: id,
      productId,
      productName: str(row, 'productName') || 'Product',
      userId: `legacy-guest:${id}`,
      customerName: str(row, 'customerName'),
      rating,
      comment,
      city: str(row, 'city') || undefined,
      verifiedPurchase: row.verifiedPurchase === true,
      approved: row.approved !== false,
      deletedAt: null,
      createdAt,
      updatedAt: createdAt,
    });
  }
  if (reviews.length) warnings.push('reviews have no customer account in the export (plaintext PINs were never exported). Each review is stored with userId legacy-guest:<review id>.');

  const settingsClone = { ...settingsIn };
  delete settingsClone.id;
  const marked = rewriteDataUrls(settingsClone, settingsFolder, index, problems, 'settings') as Record<string, unknown>;
  let secrets = { present: [] as string[], empty: [] as string[] };
  let sealedConfig: Record<string, unknown> | null = null;
  let sealedSecrets: Record<string, string> = {};
  try {
    const sealed = sealImportedSecrets(marked);
    secrets = { present: sealed.present, empty: sealed.empty };
    sealedSecrets = sealed.secrets;
    const withUrls = applyMarks(sealed.config, placeholderUrl) as Record<string, unknown>;
    const parsed = updateSettingsSchema.safeParse({ ...withUrls, version: 0 });
    if (!parsed.success) {
      for (const issue of parsed.error.issues) problems.push(`settings.${issue.path.join('.') || 'root'}: ${issue.message}`);
    } else {
      const { version: _v, ...config } = parsed.data;
      // Keep marks in the plan so the write substitutes the real Cloudinary URL, not the validation placeholder.
      sealedConfig = restoreMarks(config);
    }
  } catch (e) {
    problems.push((e as Error).message);
  }
  const missingDefaults = ['storeName', 'supportPhone', 'enableCustomerReviews', 'enableCoupons'].filter((k) => settingsIn[k] === undefined);
  if (missingDefaults.length) warnings.push(`settings is missing ${missingDefaults.join(', ')}; reads fill those from the API defaults`);
  warnings.push('no coupons were in the seed export, so the coupons collection is left empty');
  warnings.push('admin_audit_logs.json is not imported; the new audit log is a different collection');

  problemsOrThrow(problems);
  return {
    categories,
    products,
    orders,
    reviews,
    settings: sealedConfig ? { config: sealedConfig, secrets: sealedSecrets } : null,
    images: index.images,
    warnings,
    secrets,
  };
}

function materialize(plan: SeedPlan, urlFor: (publicId: string) => string) {
  const ref = (id: unknown) => (typeof id === 'string' && id ? imageRef(id, urlFor) : null);
  const categories = plan.categories.map((c) => ({ ...c, image: ref(c.image) }));
  const products = plan.products.map((p) => ({
    ...p,
    image: ref(p.image),
    images: Array.isArray(p.images) ? (p.images as string[]).map((id) => imageRef(id, urlFor)) : [],
  }));
  const orders = plan.orders.map((o) => ({
    ...o,
    items: (o.items as Record<string, unknown>[]).map((item) => ({ ...item, image: typeof item.image === 'string' && item.image ? urlFor(item.image) : '' })),
  }));
  const settingsConfig = plan.settings ? (applyMarks(plan.settings.config, urlFor) as Record<string, unknown>) : null;
  return { categories, products, orders, reviews: plan.reviews, settingsConfig };
}

async function writeNew(model: { exists: (q: object) => Promise<unknown>; deleteOne: (q: object) => Promise<unknown>; create: (doc: object) => Promise<unknown> }, docs: Record<string, unknown>[], force: boolean) {
  let inserted = 0;
  let skipped = 0;
  for (const doc of docs) {
    const exists = await model.exists({ _id: doc._id });
    if (exists && !force) {
      skipped++;
      continue;
    }
    if (exists && force) await model.deleteOne({ _id: doc._id });
    await model.create(doc);
    inserted++;
  }
  return { inserted, skipped };
}

export async function executePlan(plan: SeedPlan, opts: { dryRun: boolean; force: boolean; uploader?: ImageUploader }): Promise<ImportReport> {
  const existingMedia = await MediaModel.find({ publicId: { $in: plan.images.map((i) => i.publicId) } }).select('publicId secureUrl url format bytes width height folder').lean();
  const known = new Map(existingMedia.map((m) => [m.publicId, m]));
  const toUpload = plan.images.filter((i) => !known.has(i.publicId));
  const report: ImportReport = {
    dryRun: opts.dryRun,
    force: opts.force,
    planned: { products: plan.products.length, categories: plan.categories.length, orders: plan.orders.length, reviews: plan.reviews.length, settings: plan.settings ? 1 : 0, media: plan.images.length, coupons: 0 },
    images: { unique: plan.images.length, alreadyInMedia: known.size, toUpload: toUpload.length },
    secrets: plan.secrets,
    warnings: plan.warnings,
    skipped: { coupons: 'not in the seed export', auditLogs: 'legacy audit log is a different shape and is not imported' },
  };
  if (opts.dryRun) return report;
  if (!opts.uploader) throw new Error('An image uploader is required when dryRun is false');

  const urlFor = new Map<string, string>();
  for (const m of existingMedia) urlFor.set(m.publicId, m.secureUrl);
  let uploaded = 0;
  for (const image of toUpload) {
    const asset = await opts.uploader(image);
    if (!asset.secureUrl.startsWith('https://') || !asset.secureUrl.includes(image.publicId)) {
      throw new Error(`Uploader returned an unexpected URL for ${image.publicId}`);
    }
    urlFor.set(image.publicId, asset.secureUrl);
    await MediaModel.create({
      publicId: image.publicId,
      url: asset.url ?? asset.secureUrl.replace(/^https:/, 'http:'),
      secureUrl: asset.secureUrl,
      resourceType: 'image',
      format: asset.format ?? image.format,
      bytes: asset.bytes ?? image.bytes,
      width: asset.width,
      height: asset.height,
      folder: image.folder,
    });
    uploaded++;
  }
  const resolve = (publicId: string) => {
    const url = urlFor.get(publicId);
    if (!url) throw new Error(`No URL for image ${publicId}`);
    return url;
  };
  const docs = materialize(plan, resolve);
  const categories = await writeNew(CategoryModel, docs.categories, opts.force);
  const products = await writeNew(ProductModel, docs.products, opts.force);
  const reviews = await writeNew(ReviewModel, docs.reviews, opts.force);
  const orders = await writeNew(OrderModel, docs.orders as Record<string, unknown>[], opts.force);
  let settingsInserted = 0;
  let settingsSkipped = 0;
  if (docs.settingsConfig && plan.settings) {
    const exists = await SettingsModel.exists({ _id: SETTINGS_ID });
    if (exists && !opts.force) settingsSkipped = 1;
    else {
      if (exists) await SettingsModel.deleteOne({ _id: SETTINGS_ID });
      await SettingsModel.create({ _id: SETTINGS_ID, config: docs.settingsConfig, secrets: plan.settings.secrets, version: 0 });
      settingsInserted = 1;
    }
  }
  const actor = await UserModel.findOne({ role: 'super_admin' }).select('_id email role').lean();
  await recordAudit({
    actor: actor ? { id: actor._id, email: actor.email, role: actor.role } : { email: 'seed-import', role: 'system' },
    action: 'seed.import',
    entity: 'Import',
    entityId: 'seed',
    details: {
      products: products.inserted,
      categories: categories.inserted,
      orders: orders.inserted,
      reviews: reviews.inserted,
      settings: settingsInserted,
      media: uploaded,
      skippedProducts: products.skipped,
      skippedOrders: orders.skipped,
    },
  });
  report.result = {
    inserted: { products: products.inserted, categories: categories.inserted, orders: orders.inserted, reviews: reviews.inserted, settings: settingsInserted, media: uploaded },
    skipped: { products: products.skipped, categories: categories.skipped, orders: orders.skipped, reviews: reviews.skipped, settings: settingsSkipped },
    uploaded,
    database: {
      products: await ProductModel.countDocuments(),
      categories: await CategoryModel.countDocuments(),
      orders: await OrderModel.countDocuments(),
      reviews: await ReviewModel.countDocuments(),
      media: await MediaModel.countDocuments(),
      settings: await SettingsModel.countDocuments(),
    },
  };
  return report;
}

export async function runImport(files: SeedFiles, opts: { dryRun: boolean; force: boolean; uploader?: ImageUploader }): Promise<ImportReport> {
  return executePlan(buildPlan(files), opts);
}
