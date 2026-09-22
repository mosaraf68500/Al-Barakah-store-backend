import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { AuditLogModel } from '../src/modules/audit/audit.model';
import { CategoryModel } from '../src/modules/categories/category.model';
import { ProductModel } from '../src/modules/products/product.model';
import { adminCtx, app, auth, mkCategory, mkMedia, registerCustomer } from './helpers';

describe('categories - public read', () => {
  it('lists ALL categories (enabled + disabled) sorted by order, in the storefront CategoryItem shape', async () => {
    const { a, tok } = await adminCtx();
    const img = await mkMedia('honey', 'categories');
    await mkCategory(a, tok, 'Honey', { image: img, badge: 'HOT' });
    await mkCategory(a, tok, 'Attar', { enabled: false });
    const res = await request(a).get('/v1/categories');
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toMatch(/public/);
    expect(res.body).toEqual([
      { id: expect.stringMatching(/^cat-/), name: 'Honey', slug: 'honey', image: img, enabled: true, badge: 'HOT', order: 0 },
      { id: expect.stringMatching(/^cat-/), name: 'Attar', slug: 'attar', image: '', enabled: false, order: 1 },
    ]);
    expect(JSON.stringify(res.body)).not.toMatch(/publicId|_id|createdAt/);
  });
});

describe('categories - admin CRUD', () => {
  it('writes need admin/super_admin (anonymous + customer are rejected) and every write returns the full updated list', async () => {
    const { a, tok } = await adminCtx();
    const cust = await registerCustomer(a);
    for (const [m, p] of [['post', '/v1/admin/categories'], ['put', '/v1/admin/categories'], ['patch', '/v1/admin/categories/x'], ['delete', '/v1/admin/categories/x'], ['get', '/v1/admin/categories']] as const) {
      expect((await request(a)[m](p).send({})).status).toBe(401);
      expect((await request(a)[m](p).set(auth(cust.body.accessToken)).send({})).status).toBe(401);
    }
    const created = await request(a).post('/v1/admin/categories').set(auth(tok)).send({ name: 'Dates' });
    expect(created.status).toBe(201);
    expect(created.body).toHaveLength(1);
    expect((await AuditLogModel.findOne({ action: 'category.create' }))!.details).toMatchObject({ name: 'Dates' });
  });

  it('name + slug are unique (case-insensitive); slug is generated (or falls back to the id for non-latin names); images must be registered Media', async () => {
    const { a, tok } = await adminCtx();
    await mkCategory(a, tok, 'Organic Foods');
    expect((await request(a).post('/v1/admin/categories').set(auth(tok)).send({ name: 'organic foods' })).body.error).toBe('CATEGORY_NAME_TAKEN');
    expect((await request(a).post('/v1/admin/categories').set(auth(tok)).send({ name: 'Other', slug: 'organic-foods' })).body.error).toBe('CATEGORY_SLUG_TAKEN');
    const bn = await request(a).post('/v1/admin/categories').set(auth(tok)).send({ id: 'cat-bn-1', name: 'খাঁটি মধু' });
    expect(bn.body.find((c: { name: string }) => c.name === 'খাঁটি মধু').slug).toBe('cat-bn-1');
    const bad = await request(a).post('/v1/admin/categories').set(auth(tok)).send({ name: 'Pic', image: 'https://images.unsplash.com/x.jpg' });
    expect(bad.status).toBe(400);
    expect(bad.body).toMatchObject({ error: 'IMAGE_NOT_REGISTERED', details: { urls: ['https://images.unsplash.com/x.jpg'] } });
    expect((await request(a).post('/v1/admin/categories').set(auth(tok)).send({ name: '' })).body.error).toBe('VALIDATION_ERROR');
  });

  it('PATCH renames/toggles; the stored products follow the rename automatically (they reference categoryId)', async () => {
    const { a, tok } = await adminCtx();
    const cat = await mkCategory(a, tok, 'Old Name');
    await request(a).post('/v1/admin/products').set(auth(tok)).send({ name: 'P1', category: 'Old Name', price: 10 }).expect(201);
    const res = await request(a).patch(`/v1/admin/categories/${cat.id}`).set(auth(tok)).send({ name: 'New Name', enabled: false });
    expect(res.status).toBe(200);
    expect(res.body[0]).toMatchObject({ name: 'New Name', enabled: false });
    const prods = (await request(a).get('/v1/products')).body;
    expect(prods[0].category).toBe('New Name');
    expect((await request(a).patch('/v1/admin/categories/cat-nope').set(auth(tok)).send({ name: 'x' })).status).toBe(404);
  });
});

describe('categories - BLOCK DELETE when products exist (legacy rule, BUG_FIXES A12)', () => {
  it('409 with the Bengali message and the product count; nothing is deleted', async () => {
    const { a, tok } = await adminCtx();
    const cat = await mkCategory(a, tok, 'Honey');
    await request(a).post('/v1/admin/products').set(auth(tok)).send({ name: 'P1', category: 'Honey', price: 10 }).expect(201);
    await request(a).post('/v1/admin/products').set(auth(tok)).send({ name: 'P2', category: 'Honey', price: 10 }).expect(201);
    const res = await request(a).delete(`/v1/admin/categories/${cat.id}`).set(auth(tok));
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('CATEGORY_HAS_PRODUCTS');
    expect(res.body.message).toBe('এই ক্যাটাগরিতে 2 টি প্রোডাক্ট আছে। আগে প্রোডাক্টগুলো অন্য ক্যাটাগরিতে সরান, তারপর ডিলিট করুন।');
    expect(res.body.details.productCount).toBe(2);
    expect(await CategoryModel.countDocuments()).toBe(1);
  });

  it('archived (soft-deleted) products still block; after moving/removing them the delete works and order is renumbered', async () => {
    const { a, tok } = await adminCtx();
    const c1 = await mkCategory(a, tok, 'One');
    await mkCategory(a, tok, 'Two');
    const c3 = await mkCategory(a, tok, 'Three');
    const p = (await request(a).post('/v1/admin/products').set(auth(tok)).send({ name: 'P', category: 'One', price: 10 })).body;
    await request(a).delete(`/v1/admin/products/${p.id}`).set(auth(tok)).expect(200); // archived, still references the category
    expect((await request(a).delete(`/v1/admin/categories/${c1.id}`).set(auth(tok))).status).toBe(409);
    await request(a).put(`/v1/admin/products/${p.id}`).set(auth(tok)).send({ name: 'P', category: 'Two', price: 10 }).expect(409); // archived: restore first
    await request(a).post(`/v1/admin/products/${p.id}/restore`).set(auth(tok)).expect(200);
    await request(a).put(`/v1/admin/products/${p.id}`).set(auth(tok)).send({ name: 'P', category: 'Two', price: 10 }).expect(200);
    const del = await request(a).delete(`/v1/admin/categories/${c1.id}`).set(auth(tok));
    expect(del.status).toBe(200);
    expect(del.body.map((c: { name: string; order: number }) => [c.name, c.order])).toEqual([['Two', 0], ['Three', 1]]);
    expect((await request(a).delete(`/v1/admin/categories/${c3.id}`).set(auth(tok))).status).toBe(200);
    expect((await request(a).delete(`/v1/admin/categories/${c3.id}`).set(auth(tok))).status).toBe(404);
  });
});

describe('categories - bulk PUT (reorder / all on-off / reset)', () => {
  it('reorders, toggles all, creates new ids, deletes removed rows, and supports swapping names', async () => {
    const { a, tok } = await adminCtx();
    const a1 = await mkCategory(a, tok, 'A');
    const b1 = await mkCategory(a, tok, 'B');
    const list = (await request(a).get('/v1/admin/categories').set(auth(tok))).body as Array<Record<string, unknown>>;
    // reorder + toggle all off
    const r1 = await request(a).put('/v1/admin/categories').set(auth(tok)).send({ categories: [{ ...list[1], enabled: false }, { ...list[0], enabled: false }] });
    expect(r1.body.map((c: { name: string; order: number; enabled: boolean }) => [c.name, c.order, c.enabled])).toEqual([['B', 0, false], ['A', 1, false]]);
    // swap the two names in one request (would collide without the two-phase write)
    const r2 = await request(a).put('/v1/admin/categories').set(auth(tok)).send({ categories: [{ id: a1.id, name: 'B', slug: 'b' }, { id: b1.id, name: 'A', slug: 'a' }] });
    expect(r2.status).toBe(200);
    expect(r2.body.map((c: { id: string; name: string }) => [c.id, c.name])).toEqual([[a1.id, 'B'], [b1.id, 'A']]);
    // add a new one (no id) and drop 'A' (no products) in the same request
    const r3 = await request(a).put('/v1/admin/categories').set(auth(tok)).send({ categories: [{ id: a1.id, name: 'B' }, { name: 'Fresh' }] });
    expect(r3.body.map((c: { name: string }) => c.name)).toEqual(['B', 'Fresh']);
    expect(await CategoryModel.countDocuments()).toBe(2);
  });

  it('is all-or-nothing: removing a category that has products refuses the WHOLE request and changes nothing', async () => {
    const { a, tok } = await adminCtx();
    const keep = await mkCategory(a, tok, 'Keep');
    await mkCategory(a, tok, 'Used');
    await request(a).post('/v1/admin/products').set(auth(tok)).send({ name: 'P', category: 'Used', price: 1 }).expect(201);
    const res = await request(a).put('/v1/admin/categories').set(auth(tok)).send({ categories: [{ id: keep.id, name: 'Renamed', enabled: false }, { name: 'Brand New' }] });
    expect(res.status).toBe(409);
    expect((await CategoryModel.find().sort({ order: 1 }).lean()).map((c) => [c.name, c.enabled])).toEqual([['Keep', true], ['Used', true]]);
    expect((await request(a).put('/v1/admin/categories').set(auth(tok)).send({ categories: [{ id: 'cat-x', name: 'A' }, { id: 'cat-x', name: 'B' }] })).body.error).toBe('DUPLICATE_CATEGORY_ID');
  });
});
void app; void ProductModel;
