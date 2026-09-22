import crypto from 'node:crypto';
import mongoose from 'mongoose';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { AuditLogModel } from '../src/modules/audit/audit.model';
import { CouponModel } from '../src/modules/coupons/coupon.model';
import { expirePendingOrders } from '../src/modules/orders/order.service';
import { OrderModel } from '../src/modules/orders/order.model';
import { ProductModel } from '../src/modules/products/product.model';
import { adminCtx, app, auth, mkProduct, patchSettings, registerCustomer } from './helpers';

let seq = 10_000_000;
const nextPhone = () => `017${String(seq++).padStart(8, '0')}`;
const relaxCod = (a: request.Agent | ReturnType<typeof app>, tok: string) => patchSettings(a as never, tok, { deliveryConfig: { requireAdvanceDeliveryCharge: false } });
const guestOrder = (over: Record<string, unknown> = {}) => ({
  items: [], customer: { fullName: 'Halima', phone: nextPhone(), address: '12 Green Road, Dhanmondi', city: 'Inside Dhaka' }, paymentChoice: 'FULL_COD', ...over,
});
const stockOf = async (id: string) => (await ProductModel.findById(id).lean())!.stockCount;

describe('orders - creation (guest + logged-in, server-computed pricing)', () => {
  it('guest FULL_COD: server prices from the product (client price/total/id are silently ignored), stock is deducted, tracking id is AB-######', async () => {
    const { a, tok } = await adminCtx();
    await relaxCod(a, tok);
    const p = await mkProduct(a, tok, { price: 500, stockCount: 10 });
    const res = await request(a).post('/v1/orders').send(guestOrder({
      items: [{ productId: p.id, quantity: 2, price: 1, unitPrice: 999999 }], // client price - must be ignored
      id: 'AB-000001', total: 1, // client id/total - must be ignored
    }));
    expect(res.status).toBe(201);
    const o = res.body.order;
    expect(o.id).toMatch(/^AB-\d{6}$/);
    expect(o.id).not.toBe('AB-000001');
    expect(o).toMatchObject({ subtotal: 1000, discount: 0, shipping: 80, total: 1080, status: 'pending', currency: 'BDT' });
    expect(o.items).toEqual([{ productId: p.id, name: p.name, image: '', price: 500, quantity: 2, totalPrice: 1000 }]);
    expect(o.advancePaymentType).toBe('NONE');
    expect(o.deliveryPaymentStatus).toBe('COD_PENDING');
    expect(await stockOf(p.id)).toBe(8);
    expect((await AuditLogModel.findOne({ action: 'order.create' }))!.actorEmail).toBe('guest');
  });

  it('logged-in customer: userId is attached to the order and it shows up unmasked with FULL_PAID for FULL_BKASH (unaffected by decision #3)', async () => {
    const { a, tok } = await adminCtx();
    const p = await mkProduct(a, tok, { price: 300, stockCount: 5 });
    const cust = await registerCustomer(a);
    const res = await request(a).post('/v1/orders').set(auth(cust.body.accessToken)).send(guestOrder({
      items: [{ productId: p.id, quantity: 1 }], paymentChoice: 'FULL_BKASH', bkashTrxId: 'TRX123', senderBkashNumber: '01711111111',
    }));
    expect(res.status).toBe(201);
    expect(res.body.order).toMatchObject({ advancePaymentType: 'FULL_PAYMENT', advanceAmount: 380, dueAmountOnDelivery: 0, deliveryPaymentStatus: 'FULL_PAID', bkashTrxId: 'TRX123' });
    const stored = await OrderModel.findById(res.body.order.id).lean();
    expect(stored!.userId).toBe(String(cust.body.user?.id ?? (await mongoose.connection.db!.collection('users').findOne({}))!._id));
  });

  it('ADVANCE_DELIVERY with a TrxID -> ADVANCE_PENDING, NOT ADVANCE_PAID (decision #3: admin must verify it, see Module 5c)', async () => {
    const { a, tok } = await adminCtx();
    const p = await mkProduct(a, tok, { price: 400, stockCount: 5 });
    const res = await request(a).post('/v1/orders').send(guestOrder({ items: [{ productId: p.id, quantity: 1 }], paymentChoice: 'ADVANCE_DELIVERY', bkashTrxId: 'ADV-1' }));
    expect(res.status).toBe(201);
    expect(res.body.order).toMatchObject({ advancePaymentType: 'DELIVERY_ONLY', advanceAmount: 80, dueAmountOnDelivery: 400, deliveryPaymentStatus: 'ADVANCE_PENDING' });
  });

  it('ADVANCE_DELIVERY with the delivery fee waived by free delivery: no TrxID required, behaves like COD (decision #2)', async () => {
    const { a, tok } = await adminCtx();
    await patchSettings(a, tok, { deliveryConfig: { enableFreeDelivery: true, freeDeliveryThreshold: 100 } });
    const p = await mkProduct(a, tok, { price: 400, stockCount: 5 });
    const res = await request(a).post('/v1/orders').send(guestOrder({ items: [{ productId: p.id, quantity: 1 }], paymentChoice: 'ADVANCE_DELIVERY' })); // no bkashTrxId at all
    expect(res.status).toBe(201);
    expect(res.body.order).toMatchObject({ shipping: 0, advanceAmount: 0, dueAmountOnDelivery: 400, deliveryPaymentStatus: 'COD_PENDING' });
  });

  it('a required TrxID that is missing -> 400 TRX_ID_REQUIRED and NOTHING is created (no order, stock untouched)', async () => {
    const { a, tok } = await adminCtx();
    const p = await mkProduct(a, tok, { price: 400, stockCount: 5 });
    const res = await request(a).post('/v1/orders').send(guestOrder({ items: [{ productId: p.id, quantity: 1 }], paymentChoice: 'FULL_BKASH' }));
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('TRX_ID_REQUIRED');
    expect(await OrderModel.countDocuments()).toBe(0);
    expect(await stockOf(p.id)).toBe(5);
  });

  it('FULL_COD is forbidden by the default delivery policy (requireAdvanceDeliveryCharge) -> 400, nothing created', async () => {
    const { a, tok } = await adminCtx();
    const p = await mkProduct(a, tok, { price: 400, stockCount: 5 });
    const res = await request(a).post('/v1/orders').send(guestOrder({ items: [{ productId: p.id, quantity: 1 }] }));
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('ADVANCE_DELIVERY_REQUIRED');
    expect(await OrderModel.countDocuments()).toBe(0);
    expect(await stockOf(p.id)).toBe(5);
  });

  it('a valid coupon is redeemed EXACTLY ONCE and its discount is reflected in the total', async () => {
    const { a, tok } = await adminCtx();
    await patchSettings(a, tok, { enableCoupons: true });
    await request(a).post('/v1/admin/coupons').set(auth(tok)).send({ code: 'SAVE10', discountPercent: 10, minSpend: 0 }).expect(201);
    const p = await mkProduct(a, tok, { price: 1000, stockCount: 5 });
    const res = await request(a).post('/v1/orders').send(guestOrder({ items: [{ productId: p.id, quantity: 1 }], paymentChoice: 'FULL_BKASH', bkashTrxId: 'T1', couponCode: ' save10 ' }));
    expect(res.status).toBe(201);
    expect(res.body.order).toMatchObject({ subtotal: 1000, discount: 100, total: 980, couponCode: 'SAVE10' });
    expect((await CouponModel.findOne({ code: 'SAVE10' }))!.timesUsed).toBe(1);
  });

  it('ATOMICITY: a coupon that fails to redeem (below min spend) aborts the WHOLE order - no order, no stock change, coupon untouched', async () => {
    const { a, tok } = await adminCtx();
    await patchSettings(a, tok, { enableCoupons: true });
    await request(a).post('/v1/admin/coupons').set(auth(tok)).send({ code: 'BIG', discountPercent: 10, minSpend: 50_000 }).expect(201);
    const p = await mkProduct(a, tok, { price: 500, stockCount: 5 });
    const res = await request(a).post('/v1/orders').send(guestOrder({ items: [{ productId: p.id, quantity: 1 }], paymentChoice: 'FULL_BKASH', bkashTrxId: 'T1', couponCode: 'BIG' }));
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/^MIN_SPEND:/);
    expect(await OrderModel.countDocuments()).toBe(0);
    expect(await stockOf(p.id)).toBe(5);
    expect((await CouponModel.findOne({ code: 'BIG' }))!.timesUsed).toBe(0);
  });

  it('ATOMICITY: insufficient stock on ONE line aborts the WHOLE order - the other line is NOT partially reserved', async () => {
    const { a, tok } = await adminCtx();
    await relaxCod(a, tok);
    const plenty = await mkProduct(a, tok, { price: 100, stockCount: 100 });
    const scarce = await mkProduct(a, tok, { price: 100, stockCount: 1 });
    const res = await request(a).post('/v1/orders').send(guestOrder({ items: [{ productId: plenty.id, quantity: 2 }, { productId: scarce.id, quantity: 5 }] }));
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('INSUFFICIENT_STOCK');
    expect(await OrderModel.countDocuments()).toBe(0);
    expect(await stockOf(plenty.id)).toBe(100); // NOT reduced, even though this line alone had enough stock
    expect(await stockOf(scarce.id)).toBe(1);
  });

  it('an unknown or archived product -> 409 PRODUCT_UNAVAILABLE, nothing created', async () => {
    const { a, tok } = await adminCtx();
    await relaxCod(a, tok);
    const p = await mkProduct(a, tok, { price: 100, stockCount: 5 });
    await request(a).delete(`/v1/admin/products/${p.id}`).set(auth(tok)).expect(200);
    for (const id of [p.id, 'prod-ghost']) {
      const res = await request(a).post('/v1/orders').send(guestOrder({ items: [{ productId: id, quantity: 1 }] }));
      expect(res.status).toBe(409);
      expect(res.body.error).toBe('PRODUCT_UNAVAILABLE');
    }
    expect(await OrderModel.countDocuments()).toBe(0);
  });

  it('validation: empty cart, bad BD phone, and a missing address are all 400 VALIDATION_ERROR / INVALID_BD_PHONE', async () => {
    const { a, tok } = await adminCtx();
    await relaxCod(a, tok);
    const p = await mkProduct(a, tok);
    expect((await request(a).post('/v1/orders').send(guestOrder({ items: [] }))).body.error).toBe('VALIDATION_ERROR');
    expect((await request(a).post('/v1/orders').send(guestOrder({ items: [{ productId: p.id, quantity: 1 }], customer: { fullName: 'X', phone: '123', address: 'a', city: '' } }))).body.error).toBe('INVALID_BD_PHONE');
    expect((await request(a).post('/v1/orders').send(guestOrder({ items: [{ productId: p.id, quantity: 1 }], customer: { fullName: 'X', phone: nextPhone(), address: '', city: '' } }))).body.error).toBe('VALIDATION_ERROR');
    expect((await request(a).post('/v1/orders').send(guestOrder({ items: [{ productId: p.id, quantity: 0 }] }))).body.error).toBe('VALIDATION_ERROR');
  });

  it('an order-id collision is retried with a fresh id - no double stock deduction, no double coupon redemption', async () => {
    const { a, tok } = await adminCtx();
    await relaxCod(a, tok);
    await patchSettings(a, tok, { enableCoupons: true });
    await request(a).post('/v1/admin/coupons').set(auth(tok)).send({ code: 'ONCE', discountPercent: 5 }).expect(201);
    const p = await mkProduct(a, tok, { price: 200, stockCount: 10 });
    await OrderModel.create({ _id: 'AB-654321', customer: { fullName: 'Taken', phone: '+8801799999999', address: 'x', city: '' }, phoneKey: '1799999999', items: [{ name: 'x', price: 1, quantity: 1, totalPrice: 1 }], subtotal: 1, total: 1, status: 'pending' });
    const spy = vi.spyOn(crypto, 'randomInt');
    spy.mockReturnValueOnce(654321 as never).mockReturnValueOnce(654322 as never);
    try {
      const res = await request(a).post('/v1/orders').send(guestOrder({ items: [{ productId: p.id, quantity: 1 }], couponCode: 'ONCE' }));
      expect(res.status).toBe(201);
      expect(res.body.order.id).toBe('AB-654322');
    } finally {
      spy.mockRestore();
    }
    expect(await stockOf(p.id)).toBe(9); // deducted exactly once, not twice
    expect((await CouponModel.findOne({ code: 'ONCE' }))!.timesUsed).toBe(1);
    expect(await OrderModel.countDocuments()).toBe(2); // the pre-seeded stub + the one real order
  });

  it('per-identity throttle: 10 orders / hour for the same IP+phone, the 11th is 429 (always on, independent of the IP rate-limit toggle)', async () => {
    const { a, tok } = await adminCtx();
    await relaxCod(a, tok);
    const p = await mkProduct(a, tok, { price: 10, stockCount: 100 });
    const phone = nextPhone();
    let last = 0;
    for (let i = 0; i < 11; i++) {
      const res = await request(a).post('/v1/orders').send(guestOrder({ items: [{ productId: p.id, quantity: 1 }], customer: { fullName: 'F', phone, address: 'a', city: '' } }));
      last = res.status;
      if (i < 10) expect(res.status).toBe(201);
    }
    expect(last).toBe(429);
  });
});

describe('orders - public tracking (masked PII, BACKEND_PLAN B8)', () => {
  async function place(a: ReturnType<typeof app>, tok: string) {
    await relaxCod(a, tok);
    const p = await mkProduct(a, tok, { price: 300, stockCount: 5 });
    const res = await request(a).post('/v1/orders').send(guestOrder({ items: [{ productId: p.id, quantity: 1 }], customer: { fullName: 'Halima Akter', phone: nextPhone(), email: 'halima@example.com', address: '45 Lake Road, Gulshan', city: 'Inside Dhaka' }, notes: 'ring the bell', bkashTrxId: 'SECRET-TRX' }));
    return res.body.order as { id: string };
  }

  it('exact id match, masks phone/email/address, and leaks no payment/admin internals', async () => {
    const { a, tok } = await adminCtx();
    const order = await place(a, tok);
    const res = await request(a).get(`/v1/orders/track/${order.id}`);
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body.customer.fullName).toBe('Halima Akter');
    expect(res.body.customer.email).toMatch(/^h\*\*\*a@example\.com$/);
    expect(res.body.customer.phone).toMatch(/^\d{3}\*\*\*\*\d{3}$/);
    expect(res.body.customer.address).toMatch(/^\*\*\*, .+\(Inside Dhaka\)$/);
    const text = JSON.stringify(res.body);
    expect(text).not.toMatch(/SECRET-TRX|ring the bell|userId|stockDeducted|isFakeSuspected|halima@example\.com/);
  });

  it('fuzzy CONTAINS match (>=4 chars, case-insensitive) finds it without the exact code; a short/unknown query 404s', async () => {
    const { a, tok } = await adminCtx();
    const order = await place(a, tok);
    const digits = order.id.replace('AB-', '');
    expect((await request(a).get(`/v1/orders/track/${digits.toLowerCase()}`)).body.id).toBe(order.id);
    expect((await request(a).get(`/v1/orders/track/${digits.slice(0, 3)}`)).status).toBe(404); // 3 chars: too short
    expect((await request(a).get('/v1/orders/track/AB-000000')).status).toBe(404);
    expect((await request(a).get('/v1/orders/track/zzzz')).status).toBe(404);
  });
});

describe('orders - GET /orders/my', () => {
  it('requires a customer session; a customer sees only their own orders (incl. a matching-phone guest order) newest first, paginated', async () => {
    const { a, tok } = await adminCtx();
    await relaxCod(a, tok);
    const p = await mkProduct(a, tok, { price: 100, stockCount: 20 });
    expect((await request(a).get('/v1/orders/my')).status).toBe(401);

    const phone = nextPhone();
    const cust = await registerCustomer(a, { phone: phone.replace(/^0/, '0') }); // customer's own account phone
    const mine = cust.body.accessToken as string;
    const placeAs = (auth_: Record<string, string>, custPhone = phone) => request(a).post('/v1/orders').set(auth_).send(guestOrder({ items: [{ productId: p.id, quantity: 1 }], customer: { fullName: 'Me', phone: custPhone, address: 'a', city: '' } }));

    const guestFirst = await placeAs({}); // guest order placed with the SAME phone before "registering" - should still show up
    await new Promise((r) => setTimeout(r, 5));
    const asMe1 = await placeAs(auth(mine));
    await new Promise((r) => setTimeout(r, 5));
    const asMe2 = await placeAs(auth(mine));
    const other = await registerCustomer(a, { phone: nextPhone() });
    await request(a).post('/v1/orders').set(auth(other.body.accessToken)).send(guestOrder({ items: [{ productId: p.id, quantity: 1 }], customer: { fullName: 'Other', phone: nextPhone(), address: 'a', city: '' } }));

    const res = await request(a).get('/v1/orders/my').set(auth(mine));
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(3);
    expect(res.body.items.map((o: { id: string }) => o.id)).toEqual([asMe2.body.order.id, asMe1.body.order.id, guestFirst.body.order.id]);

    const p1 = await request(a).get('/v1/orders/my?limit=2&page=1').set(auth(mine));
    expect(p1.body).toMatchObject({ page: 1, limit: 2, total: 3, totalPages: 2 });
    expect(p1.body.items).toHaveLength(2);
    const p2 = await request(a).get('/v1/orders/my?limit=2&page=2').set(auth(mine));
    expect(p2.body.items).toHaveLength(1);
  });
});

describe('cron: expire abandoned pending orders (env PENDING_ORDER_TIMEOUT_HOURS, default 24h)', () => {
  it('an old pending order is auto-cancelled and its stock released, audited as a SYSTEM action (no admin user)', async () => {
    const { a, tok } = await adminCtx();
    await relaxCod(a, tok);
    const p = await mkProduct(a, tok, { price: 100, stockCount: 10 });
    const old = await request(a).post('/v1/orders').send(guestOrder({ items: [{ productId: p.id, quantity: 3 }] }));
    const recent = await request(a).post('/v1/orders').send(guestOrder({ items: [{ productId: p.id, quantity: 2 }] }));
    expect(await stockOf(p.id)).toBe(5);
    await OrderModel.collection.updateOne({ _id: old.body.order.id }, { $set: { createdAt: new Date(Date.now() - 25 * 3_600_000) } });

    const result = await expirePendingOrders();
    expect(result).toEqual({ expired: 1 });

    const oldDoc = await OrderModel.findById(old.body.order.id).lean();
    expect(oldDoc).toMatchObject({ status: 'cancelled', stockDeducted: false });
    expect(await stockOf(p.id)).toBe(8); // 3 released, the recent order's 2 still held
    const recentDoc = await OrderModel.findById(recent.body.order.id).lean();
    expect(recentDoc).toMatchObject({ status: 'pending', stockDeducted: true });

    const audit = await AuditLogModel.findOne({ action: 'order.auto_expired' });
    expect(audit).toMatchObject({ actorEmail: 'system', actorRole: 'system', entityId: old.body.order.id });
    expect(audit!.actorUserId).toBeUndefined();

    expect(await expirePendingOrders()).toEqual({ expired: 0 }); // idempotent: already cancelled, not picked up again
  });

  it('a non-pending order is never touched, however old', async () => {
    const { a, tok } = await adminCtx();
    await relaxCod(a, tok);
    const p = await mkProduct(a, tok, { price: 100, stockCount: 10 });
    const res = await request(a).post('/v1/orders').send(guestOrder({ items: [{ productId: p.id, quantity: 1 }] }));
    await OrderModel.collection.updateOne({ _id: res.body.order.id }, { $set: { createdAt: new Date(Date.now() - 999 * 3_600_000), status: 'processing' } });
    expect(await expirePendingOrders()).toEqual({ expired: 0 });
    expect((await OrderModel.findById(res.body.order.id).lean())!.status).toBe('processing');
  });

  it('the cron HTTP route requires the CRON_SECRET bearer token', async () => {
    const a = app();
    expect((await request(a).get('/v1/internal/cron/orders/expire-pending')).status).toBe(401);
    const res = await request(a).get('/v1/internal/cron/orders/expire-pending').set({ Authorization: `Bearer ${process.env.CRON_SECRET}` });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, expired: 0 });
  });
});
