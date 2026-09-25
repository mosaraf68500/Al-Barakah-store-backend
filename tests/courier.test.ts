import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { resetEnvCacheForTests } from '../src/config/env';
import { isAllowedCourierHost } from '../src/modules/courier/hostAllowList';
import { dispatchToSteadfast } from '../src/modules/courier/steadfast';
import { dispatchToPathao } from '../src/modules/courier/pathao';
import { OrderModel } from '../src/modules/orders/order.model';
import { ProductModel } from '../src/modules/products/product.model';
import { adminCtx, app, auth, orderAuth, mkProduct, patchSettings } from './helpers';

let seq = 80_000_000;
const nextPhone = () => `016${String(seq++).padStart(8, '0')}`;
const relaxCod = (a: ReturnType<typeof app>, tok: string) => patchSettings(a, tok, { deliveryConfig: { requireAdvanceDeliveryCharge: false } });
const stockOf = async (id: string) => (await ProductModel.findById(id).lean())!.stockCount;
const savedEnv: Record<string, string | undefined> = {};
function useEnv(env: Record<string, string | undefined>) {
  for (const [k, v] of Object.entries(env)) {
    if (!(k in savedEnv)) savedEnv[k] = process.env[k];
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  resetEnvCacheForTests();
}
function restoreEnv() {
  for (const [k, v] of Object.entries(savedEnv)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; delete savedEnv[k]; }
  resetEnvCacheForTests();
}
async function withFetch<T>(impl: typeof fetch, fn: () => Promise<T>): Promise<T> {
  const orig = globalThis.fetch;
  globalThis.fetch = impl;
  try { return await fn(); } finally { globalThis.fetch = orig; }
}
const jsonResponse = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

async function place(a: ReturnType<typeof app>, tok: string, over: Record<string, unknown> = {}) {
  await relaxCod(a, tok);
  const p = await mkProduct(a, tok, { price: 1000, stockCount: 5 });
  const res = await request(a).post('/v1/orders').set(await orderAuth(a)).send({
    items: [{ productId: p.id, quantity: 1 }], customer: { fullName: 'Rafiq Islam', phone: nextPhone(), address: '4/B Dhanmondi', city: 'Inside Dhaka' }, paymentChoice: 'FULL_COD', ...over,
  });
  return { order: (await OrderModel.findById(res.body.order.id))!, product: p };
}
const withSteadfast = (a: ReturnType<typeof app>, tok: string, baseUrl = 'https://portal.steadfast.com.bd') =>
  patchSettings(a, tok, { courierConfig: { steadfast: { enabled: true, baseUrl, apiKey: 'SF_KEY', secretKey: 'SF_SECRET' }, defaultCourier: 'steadfast' } });
const withPathao = (a: ReturnType<typeof app>, tok: string, baseUrl = 'https://api-hermes.pathao.com') =>
  patchSettings(a, tok, { courierConfig: { pathao: { enabled: true, baseUrl, storeId: '999', clientId: 'PC_ID', clientSecret: 'PC_SECRET', username: 'ops@albarakah.test', password: 'pw123456' }, defaultCourier: 'pathao' } });

describe('host allow-list (SECURITY_RISKS #18/#25, closed in Module 11)', () => {
  it('isAllowedCourierHost: only the exact documented host per provider, nothing else', () => {
    expect(isAllowedCourierHost('steadfast', 'https://portal.steadfast.com.bd')).toBe(true);
    expect(isAllowedCourierHost('steadfast', 'https://portal.steadfast.com.bd/')).toBe(true);
    expect(isAllowedCourierHost('steadfast', 'https://evil.example.com')).toBe(false);
    expect(isAllowedCourierHost('steadfast', 'https://api-hermes.pathao.com')).toBe(false); // right provider's own host doesn't cross over
    expect(isAllowedCourierHost('steadfast', 'https://sub.portal.steadfast.com.bd')).toBe(false); // no subdomain wildcard
    expect(isAllowedCourierHost('steadfast', 'not a url')).toBe(false);
    expect(isAllowedCourierHost('pathao', 'https://api-hermes.pathao.com')).toBe(true);
    expect(isAllowedCourierHost('pathao', 'https://portal.steadfast.com.bd')).toBe(false);
  });

  it('settings PATCH refuses to SAVE a disallowed courier base URL (checked before it can ever be dispatched to)', async () => {
    const { a, tok } = await adminCtx();
    const bad = await patchSettings(a, tok, { courierConfig: { steadfast: { baseUrl: 'https://evil.example.com' } } });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toBe('VALIDATION_ERROR');
    const badPathao = await patchSettings(a, tok, { courierConfig: { pathao: { baseUrl: 'https://portal.steadfast.com.bd' } } }); // steadfast's own host isn't valid for pathao either
    expect(badPathao.status).toBe(400);
    const ok = await withSteadfast(a, tok);
    expect(ok.status).toBe(200);
  });

  it('dispatchToSteadfast/dispatchToPathao refuse a disallowed host even if one somehow got past settings validation (defence in depth) - no network call is made', async () => {
    const { a, tok } = await adminCtx();
    const { order } = await place(a, tok);
    let called = false;
    await withFetch((async () => { called = true; return jsonResponse({}); }) as typeof fetch, async () => {
      await expect(dispatchToSteadfast(order, 100, { apiKey: 'k', secretKey: 's', baseUrl: 'https://evil.example.com' })).rejects.toMatchObject({ status: 502, code: 'COURIER_HOST_NOT_ALLOWED' });
      await expect(dispatchToPathao(order, 100, { clientId: 'a', clientSecret: 'b', username: 'c', password: 'd', baseUrl: 'https://evil.example.com' })).rejects.toMatchObject({ status: 502, code: 'COURIER_HOST_NOT_ALLOWED' });
    });
    expect(called).toBe(false);
  });
});

describe('simulated mode (default) - unaffected by adding the real adapters', () => {
  it('still simulates, still no network call, still SIM- ids, exactly as Module 5c built it', async () => {
    const { a, tok } = await adminCtx();
    await withSteadfast(a, tok);
    const { order } = await place(a, tok);
    let called = false;
    const res = await withFetch((async () => { called = true; return jsonResponse({}); }) as typeof fetch, () =>
      request(a).post(`/v1/admin/orders/${order._id}/dispatch`).set(auth(tok)).send({ provider: 'steadfast' }));
    expect(res.status).toBe(200);
    expect(called).toBe(false);
    expect(res.body.courier).toMatchObject({ simulated: true, consignmentId: `SIM-${order._id}`, provider: 'steadfast' });
  });
});

describe('dispatchToSteadfast - real request/response shape (mocked HTTP, no real credentials)', () => {
  it('sends the documented payload (invoice, digits-only phone, COD-fixed amount) and parses a successful consignment', async () => {
    const { a, tok } = await adminCtx();
    const { order } = await place(a, tok, { notes: 'leave at the gate' });
    let calledUrl = '', calledHeaders: Record<string, string> = {}, calledBody: any;
    const result = await withFetch((async (url: string, init: any) => {
      calledUrl = String(url); calledHeaders = init.headers; calledBody = JSON.parse(init.body);
      return jsonResponse({ status: 200, consignment: { consignment_id: 'CID-1', tracking_code: 'TRK-1', status: 'in_review' } });
    }) as typeof fetch, () => dispatchToSteadfast(order, 777, { apiKey: 'SF_KEY', secretKey: 'SF_SECRET', baseUrl: 'https://portal.steadfast.com.bd' }));

    expect(calledUrl).toBe('https://portal.steadfast.com.bd/api/v1/create_order');
    expect(calledHeaders).toMatchObject({ 'Api-Key': 'SF_KEY', 'Secret-Key': 'SF_SECRET' });
    expect(calledBody).toMatchObject({ invoice: order._id.slice(-20), recipient_name: 'Rafiq Islam', recipient_address: '4/B Dhanmondi', cod_amount: 777, note: 'leave at the gate' });
    expect(calledBody.recipient_phone).toMatch(/^\d+$/); // digits only, no +880/spaces
    expect(result).toEqual({ success: true, consignmentId: 'CID-1', trackingCode: 'TRK-1', status: 'in_review', raw: expect.anything() });
  });

  it('reports a Steadfast-rejected request as a failure with its message, and a network error without throwing', async () => {
    const { a, tok } = await adminCtx();
    const { order } = await place(a, tok);
    const rejected = await withFetch((async () => jsonResponse({ status: 400, message: 'Invalid recipient phone' }, 400)) as typeof fetch, () =>
      dispatchToSteadfast(order, 100, { apiKey: 'k', secretKey: 's', baseUrl: 'https://portal.steadfast.com.bd' }));
    expect(rejected).toMatchObject({ success: false, error: 'Invalid recipient phone' });

    const networkDown = await withFetch((async () => { throw new Error('ECONNRESET'); }) as unknown as typeof fetch, () =>
      dispatchToSteadfast(order, 100, { apiKey: 'k', secretKey: 's', baseUrl: 'https://portal.steadfast.com.bd' }));
    expect(networkDown).toMatchObject({ success: false, error: 'ECONNRESET' });
    void a; void tok;
  });
});

describe('dispatchToPathao - real request/response shape (mocked HTTP, no real credentials)', () => {
  it('does the OAuth step then create-order, hard-codes Dhaka city 1/zone 1, and applies the COD-amount fix', async () => {
    const { a, tok } = await adminCtx();
    const { order } = await place(a, tok);
    const calls: Array<{ url: string; body: any; headers: any }> = [];
    const result = await withFetch((async (url: string, init: any) => {
      calls.push({ url: String(url), body: JSON.parse(init.body), headers: init.headers });
      if (calls.length === 1) return jsonResponse({ access_token: 'TOKEN-XYZ' });
      return jsonResponse({ data: { consignment_id: 'PID-1', order_status: 'Pending' } });
    }) as typeof fetch, () => dispatchToPathao(order, 555, { clientId: 'cid', clientSecret: 'csec', username: 'u', password: 'p', storeId: '42', baseUrl: 'https://api-hermes.pathao.com' }));

    expect(calls[0].url).toBe('https://api-hermes.pathao.com/aladdin/api/v1/issue-token');
    expect(calls[0].body).toMatchObject({ client_id: 'cid', client_secret: 'csec', username: 'u', password: 'p', grant_type: 'password' });
    expect(calls[1].url).toBe('https://api-hermes.pathao.com/aladdin/api/v1/orders');
    expect(calls[1].headers.Authorization).toBe('Bearer TOKEN-XYZ');
    expect(calls[1].body).toMatchObject({ store_id: 42, recipient_city: 1, recipient_zone: 1, delivery_type: 48, item_type: 2, amount_to_collect: 555 });
    expect(result).toEqual({ success: true, consignmentId: 'PID-1', trackingCode: 'PID-1', status: 'Pending', raw: expect.anything() });
    void a; void tok;
  });

  it('reports an auth failure without attempting to create an order, and a create failure separately', async () => {
    const { a, tok } = await adminCtx();
    const { order } = await place(a, tok);
    let createAttempted = false;
    const authFailed = await withFetch((async () => jsonResponse({ message: 'invalid_credentials' }, 401)) as typeof fetch, () =>
      dispatchToPathao(order, 100, { clientId: 'x', clientSecret: 'y', username: 'u', password: 'p', baseUrl: 'https://api-hermes.pathao.com' }));
    expect(authFailed).toMatchObject({ success: false, error: expect.stringContaining('invalid_credentials') });

    const createFailed = await withFetch((async (_url: string, init: any) => {
      if (JSON.parse(init.body).grant_type) return jsonResponse({ access_token: 'T' });
      createAttempted = true;
      return jsonResponse({ message: 'Invalid zone' }, 422);
    }) as typeof fetch, () => dispatchToPathao(order, 100, { clientId: 'x', clientSecret: 'y', username: 'u', password: 'p', baseUrl: 'https://api-hermes.pathao.com' }));
    expect(createAttempted).toBe(true);
    expect(createFailed).toMatchObject({ success: false, error: 'Invalid zone' });
    void a; void tok;
  });
});

describe('POST /admin/orders/:id/dispatch - live end to end (mocked HTTP)', () => {
  it('on success: writes the courier field, advances status to shipped, and the response matches al-barakah-admin\'s OrderMutation shape', async () => {
    const { a, tok } = await adminCtx();
    await withSteadfast(a, tok);
    const { order } = await place(a, tok);
    useEnv({ ENABLE_LIVE_INTEGRATIONS: 'true' });
    try {
      const res = await withFetch((async () => jsonResponse({ status: 200, consignment: { consignment_id: 'CID-9', tracking_code: 'TRK-9', status: 'in_review' } })) as typeof fetch, () =>
        request(a).post(`/v1/admin/orders/${order._id}/dispatch`).set(auth(tok)).send({}));
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ order: { status: 'shipped' }, stock: 'none', courier: { success: true, provider: 'steadfast', consignmentId: 'CID-9', trackingCode: 'TRK-9', simulated: false } });
      const stored = await OrderModel.findById(order._id).lean();
      expect(stored!.status).toBe('shipped');
      expect(stored!.courier).toMatchObject({ provider: 'steadfast', consignmentId: 'CID-9' });
    } finally {
      restoreEnv();
    }
  });

  it('on FAILURE: the order is left completely untouched (status, stock, courier field) and the admin gets a clear 502 to retry manually', async () => {
    const { a, tok } = await adminCtx();
    await withSteadfast(a, tok);
    const { order, product } = await place(a, tok);
    const before = await OrderModel.findById(order._id).lean();
    useEnv({ ENABLE_LIVE_INTEGRATIONS: 'true' });
    try {
      const res = await withFetch((async () => jsonResponse({ status: 400, message: 'Recipient address too short' }, 400)) as typeof fetch, () =>
        request(a).post(`/v1/admin/orders/${order._id}/dispatch`).set(auth(tok)).send({}));
      expect(res.status).toBe(502);
      expect(res.body.error).toBe('COURIER_DISPATCH_FAILED');
      const after = await OrderModel.findById(order._id).lean();
      expect(after!.status).toBe(before!.status); // untouched
      expect(after!.courier).toBeNull();
      expect(await stockOf(product.id)).toBe(4); // stock reserved at placement, untouched by the failed dispatch either way
    } finally {
      restoreEnv();
    }
  });

  it('dispatching an already-delivered or cancelled order writes the courier record but does NOT change its status backwards', async () => {
    const { a, tok } = await adminCtx();
    await withSteadfast(a, tok);
    const { order } = await place(a, tok);
    await request(a).patch(`/v1/admin/orders/${order._id}`).set(auth(tok)).send({ status: 'cancelled' }).expect(200);
    useEnv({ ENABLE_LIVE_INTEGRATIONS: 'true' });
    try {
      const res = await withFetch((async () => jsonResponse({ status: 200, consignment: { consignment_id: 'C', tracking_code: 'T', status: 'in_review' } })) as typeof fetch, () =>
        request(a).post(`/v1/admin/orders/${order._id}/dispatch`).set(auth(tok)).send({}));
      expect(res.status).toBe(200);
      expect(res.body.order.status).toBe('cancelled'); // not silently resurrected to "shipped"
      expect(res.body.order.courier).toMatchObject({ provider: 'steadfast' }); // the consignment record is still saved
    } finally {
      restoreEnv();
    }
  });
});

describe('auto-dispatch on confirm (BACKEND_PLAN B2)', () => {
  it('autoSendOnConfirm + a status PATCH to processing automatically dispatches via the default courier (simulated by default)', async () => {
    const { a, tok } = await adminCtx();
    await withSteadfast(a, tok);
    await patchSettings(a, tok, { courierConfig: { autoSendOnConfirm: true } });
    const { order } = await place(a, tok);
    const res = await request(a).patch(`/v1/admin/orders/${order._id}`).set(auth(tok)).send({ status: 'processing' });
    expect(res.status).toBe(200);
    expect(res.body.order.status).toBe('shipped'); // dispatchOrder advanced it past "processing"
    expect(res.body.courier).toMatchObject({ provider: 'steadfast', simulated: true });
  });

  it('never auto-dispatches twice: an order that already has a consignment is left alone on a later status PATCH', async () => {
    const { a, tok } = await adminCtx();
    await withSteadfast(a, tok);
    await patchSettings(a, tok, { courierConfig: { autoSendOnConfirm: true } });
    const { order } = await place(a, tok);
    const first = await request(a).patch(`/v1/admin/orders/${order._id}`).set(auth(tok)).send({ status: 'processing' });
    const firstConsignment = first.body.courier.consignmentId;
    const second = await request(a).patch(`/v1/admin/orders/${order._id}`).set(auth(tok)).send({ status: 'delivered' });
    expect(second.body.courier).toBeUndefined(); // no re-dispatch
    expect((await OrderModel.findById(order._id).lean())!.courier).toMatchObject({ consignmentId: firstConsignment });
  });

  it('off by default: a status change to processing does NOT auto-dispatch when autoSendOnConfirm is false', async () => {
    const { a, tok } = await adminCtx();
    await withSteadfast(a, tok); // configured, but autoSendOnConfirm stays false (the settings default)
    const { order } = await place(a, tok);
    const res = await request(a).patch(`/v1/admin/orders/${order._id}`).set(auth(tok)).send({ status: 'processing' });
    expect(res.body.order.status).toBe('processing'); // not auto-advanced to shipped
    expect(res.body.courier).toBeUndefined();
  });

  it('a broken auto-dispatch (e.g. live mode with bad credentials) never fails the status change that triggered it', async () => {
    const { a, tok } = await adminCtx();
    await patchSettings(a, tok, { courierConfig: { autoSendOnConfirm: true, defaultCourier: 'steadfast', steadfast: { enabled: true, baseUrl: 'https://portal.steadfast.com.bd' } } }); // enabled, but no credentials
    const { order } = await place(a, tok);
    useEnv({ ENABLE_LIVE_INTEGRATIONS: 'true' }); // otherwise dispatch just simulates and always "succeeds" - this test needs the live path to actually fail
    try {
      const res = await request(a).patch(`/v1/admin/orders/${order._id}`).set(auth(tok)).send({ status: 'processing' });
      expect(res.status).toBe(200); // the status change itself still succeeds
      expect(res.body.order.status).toBe('processing'); // auto-dispatch silently failed, so no advance to shipped
      expect(res.body.courier).toBeUndefined();
    } finally {
      restoreEnv();
    }
  });
});
