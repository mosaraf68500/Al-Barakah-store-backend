import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { computeDiscount, evaluateCoupon, normalizeCouponCode } from '../src/domain/coupon';
import { AuditLogModel } from '../src/modules/audit/audit.model';
import { CouponModel } from '../src/modules/coupons/coupon.model';
import { redeemCoupon, releaseCoupon, validateCoupon } from '../src/modules/coupons/coupon.service';
import { adminCtx, app, auth, registerCustomer, withV } from './helpers';

async function setup(enable = true) {
  const { a, tok } = await adminCtx();
  if (enable) await request(a).patch('/v1/admin/settings').set(auth(tok)).send(await withV(a, tok, { enableCoupons: true })).expect(200);
  const mk = (b: Record<string, unknown>) => request(a).post('/v1/admin/coupons').set(auth(tok)).send({ code: 'SAVE10', discountPercent: 10, ...b });
  const validate = (code: string, subtotal: number) => request(a).post('/v1/coupons/validate').send({ code, subtotal });
  return { a, tok, mk, validate };
}
const past = () => new Date(Date.now() - 60_000).toISOString();
const future = () => new Date(Date.now() + 3_600_000).toISOString();

describe('coupon domain rules (pure)', () => {
  const base = { isActive: true, discountPercent: 10, minOrderAmount: 0, timesUsed: 0 };
  it('normalises codes (trim, ALL whitespace removed, upper-case)', () => {
    expect(normalizeCouponCode('  eid 2026 ')).toBe('EID2026');
  });
  it('discount = percent of subtotal, capped by maxDiscountAmount, never above the subtotal, 2dp', () => {
    expect(computeDiscount(1000, 10)).toBe(100);
    expect(computeDiscount(1000, 10, 60)).toBe(60);
    expect(computeDiscount(1000, 10, 500)).toBe(100); // cap not reached
    expect(computeDiscount(333, 10)).toBe(33.3);
    expect(computeDiscount(100, 100, 5000)).toBe(100);
    expect(computeDiscount(0, 50)).toBe(0);
    expect(computeDiscount(199.99, 15)).toBe(30);
  });
  it('check order: inactive -> expired -> limit -> min spend (a coupon failing several reports the FIRST)', () => {
    const now = new Date();
    const bad = { ...base, isActive: false, expiresAt: new Date(now.getTime() - 1), usageLimit: 1, timesUsed: 1, minOrderAmount: 999 };
    expect(evaluateCoupon(bad, 1, now)).toEqual({ ok: false, reason: 'INVALID_COUPON' });
    expect(evaluateCoupon({ ...bad, isActive: true }, 1, now)).toEqual({ ok: false, reason: 'COUPON_EXPIRED' });
    expect(evaluateCoupon({ ...bad, isActive: true, expiresAt: null }, 1, now)).toEqual({ ok: false, reason: 'COUPON_LIMIT' });
    expect(evaluateCoupon({ ...bad, isActive: true, expiresAt: null, usageLimit: null }, 1, now)).toEqual({ ok: false, reason: 'MIN_SPEND', minSpend: 999 });
  });
  it('boundaries: subtotal == min passes; expiresAt == now is expired; timesUsed == limit is exhausted, limit-1 is fine', () => {
    const now = new Date();
    expect(evaluateCoupon({ ...base, minOrderAmount: 500 }, 500, now).ok).toBe(true);
    expect(evaluateCoupon({ ...base, minOrderAmount: 500 }, 499.99, now).ok).toBe(false);
    expect(evaluateCoupon({ ...base, expiresAt: now }, 10, now)).toMatchObject({ ok: false, reason: 'COUPON_EXPIRED' });
    expect(evaluateCoupon({ ...base, usageLimit: 3, timesUsed: 2 }, 10, now).ok).toBe(true);
    expect(evaluateCoupon({ ...base, usageLimit: 3, timesUsed: 3 }, 10, now)).toMatchObject({ ok: false, reason: 'COUPON_LIMIT' });
  });
});

describe('coupons - admin CRUD', () => {
  it('admin/super_admin only; creates in the apps\' CouponItem shape with derived status; audit rows written', async () => {
    const { a, tok, mk } = await setup();
    const cust = await registerCustomer(a);
    expect((await request(a).get('/v1/admin/coupons')).status).toBe(401);
    expect((await request(a).post('/v1/admin/coupons').set(auth(cust.body.accessToken)).send({})).status).toBe(401);
    const res = await mk({ code: ' eid 2026 ', minSpend: 1000, maxDiscountAmount: 200, usageLimit: 50, expiresAt: future(), timesUsed: 999, usageCount: 999, status: 'expired' });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ id: expect.stringMatching(/^cpn-/), code: 'EID2026', discountPercent: 10, minSpend: 1000, maxDiscountAmount: 200, usageLimit: 50, status: 'active', usageCount: 0, isActive: true, deletedAt: null });
    expect((await request(a).get('/v1/admin/coupons').set(auth(tok))).body).toHaveLength(1);
    expect(await AuditLogModel.countDocuments({ action: 'coupon.create' })).toBe(1);
  });

  it('input validation: percent 0<p<=100, non-negative money, integer limit>=1, sane code, ISO expiry', async () => {
    const { mk } = await setup();
    for (const bad of [{ discountPercent: 0 }, { discountPercent: 101 }, { discountPercent: -5 }, { minSpend: -1 }, { maxDiscountAmount: 0 }, { usageLimit: 0 }, { usageLimit: 1.5 }, { code: 'a' }, { code: 'bad code!' }, { code: '' }, { expiresAt: 'tomorrow' }, { discountPercent: 'ten' }]) {
      const r = await mk(bad);
      expect(r.status, JSON.stringify(bad)).toBe(400);
    }
    expect((await mk({ discountPercent: 100, code: 'FREE100' })).status).toBe(201);
  });

  it('code is unique among live coupons (case/space-insensitive); PATCH edits fields, null clears optionals; code locked once used', async () => {
    const { mk, a, tok } = await setup();
    const c = (await mk({ maxDiscountAmount: 50, usageLimit: 5, expiresAt: future() })).body;
    expect((await mk({ code: 'save 10' })).body.error).toBe('COUPON_CODE_TAKEN');
    const other = (await mk({ code: 'OTHER' })).body;
    expect((await request(a).patch(`/v1/admin/coupons/${other.id}`).set(auth(tok)).send({ code: 'save10' })).body.error).toBe('COUPON_CODE_TAKEN');
    const p = await request(a).patch(`/v1/admin/coupons/${c.id}`).set(auth(tok)).send({ discountPercent: 25, minSpend: 300, maxDiscountAmount: null, usageLimit: null, expiresAt: null, isActive: false, timesUsed: 77 });
    expect(p.status).toBe(200);
    expect(p.body).toMatchObject({ discountPercent: 25, minSpend: 300, isActive: false, status: 'expired', usageCount: 0 });
    for (const k of ['maxDiscountAmount', 'usageLimit', 'expiresAt']) expect(p.body).not.toHaveProperty(k);
    await CouponModel.updateOne({ _id: c.id }, { $set: { timesUsed: 2 } });
    expect((await request(a).patch(`/v1/admin/coupons/${c.id}`).set(auth(tok)).send({ code: 'RENAMED' })).body.error).toBe('COUPON_CODE_LOCKED');
    expect((await request(a).patch(`/v1/admin/coupons/${c.id}`).set(auth(tok)).send({ code: 'save10' })).status).toBe(200); // same code = no change
    expect((await request(a).patch('/v1/admin/coupons/nope').set(auth(tok)).send({ isActive: true })).status).toBe(404);
  });

  it('SOFT DELETE: hidden from the default admin list, ?deleted=include|only shows it, row + usage history stay, code is reusable, restore conflicts if the code was reused', async () => {
    const { mk, a, tok, validate } = await setup();
    const c = (await mk({})).body;
    await CouponModel.updateOne({ _id: c.id }, { $set: { timesUsed: 4 } });
    expect((await request(a).delete(`/v1/admin/coupons/${c.id}`).set(auth(tok))).body).toEqual({ ok: true });
    expect((await request(a).delete(`/v1/admin/coupons/${c.id}`).set(auth(tok))).status).toBe(404);
    expect((await request(a).get('/v1/admin/coupons').set(auth(tok))).body).toEqual([]);
    expect((await request(a).get('/v1/admin/coupons?deleted=include').set(auth(tok))).body).toHaveLength(1);
    const only = (await request(a).get('/v1/admin/coupons?deleted=only').set(auth(tok))).body;
    expect(only[0]).toMatchObject({ id: c.id, usageCount: 4 });
    expect(only[0].deletedAt).toMatch(/^\d{4}-/);
    expect(await CouponModel.countDocuments()).toBe(1);
    expect((await validate('SAVE10', 1000)).body.error).toBe('INVALID_COUPON'); // archived never validates
    expect((await request(a).patch(`/v1/admin/coupons/${c.id}`).set(auth(tok)).send({ isActive: true })).body.error).toBe('COUPON_ARCHIVED');
    expect((await mk({})).status).toBe(201); // code freed
    expect((await request(a).post(`/v1/admin/coupons/${c.id}/restore`).set(auth(tok))).body.error).toBe('COUPON_CODE_TAKEN');
    expect(await AuditLogModel.countDocuments({ action: 'coupon.delete' })).toBe(1);
  });
});

describe('POST /v1/coupons/validate - validation matrix', () => {
  it('valid: returns the storefront shape + computed discount, and does NOT consume a use', async () => {
    const { mk, validate } = await setup();
    await mk({ minSpend: 500, maxDiscountAmount: 80, usageLimit: 2 });
    const r = await validate('  save10 ', 1000);
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ code: 'SAVE10', discountPercent: 10, minSpend: 500, maxDiscountAmount: 80, discountAmount: 80 });
    expect((await validate('SAVE10', 600)).body.discountAmount).toBe(60);
    expect((await CouponModel.findOne())!.timesUsed).toBe(0);
    expect(r.headers['cache-control']).toBe('no-store');
    expect(JSON.stringify(r.body)).not.toMatch(/timesUsed|usageLimit|_id|expiresAt/); // no internals to the public
  });

  it.each([
    ['unknown code', {}, 'NOPE', 1000, 'INVALID_COUPON'],
    ['inactive', { isActive: false }, 'SAVE10', 1000, 'INVALID_COUPON'],
    ['expired', { expiresAt: past() }, 'SAVE10', 1000, 'COUPON_EXPIRED'],
    ['below minimum spend', { minSpend: 1000 }, 'SAVE10', 999.99, 'MIN_SPEND:1000'],
  ])('%s -> 400 %s', async (_n, cfg, code, subtotal, err) => {
    const { mk, validate } = await setup();
    await mk(cfg as Record<string, unknown>);
    const r = await validate(code, subtotal);
    expect(r.status).toBe(400);
    expect(r.body.error).toBe(err);
  });

  it('MIN_SPEND carries the number in the code (storefront contract) and in details', async () => {
    const { mk, validate } = await setup();
    await mk({ minSpend: 1500 });
    expect((await validate('SAVE10', 10)).body).toEqual({ error: 'MIN_SPEND:1500', details: { minSpend: 1500 } });
    expect((await validate('SAVE10', 1500)).status).toBe(200); // boundary
  });

  it('usage limit: exhausted -> COUPON_LIMIT; a limit of N allows exactly N redemptions', async () => {
    const { mk, validate } = await setup();
    await mk({ usageLimit: 2 });
    expect((await validate('SAVE10', 100)).status).toBe(200);
    await redeemCoupon('SAVE10', 100);
    await redeemCoupon('SAVE10', 100);
    expect((await validate('SAVE10', 100)).body.error).toBe('COUPON_LIMIT');
    await expect(redeemCoupon('SAVE10', 100)).rejects.toMatchObject({ code: 'COUPON_LIMIT' });
  });

  it('enableCoupons OFF (the default) -> every code is INVALID_COUPON; turning it on makes the same coupon valid', async () => {
    const { mk, validate, a, tok } = await setup(false);
    await mk({});
    expect((await validate('SAVE10', 1000)).body.error).toBe('INVALID_COUPON');
    await request(a).patch('/v1/admin/settings').set(auth(tok)).send(await withV(a, tok, { enableCoupons: true })).expect(200);
    expect((await validate('SAVE10', 1000)).status).toBe(200);
  });

  it('body validation: missing/negative/non-numeric/NaN subtotal and empty code are 400 VALIDATION_ERROR', async () => {
    const { validate, a } = await setup();
    expect((await validate('X', -1)).body.error).toBe('VALIDATION_ERROR');
    expect((await request(a).post('/v1/coupons/validate').send({ code: 'X' })).body.error).toBe('VALIDATION_ERROR');
    expect((await request(a).post('/v1/coupons/validate').send({ code: 'X', subtotal: '100' })).body.error).toBe('VALIDATION_ERROR');
    expect((await request(a).post('/v1/coupons/validate').send({ code: '', subtotal: 1 })).body.error).toBe('VALIDATION_ERROR');
    expect((await request(a).post('/v1/coupons/validate').send({ code: 'X', subtotal: 1e12 })).body.error).toBe('VALIDATION_ERROR');
  });

  it('codes are not listable publicly (no GET on /v1/coupons) and NoSQL-operator codes are just strings', async () => {
    const { a, mk } = await setup();
    await mk({});
    expect((await request(a).get('/v1/coupons')).status).toBe(404);
    expect((await request(a).post('/v1/coupons/validate').send({ code: { $ne: '' }, subtotal: 100 })).body.error).toBe('VALIDATION_ERROR');
    expect((await request(a).post('/v1/coupons/validate').send({ code: '.*', subtotal: 100 })).body.error).toBe('INVALID_COUPON');
  });

  it('RATE LIMIT: 30 validations / 15 min / IP, the 31st is 429 (and the store is DB-backed)', async () => {
    const a = app(true);
    for (let i = 0; i < 30; i++) expect((await request(a).post('/v1/coupons/validate').send({ code: 'X', subtotal: 1 })).status).toBe(400);
    const r = await request(a).post('/v1/coupons/validate').send({ code: 'X', subtotal: 1 });
    expect(r.status).toBe(429);
    expect(r.body.error).toBe('TOO_MANY_REQUESTS');
  });
});

describe('redeemCoupon - atomic redemption (not wired to any route yet)', () => {
  it('increments timesUsed by exactly one and returns the quote; a failed validation consumes nothing', async () => {
    const { mk } = await setup();
    await mk({ minSpend: 500, maxDiscountAmount: 40 });
    await expect(redeemCoupon('SAVE10', 100)).rejects.toMatchObject({ code: 'MIN_SPEND:500' });
    expect((await CouponModel.findOne())!.timesUsed).toBe(0);
    expect(await redeemCoupon('save10', 1000)).toMatchObject({ code: 'SAVE10', discountAmount: 40 });
    expect((await CouponModel.findOne())!.timesUsed).toBe(1);
  });

  it('CONCURRENCY: 25 parallel redemptions of a coupon with limit 5 succeed exactly 5 times; timesUsed ends at 5, never above', async () => {
    const { mk } = await setup();
    await mk({ usageLimit: 5 });
    const results = await Promise.allSettled(Array.from({ length: 25 }, () => redeemCoupon('SAVE10', 1000)));
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(5);
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    expect(rejected).toHaveLength(20);
    expect(rejected.every((r) => r.reason.code === 'COUPON_LIMIT')).toBe(true);
    expect((await CouponModel.findOne())!.timesUsed).toBe(5);
  });

  it('unlimited coupons count every use; deactivated/expired/archived coupons cannot be redeemed even mid-flight', async () => {
    const { mk } = await setup();
    await mk({});
    await Promise.all(Array.from({ length: 10 }, () => redeemCoupon('SAVE10', 100)));
    expect((await CouponModel.findOne())!.timesUsed).toBe(10);
    await CouponModel.updateOne({}, { $set: { isActive: false } });
    await expect(redeemCoupon('SAVE10', 100)).rejects.toMatchObject({ code: 'INVALID_COUPON' });
    await CouponModel.updateOne({}, { $set: { isActive: true, expiresAt: new Date(Date.now() - 1000) } });
    await expect(redeemCoupon('SAVE10', 100)).rejects.toMatchObject({ code: 'COUPON_EXPIRED' });
    await CouponModel.updateOne({}, { $set: { expiresAt: null, deletedAt: new Date() } });
    await expect(redeemCoupon('SAVE10', 100)).rejects.toMatchObject({ code: 'INVALID_COUPON' });
    expect((await CouponModel.findOne())!.timesUsed).toBe(10);
  });

  it('respects the enableCoupons flag; releaseCoupon gives a use back and never goes below zero', async () => {
    const { mk, a, tok } = await setup();
    await mk({ usageLimit: 1 });
    await request(a).patch('/v1/admin/settings').set(auth(tok)).send(await withV(a, tok, { enableCoupons: false })).expect(200);
    await expect(redeemCoupon('SAVE10', 100)).rejects.toMatchObject({ code: 'INVALID_COUPON' });
    await request(a).patch('/v1/admin/settings').set(auth(tok)).send(await withV(a, tok, { enableCoupons: true })).expect(200);
    await redeemCoupon('SAVE10', 100);
    await expect(validateCoupon('SAVE10', 100)).rejects.toMatchObject({ code: 'COUPON_LIMIT' });
    expect(await releaseCoupon('SAVE10')).toBe(true);
    expect((await validateCoupon('SAVE10', 100)).discountAmount).toBe(10);
    expect(await releaseCoupon('SAVE10')).toBe(false); // already 0: never negative
    expect((await CouponModel.findOne())!.timesUsed).toBe(0);
  });

  it('is called from exactly one place: order creation (Module 5b), inside its transaction', async () => {
    const { execSync } = await import('node:child_process');
    const hits = execSync("grep -rl 'redeemCoupon(' src || true").toString().trim().split('\n').sort();
    expect(hits).toEqual(['src/modules/coupons/coupon.service.ts', 'src/modules/orders/order.service.ts']);
  });
});
