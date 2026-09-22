import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { applyReviewToRating } from '../src/domain/rating';
import { AuditLogModel } from '../src/modules/audit/audit.model';
import { ProductModel } from '../src/modules/products/product.model';
import { ReviewModel } from '../src/modules/reviews/review.model';
import { adminCtx, app, auth, mkProduct, patchSettings, registerCustomer } from './helpers';

let seq = 70_000_000;
const nextPhone = () => `019${String(seq++).padStart(8, '0')}`;
const relaxCod = (a: ReturnType<typeof app>, tok: string) => patchSettings(a, tok, { deliveryConfig: { requireAdvanceDeliveryCharge: false } });

async function customer(a: ReturnType<typeof app>) {
  const res = await registerCustomer(a, { phone: nextPhone() });
  return { token: res.body.accessToken as string, id: res.body.user.id as string, name: res.body.user.name as string };
}
/** Places an order for `productId` as the given customer token and walks it (as admin) all the way to `delivered`. */
async function deliverOrderFor(a: ReturnType<typeof app>, tok: string, adminTok: string, productId: string) {
  await relaxCod(a, adminTok);
  const order = await request(a).post('/v1/orders').set(auth(tok)).send({
    items: [{ productId, quantity: 1 }], customer: { fullName: 'Buyer', phone: nextPhone(), address: 'a', city: 'Inside Dhaka' }, paymentChoice: 'FULL_COD',
  });
  const id = order.body.order.id;
  for (const status of ['processing', 'shipped', 'delivered']) await request(a).patch(`/v1/admin/orders/${id}`).set(auth(adminTok)).send({ status }).expect(200);
  return id;
}
const productOf = async (a: ReturnType<typeof app>, id: string) => (await request(a).get(`/v1/products/${id}`)).body;

describe('reviews - public read', () => {
  it('empty by default, filters by productId, only approved+non-deleted, newest first, cached', async () => {
    const { a, tok } = await adminCtx();
    const p1 = await mkProduct(a, tok);
    const p2 = await mkProduct(a, tok);
    expect((await request(a).get('/v1/reviews')).body).toEqual([]);

    const c1 = await customer(a);
    const c2 = await customer(a);
    await request(a).post('/v1/reviews').set(auth(c1.token)).send({ productId: p1.id, rating: 5, comment: 'Great!' }).expect(201);
    await new Promise((r) => setTimeout(r, 5));
    await request(a).post('/v1/reviews').set(auth(c2.token)).send({ productId: p1.id, rating: 3, comment: 'Okay' }).expect(201);
    await request(a).post('/v1/reviews').set(auth(c1.token)).send({ productId: p2.id, rating: 4, comment: 'For p2' }).expect(201);

    const all = await request(a).get('/v1/reviews');
    expect(all.body).toHaveLength(3);
    expect(all.headers['cache-control']).toMatch(/public/);
    const forP1 = await request(a).get(`/v1/reviews?productId=${p1.id}`);
    expect(forP1.body.map((r: { comment: string }) => r.comment)).toEqual(['Okay', 'Great!']); // newest first
    expect(forP1.body[0]).toMatchObject({ productId: p1.id, rating: 3, comment: 'Okay', verifiedPurchase: false });
    expect(forP1.body[0]).not.toHaveProperty('userId');
    expect(forP1.body[0]).not.toHaveProperty('approved');
  });

  it('paginated when both page and limit are given, plain array otherwise', async () => {
    const { a, tok } = await adminCtx();
    const p = await mkProduct(a, tok);
    for (let i = 0; i < 3; i++) {
      const c = await customer(a);
      await request(a).post('/v1/reviews').set(auth(c.token)).send({ productId: p.id, rating: 5, comment: `r${i}` }).expect(201);
    }
    const paged = await request(a).get(`/v1/reviews?productId=${p.id}&page=1&limit=2`);
    expect(paged.body).toMatchObject({ total: 3, page: 1, limit: 2, totalPages: 2 });
    expect(paged.body.items).toHaveLength(2);
    expect(Array.isArray((await request(a).get(`/v1/reviews?productId=${p.id}`)).body)).toBe(true);
  });
});

describe('reviews - creation requires login (Phase 4 contract change, BACKEND_PLAN Q22)', () => {
  it('anonymous is rejected; an unknown/archived product is 404; validation matrix', async () => {
    const { a, tok } = await adminCtx();
    const p = await mkProduct(a, tok);
    await request(a).delete(`/v1/admin/products/${p.id}`).set(auth(tok)).expect(200);
    const c = await customer(a);
    expect((await request(a).post('/v1/reviews').send({ productId: p.id, rating: 5, comment: 'x' })).status).toBe(401);
    for (const bad of [{ rating: 0 }, { rating: 6 }, { rating: 5, comment: '' }, { rating: 2.5 }]) {
      expect((await request(a).post('/v1/reviews').set(auth(c.token)).send({ productId: p.id, comment: 'x', ...bad })).body.error).toBe('VALIDATION_ERROR');
    }
    expect((await request(a).post('/v1/reviews').set(auth(c.token)).send({ productId: p.id, rating: 5, comment: 'x' })).status).toBe(404); // archived
    expect((await request(a).post('/v1/reviews').set(auth(c.token)).send({ productId: 'prod-ghost', rating: 5, comment: 'x' })).status).toBe(404);
  });

  it('is refused (403) when settings.enableCustomerReviews is off', async () => {
    const { a, tok } = await adminCtx();
    const p = await mkProduct(a, tok);
    await patchSettings(a, tok, { enableCustomerReviews: false });
    const c = await customer(a);
    const r = await request(a).post('/v1/reviews').set(auth(c.token)).send({ productId: p.id, rating: 5, comment: 'x' });
    expect(r.status).toBe(403);
    expect(r.body.error).toBe('REVIEWS_DISABLED');
  });

  it('verifiedPurchase is computed server-side from a DELIVERED order - never trusted from the client (legacy always faked true)', async () => {
    const { a, tok } = await adminCtx();
    const p = await mkProduct(a, tok);
    const buyer = await customer(a);
    const stranger = await customer(a);
    await deliverOrderFor(a, buyer.token, tok, p.id);

    const fromBuyer = await request(a).post('/v1/reviews').set(auth(buyer.token)).send({ productId: p.id, rating: 5, comment: 'Bought it, love it', verifiedPurchase: false });
    expect(fromBuyer.body.verifiedPurchase).toBe(true); // true despite the client sending false
    const fromStranger = await request(a).post('/v1/reviews').set(auth(stranger.token)).send({ productId: p.id, rating: 5, comment: 'Never bought this', verifiedPurchase: true });
    expect(fromStranger.body.verifiedPurchase).toBe(false); // false despite the client sending true
  });

  it('ONE REVIEW PER CUSTOMER PER PRODUCT (new rule - legacy enforced none at all, anonymous free-text form): a second attempt is 409; a different product is fine', async () => {
    const { a, tok } = await adminCtx();
    const p1 = await mkProduct(a, tok);
    const p2 = await mkProduct(a, tok);
    const c = await customer(a);
    await request(a).post('/v1/reviews').set(auth(c.token)).send({ productId: p1.id, rating: 4, comment: 'first' }).expect(201);
    const dup = await request(a).post('/v1/reviews').set(auth(c.token)).send({ productId: p1.id, rating: 2, comment: 'again' });
    expect(dup.status).toBe(409);
    expect(dup.body.error).toBe('ALREADY_REVIEWED');
    expect(await ReviewModel.countDocuments({ productId: p1.id })).toBe(1);
    expect((await request(a).post('/v1/reviews').set(auth(c.token)).send({ productId: p2.id, rating: 5, comment: 'other product' })).status).toBe(201);
  });

  it('after an admin deletes (moderates away) a review, the same customer CAN write a new one for that product', async () => {
    const { a, tok } = await adminCtx();
    const p = await mkProduct(a, tok);
    const c = await customer(a);
    const first = await request(a).post('/v1/reviews').set(auth(c.token)).send({ productId: p.id, rating: 4, comment: 'first' });
    await request(a).delete(`/v1/admin/reviews/${first.body.id}`).set(auth(tok)).expect(200);
    const second = await request(a).post('/v1/reviews').set(auth(c.token)).send({ productId: p.id, rating: 5, comment: 'second try' });
    expect(second.status).toBe(201);
  });
});

describe('reviews - rating recalculation (Module 3\'s fixed logic, now actually wired in)', () => {
  it('each new review updates product.rating/reviewCount exactly per applyReviewToRating, atomically', async () => {
    const { a, tok } = await adminCtx();
    const p = await mkProduct(a, tok, { rating: 5, reviewCount: 0 });
    let expected = { rating: 5, reviewCount: 0 };
    for (const stars of [4, 3, 5, 2]) {
      const c = await customer(a);
      await request(a).post('/v1/reviews').set(auth(c.token)).send({ productId: p.id, rating: stars, comment: `stars=${stars}` }).expect(201);
      expected = applyReviewToRating(expected.rating, expected.reviewCount, stars);
      const prod = await productOf(a, p.id);
      expect({ rating: prod.rating, reviewCount: prod.reviewCount }).toEqual(expected);
    }
  });

  it('10 concurrent reviews from 10 different customers never lose an update (reuses the atomic pipeline)', async () => {
    const { a, tok } = await adminCtx();
    const p = await mkProduct(a, tok, { rating: 4, reviewCount: 2 });
    const customers = await Promise.all(Array.from({ length: 10 }, () => customer(a)));
    await Promise.all(customers.map((c) => request(a).post('/v1/reviews').set(auth(c.token)).send({ productId: p.id, rating: 5, comment: 'concurrent' })));
    const prod = await productOf(a, p.id);
    expect(prod.reviewCount).toBe(12);
    expect(prod.rating).toBeGreaterThan(4);
    expect(prod.rating).toBeLessThanOrEqual(5);
  });

  it('deleting a review UN-DOES its contribution to the rating (the exact inverse, domain/rating.ts removeReviewFromRating)', async () => {
    const { a, tok } = await adminCtx();
    const p = await mkProduct(a, tok, { rating: 5, reviewCount: 0 });
    const c1 = await customer(a);
    const c2 = await customer(a);
    const r1 = await request(a).post('/v1/reviews').set(auth(c1.token)).send({ productId: p.id, rating: 3, comment: 'r1' });
    await request(a).post('/v1/reviews').set(auth(c2.token)).send({ productId: p.id, rating: 5, comment: 'r2' });
    const afterBoth = await productOf(a, p.id);
    expect(afterBoth).toMatchObject({ reviewCount: 2 }); // rating = round1((3+5)/2) = 4

    await request(a).delete(`/v1/admin/reviews/${r1.body.id}`).set(auth(tok)).expect(200);
    const afterDelete = await productOf(a, p.id);
    expect(afterDelete).toMatchObject({ rating: 5, reviewCount: 1 }); // only r2 (5 stars) remains

    // and deleting the LAST remaining review resets to the creation baseline (5 / 0)
    const r2list = await request(a).get(`/v1/reviews?productId=${p.id}`);
    await request(a).delete(`/v1/admin/reviews/${r2list.body[0].id}`).set(auth(tok)).expect(200);
    expect(await productOf(a, p.id)).toMatchObject({ rating: 5, reviewCount: 0 });
  });
});

describe('reviews - admin moderation', () => {
  it('auth required for list and delete', async () => {
    const { a, tok } = await adminCtx();
    const p = await mkProduct(a, tok);
    const c = await customer(a);
    const r = await request(a).post('/v1/reviews').set(auth(c.token)).send({ productId: p.id, rating: 5, comment: 'x' });
    expect((await request(a).get('/v1/admin/reviews')).status).toBe(401);
    expect((await request(a).get('/v1/admin/reviews').set(auth(c.token))).status).toBe(401);
    expect((await request(a).delete(`/v1/admin/reviews/${r.body.id}`)).status).toBe(401);
    expect((await request(a).delete(`/v1/admin/reviews/${r.body.id}`).set(auth(c.token))).status).toBe(401);
  });

  it('list is full and unmasked (userId, approved, deletedAt); soft-delete excludes it by default, ?deleted=only shows it, the row survives', async () => {
    const { a, tok } = await adminCtx();
    const p = await mkProduct(a, tok);
    const c = await customer(a);
    const r = await request(a).post('/v1/reviews').set(auth(c.token)).send({ productId: p.id, rating: 5, comment: 'to be moderated' });
    const listed = await request(a).get('/v1/admin/reviews').set(auth(tok));
    expect(listed.body[0]).toMatchObject({ id: r.body.id, userId: c.id, approved: true, deletedAt: null });

    const del = await request(a).delete(`/v1/admin/reviews/${r.body.id}`).set(auth(tok));
    expect(del.body).toEqual({ ok: true });
    expect((await request(a).get('/v1/admin/reviews').set(auth(tok))).body).toEqual([]);
    const only = await request(a).get('/v1/admin/reviews?deleted=only').set(auth(tok));
    expect(only.body[0].deletedAt).toMatch(/^\d{4}-/);
    expect(await ReviewModel.countDocuments()).toBe(1); // row still exists, just flagged
    expect((await request(a).get('/v1/reviews')).body).toEqual([]); // and gone from the public list

    expect((await request(a).delete(`/v1/admin/reviews/${r.body.id}`).set(auth(tok))).status).toBe(404); // already deleted
    expect((await request(a).delete('/v1/admin/reviews/rev-ghost').set(auth(tok))).status).toBe(404);
    expect(await AuditLogModel.findOne({ action: 'review.delete', entityId: r.body.id })).toBeTruthy();
  });
});
