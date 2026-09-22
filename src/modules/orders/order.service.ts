import crypto from 'node:crypto';
import type { Request } from 'express';
import type { ClientSession, FilterQuery } from 'mongoose';
import { deriveZone } from '../../domain/zone';
import { computeSubtotal, priceOrder, round2, type PricingLine } from '../../domain/pricing';
import { getEnv } from '../../config/env';
import { ApiError } from '../../utils/ApiError';
import { logger } from '../../utils/logger';
import { normalizeBdMobile, phoneKey as last10 } from '../../utils/phone';
import { recordAudit } from '../audit/audit.service';
import { consumeLimit } from '../security';
import { redeemCoupon } from '../coupons/coupon.service';
import { serializeImage } from '../media/media.lookup';
import { ProductModel } from '../products/product.model';
import { getAdminSettings, getPublicSettings } from '../settings/settings.service';
import type { UserDocument } from '../users/user.model';
import { ORDER_STATUSES, OrderModel, type OrderDoc, type OrderStatus } from './order.model';
import { toFullOrder, toTrackedOrder } from './order.serializer';
import { releaseStock, reserveStock, setOrderStock, stockActionForTransition, withTransaction } from './stock.service';
import type { CreateOrderInput } from './order.validation';

const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const MAX_ID_ATTEMPTS = 6;
const actorOf = (u: UserDocument) => ({ id: u._id, email: u.email, role: u.role });

/** `AB-######` (BACKEND_PLAN B7): 6 random digits (100000-999999), uniqueness enforced by the `_id` index + retry on collision. */
const generateOrderId = () => `AB-${crypto.randomInt(100000, 1_000_000)}`;

/** Order intent gives BD-local numbers; stored/emitted as `+880XXXXXXXXXX` (BACKEND_PLAN §2.8). */
function toPlus880(input: string): string | null {
  const local = normalizeBdMobile(input);
  return local ? `+880${local.slice(1)}` : null;
}

const PER_IDENTITY_ORDER_LIMIT = { limit: 10, windowMs: 60 * 60_000 }; // 10 / hour per IP+phone (BACKEND_PLAN §4)

export interface OrderLine { productId: string; name: string; image: string; price: number; quantity: number; selectedSize?: string; selectedColor?: string; totalPrice: number }

/* ------------------------------------------------------------------------------------------------ shared stale-order expiry */

/**
 * Expires ONE `pending` order matching `filter` if it exists, releasing its stock if it was still held. Returns the expired
 * order's id, or `null` if nothing matched. The single source of truth for "abandon an unpaid order" - used by the cron, by the
 * lazy check before a new stock reservation, and by the lazy check on the admin pending list (Module 5c).
 */
async function expireOneIfStale(filter: FilterQuery<OrderDoc>, session: ClientSession): Promise<string | null> {
  const stale = await OrderModel.findOne(filter).session(session).sort({ createdAt: 1 }).select('_id items stockDeducted').lean();
  if (!stale) return null;
  const flipped = await OrderModel.findOneAndUpdate({ _id: stale._id, status: 'pending' }, { $set: { status: 'cancelled' } }, { session, new: true });
  if (!flipped) return null; // raced with something else (an admin action, another expiry pass) between the read and here
  if (stale.stockDeducted) {
    await releaseStock(stale.items.filter((i) => i.productId).map((i) => ({ productId: i.productId as string, quantity: i.quantity })), session);
    await OrderModel.updateOne({ _id: stale._id }, { $set: { stockDeducted: false } }, { session });
  }
  return stale._id;
}

/**
 * Expires every stale `pending` order matching `extraFilter` (e.g. referencing one product, or none = all of them).
 * With `opts.session`: everything runs as extra steps INSIDE the caller's existing transaction (used when called mid-reservation
 * or mid-listing, so it can never open a nested/second transaction on top of one already in progress). Without a session: each
 * expired order gets its OWN small transaction, so one bad row can never block the rest (used by the cron and the admin list).
 */
export async function expireStaleOrders(extraFilter: FilterQuery<OrderDoc> = {}, opts: { session?: ClientSession; now?: Date } = {}): Promise<{ expired: string[] }> {
  const cutoff = new Date((opts.now ?? new Date()).getTime() - getEnv().PENDING_ORDER_TIMEOUT_HOURS * 3_600_000);
  const filter: FilterQuery<OrderDoc> = { status: 'pending', deletedAt: null, createdAt: { $lt: cutoff }, ...extraFilter };
  const expiredIds: string[] = [];
  if (opts.session) {
    for (;;) {
      const id = await expireOneIfStale(filter, opts.session);
      if (!id) break;
      expiredIds.push(id);
    }
  } else {
    for (;;) {
      const id = await withTransaction((session) => expireOneIfStale(filter, session));
      if (!id) break;
      expiredIds.push(id);
    }
  }
  for (const id of expiredIds) {
    await recordAudit({ actor: { email: 'system', role: 'system' }, action: 'order.auto_expired', entity: 'Order', entityId: id, details: { pendingSinceOlderThanHours: getEnv().PENDING_ORDER_TIMEOUT_HOURS } });
  }
  return { expired: expiredIds };
}

/** Cron entry point (`GET /internal/cron/orders/expire-pending`) - a daily backstop; the real-time path is the lazy checks below. */
export async function expirePendingOrders(now = new Date()): Promise<{ expired: number }> {
  return { expired: (await expireStaleOrders({}, { now })).expired.length };
}

/* ------------------------------------------------------------------------------------------------------------ order creation */

/**
 * Places an order (guest or logged-in). ONE MongoDB transaction covers everything: expiring any stale pending order that is
 * holding stock this order needs, reading & locking the products' current price and stock, redeeming the coupon (if any), and
 * inserting the order. Any failure - insufficient stock, an exhausted/expired coupon, a payment-policy violation - aborts the
 * WHOLE transaction, so nothing is half-applied and no compensation is needed. Client-sent prices/totals do not exist in this
 * function's input: every amount comes from the server's own product/settings data.
 */
export async function createOrder(input: CreateOrderInput, authUser: UserDocument | null, req: Request) {
  const phone = toPlus880(input.customer.phone);
  if (!phone) throw ApiError.badRequest('INVALID_BD_PHONE');
  const key = last10(phone); // last 10 digits, same rule as customer accounts (phoneKey just takes the last 10 chars, prefix-agnostic)

  const ip = req.ip ?? 'unknown';
  const throttle = await consumeLimit(`order-create:${ip}:${key}`, PER_IDENTITY_ORDER_LIMIT.limit, PER_IDENTITY_ORDER_LIMIT.windowMs);
  if (!throttle.allowed) throw ApiError.tooMany('TOO_MANY_ORDERS', 'Too many orders from this number. Try again later.', throttle.retryAfterSeconds);

  const settings = await getPublicSettings();
  const { zone, uncertain: zoneUncertain } = deriveZone(input.customer.city);
  const couponCode = input.couponCode?.trim() || undefined;

  let lastErr: unknown;
  for (let attempt = 0; attempt < MAX_ID_ATTEMPTS; attempt++) {
    const id = generateOrderId();
    try {
      const doc = await withTransaction(async (session) => {
        const productIds = [...new Set(input.items.map((i) => i.productId))];
        const products = await ProductModel.find({ _id: { $in: productIds } }).session(session).lean();
        const byId = new Map(products.map((p) => [p._id, p]));

        const lines: OrderLine[] = input.items.map((i) => {
          const p = byId.get(i.productId);
          if (!p || p.deletedAt) throw new ApiError(409, 'PRODUCT_UNAVAILABLE', 'One of the items in your cart is no longer available', { productId: i.productId });
          return {
            productId: p._id, name: p.name, image: serializeImage(p.image) || p.images?.[0]?.url || '', price: p.price, quantity: i.quantity,
            selectedSize: i.selectedSize, selectedColor: i.selectedColor, totalPrice: round2(p.price * i.quantity),
          };
        });
        const pricingLines: PricingLine[] = lines.map((l) => ({ unitPrice: l.price, quantity: l.quantity }));
        const subtotal = computeSubtotal(pricingLines);

        let discount = 0;
        let redeemedCode: string | undefined;
        if (couponCode) {
          const q = await redeemCoupon(couponCode, subtotal, new Date(), session);
          discount = q.discountAmount;
          redeemedCode = q.code;
        }

        const pricing = priceOrder({ lines: pricingLines, discount, zone, paymentChoice: input.paymentChoice, delivery: settings.deliveryConfig, hasTrxId: Boolean(input.bkashTrxId) });

        // Lazy expiry (Module 5c): before reserving, release any of THESE products that an abandoned pending order is still
        // holding - resolves the real failure mode (a genuinely available unit refused because an old order never let go)
        // exactly when it matters, without depending on the once-a-day cron having already run.
        await reserveStock(
          lines.map((l) => ({ productId: l.productId, quantity: l.quantity })),
          session,
          { beforeReserve: (ids, s) => expireStaleOrders({ 'items.productId': { $in: ids } }, { session: s }).then(() => undefined) },
        );

        const [created] = await OrderModel.create(
          [{
            _id: id,
            userId: authUser ? String(authUser._id) : null,
            customer: { fullName: input.customer.fullName, email: input.customer.email || undefined, phone, address: input.customer.address, city: input.customer.city, postalCode: undefined },
            phoneKey: key,
            items: lines,
            subtotal: pricing.subtotal, discount: pricing.discount, shipping: pricing.deliveryFee, total: pricing.total, currency: 'BDT',
            couponCode: redeemedCode,
            status: 'pending',
            advancePaymentType: pricing.advancePaymentType, advanceAmount: pricing.advanceAmount, dueAmountOnDelivery: pricing.dueAmountOnDelivery, deliveryPaymentStatus: pricing.deliveryPaymentStatus,
            bkashTrxId: input.bkashTrxId, senderBkashNumber: input.senderBkashNumber,
            isFakeSuspected: false, stockDeducted: true, notes: input.notes,
            deliveryZone: zone, zoneUncertain,
          }],
          { session },
        );
        return created;
      });
      await recordAudit({ actor: authUser ? actorOf(authUser) : { email: 'guest', role: 'guest' }, action: 'order.create', entity: 'Order', entityId: id, details: { total: doc.total, paymentChoice: input.paymentChoice, couponCode: doc.couponCode, zoneUncertain: doc.zoneUncertain }, req });
      return toFullOrder(doc);
    } catch (e) {
      lastErr = e;
      if ((e as { code?: number }).code === 11000) continue; // order-id collision (~1 in 900,000): try another id
      throw e;
    }
  }
  logger.error({ err: lastErr }, 'order id generation exhausted retries');
  throw lastErr;
}

/* ------------------------------------------------------------------------------------------------------ public reads */

/** Exact `_id` match first, then a case-insensitive CONTAINS match (>=4 chars) - same fuzziness the legacy tracker offered, without needing the numeric-only fallback (our ids are always `AB-######`, so "contains" alone covers a bare 6-digit search too). Soft-deleted orders never resolve. */
export async function trackOrder(rawCode: string) {
  const query = rawCode.trim().toUpperCase();
  if (!query) throw ApiError.notFound('ORDER_NOT_FOUND');
  const live = { deletedAt: null };
  const exact = await OrderModel.findOne({ _id: query, ...live }).lean();
  if (exact) return toTrackedOrder(exact);
  if (query.length < 4) throw ApiError.notFound('ORDER_NOT_FOUND');
  const fuzzy = await OrderModel.findOne({ _id: { $regex: escapeRegex(query), $options: 'i' }, ...live }).sort({ createdAt: -1 }).lean();
  if (!fuzzy) throw ApiError.notFound('ORDER_NOT_FOUND');
  return toTrackedOrder(fuzzy);
}

/** `GET /orders/my` (BACKEND_PLAN B9): matched by `userId` OR the last 10 digits of the account's phone (links pre-login guest orders), newest first. */
export async function myOrders(authUser: UserDocument, page: number, limit: number) {
  const or: Record<string, unknown>[] = [{ userId: String(authUser._id) }];
  if (authUser.phone) or.push({ phoneKey: last10(authUser.phone) });
  const filter = { $or: or, deletedAt: null };
  const [items, total] = await Promise.all([
    OrderModel.find(filter).sort({ createdAt: -1, _id: 1 }).skip((page - 1) * limit).limit(limit).lean(),
    OrderModel.countDocuments(filter),
  ]);
  return { items: items.map(toFullOrder), total, page, limit, totalPages: Math.ceil(total / limit) };
}

/* ------------------------------------------------------------------------------------------------------ admin (Module 5c) */

/** `GET /admin/orders[?status=]`: the full list (no pagination - BACKEND_PLAN Q18, the admin dashboard aggregates client-side), newest first, soft-deleted excluded. Whenever the result could include `pending` orders (no filter, or filtering to `pending`), stale ones are lazily expired first so the list an admin sees is never stale. */
export async function listAdminOrders(status?: OrderStatus) {
  if (!status || status === 'pending') await expireStaleOrders(status === 'pending' ? { status } : {});
  const filter: FilterQuery<OrderDoc> = { deletedAt: null, ...(status ? { status } : {}) };
  return (await OrderModel.find(filter).sort({ createdAt: -1, _id: 1 }).lean()).map(toFullOrder);
}

async function getDoc(id: string) {
  const o = await OrderModel.findOne({ _id: id, deletedAt: null });
  if (!o) throw ApiError.notFound('ORDER_NOT_FOUND');
  return o;
}
export async function getAdminOrder(id: string) {
  return toFullOrder(await getDoc(id));
}

export interface OrderPatch { status?: OrderStatus; deliveryPaymentStatus?: Exclude<OrderDoc['deliveryPaymentStatus'], 'FAKE_SUSPECTED' | 'ADVANCE_PAID'>; toggleFakeSuspicion?: boolean }
export interface OrderMutationResult { order: ReturnType<typeof toFullOrder>; stock: 'deducted' | 'restored' | 'none' }

/**
 * `PATCH /admin/orders/:id` - status changes are wired to Module 5a's stock reserve/release (only entering/leaving `cancelled`
 * moves stock; every other status is a label change only, since stock was already reserved at placement). `toggleFakeSuspicion`
 * ports BUG_FIXES A11's flag -> `FAKE_SUSPECTED` half exactly, but FIXES its un-flag half (BUG_FIXES B4): the legacy rule always
 * reset to `COD_PENDING`, silently discarding an `ADVANCE_PENDING`/`FULL_PAID`/`VERIFIED` state the order had before being
 * flagged. `statusBeforeFakeSuspicion` remembers exactly what it was and restores that on un-flag. `deliveryPaymentStatus` is a
 * manual admin override kept for compatibility with the existing `al-barakah-admin` API contract, narrowed to exclude
 * `ADVANCE_PAID` and `FAKE_SUSPECTED` (each reachable only through its own guarded action - verify-payment, this toggle - so a
 * claim of "paid" or "fake" always goes through the check that action performs). One combined transaction; a failed stock move
 * (e.g. re-opening a cancelled order whose stock sold out meanwhile) rolls back the whole patch, including the status change.
 */
export async function patchOrder(actor: UserDocument, id: string, patch: OrderPatch, req: Request): Promise<OrderMutationResult> {
  let stockEffect: OrderMutationResult['stock'] = 'none';
  const changed: string[] = [];
  await withTransaction(async (session) => {
    const current = await OrderModel.findOne({ _id: id, deletedAt: null }).session(session);
    if (!current) throw ApiError.notFound('ORDER_NOT_FOUND');
    const prevStatus = current.status;

    if (patch.status !== undefined && patch.status !== current.status) {
      current.status = patch.status;
      changed.push('status');
    }
    if (patch.toggleFakeSuspicion) {
      current.isFakeSuspected = !current.isFakeSuspected;
      if (current.isFakeSuspected) {
        current.statusBeforeFakeSuspicion = current.deliveryPaymentStatus; // captured BEFORE it gets overwritten below
        current.deliveryPaymentStatus = 'FAKE_SUSPECTED';
      } else {
        current.deliveryPaymentStatus = current.statusBeforeFakeSuspicion ?? 'COD_PENDING'; // fallback only for a pre-fix row that was never flagged
        current.statusBeforeFakeSuspicion = null;
      }
      changed.push('isFakeSuspected');
    }
    if (patch.deliveryPaymentStatus !== undefined && patch.deliveryPaymentStatus !== current.deliveryPaymentStatus) {
      current.deliveryPaymentStatus = patch.deliveryPaymentStatus;
      changed.push('deliveryPaymentStatus');
    }
    await current.save({ session });

    const action = stockActionForTransition(prevStatus, current.status);
    if (action !== 'none') {
      await setOrderStock(id, action, session); // throws (aborting everything) if re-reserving fails, e.g. sold out meanwhile
      stockEffect = action === 'reserve' ? 'deducted' : 'restored';
    }
  });
  await recordAudit({ actor: actorOf(actor), action: 'order.update', entity: 'Order', entityId: id, details: { changed, ...patch }, req });
  return { order: await getAdminOrder(id), stock: stockEffect };
}

/**
 * Verifies a customer-claimed bKash TrxID: `ADVANCE_PENDING` -> `ADVANCE_PAID` (Module 5b decision #3 - the customer's claim is
 * never auto-trusted; an admin confirms the money actually arrived before the order shows as paid). Only that one transition;
 * anything else is a 409, so this action can't be misused to stamp an order paid from an unrelated state.
 */
export async function verifyOrderPayment(actor: UserDocument, id: string, req: Request) {
  const o = await OrderModel.findOneAndUpdate({ _id: id, deletedAt: null, deliveryPaymentStatus: 'ADVANCE_PENDING' }, { $set: { deliveryPaymentStatus: 'ADVANCE_PAID' } }, { new: true });
  if (!o) {
    await getDoc(id); // 404 if the order itself doesn't exist
    throw ApiError.conflict('NOT_PENDING_VERIFICATION', 'Only an order awaiting advance-payment verification can be verified');
  }
  await recordAudit({ actor: actorOf(actor), action: 'order.payment_verified', entity: 'Order', entityId: id, req });
  return toFullOrder(o);
}

/** `DELETE /admin/orders/:id` -> soft delete. Releases stock if still held (same as a cancel); the coupon use is NOT released (confirmed policy, same as admin cancellation - no use-then-delete refund). */
export async function softDeleteOrder(actor: UserDocument, id: string, req: Request) {
  await withTransaction(async (session) => {
    const o = await OrderModel.findOneAndUpdate({ _id: id, deletedAt: null }, { $set: { deletedAt: new Date() } }, { session, new: true });
    if (!o) throw ApiError.notFound('ORDER_NOT_FOUND');
    if (o.stockDeducted) {
      await releaseStock(o.items.filter((i) => i.productId).map((i) => ({ productId: i.productId as string, quantity: i.quantity })), session);
      await OrderModel.updateOne({ _id: id }, { $set: { stockDeducted: false } }, { session });
    }
  });
  await recordAudit({ actor: actorOf(actor), action: 'order.delete', entity: 'Order', entityId: id, req });
  return { ok: true as const };
}

/**
 * `POST /admin/orders/:id/dispatch` - SIMULATED consignment creation (the real Steadfast/Pathao HTTP calls are Module 11).
 * `ENABLE_LIVE_INTEGRATIONS=true` without a real adapter yet is refused loudly (501) rather than silently pretending.
 * `codAmount` is the courier COD-collection fix (BUG_FIXES B1): the courier must collect `dueAmountOnDelivery`
 * (= total - whatever was actually paid in advance), never the raw `total`, or a customer who prepaid the delivery fee (or the
 * whole order via bKash) would be double-charged on delivery.
 */
export async function dispatchOrder(actor: UserDocument, id: string, requestedProvider: 'steadfast' | 'pathao' | undefined, req: Request) {
  if (getEnv().ENABLE_LIVE_INTEGRATIONS) throw new ApiError(501, 'COURIER_LIVE_NOT_IMPLEMENTED', 'Live courier dispatch is not implemented yet (Module 11)');
  const o = await getDoc(id);
  const settings = await getAdminSettings();
  const provider = requestedProvider ?? (settings.courierConfig as { defaultCourier?: string })?.defaultCourier ?? 'manual';
  if (provider !== 'steadfast' && provider !== 'pathao') throw ApiError.conflict('COURIER_NOT_CONFIGURED', 'No courier is configured for automatic dispatch');
  const codAmount = o.dueAmountOnDelivery; // == total - advanceAmount by construction (Module 5a's pricing invariant)

  const consignmentId = `SIM-${o._id}`;
  const trackingCode = `SIM-TRK-${o._id}`;
  const courier = { success: true, provider, consignmentId, trackingCode, status: 'in_review', message: `[SIMULATED] ${provider} consignment created (COD ৳${codAmount})`, simulated: true, codAmount };
  await OrderModel.updateOne({ _id: id }, { $set: { courier: { provider, consignmentId, trackingCode, status: 'in_review', sentAt: new Date(), response: courier } } });
  await recordAudit({ actor: actorOf(actor), action: 'order.dispatch', entity: 'Order', entityId: id, details: { provider, codAmount, simulated: true }, req });
  return { order: await getAdminOrder(id), courier };
}

export { ORDER_STATUSES };
