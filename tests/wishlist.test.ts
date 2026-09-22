import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { adminCtx, app, auth, mkProduct, registerCustomer } from './helpers';

let seq = 60_000_000;
const nextPhone = () => `014${String(seq++).padStart(8, '0')}`;
async function customer(a: ReturnType<typeof app>) {
  const res = await registerCustomer(a, { phone: nextPhone() });
  return res.body.accessToken as string;
}

describe('wishlist (BACKEND_PLAN §2.13/§3.1, Q11 confirmed GO) - contract built from the plan spec, since al-barakah-frontend has no lib/api/wishlist.ts yet (local Zustand only)', () => {
  it('empty by default; requires customer auth', async () => {
    const { a, tok } = await adminCtx();
    const p = await mkProduct(a, tok);
    const c = await customer(a);
    expect((await request(a).get('/v1/wishlist').set(auth(c))).body).toEqual([]);
    expect((await request(a).get('/v1/wishlist')).status).toBe(401);
    expect((await request(a).post(`/v1/wishlist/${p.id}`)).status).toBe(401);
  });

  it('POST toggles - matches the frontend Zustand store\'s own toggle() semantics: {added:true} then {added:false}', async () => {
    const { a, tok } = await adminCtx();
    const p = await mkProduct(a, tok);
    const c = await customer(a);
    const added = await request(a).post(`/v1/wishlist/${p.id}`).set(auth(c));
    expect(added.status).toBe(200);
    expect(added.body).toEqual({ added: true });
    expect((await request(a).get('/v1/wishlist').set(auth(c))).body.map((x: { id: string }) => x.id)).toEqual([p.id]);

    const removed = await request(a).post(`/v1/wishlist/${p.id}`).set(auth(c));
    expect(removed.body).toEqual({ added: false });
    expect((await request(a).get('/v1/wishlist').set(auth(c))).body).toEqual([]);
  });

  it('DELETE explicitly removes (idempotent - a second delete is still ok, not a 404)', async () => {
    const { a, tok } = await adminCtx();
    const p = await mkProduct(a, tok);
    const c = await customer(a);
    await request(a).post(`/v1/wishlist/${p.id}`).set(auth(c)).expect(200);
    expect((await request(a).delete(`/v1/wishlist/${p.id}`).set(auth(c))).body).toEqual({ ok: true });
    expect((await request(a).get('/v1/wishlist').set(auth(c))).body).toEqual([]);
    expect((await request(a).delete(`/v1/wishlist/${p.id}`).set(auth(c))).status).toBe(200); // idempotent
  });

  it('an unknown or archived product 404s on toggle; list is per-customer (no cross-account leakage); shape has no costPrice', async () => {
    const { a, tok } = await adminCtx();
    const p1 = await mkProduct(a, tok, { costPrice: 999 });
    const p2 = await mkProduct(a, tok);
    await request(a).delete(`/v1/admin/products/${p2.id}`).set(auth(tok)).expect(200); // archive it
    const c1 = await customer(a);
    const c2 = await customer(a);
    expect((await request(a).post(`/v1/wishlist/${p2.id}`).set(auth(c1))).status).toBe(404);
    expect((await request(a).post(`/v1/wishlist/prod-ghost`).set(auth(c1))).status).toBe(404);

    await request(a).post(`/v1/wishlist/${p1.id}`).set(auth(c1)).expect(200);
    expect((await request(a).get('/v1/wishlist').set(auth(c2))).body).toEqual([]); // c2 sees nothing
    const list1 = await request(a).get('/v1/wishlist').set(auth(c1));
    expect(list1.body).toHaveLength(1);
    expect(list1.body[0]).toMatchObject({ id: p1.id, category: expect.any(String) });
    expect(JSON.stringify(list1.body)).not.toMatch(/costPrice/i);
  });

  it('a wishlisted product that is later archived silently drops from the list, then reappears if restored', async () => {
    const { a, tok } = await adminCtx();
    const p = await mkProduct(a, tok);
    const c = await customer(a);
    await request(a).post(`/v1/wishlist/${p.id}`).set(auth(c)).expect(200);
    await request(a).delete(`/v1/admin/products/${p.id}`).set(auth(tok)).expect(200);
    expect((await request(a).get('/v1/wishlist').set(auth(c))).body).toEqual([]);
    await request(a).post(`/v1/admin/products/${p.id}/restore`).set(auth(tok)).expect(200);
    expect((await request(a).get('/v1/wishlist').set(auth(c))).body.map((x: { id: string }) => x.id)).toEqual([p.id]);
  });
});
