import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { resetEnvCacheForTests } from '../src/config/env';
import { deriveZone } from '../src/domain/zone';
import { AuditLogModel } from '../src/modules/audit/audit.model';
import { OrderModel } from '../src/modules/orders/order.model';
import { ProductModel } from '../src/modules/products/product.model';
import { adminCtx, app, auth, mkProduct, patchSettings, registerCustomer } from './helpers';

let seq = 50_000_000;
const nextPhone = () => `018${String(seq++).padStart(8, '0')}`;
const relaxCod = (a: ReturnType<typeof app>, tok: string) => patchSettings(a, tok, { deliveryConfig: { requireAdvanceDeliveryCharge: false } });
const guestOrder = (over: Record<string, unknown> = {}) => ({
  items: [], customer: { fullName: 'Rafiq', phone: nextPhone(), address: '9 Banani', city: 'Inside Dhaka' }, paymentChoice: 'FULL_COD', ...over,
});
const stockOf = async (id: string) => (await ProductModel.findById(id).lean())!.stockCount;
const ageOrder = (id: string, hoursAgo: number) => OrderModel.collection.updateOne({ _id: id } as Record<string, unknown>, { $set: { createdAt: new Date(Date.now() - hoursAgo * 3_600_000) } });
async function place(a: ReturnType<typeof app>, tok: string, over: Record<string, unknown> = {}) {
  await relaxCod(a, tok);
  const p = over.__product as { id: string } | undefined;
  const prod = p ?? (await mkProduct(a, tok, { price: 500, stockCount: 5 }));
  const body = guestOrder({ items: [{ productId: prod.id, quantity: 1 }], ...over });
  const res = await request(a).post('/v1/orders').send(body);
  return { res, product: prod };
}

describe('deriveZone (domain, pure - zone-derivation robustness fix)', () => {
  it('recognises the exact strings the checkout sends, case/whitespace-insensitively', () => {
    expect(deriveZone('Inside Dhaka')).toEqual({ zone: 'inside', uncertain: false });
    expect(deriveZone('  outside dhaka  ')).toEqual({ zone: 'outside', uncertain: false });
    expect(deriveZone('OUTSIDE')).toEqual({ zone: 'outside', uncertain: false });
    expect(deriveZone('inside')).toEqual({ zone: 'inside', uncertain: false });
  });
  it('common variations resolve confidently to inside', () => {
    expect(deriveZone('Dhaka')).toEqual({ zone: 'inside', uncertain: false });
    expect(deriveZone('dhaka city')).toEqual({ zone: 'inside', uncertain: false });
  });
  it('anything unrecognised (blank, a real district name, garbage) defaults to OUTSIDE and is flagged uncertain', () => {
    expect(deriveZone('')).toEqual({ zone: 'outside', uncertain: true });
    expect(deriveZone(undefined)).toEqual({ zone: 'outside', uncertain: true });
    expect(deriveZone('Chittagong')).toEqual({ zone: 'outside', uncertain: true });
    expect(deriveZone('   ')).toEqual({ zone: 'outside', uncertain: true });
  });
});

describe('order creation - zone flagging end to end', () => {
  it('a recognised city is priced correctly and NOT flagged; an unrecognised one defaults to the outside fee and IS flagged', async () => {
    const { a, tok } = await adminCtx();
    await relaxCod(a, tok);
    const p = await mkProduct(a, tok, { price: 100, stockCount: 10 });
    const good = await request(a).post('/v1/orders').send(guestOrder({ items: [{ productId: p.id, quantity: 1 }], customer: { fullName: 'X', phone: nextPhone(), address: 'a', city: 'Inside Dhaka' } }));
    expect(good.body.order).toMatchObject({ shipping: 80, deliveryZone: 'inside' });
    expect(good.body.order).not.toHaveProperty('zoneUncertain');

    const bad = await request(a).post('/v1/orders').send(guestOrder({ items: [{ productId: p.id, quantity: 1 }], customer: { fullName: 'X', phone: nextPhone(), address: 'a', city: 'Rangpur' } }));
    expect(bad.body.order).toMatchObject({ shipping: 160, deliveryZone: 'outside', zoneUncertain: true });
    const stored = await OrderModel.findById(bad.body.order.id).lean();
    expect(stored!.zoneUncertain).toBe(true);
  });
});

describe('lazy expiry - triggered by stock reservation (Module 5c, replaces the 30-min cron as the primary mechanism)', () => {
  it('reserving stock for a NEW order expires a blocking abandoned pending order and the new order then succeeds', async () => {
    const { a, tok } = await adminCtx();
    const p = await mkProduct(a, tok, { price: 200, stockCount: 1 });
    const stuck = await place(a, tok, { __product: p });
    expect(stuck.res.status).toBe(201);
    expect(await stockOf(p.id)).toBe(0);
    await ageOrder(stuck.res.body.order.id, 25);

    const fresh = await place(a, tok, { __product: p });
    expect(fresh.res.status).toBe(201); // would have been 409 INSUFFICIENT_STOCK before the lazy check

    const stuckDoc = await OrderModel.findById(stuck.res.body.order.id).lean();
    expect(stuckDoc).toMatchObject({ status: 'cancelled', stockDeducted: false });
    expect(await stockOf(p.id)).toBe(0); // released then immediately re-taken by the new order
    expect(await AuditLogModel.findOne({ action: 'order.auto_expired', entityId: stuck.res.body.order.id })).toMatchObject({ actorEmail: 'system' });
  });

  it('a RECENT pending order is left untouched and still correctly blocks/competes for the same stock', async () => {
    const { a, tok } = await adminCtx();
    const p = await mkProduct(a, tok, { price: 200, stockCount: 1 });
    const holder = await place(a, tok, { __product: p });
    expect(holder.res.status).toBe(201);
    const competitor = await place(a, tok, { __product: p }); // not aged - still well within the window
    expect(competitor.res.status).toBe(409);
    expect(competitor.res.body.error).toBe('INSUFFICIENT_STOCK');
    const holderDoc = await OrderModel.findById(holder.res.body.order.id).lean();
    expect(holderDoc).toMatchObject({ status: 'pending', stockDeducted: true });
    expect(await stockOf(p.id)).toBe(0);
  });

  it('only expires orders that actually hold stock on the product being reserved - an old pending order for a DIFFERENT product is untouched', async () => {
    const { a, tok } = await adminCtx();
    const p1 = await mkProduct(a, tok, { price: 100, stockCount: 5 });
    const p2 = await mkProduct(a, tok, { price: 100, stockCount: 5 });
    const other = await place(a, tok, { __product: p1 });
    await ageOrder(other.res.body.order.id, 25);
    await place(a, tok, { __product: p2 }); // reserving p2 must not touch p1's old order
    expect((await OrderModel.findById(other.res.body.order.id).lean())!.status).toBe('pending');
  });
});

describe('lazy expiry - admin pending list (Module 5c)', () => {
  it('GET /admin/orders?status=pending excludes a lazily-expired order; it then shows up under status=cancelled', async () => {
    const { a, tok } = await adminCtx();
    const { res } = await place(a, tok);
    await ageOrder(res.body.order.id, 25);

    const pending = await request(a).get('/v1/admin/orders?status=pending').set(auth(tok));
    expect(pending.body.map((o: { id: string }) => o.id)).not.toContain(res.body.order.id);

    const cancelled = await request(a).get('/v1/admin/orders?status=cancelled').set(auth(tok));
    expect(cancelled.body.map((o: { id: string }) => o.id)).toContain(res.body.order.id);
  });

  it('the unfiltered admin list also lazily expires stale pending orders before responding', async () => {
    const { a, tok } = await adminCtx();
    const { res } = await place(a, tok);
    await ageOrder(res.body.order.id, 25);
    await request(a).get('/v1/admin/orders').set(auth(tok)).expect(200);
    expect((await OrderModel.findById(res.body.order.id).lean())!.status).toBe('cancelled');
  });
});

describe('admin orders - auth', () => {
  it('every route requires admin/super_admin', async () => {
    const { a, tok } = await adminCtx();
    const { res } = await place(a, tok);
    const id = res.body.order.id;
    const cust = await registerCustomer(a);
    for (const call of [
      () => request(a).get('/v1/admin/orders'),
      () => request(a).get(`/v1/admin/orders/${id}`),
      () => request(a).patch(`/v1/admin/orders/${id}`).send({ status: 'processing' }),
      () => request(a).delete(`/v1/admin/orders/${id}`),
      () => request(a).post(`/v1/admin/orders/${id}/dispatch`).send({}),
      () => request(a).post(`/v1/admin/orders/${id}/verify-payment`),
    ]) {
      expect((await call()).status).toBe(401);
      expect((await call().then((r) => r)).status).toBe(401);
      expect((await request(a).get('/v1/admin/orders').set(auth(cust.body.accessToken))).status).toBe(401);
    }
  });
});

describe('admin orders - list + detail', () => {
  it('full array, newest first, unmasked (admin sees TrxID/userId/notes), soft-deleted excluded', async () => {
    const { a, tok } = await adminCtx();
    await relaxCod(a, tok);
    const p = await mkProduct(a, tok, { price: 300, stockCount: 10 });
    const cust = await registerCustomer(a);
    const first = await request(a).post('/v1/orders').set(auth(cust.body.accessToken)).send(guestOrder({ items: [{ productId: p.id, quantity: 1 }], notes: 'leave at gate', paymentChoice: 'FULL_BKASH', bkashTrxId: 'ABC1' }));
    await new Promise((r) => setTimeout(r, 5));
    const second = await request(a).post('/v1/orders').send(guestOrder({ items: [{ productId: p.id, quantity: 1 }] }));

    const list = await request(a).get('/v1/admin/orders').set(auth(tok));
    expect(list.status).toBe(200);
    expect(list.body.map((o: { id: string }) => o.id)).toEqual([second.body.order.id, first.body.order.id]);
    const admin1 = list.body.find((o: { id: string }) => o.id === first.body.order.id);
    expect(admin1).toMatchObject({ notes: 'leave at gate', bkashTrxId: 'ABC1', userId: expect.any(String) });

    const detail = await request(a).get(`/v1/admin/orders/${first.body.order.id}`).set(auth(tok));
    expect(detail.body).toMatchObject({ notes: 'leave at gate', bkashTrxId: 'ABC1' });
    expect((await request(a).get('/v1/admin/orders/AB-000000').set(auth(tok))).status).toBe(404);

    await request(a).delete(`/v1/admin/orders/${second.body.order.id}`).set(auth(tok)).expect(200);
    expect((await request(a).get('/v1/admin/orders').set(auth(tok))).body.map((o: { id: string }) => o.id)).not.toContain(second.body.order.id);
    expect((await request(a).get(`/v1/admin/orders/${second.body.order.id}`).set(auth(tok))).status).toBe(404);
  });
});

describe('admin orders - status transitions wired to stock (Module 5a reserve/release)', () => {
  it('cancelling a pending order releases its stock; re-opening it reserves stock again (when available)', async () => {
    const { a, tok } = await adminCtx();
    const p = await mkProduct(a, tok, { price: 100, stockCount: 5 });
    const { res } = await place(a, tok, { __product: p });
    const id = res.body.order.id;
    expect(await stockOf(p.id)).toBe(4);

    const cancel = await request(a).patch(`/v1/admin/orders/${id}`).set(auth(tok)).send({ status: 'cancelled' });
    expect(cancel.status).toBe(200);
    expect(cancel.body).toMatchObject({ stock: 'restored', order: { status: 'cancelled', stockDeducted: false } });
    expect(await stockOf(p.id)).toBe(5);

    const reopen = await request(a).patch(`/v1/admin/orders/${id}`).set(auth(tok)).send({ status: 'processing' });
    expect(reopen.status).toBe(200);
    expect(reopen.body).toMatchObject({ stock: 'deducted', order: { status: 'processing', stockDeducted: true } });
    expect(await stockOf(p.id)).toBe(4);
  });

  it('ordinary progress (pending -> processing -> shipped -> delivered) never touches stock', async () => {
    const { a, tok } = await adminCtx();
    const p = await mkProduct(a, tok, { price: 100, stockCount: 5 });
    const { res } = await place(a, tok, { __product: p });
    const id = res.body.order.id;
    for (const status of ['processing', 'shipped', 'delivered']) {
      const r = await request(a).patch(`/v1/admin/orders/${id}`).set(auth(tok)).send({ status });
      expect(r.body).toMatchObject({ stock: 'none', order: { status } });
    }
    expect(await stockOf(p.id)).toBe(4);
  });

  it('re-opening a cancelled order whose stock sold out meanwhile FAILS (409) and rolls back the WHOLE patch - status stays cancelled', async () => {
    const { a, tok } = await adminCtx();
    const p = await mkProduct(a, tok, { price: 100, stockCount: 1 });
    const { res } = await place(a, tok, { __product: p });
    const id = res.body.order.id;
    await request(a).patch(`/v1/admin/orders/${id}`).set(auth(tok)).send({ status: 'cancelled' }).expect(200); // releases the 1 unit
    await place(a, tok, { __product: p }).then((r) => expect(r.res.status).toBe(201)); // someone else takes it
    expect(await stockOf(p.id)).toBe(0);

    const reopen = await request(a).patch(`/v1/admin/orders/${id}`).set(auth(tok)).send({ status: 'processing' });
    expect(reopen.status).toBe(409);
    expect(reopen.body.error).toBe('INSUFFICIENT_STOCK');
    expect((await OrderModel.findById(id).lean())!.status).toBe('cancelled'); // rolled back, not stuck half-changed
  });

  it('rejects an unknown status/order and requires at least one field', async () => {
    const { a, tok } = await adminCtx();
    const { res } = await place(a, tok);
    expect((await request(a).patch(`/v1/admin/orders/${res.body.order.id}`).set(auth(tok)).send({ status: 'bogus' })).body.error).toBe('VALIDATION_ERROR');
    expect((await request(a).patch(`/v1/admin/orders/${res.body.order.id}`).set(auth(tok)).send({})).body.error).toBe('VALIDATION_ERROR');
    expect((await request(a).patch('/v1/admin/orders/AB-000000').set(auth(tok)).send({ status: 'processing' })).status).toBe(404);
  });
});

describe('admin orders - fake-suspicion toggle (BUG_FIXES A11, un-flag data-loss fixed per BUG_FIXES B4)', () => {
  it('a COD order: flag -> FAKE_SUSPECTED; un-flag -> COD_PENDING (unchanged from before)', async () => {
    const { a, tok } = await adminCtx();
    const { res } = await place(a, tok);
    const id = res.body.order.id;
    expect((await OrderModel.findById(id).lean())!.deliveryPaymentStatus).toBe('COD_PENDING');

    const flagged = await request(a).patch(`/v1/admin/orders/${id}`).set(auth(tok)).send({ toggleFakeSuspicion: true });
    expect(flagged.body.order).toMatchObject({ isFakeSuspected: true, deliveryPaymentStatus: 'FAKE_SUSPECTED' });
    expect(flagged.body.stock).toBe('none');

    const unflagged = await request(a).patch(`/v1/admin/orders/${id}`).set(auth(tok)).send({ toggleFakeSuspicion: true });
    expect(unflagged.body.order).toMatchObject({ isFakeSuspected: false, deliveryPaymentStatus: 'COD_PENDING' });
  });

  it('THE FIX: an ADVANCE_PENDING order flagged then un-flagged is restored to ADVANCE_PENDING, not reset to COD_PENDING', async () => {
    const { a, tok } = await adminCtx();
    const p = await mkProduct(a, tok, { price: 500, stockCount: 5 });
    const adv = await request(a).post('/v1/orders').send(guestOrder({ items: [{ productId: p.id, quantity: 1 }], paymentChoice: 'ADVANCE_DELIVERY', bkashTrxId: 'F1' }));
    const id = adv.body.order.id;
    expect(adv.body.order.deliveryPaymentStatus).toBe('ADVANCE_PENDING');

    await request(a).patch(`/v1/admin/orders/${id}`).set(auth(tok)).send({ toggleFakeSuspicion: true }).expect(200);
    const unflagged = await request(a).patch(`/v1/admin/orders/${id}`).set(auth(tok)).send({ toggleFakeSuspicion: true });
    expect(unflagged.body.order.deliveryPaymentStatus).toBe('ADVANCE_PENDING'); // not COD_PENDING - the old bug would have lost this

    // same for a FULL_BKASH order (FULL_PAID) and one already admin-verified (VERIFIED)
    const full = await request(a).post('/v1/orders').send(guestOrder({ items: [{ productId: p.id, quantity: 1 }], paymentChoice: 'FULL_BKASH', bkashTrxId: 'F2' }));
    await request(a).patch(`/v1/admin/orders/${full.body.order.id}`).set(auth(tok)).send({ toggleFakeSuspicion: true }).expect(200);
    const fullUnflagged = await request(a).patch(`/v1/admin/orders/${full.body.order.id}`).set(auth(tok)).send({ toggleFakeSuspicion: true });
    expect(fullUnflagged.body.order.deliveryPaymentStatus).toBe('FULL_PAID');
  });

  it('flag then re-flag without ever un-flagging keeps the ORIGINAL pre-flag status (does not overwrite it with FAKE_SUSPECTED itself)', async () => {
    const { a, tok } = await adminCtx();
    const p = await mkProduct(a, tok, { price: 500, stockCount: 5 });
    const adv = await request(a).post('/v1/orders').send(guestOrder({ items: [{ productId: p.id, quantity: 1 }], paymentChoice: 'ADVANCE_DELIVERY', bkashTrxId: 'F3' }));
    const id = adv.body.order.id;
    await request(a).patch(`/v1/admin/orders/${id}`).set(auth(tok)).send({ toggleFakeSuspicion: true }).expect(200); // flag
    await request(a).patch(`/v1/admin/orders/${id}`).set(auth(tok)).send({ toggleFakeSuspicion: true }).expect(200); // un-flag (back to ADVANCE_PENDING)
    const reflagged = await request(a).patch(`/v1/admin/orders/${id}`).set(auth(tok)).send({ toggleFakeSuspicion: true }); // flag again
    expect(reflagged.body.order.deliveryPaymentStatus).toBe('FAKE_SUSPECTED');
    const unflaggedAgain = await request(a).patch(`/v1/admin/orders/${id}`).set(auth(tok)).send({ toggleFakeSuspicion: true });
    expect(unflaggedAgain.body.order.deliveryPaymentStatus).toBe('ADVANCE_PENDING'); // still remembers the ORIGINAL state, not FAKE_SUSPECTED
  });
});

describe('admin orders - payment status (generic override + the new verify-payment action)', () => {
  it('the generic PATCH deliveryPaymentStatus accepts the safe enum values but NOT ADVANCE_PAID or FAKE_SUSPECTED (only their own guarded actions can set those)', async () => {
    const { a, tok } = await adminCtx();
    const { res } = await place(a, tok);
    const id = res.body.order.id;
    const ok = await request(a).patch(`/v1/admin/orders/${id}`).set(auth(tok)).send({ deliveryPaymentStatus: 'VERIFIED' });
    expect(ok.body.order.deliveryPaymentStatus).toBe('VERIFIED');
    expect((await request(a).patch(`/v1/admin/orders/${id}`).set(auth(tok)).send({ deliveryPaymentStatus: 'FAKE_SUSPECTED' })).body.error).toBe('VALIDATION_ERROR');
    expect((await request(a).patch(`/v1/admin/orders/${id}`).set(auth(tok)).send({ deliveryPaymentStatus: 'ADVANCE_PAID' })).body.error).toBe('VALIDATION_ERROR');
  });

  it('verify-payment: ADVANCE_PENDING -> ADVANCE_PAID (decision #3), audited distinctly; refuses any other starting state', async () => {
    const { a, tok } = await adminCtx();
    const p = await mkProduct(a, tok, { price: 500, stockCount: 5 });
    const adv = await request(a).post('/v1/orders').send(guestOrder({ items: [{ productId: p.id, quantity: 1 }], paymentChoice: 'ADVANCE_DELIVERY', bkashTrxId: 'ADV-9' }));
    expect(adv.body.order.deliveryPaymentStatus).toBe('ADVANCE_PENDING');
    const id = adv.body.order.id;

    const verified = await request(a).post(`/v1/admin/orders/${id}/verify-payment`).set(auth(tok));
    expect(verified.status).toBe(200);
    expect(verified.body.deliveryPaymentStatus).toBe('ADVANCE_PAID');
    expect(await AuditLogModel.findOne({ action: 'order.payment_verified', entityId: id })).toBeTruthy();

    expect((await request(a).post(`/v1/admin/orders/${id}/verify-payment`).set(auth(tok))).body.error).toBe('NOT_PENDING_VERIFICATION'); // already verified
    const { res: cod } = await place(a, tok);
    expect((await request(a).post(`/v1/admin/orders/${cod.body.order.id}/verify-payment`).set(auth(tok))).body.error).toBe('NOT_PENDING_VERIFICATION'); // plain COD, never claimed
    expect((await request(a).post('/v1/admin/orders/AB-000000/verify-payment').set(auth(tok))).status).toBe(404);
  });
});

describe('admin orders - dispatch (SIMULATED) and the courier COD-amount fix (BUG_FIXES B1)', () => {
  it('COD amount = dueAmountOnDelivery, never the raw total - proven across all three payment choices', async () => {
    const { a, tok } = await adminCtx();
    const p = await mkProduct(a, tok, { price: 1000, stockCount: 10 });

    const cod = await place(a, tok, { __product: p }); // FULL_COD: nothing paid in advance
    const codDispatch = await request(a).post(`/v1/admin/orders/${cod.res.body.order.id}/dispatch`).set(auth(tok)).send({ provider: 'steadfast' });
    expect(codDispatch.body.courier).toMatchObject({ success: true, provider: 'steadfast', simulated: true, codAmount: cod.res.body.order.total });
    expect(codDispatch.body.courier.codAmount).toBe(1080); // 1000 + 80 delivery, all due on delivery

    const adv = await request(a).post('/v1/orders').send(guestOrder({ items: [{ productId: p.id, quantity: 1 }], paymentChoice: 'ADVANCE_DELIVERY', bkashTrxId: 'T' }));
    expect(adv.body.order).toMatchObject({ total: 1080, advanceAmount: 80, dueAmountOnDelivery: 1000 });
    const advDispatch = await request(a).post(`/v1/admin/orders/${adv.body.order.id}/dispatch`).set(auth(tok)).send({ provider: 'steadfast' });
    expect(advDispatch.body.courier.codAmount).toBe(1000); // the OLD bug would have charged 1080 (the full total) again on top of the prepaid delivery fee

    const full = await request(a).post('/v1/orders').send(guestOrder({ items: [{ productId: p.id, quantity: 1 }], paymentChoice: 'FULL_BKASH', bkashTrxId: 'T2' }));
    const fullDispatch = await request(a).post(`/v1/admin/orders/${full.body.order.id}/dispatch`).set(auth(tok)).send({ provider: 'pathao' });
    expect(fullDispatch.body.courier.codAmount).toBe(0); // fully prepaid, nothing to collect
  });

  it('provider defaults from settings.courierConfig.defaultCourier (steadfast out of the box) when none is given', async () => {
    const { a, tok } = await adminCtx();
    const { res } = await place(a, tok);
    const id = res.body.order.id;
    const dispatched = await request(a).post(`/v1/admin/orders/${id}/dispatch`).set(auth(tok)).send({});
    expect(dispatched.status).toBe(200);
    expect(dispatched.body.courier.provider).toBe('steadfast');
    expect(dispatched.body.order.courier).toMatchObject({ provider: 'steadfast', status: 'in_review' });
    expect(await AuditLogModel.findOne({ action: 'order.dispatch', entityId: id })).toMatchObject({ details: { provider: 'steadfast', simulated: true } });
  });

  it('"manual" (explicitly configured, or requested) refuses dispatch - there is no manual consignment to create', async () => {
    const { a, tok } = await adminCtx();
    await patchSettings(a, tok, { courierConfig: { defaultCourier: 'manual' } });
    const { res } = await place(a, tok);
    const id = res.body.order.id;
    const manual = await request(a).post(`/v1/admin/orders/${id}/dispatch`).set(auth(tok)).send({});
    expect(manual.status).toBe(409);
    expect(manual.body.error).toBe('COURIER_NOT_CONFIGURED');
    // an explicit provider on the request still overrides the (manual) default
    const explicit = await request(a).post(`/v1/admin/orders/${id}/dispatch`).set(auth(tok)).send({ provider: 'pathao' });
    expect(explicit.status).toBe(200);
    expect(explicit.body.courier.provider).toBe('pathao');
  });

  it('ENABLE_LIVE_INTEGRATIONS=true refuses (501) instead of silently simulating - there is no real adapter yet (Module 11)', async () => {
    const { a, tok } = await adminCtx();
    const { res } = await place(a, tok);
    process.env.ENABLE_LIVE_INTEGRATIONS = 'true';
    resetEnvCacheForTests();
    try {
      const r = await request(a).post(`/v1/admin/orders/${res.body.order.id}/dispatch`).set(auth(tok)).send({ provider: 'steadfast' });
      expect(r.status).toBe(501);
      expect(r.body.error).toBe('COURIER_LIVE_NOT_IMPLEMENTED');
    } finally {
      process.env.ENABLE_LIVE_INTEGRATIONS = 'false';
      resetEnvCacheForTests();
    }
  });
});
