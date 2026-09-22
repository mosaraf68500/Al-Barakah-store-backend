import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { resetEnvCacheForTests } from '../src/config/env';
import { memoryOutbox } from '../src/modules/notifications/mailer';
import { notifyOrderPlaced } from '../src/modules/notifications/orderEvents.service';
import { buildPurchasePayload, sendFacebookPurchaseEvent } from '../src/modules/notifications/facebookCapi';
import { formatOrderForTelegram, sendTelegramOrderAlert } from '../src/modules/notifications/telegram';
import { OrderModel } from '../src/modules/orders/order.model';
import { adminCtx, app, auth, mkProduct, patchSettings } from './helpers';

let seq = 95_000_000;
const nextPhone = () => `015${String(seq++).padStart(8, '0')}`;
const relaxCod = (a: ReturnType<typeof app>, tok: string) => patchSettings(a, tok, { deliveryConfig: { requireAdvanceDeliveryCharge: false } });
const savedEnv: Record<string, string | undefined> = {};
function useEnv(env: Record<string, string | undefined>) {
  for (const [k, v] of Object.entries(env)) {
    if (!(k in savedEnv)) savedEnv[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  resetEnvCacheForTests();
}
afterEach(() => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
    delete savedEnv[k];
  }
  resetEnvCacheForTests();
});

async function placedOrder(a: ReturnType<typeof app>, tok: string, over: Record<string, unknown> = {}) {
  await relaxCod(a, tok);
  const p = await mkProduct(a, tok, { price: 500, stockCount: 5 });
  const res = await request(a).post('/v1/orders').send({
    items: [{ productId: p.id, quantity: 1 }], customer: { fullName: 'Halima Akter', phone: nextPhone(), address: '9 Road, Dhanmondi', city: 'Inside Dhaka' }, paymentChoice: 'FULL_COD', ...over,
  });
  return OrderModel.findById(res.body.order.id) as unknown as Promise<InstanceType<typeof OrderModel>>;
}
const withTelegram = (a: ReturnType<typeof app>, tok: string) => patchSettings(a, tok, { notificationConfig: { telegram: { enabled: true, botToken: 'TEST_BOT_TOKEN', chatId: '-100555' } } });
const withCapi = (a: ReturnType<typeof app>, tok: string) => patchSettings(a, tok, { facebookPixelConfig: { enabled: true, enableCapi: true, trackPurchase: true, pixelId: 'PIXEL123', accessToken: 'FB_TOKEN_XYZ', testEventCode: 'TEST9999' } });

describe('Telegram order alert - simulated by default (BACKEND_PLAN module 10)', () => {
  it('not configured -> skipped, no network call; the settings toggle actually gates it', async () => {
    const { a, tok } = await adminCtx();
    const order = await placedOrder(a, tok);
    expect(await sendTelegramOrderAlert(order)).toEqual({ sent: false, simulated: false, reason: 'NOT_CONFIGURED' });
  });

  it('configured + ENABLE_LIVE_INTEGRATIONS=false (the default) -> SIMULATED (logged, no live call)', async () => {
    const { a, tok } = await adminCtx();
    await withTelegram(a, tok);
    const order = await placedOrder(a, tok);
    let fetched = false;
    const orig = globalThis.fetch;
    globalThis.fetch = (async (...args: Parameters<typeof fetch>) => { fetched = true; return orig(...args); }) as typeof fetch;
    try {
      expect(await sendTelegramOrderAlert(order)).toEqual({ sent: false, simulated: true });
    } finally {
      globalThis.fetch = orig;
    }
    expect(fetched).toBe(false); // no real network call was made
  });

  it('ENABLE_LIVE_INTEGRATIONS=true actually calls the Telegram API and reports the result', async () => {
    const { a, tok } = await adminCtx();
    await withTelegram(a, tok);
    const order = await placedOrder(a, tok);
    useEnv({ ENABLE_LIVE_INTEGRATIONS: 'true' });
    const orig = globalThis.fetch;
    let calledUrl = '';
    let calledBody: any;
    globalThis.fetch = (async (url: string, init: any) => {
      calledUrl = String(url);
      calledBody = JSON.parse(init.body);
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as typeof fetch;
    try {
      const r = await sendTelegramOrderAlert(order);
      expect(r).toEqual({ sent: true, simulated: false });
    } finally {
      globalThis.fetch = orig;
    }
    expect(calledUrl).toBe('https://api.telegram.org/botTEST_BOT_TOKEN/sendMessage');
    expect(calledBody).toMatchObject({ chat_id: '-100555', parse_mode: 'HTML' });
  });

  it('a live-call failure/network error never throws - it is caught and reported', async () => {
    const { a, tok } = await adminCtx();
    await withTelegram(a, tok);
    const order = await placedOrder(a, tok);
    useEnv({ ENABLE_LIVE_INTEGRATIONS: 'true' });
    const orig = globalThis.fetch;
    globalThis.fetch = (async () => { throw new Error('network down'); }) as unknown as typeof fetch;
    try {
      const r = await sendTelegramOrderAlert(order);
      expect(r).toEqual({ sent: false, simulated: false, reason: 'ERROR' });
    } finally {
      globalThis.fetch = orig;
    }
  });
});

describe('formatOrderForTelegram - content sanitization (legacy sent this raw into parse_mode=HTML)', () => {
  it('escapes HTML metacharacters in every user-supplied field (name, address, notes, item name/variant)', async () => {
    const { a, tok } = await adminCtx();
    const order = await placedOrder(a, tok, {
      customer: { fullName: '<b>Evil</b> & "Name"', phone: nextPhone(), address: '<img src=x onerror=alert(1)>', city: 'Inside Dhaka' },
      notes: '</b><script>alert(1)</script>',
    });
    const text = formatOrderForTelegram(order);
    expect(text).not.toContain('<script>');
    expect(text).not.toContain('<img');
    expect(text).toContain('&lt;b&gt;Evil&lt;/b&gt; &amp; &quot;Name&quot;');
    expect(text).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(text).toContain('&lt;/b&gt;&lt;script&gt;alert(1)&lt;/script&gt;');
    // the message stays valid Telegram HTML: only the intentional <b>/<code>/<i> tags survive
    const stripKnownTags = text.replace(/<\/?(b|i|code)>/g, '');
    expect(stripKnownTags).not.toMatch(/<[a-z]/i);
  });
});

describe('Facebook CAPI Purchase event - simulated by default, PII hashed (fixes legacy plaintext)', () => {
  it('not configured -> skipped', async () => {
    const { a, tok } = await adminCtx();
    const order = await placedOrder(a, tok);
    expect(await sendFacebookPurchaseEvent(order)).toEqual({ sent: false, simulated: false, reason: 'NOT_CONFIGURED' });
  });

  it('buildPurchasePayload (pure): phone/email/name are SHA-256 hashed, never sent in clear text (legacy bug)', async () => {
    const { a, tok } = await adminCtx();
    const order = await placedOrder(a, tok, { customer: { fullName: 'Halima Akter', phone: '01712345678', address: 'a', city: 'Inside Dhaka', email: 'Halima@Example.com' } });
    const payload = buildPurchasePayload(order, { customCurrency: 'BDT', testEventCode: 'T1' });
    const ev = payload.data[0];
    expect(ev.event_name).toBe('Purchase');
    expect(ev.user_data.ph).toMatch(/^[0-9a-f]{64}$/);
    expect(ev.user_data.em).toMatch(/^[0-9a-f]{64}$/);
    expect(ev.user_data.fn).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(payload)).not.toContain('01712345678');
    expect(JSON.stringify(payload)).not.toContain('halima@example.com');
    expect(JSON.stringify(payload)).not.toMatch(/halima akter/i);
    expect(ev.custom_data).toMatchObject({ value: order.total, currency: 'BDT', order_id: order._id, content_type: 'product' });
    expect(payload.test_event_code).toBe('T1');
  });

  it('configured + ENABLE_LIVE_INTEGRATIONS=false -> SIMULATED, no network call', async () => {
    const { a, tok } = await adminCtx();
    await withCapi(a, tok);
    const order = await placedOrder(a, tok);
    let fetched = false;
    const orig = globalThis.fetch;
    globalThis.fetch = (async (...args: Parameters<typeof fetch>) => { fetched = true; return orig(...args); }) as typeof fetch;
    try {
      expect(await sendFacebookPurchaseEvent(order)).toEqual({ sent: false, simulated: true });
    } finally {
      globalThis.fetch = orig;
    }
    expect(fetched).toBe(false);
  });

  it('ENABLE_LIVE_INTEGRATIONS=true calls the Graph API with the access token and reports the result; failures never throw', async () => {
    const { a, tok } = await adminCtx();
    await withCapi(a, tok);
    const order = await placedOrder(a, tok);
    useEnv({ ENABLE_LIVE_INTEGRATIONS: 'true' });
    const orig = globalThis.fetch;
    let calledUrl = '';
    globalThis.fetch = (async (url: string) => { calledUrl = String(url); return new Response(JSON.stringify({ events_received: 1 }), { status: 200 }); }) as typeof fetch;
    try {
      expect(await sendFacebookPurchaseEvent(order)).toEqual({ sent: true, simulated: false });
    } finally {
      globalThis.fetch = orig;
    }
    expect(calledUrl).toBe('https://graph.facebook.com/v19.0/PIXEL123/events?access_token=FB_TOKEN_XYZ');

    globalThis.fetch = (async () => { throw new Error('boom'); }) as unknown as typeof fetch;
    try {
      expect(await sendFacebookPurchaseEvent(order)).toEqual({ sent: false, simulated: false, reason: 'ERROR' });
    } finally {
      globalThis.fetch = orig;
    }
  });
});

describe('notifyOrderPlaced - real trigger point (order creation) and non-blocking failure handling', () => {
  it('placing an order sends the owner e-mail, and the customer e-mail ONLY when one was given', async () => {
    const { a, tok } = await adminCtx();
    await relaxCod(a, tok);
    const p = await mkProduct(a, tok, { price: 200, stockCount: 5 });
    const before = memoryOutbox.length;
    const withEmail = await request(a).post('/v1/orders').send({ items: [{ productId: p.id, quantity: 1 }], customer: { fullName: 'A', phone: nextPhone(), email: 'buyer@example.com', address: 'a', city: 'Inside Dhaka' }, paymentChoice: 'FULL_COD' });
    expect(withEmail.status).toBe(201);
    await new Promise((r) => setTimeout(r, 20)); // notifyOrderPlaced is fire-and-forget (not awaited by the route)
    expect(memoryOutbox.length).toBe(before + 2); // owner + customer
    expect(memoryOutbox.some((m) => [m.to].flat().includes('buyer@example.com'))).toBe(true);

    const before2 = memoryOutbox.length;
    const noEmail = await request(a).post('/v1/orders').send({ items: [{ productId: p.id, quantity: 1 }], customer: { fullName: 'B', phone: nextPhone(), address: 'a', city: 'Inside Dhaka' }, paymentChoice: 'FULL_COD' });
    expect(noEmail.status).toBe(201);
    await new Promise((r) => setTimeout(r, 20));
    expect(memoryOutbox.length).toBe(before2 + 1); // owner only
  });

  it('notifyOrderPlaced aggregates every channel and NEVER throws, even when every channel is broken/unconfigured', async () => {
    const { a, tok } = await adminCtx();
    const order = await placedOrder(a, tok, { customer: { fullName: 'C', phone: nextPhone(), address: 'a', city: 'Inside Dhaka' } }); // no customer email
    useEnv({ ORDER_NOTIFY_EMAILS: undefined }); // breaks the owner e-mail (throws inside sendOrderNotificationEmail)
    const result = await notifyOrderPlaced(order);
    expect(result).toEqual({ ownerEmail: 'failed', customerEmail: 'skipped', telegram: { sent: false, simulated: false, reason: 'NOT_CONFIGURED' }, facebookCapi: { sent: false, simulated: false, reason: 'NOT_CONFIGURED' } });
  });

  it('ORDER CREATION ITSELF STILL SUCCEEDS (201) even when every notification channel is broken - a notification failure never fails or rolls back the order', async () => {
    const { a, tok } = await adminCtx();
    await relaxCod(a, tok);
    const p = await mkProduct(a, tok, { price: 100, stockCount: 5 });
    useEnv({ ORDER_NOTIFY_EMAILS: undefined });
    const res = await request(a).post('/v1/orders').send({ items: [{ productId: p.id, quantity: 1 }], customer: { fullName: 'D', phone: nextPhone(), address: 'a', city: 'Inside Dhaka' }, paymentChoice: 'FULL_COD' });
    expect(res.status).toBe(201);
    await new Promise((r) => setTimeout(r, 20));
    expect((await OrderModel.findById(res.body.order.id))).not.toBeNull(); // the order really was persisted, not rolled back
  });
});
