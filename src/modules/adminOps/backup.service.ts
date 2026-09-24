/**
 * Full database backup / restore (BACKEND_PLAN §3.4, module 12). Legacy's own feature ("One-click full database backup")
 * dumped Firestore documents for products/orders/categories/reviews/settings and upserted them back by id on restore, with a
 * client-side confirm dialog and no server-side safety gate - the *purpose* (disaster recovery / portability of everything an
 * admin can already see) is replicated faithfully; the *shape* is not, because it can't be: our schema has moved on
 * (categoryId not category name, atomic stock/coupon fields, `{url,publicId}` images, etc.), and legacy's file also embedded
 * every integration secret in clear text (KNOWN_LIMITATIONS §5) - a bug this backend does not repeat.
 *
 * This is a RAW collection dump/restore (`.lean()` out, `bulkWrite` upsert-by-id back in), not a pass through any module's
 * create/update service - those assume a brand-new resource (slug/code uniqueness checks that a restore of the SAME data would
 * legitimately trip) and have side effects (per-item audit rows, rate limits) that a bulk restore must not repeat 1000 times.
 * A raw dump also round-trips every field losslessly (including `costPrice`, `deletedAt`, and the exact `{url,publicId}` image
 * objects) with nothing to re-derive. JSON has no Date type, so date fields come back as ISO strings and are revived to
 * real Dates before write — a string `createdAt` would both crash serializers (`toISOString`) and look older than every
 * BSON Date, so pending-order expiry would cancel the whole restored book.
 *
 * Restore is an UPSERT, never a wipe: an id present in the backup overwrites/creates that document; anything NOT in the backup
 * is left completely alone (matches legacy's own per-item upsert semantics - nothing in this or the legacy tool ever deleted a
 * live document that the backup didn't mention). `settings` restores only the non-secret `config` - secrets are never exported,
 * so restoring an old backup can never resurrect a stale/rotated credential; an admin re-enters secrets by hand if ever needed.
 */
import type { Request } from 'express';
import type { AnyBulkWriteOperation } from 'mongodb';
import { ApiError } from '../../utils/ApiError';
import { withTransaction } from '../../utils/transaction';
import { recordAudit } from '../audit/audit.service';
import { CategoryModel } from '../categories/category.model';
import { CouponModel } from '../coupons/coupon.model';
import { OrderModel } from '../orders/order.model';
import { ProductModel } from '../products/product.model';
import { ReviewModel } from '../reviews/review.model';
import { SETTINGS_ID, SettingsModel } from '../settings/settings.model';
import type { UserDocument } from '../users/user.model';

const actorOf = (u: UserDocument) => ({ id: u._id, email: u.email, role: u.role });
const BACKUP_VERSION = '3.0.0'; // this backend's OWN raw-document format - not legacy's Firestore-shaped '1.0.0' file

export interface BackupPayload {
  version: string;
  backupDate: string;
  storeName: string;
  data: {
    products: Record<string, unknown>[];
    categories: Record<string, unknown>[];
    coupons: Record<string, unknown>[];
    reviews: Record<string, unknown>[];
    orders: Record<string, unknown>[];
    settings: { config: Record<string, unknown>; version: number } | null;
  };
}

const DATE_KEYS = new Set(['createdAt', 'updatedAt', 'deletedAt', 'expiresAt']);

/** JSON has no Date. Revive ISO strings on known date fields; reject anything else so a bad file never writes. */
function reviveDates(value: unknown, path: string): void {
  if (Array.isArray(value)) {
    value.forEach((item, i) => reviveDates(item, `${path}[${i}]`));
    return;
  }
  if (!value || typeof value !== 'object') return;
  const row = value as Record<string, unknown>;
  for (const [key, val] of Object.entries(row)) {
    if (DATE_KEYS.has(key)) {
      if (val == null || val instanceof Date) continue;
      const parsed = typeof val === 'string' ? new Date(val) : null;
      if (!parsed || Number.isNaN(parsed.getTime())) throw ApiError.badRequest('INVALID_BACKUP_FORMAT', `Invalid date at ${path}.${key}`);
      row[key] = parsed;
    } else if (val && typeof val === 'object') {
      reviveDates(val, `${path}.${key}`);
    }
  }
}

/** `GET /admin/backup` - super_admin only (full, unmasked order PII). */
export async function createBackup(actor: UserDocument, req: Request): Promise<BackupPayload> {
  const [products, categories, coupons, reviews, orders, settingsDoc] = await Promise.all([
    ProductModel.find().select('+costPrice').lean(), // costPrice is select:false by default - a backup must include it
    CategoryModel.find().lean(),
    CouponModel.find().lean(),
    ReviewModel.find().lean(),
    OrderModel.find().lean(),
    SettingsModel.findById(SETTINGS_ID).lean(), // `secrets` is select:false on the schema - never included even by accident
  ]);
  const storeName = ((settingsDoc?.config as { storeName?: string } | undefined)?.storeName) || 'Al Barakah Premium';
  await recordAudit({ actor: actorOf(actor), action: 'admin.backup_downloaded', entity: 'Database', details: { products: products.length, categories: categories.length, coupons: coupons.length, reviews: reviews.length, orders: orders.length }, req });
  return {
    version: BACKUP_VERSION,
    backupDate: new Date().toISOString(),
    storeName,
    data: {
      products: products as unknown as Record<string, unknown>[],
      categories: categories as unknown as Record<string, unknown>[],
      coupons: coupons as unknown as Record<string, unknown>[],
      reviews: reviews as unknown as Record<string, unknown>[],
      orders: orders as unknown as Record<string, unknown>[],
      settings: settingsDoc ? { config: settingsDoc.config as Record<string, unknown>, version: typeof settingsDoc.version === 'number' ? settingsDoc.version : 0 } : null,
    },
  };
}

export interface RestoreCounts { products: number; categories: number; coupons: number; reviews: number; orders: number; settingsRestored: boolean }
export interface RestoreResult { ok: true; dryRun: boolean; counts: RestoreCounts }

/**
 * `POST /admin/backup/restore` - super_admin only, genuinely destructive (overwrites live documents by id), so it needs an
 * explicit `confirm: "RESTORE"` in the body to actually run - `dryRun: true` (or no `confirm`) only computes and returns the
 * counts that WOULD be affected, writing nothing. Every write happens in one transaction: a failure partway through rolls back
 * the whole restore rather than leaving the database half-migrated.
 */
export async function restoreBackup(actor: UserDocument, payload: BackupPayload, opts: { dryRun?: boolean; confirm?: string }, req: Request): Promise<RestoreResult> {
  if (!payload || typeof payload !== 'object' || !payload.data || typeof payload.data !== 'object') throw ApiError.badRequest('INVALID_BACKUP_FORMAT', 'The uploaded file is not a recognised backup');
  if (payload.version !== BACKUP_VERSION) throw ApiError.badRequest('INVALID_BACKUP_FORMAT', 'This file is not a version 3.0.0 backup');
  const { products = [], categories = [], coupons = [], reviews = [], orders = [], settings } = payload.data;
  for (const [name, rows] of [['products', products], ['categories', categories], ['coupons', coupons], ['reviews', reviews], ['orders', orders]] as const) {
    if (!Array.isArray(rows) || rows.some((r) => !r || typeof r !== 'object' || typeof r._id !== 'string' || !r._id)) throw ApiError.badRequest('INVALID_BACKUP_FORMAT', `"${name}" must be an array of documents with a string _id`);
    reviveDates(rows, name);
  }
  if (settings?.config && (typeof settings.version !== 'number' || !Number.isInteger(settings.version) || settings.version < 0)) {
    throw ApiError.badRequest('INVALID_BACKUP_FORMAT', 'settings.version must be a non-negative integer');
  }
  const counts: RestoreCounts = { products: products.length, categories: categories.length, coupons: coupons.length, reviews: reviews.length, orders: orders.length, settingsRestored: Boolean(settings?.config) };

  if (!opts.dryRun) {
    if (opts.confirm !== 'RESTORE') throw ApiError.badRequest('CONFIRMATION_REQUIRED', 'Pass confirm:"RESTORE" to overwrite live data with this backup, or dryRun:true to preview the counts first');

    await withTransaction(async (session) => {
      // `Model.collection.bulkWrite` (the raw MongoDB driver, not Mongoose's schema-typed wrapper) - a restore writes back
      // EXACTLY the dumped document, with no Mongoose casting/validation/defaults in the way.
      const upsert = (rows: Record<string, unknown>[]): AnyBulkWriteOperation[] => rows.map((d) => ({ replaceOne: { filter: { _id: d._id as never }, replacement: d, upsert: true } }));
      // sequential, not Promise.all: a single MongoDB session/transaction must not run concurrent operations on it
      if (products.length) await ProductModel.collection.bulkWrite(upsert(products), { session });
      if (categories.length) await CategoryModel.collection.bulkWrite(upsert(categories), { session });
      if (coupons.length) await CouponModel.collection.bulkWrite(upsert(coupons), { session });
      if (reviews.length) await ReviewModel.collection.bulkWrite(upsert(reviews), { session });
      if (orders.length) await OrderModel.collection.bulkWrite(upsert(orders), { session });
      if (settings?.config) await SettingsModel.collection.updateOne({ _id: SETTINGS_ID } as never, { $set: { config: settings.config, version: settings.version } }, { session, upsert: true });
    });
    // Recorded prominently: its own distinct action name, full per-collection counts, and (via `req`) the acting super_admin + IP.
    await recordAudit({ actor: actorOf(actor), action: 'admin.backup_restored', entity: 'Database', details: { ...counts }, req });
  }
  return { ok: true, dryRun: Boolean(opts.dryRun), counts };
}
