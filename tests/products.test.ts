import mongoose from 'mongoose';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { AuditLogModel } from '../src/modules/audit/audit.model';
import { MediaModel } from '../src/modules/media/media.model';
import { ProductModel } from '../src/modules/products/product.model';
import { addReviewToProductRating } from '../src/modules/products/product.service';
import { applyReviewToRating } from '../src/domain/rating';
import { adminCtx, auth, mkCategory, mkMedia, registerCustomer } from './helpers';

const COST = 987654; // distinctive marker: must never appear in a public response
async function seedCatalogue() {
  const { a, tok } = await adminCtx();
  await mkCategory(a, tok, 'Honey');
  await mkCategory(a, tok, 'Luxury Attar');
  const mk = (b: Record<string, unknown>) => request(a).post('/v1/admin/products').set(auth(tok)).send({ category: 'Honey', description: '', ...b });
  await mk({ name: 'Sundarban Honey', price: 500, stockCount: 10, tags: ['organic', 'sidr'], subcategory: 'Wellness', rating: 4, reviewCount: 3, costPrice: COST }).expect(201);
  await new Promise((r) => setTimeout(r, 5));
  await mk({ name: 'Black Seed Oil', price: 300, stockCount: 0, tags: ['kalojira'], description: 'cold pressed nigella' }).expect(201);
  await new Promise((r) => setTimeout(r, 5));
  await mk({ name: 'Royal Oudh', category: 'Luxury Attar', price: 2500, stockCount: 3, rating: 5, reviewCount: 9 }).expect(201);
  await new Promise((r) => setTimeout(r, 5));
  await mk({ name: 'Cheap Attar', category: 'Luxury Attar', price: 100, stockCount: 50, rating: 3, reviewCount: 1 }).expect(201);
  return { a, tok };
}
const names = (r: request.Response) => (Array.isArray(r.body) ? r.body : r.body.items).map((p: { name: string }) => p.name);

describe('products - admin create/read/update', () => {
  it('creates with the storefront Product shape: derived inStock, stock 0 is valid, category by name, generated slug, server-owned rating', async () => {
    const { a, tok } = await adminCtx();
    await mkCategory(a, tok, 'Honey');
    const res = await request(a).post('/v1/admin/products').set(auth(tok)).send({ name: 'Pure Honey 500g', category: 'honey', price: 450, stockCount: 0, costPrice: 300, badge: 'NEW', sizes: ['500g'], tags: ['x'] });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ id: expect.stringMatching(/^prod-/), slug: 'pure-honey-500g', category: 'Honey', price: 450, stockCount: 0, inStock: false, costPrice: 300, badge: 'NEW', rating: 5, reviewCount: 0, deletedAt: null, image: '', images: [] });
    const upd = await request(a).put(`/v1/admin/products/${res.body.id}`).set(auth(tok)).send({ name: 'Pure Honey 500g', category: 'Honey', price: 450, stockCount: 12 });
    expect(upd.body).toMatchObject({ stockCount: 12, inStock: true });
    expect((await request(a).put(`/v1/admin/products/${res.body.id}`).set(auth(tok)).send({ name: 'Pure Honey 500g', category: 'Honey', price: 450, stockCount: 0 })).body).toMatchObject({ stockCount: 0, inStock: false });
    expect((await AuditLogModel.find({ action: /^product\./ })).length).toBeGreaterThanOrEqual(3);
  });

  it('rejects anonymous/customer writers, bad input, unknown categories and taken ids/slugs; a Bengali-only name gets the id as slug', async () => {
    const { a, tok } = await adminCtx();
    await mkCategory(a, tok, 'Honey');
    const cust = await registerCustomer(a);
    const body = { name: 'P', category: 'Honey', price: 1 };
    expect((await request(a).post('/v1/admin/products').send(body)).status).toBe(401);
    expect((await request(a).post('/v1/admin/products').set(auth(cust.body.accessToken)).send(body)).status).toBe(401);
    const post = (b: object) => request(a).post('/v1/admin/products').set(auth(tok)).send(b);
    expect((await post({ ...body, price: -5 })).body.error).toBe('VALIDATION_ERROR');
    expect((await post({ ...body, name: '' })).body.error).toBe('VALIDATION_ERROR');
    expect((await post({ ...body, stockCount: 1.5 })).status).toBe(400);
    expect((await post({ ...body, category: 'Nope' })).body.error).toBe('CATEGORY_NOT_FOUND');
    expect((await post({ ...body, id: 'prod-fixed-1' })).status).toBe(201);
    expect((await post({ ...body, id: 'prod-fixed-1' })).body.error).toBe('PRODUCT_ID_TAKEN');
    expect((await post({ ...body, slug: 'my-slug' })).status).toBe(201);
    expect((await post({ ...body, slug: 'my-slug' })).body.error).toBe('SLUG_TAKEN');
    expect((await post({ ...body, slug: 'bad slug!' })).body.error).toBe('INVALID_SLUG');
    const twin = await post({ ...body }); // same generated slug "p" as the first one -> numeric suffix, not an error
    expect(twin.status).toBe(201);
    expect(twin.body.slug).toMatch(/^p-\d+$/);
    const bn = await post({ ...body, id: 'prod-bn-1', name: 'খাঁটি মধু' });
    expect(bn.body.slug).toBe('prod-bn-1');
  });

  it('PUT ignores client-supplied rating/reviewCount/inStock, unsets omitted optional numbers, keeps images/landingPage when omitted', async () => {
    const { a, tok } = await adminCtx();
    await mkCategory(a, tok, 'Honey');
    const img = await mkMedia('h1');
    const p = (await request(a).post('/v1/admin/products').set(auth(tok)).send({ name: 'H', category: 'Honey', price: 10, originalPrice: 20, costPrice: 5, stockCount: 4, image: img, images: [img], landingPage: { enabled: true, headline: 'Buy' } })).body;
    const u = await request(a).put(`/v1/admin/products/${p.id}`).set(auth(tok)).send({ name: 'H2', category: 'Honey', price: 11, rating: 1, reviewCount: 999, inStock: false });
    expect(u.body).toMatchObject({ name: 'H2', price: 11, rating: 5, reviewCount: 0, inStock: true, stockCount: 4, image: img, images: [img], landingPage: { enabled: true, headline: 'Buy' } });
    expect(u.body).not.toHaveProperty('originalPrice');
    expect(u.body).not.toHaveProperty('costPrice');
  });

  it('IMAGE REFERENCES must exist in Media; they are stored as {url, publicId} but served as plain URL strings', async () => {
    const { a, tok } = await adminCtx();
    await mkCategory(a, tok, 'Honey');
    const good = await mkMedia('front');
    const g2 = await mkMedia('side');
    const post = (b: object) => request(a).post('/v1/admin/products').set(auth(tok)).send({ name: 'Img', category: 'Honey', price: 1, ...b });
    const bad = await post({ image: 'https://images.unsplash.com/photo-1.jpg', images: [good, 'https://evil.test/x.png'] });
    expect(bad.status).toBe(400);
    expect(bad.body).toMatchObject({ error: 'IMAGE_NOT_REGISTERED', details: { urls: expect.arrayContaining(['https://images.unsplash.com/photo-1.jpg', 'https://evil.test/x.png']) } });
    expect(await ProductModel.countDocuments()).toBe(0);
    const ok = await post({ image: good, images: [good, g2] });
    expect(ok.status).toBe(201);
    expect(ok.body).toMatchObject({ image: good, images: [good, g2] });
    const raw = await mongoose.connection.db!.collection('products').findOne({ _id: ok.body.id as never });
    expect(raw!.image).toEqual({ url: good, publicId: 'albarakah/products/front' });
    expect(raw!.images).toEqual([{ url: good, publicId: 'albarakah/products/front' }, { url: g2, publicId: 'albarakah/products/side' }]);
    // the http:// form of a registered asset resolves to the same secure URL; image defaults to images[0]
    const http = await post({ name: 'Img2', images: [good.replace('https:', 'http:')] });
    expect(http.body).toMatchObject({ image: good, images: [good] });
    // a registered asset cannot be deleted from Media while a product (even an archived one) uses it
    const mediaId = String((await MediaModel.findOne({ publicId: 'albarakah/products/front' }))!._id);
    expect((await request(a).delete(`/v1/admin/media/${mediaId}`).set(auth(tok))).body).toMatchObject({ error: 'MEDIA_IN_USE', details: { usedBy: ['products'] } });
  });
});

describe('products - public reads', () => {
  it('costPrice NEVER appears in any public response (list, paged, single, filtered), but admins get it', async () => {
    const { a, tok } = await seedCatalogue();
    const outputs = [
      await request(a).get('/v1/products'),
      await request(a).get('/v1/products?page=1&limit=2'),
      await request(a).get('/v1/products?search=honey&sort=rating'),
      await request(a).get('/v1/products/sundarban-honey'),
      await request(a).get(`/v1/products/${(await request(a).get('/v1/products?search=honey')).body[0].id}`),
    ];
    for (const r of outputs) {
      expect(r.status).toBe(200);
      const text = JSON.stringify(r.body);
      expect(text).not.toMatch(/costPrice/i);
      expect(text).not.toContain(String(COST));
      expect(text).not.toMatch(/deletedAt|_id|publicId/);
    }
    const adminList = await request(a).get('/v1/admin/products').set(auth(tok));
    expect(adminList.body.find((p: { name: string }) => p.name === 'Sundarban Honey').costPrice).toBe(COST);
    const adminOne = await request(a).get(`/v1/admin/products/${adminList.body[0].id}`).set(auth(tok));
    expect(adminOne.status).toBe(200);
  });

  it('list = plain array in the storefront Product shape (category NAME, URL strings), newest first by default', async () => {
    const { a } = await seedCatalogue();
    const res = await request(a).get('/v1/products');
    expect(Array.isArray(res.body)).toBe(true);
    expect(names(res)).toEqual(['Cheap Attar', 'Royal Oudh', 'Black Seed Oil', 'Sundarban Honey']);
    expect(res.body[3]).toMatchObject({ category: 'Honey', slug: 'sundarban-honey', price: 500, stockCount: 10, inStock: true, rating: 4, reviewCount: 3, tags: ['organic', 'sidr'], subcategory: 'Wellness', image: '', images: [] });
    expect(res.headers['cache-control']).toMatch(/max-age=10/);
  });

  it('filters: category (name / slug / id / All / unknown), search (name, description, tags, subcategory, category name; regex-safe), stock, price range', async () => {
    const { a } = await seedCatalogue();
    const q = async (s: string) => names(await request(a).get(`/v1/products?${s}`)).sort();
    expect(await q('category=Honey')).toEqual(['Black Seed Oil', 'Sundarban Honey']);
    expect(await q('category=luxury-attar')).toEqual(['Cheap Attar', 'Royal Oudh']);
    expect(await q('category=luxury%20attar')).toEqual(['Cheap Attar', 'Royal Oudh']);
    const id = (await request(a).get('/v1/categories')).body[0].id;
    expect(await q(`category=${id}`)).toEqual(['Black Seed Oil', 'Sundarban Honey']);
    expect(await q('category=All')).toHaveLength(4);
    expect(await q('category=Nonexistent')).toEqual([]);
    expect(await q('search=SUNDARBAN')).toEqual(['Sundarban Honey']);
    expect(await q('search=nigella')).toEqual(['Black Seed Oil']); // description
    expect(await q('search=kalojira')).toEqual(['Black Seed Oil']); // tag
    expect(await q('search=wellness')).toEqual(['Sundarban Honey']); // subcategory
    expect(await q('search=luxury')).toEqual(['Cheap Attar', 'Royal Oudh']); // category name
    expect(await q('search=' + encodeURIComponent('(honey'))).toEqual(['Sundarban Honey']); // punctuation ignored by the tokenizer, no 500
    expect(await q('search=' + encodeURIComponent('.*'))).toEqual([]); // no regex semantics anywhere
    expect(await q('search=sundar')).toEqual(['Sundarban Honey']); // prefix fallback: partial / as-you-type (Module 3 regression fix)
    expect(await q('search=SUNDA')).toEqual(['Sundarban Honey']);
    expect(await q('search=kalo')).toEqual(['Black Seed Oil']); // tag prefix
    expect(await q('search=cold%20press')).toEqual(['Black Seed Oil']); // multi-word, description
    expect(await q('search=undarban')).toEqual([]); // prefix of a WORD, not an arbitrary substring
    expect((await ProductModel.collection.indexes()).some((i) => i.name === 'product_search')).toBe(true);
    expect(await q('inStockOnly=true')).toEqual(['Cheap Attar', 'Royal Oudh', 'Sundarban Honey']);
    expect(await q('minPrice=300&maxPrice=500')).toEqual(['Black Seed Oil', 'Sundarban Honey']);
    expect(await q('minPrice=1000')).toEqual(['Royal Oudh']);
    expect(await q('category=Honey&inStockOnly=true&maxPrice=1000')).toEqual(['Sundarban Honey']);
    expect((await request(a).get('/v1/products?minPrice=abc')).status).toBe(400);
    expect((await request(a).get('/v1/products?sort=bogus')).status).toBe(400);
  });

  it('sorting: price-low, price-high, rating, newest; stable and deterministic', async () => {
    const { a } = await seedCatalogue();
    const s = async (v: string) => names(await request(a).get(`/v1/products?sort=${v}`));
    expect(await s('price-low')).toEqual(['Cheap Attar', 'Black Seed Oil', 'Sundarban Honey', 'Royal Oudh']);
    expect(await s('price-high')).toEqual(['Royal Oudh', 'Sundarban Honey', 'Black Seed Oil', 'Cheap Attar']);
    expect(await s('rating')).toEqual(['Royal Oudh', 'Black Seed Oil', 'Sundarban Honey', 'Cheap Attar']); // 5 (newer) , 5 (default), 4, 3
    expect(await s('newest')).toEqual(['Cheap Attar', 'Royal Oudh', 'Black Seed Oil', 'Sundarban Honey']);
  });

  it('pagination returns {items,total,page,limit,totalPages}; single product resolves by id, slug, case-insensitive slug and name-contains (>=3 chars)', async () => {
    const { a } = await seedCatalogue();
    const p1 = await request(a).get('/v1/products?page=1&limit=3&sort=price-low');
    expect(p1.body).toMatchObject({ total: 4, page: 1, limit: 3, totalPages: 2 });
    expect(names(p1)).toEqual(['Cheap Attar', 'Black Seed Oil', 'Sundarban Honey']);
    expect(names(await request(a).get('/v1/products?page=2&limit=3&sort=price-low'))).toEqual(['Royal Oudh']);
    expect(await request(a).get('/v1/products?page=1&limit=2&category=Nope').then((r) => r.body)).toMatchObject({ items: [], total: 0 });
    const id = p1.body.items[0].id;
    expect((await request(a).get(`/v1/products/${id}`)).body.name).toBe('Cheap Attar');
    expect((await request(a).get('/v1/products/ROYAL-OUDH')).body.name).toBe('Royal Oudh');
    expect((await request(a).get('/v1/products/black%20seed')).body.name).toBe('Black Seed Oil');
    expect((await request(a).get('/v1/products/zz')).status).toBe(404);
    expect((await request(a).get('/v1/products/does-not-exist')).status).toBe(404);
  });
});

describe('products - search ranking (text index first, prefix-only after)', () => {
  it('orders whole-word (text) hits before prefix-only hits when no sort is given; an explicit sort overrides; paging works', async () => {
    const { a, tok } = await adminCtx();
    await mkCategory(a, tok, 'Misc');
    const mk = (name: string, price: number) => request(a).post('/v1/admin/products').set(auth(tok)).send({ name, category: 'Misc', price }).expect(201);
    await mk('Oudhwood Prefix Only', 10); // "oud" is only a prefix of "oudhwood"
    await new Promise((r) => setTimeout(r, 5));
    await mk('Royal Oud', 300); // whole word -> text hit, even though older than the next one
    await new Promise((r) => setTimeout(r, 5));
    await mk('Oudh Something', 5); // prefix only, newest
    const ranked = names(await request(a).get('/v1/products?search=oud'));
    expect(ranked).toEqual(['Royal Oud', 'Oudh Something', 'Oudhwood Prefix Only']); // text hit, then prefix-only newest-first
    expect(names(await request(a).get('/v1/products?search=oud&sort=price-low'))).toEqual(['Oudh Something', 'Oudhwood Prefix Only', 'Royal Oud']);
    const p1 = await request(a).get('/v1/products?search=oud&page=1&limit=2');
    expect(p1.body).toMatchObject({ total: 3, totalPages: 2 });
    expect(names(p1)).toEqual(['Royal Oud', 'Oudh Something']);
    expect(names(await request(a).get('/v1/products?search=oud&page=2&limit=2'))).toEqual(['Oudhwood Prefix Only']);
  });
  it('archived products never appear via either search path', async () => {
    const { a, tok } = await adminCtx();
    await mkCategory(a, tok, 'Misc');
    const p = (await request(a).post('/v1/admin/products').set(auth(tok)).send({ name: 'Sundarban Honey', category: 'Misc', price: 1 })).body;
    await request(a).delete(`/v1/admin/products/${p.id}`).set(auth(tok)).expect(200);
    expect(names(await request(a).get('/v1/products?search=sundar'))).toEqual([]);
    expect(names(await request(a).get('/v1/products?search=sundarban'))).toEqual([]);
  });
});

describe('products - SOFT DELETE (deletedAt)', () => {
  it('archived products vanish from every public read but stay visible to admins; restore brings them back; no hard-delete route exists', async () => {
    const { a, tok } = await seedCatalogue();
    const list = (await request(a).get('/v1/products')).body as Array<{ id: string; name: string; slug: string }>;
    const honey = list.find((p) => p.name === 'Sundarban Honey')!;
    expect((await request(a).delete(`/v1/admin/products/${honey.id}`).set(auth(tok))).body).toEqual({ ok: true });

    // public: gone from list / filters / search / single by id, slug and name
    expect(names(await request(a).get('/v1/products'))).not.toContain('Sundarban Honey');
    expect(names(await request(a).get('/v1/products?search=sundarban'))).toEqual([]);
    expect(names(await request(a).get('/v1/products?page=1&limit=10'))).toHaveLength(3);
    for (const key of [honey.id, honey.slug, 'sundarban']) expect((await request(a).get(`/v1/products/${key}`)).status).toBe(404);

    // admin: still there, flagged, and filterable
    expect((await request(a).get('/v1/admin/products').set(auth(tok))).body).toHaveLength(3); // default: archived hidden
    const adm = (await request(a).get('/v1/admin/products?deleted=include').set(auth(tok))).body as Array<{ name: string; deletedAt: string | null }>;
    expect(adm).toHaveLength(4);
    expect(adm.find((p) => p.name === 'Sundarban Honey')!.deletedAt).toMatch(/^\d{4}-/);
    expect((await request(a).get('/v1/admin/products?deleted=exclude').set(auth(tok))).body).toHaveLength(3);
    expect((await request(a).get('/v1/admin/products?deleted=only').set(auth(tok))).body.map((p: { name: string }) => p.name)).toEqual(['Sundarban Honey']);
    expect((await request(a).get(`/v1/admin/products/${honey.id}`).set(auth(tok))).body.deletedAt).toBeTruthy();
    // the row physically remains
    expect(await ProductModel.countDocuments()).toBe(4);
    // deleting twice is a 404; the slug stays reserved for the archived product
    expect((await request(a).delete(`/v1/admin/products/${honey.id}`).set(auth(tok))).status).toBe(404);
    expect((await request(a).post('/v1/admin/products').set(auth(tok)).send({ name: 'Other', category: 'Honey', price: 1, slug: honey.slug })).body.error).toBe('SLUG_TAKEN');

    const back = await request(a).post(`/v1/admin/products/${honey.id}/restore`).set(auth(tok));
    expect(back.status).toBe(200);
    expect(back.body.deletedAt).toBeNull();
    expect(names(await request(a).get('/v1/products'))).toContain('Sundarban Honey');
    expect((await request(a).post(`/v1/admin/products/${honey.id}/restore`).set(auth(tok))).status).toBe(404); // not archived

    // no hard delete anywhere: unknown verbs/paths are not routes
    expect((await request(a).delete(`/v1/admin/products/${honey.id}?hard=true`).set(auth(tok))).status).toBe(200); // still only a soft delete
    expect(await ProductModel.countDocuments()).toBe(4);
    expect(await AuditLogModel.countDocuments({ action: 'product.delete' })).toBe(2);
  });
});

describe('products - rating aggregate (Phase 1/2 fixed rule, now server-side)', () => {
  it('addReviewToProductRating matches applyReviewToRating step by step', async () => {
    const { a, tok } = await adminCtx();
    await mkCategory(a, tok, 'Honey');
    const p = (await request(a).post('/v1/admin/products').set(auth(tok)).send({ name: 'R', category: 'Honey', price: 1, rating: 5, reviewCount: 1 })).body;
    let expected = { rating: 5, reviewCount: 1 };
    for (const r of [3, 4, 4, 1, 5, 2]) {
      await addReviewToProductRating(p.id, r);
      expected = applyReviewToRating(expected.rating, expected.reviewCount, r);
      const got = (await request(a).get(`/v1/products/${p.id}`)).body;
      expect({ rating: got.rating, reviewCount: got.reviewCount }).toEqual(expected);
    }
    expect(expected.reviewCount).toBe(7);
  });

  it('is ATOMIC: 10 concurrent reviews never lose an update', async () => {
    const { a, tok } = await adminCtx();
    await mkCategory(a, tok, 'Honey');
    const p = (await request(a).post('/v1/admin/products').set(auth(tok)).send({ name: 'R', category: 'Honey', price: 1, rating: 4, reviewCount: 2 })).body;
    await Promise.all(Array.from({ length: 10 }, () => addReviewToProductRating(p.id, 5)));
    const got = (await request(a).get(`/v1/products/${p.id}`)).body;
    expect(got.reviewCount).toBe(12);
    expect(got.rating).toBeGreaterThan(4);
    expect(got.rating).toBeLessThanOrEqual(5);
  });
});
