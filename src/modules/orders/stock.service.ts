/**
 * Atomic stock accounting for orders (Module 5a). STOCK IS RESERVED AT PLACEMENT (not on a later status change), so two customers
 * can never both buy the last unit; it is given back when an order is cancelled and taken again if a cancelled order is re-opened.
 *
 * Atomicity: every operation runs inside a MongoDB transaction (needs a replica set - Atlas always is; tests use MongoMemoryReplSet).
 * A multi-item order therefore either reserves ALL its lines or none. Each line uses a guarded update
 * (`stockCount >= qty` in the filter) so the check and the decrement are one server-side step - never read-then-write.
 * Concurrent transactions touching the same product get a WriteConflict; the driver retries them (`withTransaction`).
 */
import type { ClientSession } from 'mongoose';
import { ApiError } from '../../utils/ApiError';
import { logger } from '../../utils/logger';
import { withTransaction } from '../../utils/transaction';
import { ProductModel } from '../products/product.model';
import { OrderModel, type OrderStatus } from './order.model';

export { withTransaction };
export interface StockLine { productId: string; quantity: number }
/** Runs before `reserveStock` touches any product (same transaction) - used to lazily expire abandoned pending orders that are
 * holding stock on exactly the products about to be reserved, so a genuinely available unit isn't refused just because an old
 * abandoned order never let go of it (Module 5c). Defined as a hook here, rather than importing the `orders` service directly,
 * to keep this module free of a dependency on order-domain logic; `order.service.ts` supplies the implementation. */
export type BeforeReserveHook = (productIds: string[], session: ClientSession) => Promise<void>;

/** Same product on several lines (different size/colour) is one stock movement. Sorted by id so every transaction locks in the same order. */
function merge(lines: StockLine[]): StockLine[] {
  const m = new Map<string, number>();
  for (const l of lines) {
    if (!l.productId) continue; // legacy line without a product reference: nothing to account against
    if (!Number.isInteger(l.quantity) || l.quantity < 1) throw ApiError.badRequest('INVALID_ORDER_LINE');
    m.set(l.productId, (m.get(l.productId) ?? 0) + l.quantity);
  }
  return [...m].sort(([a], [b]) => (a < b ? -1 : 1)).map(([productId, quantity]) => ({ productId, quantity }));
}

/** stock -= qty for every line, or throw (409 INSUFFICIENT_STOCK / PRODUCT_UNAVAILABLE) - inside a transaction that undoes the lines already done. */
export async function reserveStock(lines: StockLine[], session: ClientSession, opts: { beforeReserve?: BeforeReserveHook } = {}): Promise<void> {
  const merged = merge(lines);
  if (opts.beforeReserve && merged.length) await opts.beforeReserve(merged.map((l) => l.productId), session);
  for (const { productId, quantity } of merged) {
    const hit = await ProductModel.findOneAndUpdate(
      { _id: productId, deletedAt: null, stockCount: { $gte: quantity } },
      [{ $set: { stockCount: { $subtract: ['$stockCount', quantity] } } }, { $set: { inStock: { $gt: ['$stockCount', 0] } } }],
      { session, new: true, projection: { _id: 1 } },
    ).lean();
    if (hit) continue;
    const p = await ProductModel.findById(productId, { name: 1, stockCount: 1, deletedAt: 1 }).session(session).lean();
    if (!p || p.deletedAt) throw new ApiError(409, 'PRODUCT_UNAVAILABLE', 'This product is no longer available', { productId });
    throw new ApiError(409, 'INSUFFICIENT_STOCK', `Only ${p.stockCount} of "${p.name}" left in stock`, { productId, name: p.name, available: p.stockCount, requested: quantity });
  }
}

/** stock += qty for every line (also for archived products - restoring one must not lose units). Unknown products are skipped and logged. */
export async function releaseStock(lines: StockLine[], session: ClientSession): Promise<void> {
  for (const { productId, quantity } of merge(lines)) {
    const r = await ProductModel.updateOne(
      { _id: productId },
      [{ $set: { stockCount: { $add: [{ $ifNull: ['$stockCount', 0] }, quantity] } } }, { $set: { inStock: { $gt: ['$stockCount', 0] } } }],
      { session },
    );
    if (r.matchedCount === 0) logger.warn({ productId, quantity }, 'stock release: product no longer exists');
  }
}

/** What a status change means for stock. The `stockDeducted` flag on the order makes the executor idempotent regardless. */
export function stockActionForTransition(from: OrderStatus, to: OrderStatus): 'reserve' | 'release' | 'none' {
  if (from === to) return 'none';
  if (to === 'cancelled') return 'release';
  if (from === 'cancelled') return 'reserve';
  return 'none';
}

/**
 * Moves ONE existing order's stock to the requested state, atomically with its `stockDeducted` flag:
 * the flag is flipped by a conditional update (`stockDeducted` must currently be the opposite), so calling it twice - or from two requests
 * at once - moves the stock exactly once. Returns `changed:false` when the order was already in that state.
 * Pass `session` to run inside the caller's transaction (e.g. together with the status change), otherwise it opens its own.
 */
export async function setOrderStock(orderId: string, action: 'reserve' | 'release', session?: ClientSession): Promise<{ changed: boolean }> {
  const run = async (s: ClientSession) => {
    const before = await OrderModel.findOneAndUpdate(
      { _id: orderId, stockDeducted: action === 'release' },
      { $set: { stockDeducted: action === 'reserve' } },
      { session: s, new: false, projection: { items: 1 } },
    ).lean();
    if (!before) {
      if (!(await OrderModel.exists({ _id: orderId }).session(s))) throw ApiError.notFound('ORDER_NOT_FOUND');
      return { changed: false };
    }
    const lines = before.items.filter((i) => i.productId).map((i) => ({ productId: i.productId as string, quantity: i.quantity }));
    if (action === 'reserve') await reserveStock(lines, s);
    else await releaseStock(lines, s);
    return { changed: true };
  };
  return session ? run(session) : withTransaction(run);
}
