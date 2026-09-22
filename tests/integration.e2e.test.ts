/**
 * End-to-end integration scenarios (Module 12): a handful of tests that exercise a full realistic flow across MANY modules in
 * one go (auth, catalogue, coupons, orders, courier, reviews, wishlist), to catch any cross-module gap that module-level tests
 * - which mostly stub or bypass the neighbouring modules - could miss. These are intentionally slower and broader than the
 * rest of the suite; the module-level files remain the source of truth for exhaustive edge cases.
 */
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { CouponModel } from '../src/modules/coupons/coupon.model';
import { ProductModel } from '../src/modules/products/product.model';
import { adminCtx, app, auth, mkCategory, patchSettings, registerCustomer } from './helpers';

let seq = 40_000_000;
const nextPhone = () => `013${String(seq++).padStart(8, '0')}`;

describe('integration: register -> browse -> wishlist -> coupon -> order -> dispatch -> deliver -> review', () => {
  it('a full customer journey leaves every touched module in a mutually consistent state', async () => {
    const { a, tok: adminTok } = await adminCtx();

    // --- catalogue setup ---
    await mkCategory(a, adminTok, 'Honey');
    const product = (await request(a).post('/v1/admin/products').set(auth(adminTok)).send({ name: 'Sundarban Honey 500g', category: 'Honey', price: 1000, costPrice: 600, stockCount: 10 })).body;
    await patchSettings(a, adminTok, { enableCoupons: true });
    await request(a).post('/v1/admin/coupons').set(auth(adminTok)).send({ code: 'WELCOME10', discountPercent: 10 }).expect(201);

    // --- customer: register, browse, filter, wishlist ---
    const custRes = await registerCustomer(a, { phone: nextPhone(), name: 'Halima Akter' });
    const custTok = custRes.body.accessToken as string;
    const browse = await request(a).get('/v1/products?category=Honey&inStockOnly=true&sort=price-low');
    expect(browse.body.map((p: { id: string }) => p.id)).toContain(product.id);
    expect(JSON.stringify(browse.body)).not.toMatch(/costPrice/i); // public catalogue never leaks it, even mid-journey
    await request(a).post(`/v1/wishlist/${product.id}`).set(auth(custTok)).expect(200);

    // --- coupon validated from the cart, THEN the order is placed with it (server re-validates + atomically redeems) ---
    const quote = await request(a).post('/v1/coupons/validate').send({ code: 'WELCOME10', subtotal: 1000 });
    expect(quote.body).toMatchObject({ discountAmount: 100 });

    const order = await request(a).post('/v1/orders').set(auth(custTok)).send({
      items: [{ productId: product.id, quantity: 1 }],
      customer: { fullName: 'Halima Akter', phone: nextPhone(), email: 'halima@example.com', address: '12 Green Road', city: 'Inside Dhaka' },
      paymentChoice: 'FULL_BKASH', bkashTrxId: 'TRX-E2E-1', couponCode: 'welcome10',
    });
    expect(order.status).toBe(201);
    expect(order.body.order).toMatchObject({ subtotal: 1000, discount: 100, total: 980, deliveryPaymentStatus: 'FULL_PAID', couponCode: 'WELCOME10' });
    const orderId = order.body.order.id;

    // --- cross-module side effects of PLACING the order ---
    expect((await ProductModel.findById(product.id).lean())!.stockCount).toBe(9); // Module 5a: reserved at placement
    expect((await CouponModel.findOne({ code: 'WELCOME10' }))!.timesUsed).toBe(1); // Module 4: redeemed exactly once

    // --- admin: sees it in the live order list, dispatches it (simulated), status advances to shipped ---
    const adminList = await request(a).get('/v1/admin/orders?status=pending').set(auth(adminTok));
    expect(adminList.body.map((o: { id: string }) => o.id)).toContain(orderId);
    const dispatch = await request(a).post(`/v1/admin/orders/${orderId}/dispatch`).set(auth(adminTok)).send({ provider: 'steadfast' });
    expect(dispatch.status).toBe(200);
    expect(dispatch.body.order.status).toBe('shipped'); // Module 11's success side-effect
    expect(dispatch.body.courier).toMatchObject({ simulated: true, codAmount: 0 }); // FULL_BKASH: nothing due on delivery (BUG_FIXES B1)

    // --- admin marks it delivered ---
    const delivered = await request(a).patch(`/v1/admin/orders/${orderId}`).set(auth(adminTok)).send({ status: 'delivered' });
    expect(delivered.body.order.status).toBe('delivered');
    expect(delivered.body.stock).toBe('none'); // stock was already reserved at placement, not re-touched by status progress

    // --- customer: sees it in /my (newest first) and via the public masked tracker ---
    const mine = await request(a).get('/v1/orders/my').set(auth(custTok));
    expect(mine.body.items[0]).toMatchObject({ id: orderId, status: 'delivered' });
    const tracked = await request(a).get(`/v1/orders/track/${orderId}`);
    expect(tracked.body.status).toBe('delivered');
    expect(tracked.body.customer.phone).toMatch(/^\d{3}\*\*\*\*\d{3}$/); // masked, unlike the admin/owner view above

    // --- customer reviews the product: verifiedPurchase is true (they have a DELIVERED order for it), rating updates ---
    const review = await request(a).post('/v1/reviews').set(auth(custTok)).send({ productId: product.id, rating: 5, comment: 'Excellent honey, fast delivery!' });
    expect(review.status).toBe(201);
    expect(review.body.verifiedPurchase).toBe(true); // Module 6, computed from the Module 5 order just delivered
    const productAfter = await request(a).get(`/v1/products/${product.id}`);
    expect(productAfter.body).toMatchObject({ rating: 5, reviewCount: 1 });

    // --- the wishlist entry from step 1 is untouched by any of this ---
    expect((await request(a).get('/v1/wishlist').set(auth(custTok))).body.map((p: { id: string }) => p.id)).toEqual([product.id]);
  });
});

describe('integration: advance-delivery payment verification, fake-suspicion, and cancellation', () => {
  it('ADVANCE_PENDING -> admin verifies -> flags/unflags without losing state -> cancels -> stock restored, coupon NOT released', async () => {
    const { a, tok: adminTok } = await adminCtx();
    await mkCategory(a, adminTok, 'Attar');
    const product = (await request(a).post('/v1/admin/products').set(auth(adminTok)).send({ name: 'Oudh Attar', category: 'Attar', price: 2000, stockCount: 3 })).body;
    await patchSettings(a, adminTok, { enableCoupons: true });
    await request(a).post('/v1/admin/coupons').set(auth(adminTok)).send({ code: 'EID15', discountPercent: 15 }).expect(201);

    const order = await request(a).post('/v1/orders').send({
      items: [{ productId: product.id, quantity: 1 }],
      customer: { fullName: 'Guest Buyer', phone: nextPhone(), address: '4 Lake Circus', city: 'Inside Dhaka' },
      paymentChoice: 'ADVANCE_DELIVERY', bkashTrxId: 'TRX-E2E-2', couponCode: 'EID15',
    });
    expect(order.status).toBe(201);
    expect(order.body.order.deliveryPaymentStatus).toBe('ADVANCE_PENDING'); // Module 5b decision #3: never auto-trusted
    const orderId = order.body.order.id;
    expect((await ProductModel.findById(product.id).lean())!.stockCount).toBe(2);

    // admin verifies the claimed payment
    const verified = await request(a).post(`/v1/admin/orders/${orderId}/verify-payment`).set(auth(adminTok));
    expect(verified.body.deliveryPaymentStatus).toBe('ADVANCE_PAID');

    // flag as suspected fake, then un-flag: must restore ADVANCE_PAID exactly (BUG_FIXES B4), not COD_PENDING
    await request(a).patch(`/v1/admin/orders/${orderId}`).set(auth(adminTok)).send({ toggleFakeSuspicion: true }).expect(200);
    const unflagged = await request(a).patch(`/v1/admin/orders/${orderId}`).set(auth(adminTok)).send({ toggleFakeSuspicion: true });
    expect(unflagged.body.order.deliveryPaymentStatus).toBe('ADVANCE_PAID');

    // admin cancels: stock restored, but the coupon use is NOT given back (confirmed policy)
    const cancelled = await request(a).patch(`/v1/admin/orders/${orderId}`).set(auth(adminTok)).send({ status: 'cancelled' });
    expect(cancelled.body).toMatchObject({ stock: 'restored', order: { status: 'cancelled' } });
    expect((await ProductModel.findById(product.id).lean())!.stockCount).toBe(3);
    expect((await CouponModel.findOne({ code: 'EID15' }))!.timesUsed).toBe(1); // still consumed

    // the cancelled order is excluded from the admin's default pending view but still fully visible by id
    expect((await request(a).get('/v1/admin/orders?status=pending').set(auth(adminTok))).body.map((o: { id: string }) => o.id)).not.toContain(orderId);
    expect((await request(a).get(`/v1/admin/orders/${orderId}`).set(auth(adminTok))).body.status).toBe('cancelled');
  });
});
