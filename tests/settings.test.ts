import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import crypto from 'node:crypto';
import mongoose from 'mongoose';
import { resetEnvCacheForTests } from '../src/config/env';
import { AuditLogModel } from '../src/modules/audit/audit.model';
import { SECRET_PATHS } from '../src/modules/settings/settings.defaults';
import { getSecret, reencryptSecrets } from '../src/modules/settings/settings.service';
import { adminSignIn, app, withV, makeUser, registerCustomer } from './helpers';

const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });
const SECRETS = {
  bkashConfig: { gateway: { appKey: 'bk-app-key-1234567890', appSecret: 'bk-app-secret-abcdefghij', username: 'bk-user', password: 'bk-pass-word-zz9' } },
  courierConfig: { steadfast: { apiKey: 'stdf-api-key-AAAA1111', secretKey: 'stdf-secret-key-BBBB2222' }, pathao: { clientId: 'pth-client-id-1', clientSecret: 'pth-client-secret-CCCC3333', username: 'pth@user.test', password: 'pth-password-DDDD4444' } },
  facebookPixelConfig: { accessToken: 'EAAB-facebook-token-EEEE5555' },
  notificationConfig: { telegram: { botToken: '7000000000:AAH-telegram-token-FFFF6666', chatId: '-1001234567890' } },
};
const plainValues = () => [SECRETS.bkashConfig.gateway, SECRETS.courierConfig.steadfast, SECRETS.courierConfig.pathao, SECRETS.facebookPixelConfig, SECRETS.notificationConfig.telegram].flatMap((o) => Object.values(o));

async function setup() {
  const a = app();
  await makeUser('super_admin');
  await makeUser('admin', 'plain@albarakah.test', 'plain-admin-password-1', 'Plain');
  const sa = await adminSignIn(a);
  const adm = await adminSignIn(a, 'plain@albarakah.test', 'plain-admin-password-1');
  return { a, sa: sa.accessToken, adm: adm.accessToken };
}
afterEach(() => resetEnvCacheForTests());

describe('public settings (no auth) - whitelist only', () => {
  it('returns defaults on a fresh database and NEVER exposes secrets, gateway config, CAPI token or courier/Telegram config', async () => {
    const { a, sa } = await setup();
    await request(a).patch('/v1/admin/settings').set(bearer(sa)).send(await withV(a, sa, { ...SECRETS, facebookPixelConfig: { ...SECRETS.facebookPixelConfig, pixelId: '123456789012345', testEventCode: 'TEST123' } })).expect(200);
    const res = await request(a).get('/v1/settings/public');
    expect(res.status).toBe(200);
    expect(Object.keys(res.body).sort()).toEqual(['bkashConfig', 'deliveryConfig', 'enableCoupons', 'enableCustomerReviews', 'facebookPixelConfig', 'heroBanners', 'seoConfig', 'storeName', 'supportPhone', 'topSelling']);
    expect(res.body.deliveryConfig.insideDhakaCharge).toBe(80);
    expect(res.body.facebookPixelConfig.pixelId).toBe('123456789012345');
    expect(res.body.facebookPixelConfig).not.toHaveProperty('accessToken');
    expect(res.body.facebookPixelConfig).not.toHaveProperty('testEventCode');
    expect(res.body.bkashConfig).not.toHaveProperty('gateway');
    const text = JSON.stringify(res.body);
    for (const v of plainValues()) expect(text).not.toContain(v);
    expect(text).not.toMatch(/courierConfig|notificationConfig|botToken|steadfast|pathao/);
  });
});

describe('admin settings - access control', () => {
  it('anonymous, customer tokens and unauthenticated writes are rejected', async () => {
    const { a } = await setup();
    const cust = await registerCustomer(a);
    for (const [m, p] of [['get', '/v1/admin/settings'], ['patch', '/v1/admin/settings'], ['get', '/v1/admin/settings/secrets']] as const) {
      expect((await request(a)[m](p)).status).toBe(401);
      expect((await request(a)[m](p).set(bearer(cust.body.accessToken))).status).toBe(401);
    }
  });

  it('admin AND super_admin can write; both read secrets only MASKED from GET /admin/settings', async () => {
    const { a, sa, adm } = await setup();
    const w = await request(a).patch('/v1/admin/settings').set(bearer(adm)).send(await withV(a, adm, SECRETS));
    expect(w.status).toBe(200);
    for (const tok of [adm, sa]) {
      const g = await request(a).get('/v1/admin/settings').set(bearer(tok));
      expect(g.status).toBe(200);
      const text = JSON.stringify(g.body);
      for (const v of plainValues()) expect(text).not.toContain(v);
      expect(g.body.courierConfig.steadfast.apiKey).toBe('••••1111');
      expect(g.body.notificationConfig.telegram.botToken).toBe('••••6666');
      expect(g.body.bkashConfig.gateway.username).toBe('••••'); // short values reveal nothing
    }
    expect(w.body.facebookPixelConfig.accessToken).toBe('••••5555');
  });

  it('only super_admin can read DECRYPTED secrets (admin -> 403), the read is audited and never cached', async () => {
    const { a, sa, adm } = await setup();
    await request(a).patch('/v1/admin/settings').set(bearer(sa)).send(await withV(a, sa, SECRETS)).expect(200);
    expect((await request(a).get('/v1/admin/settings/secrets').set(bearer(adm))).status).toBe(403);
    const res = await request(a).get('/v1/admin/settings/secrets').set(bearer(sa));
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body.courierConfig.steadfast.apiKey).toBe(SECRETS.courierConfig.steadfast.apiKey);
    expect(res.body.notificationConfig.telegram.botToken).toBe(SECRETS.notificationConfig.telegram.botToken);
    expect(res.body.bkashConfig.gateway.appSecret).toBe(SECRETS.bkashConfig.gateway.appSecret);
    expect(await AuditLogModel.countDocuments({ action: 'settings.secrets.reveal' })).toBe(1);
  });
});

describe('settings - encryption at rest and update semantics', () => {
  it('secrets are stored as AES-GCM envelopes; the plaintext exists nowhere in MongoDB; config holds no secret field', async () => {
    const { a, sa } = await setup();
    await request(a).patch('/v1/admin/settings').set(bearer(sa)).send(await withV(a, sa, SECRETS)).expect(200);
    const raw = await mongoose.connection.db!.collection('settings').findOne({ _id: 'general' as never });
    const dump = JSON.stringify(raw);
    for (const v of plainValues()) expect(dump).not.toContain(v);
    expect(Object.keys(raw!.secrets)).toHaveLength(SECRET_PATHS.length);
    expect(Object.values(raw!.secrets as Record<string, string>).every((e) => /^v1\./.test(e))).toBe(true);
    expect(JSON.stringify(raw!.config)).not.toMatch(/apiKey|secretKey|botToken|chatId|appSecret|accessToken/);
    // server-side consumers (courier/telegram adapters) can still decrypt individual secrets
    expect(await getSecret('courierConfig.steadfast.secretKey')).toBe(SECRETS.courierConfig.steadfast.secretKey);
  });

  it('echoing a mask (or "__keep__") keeps the stored secret; "" clears it; a new value replaces it', async () => {
    const { a, sa } = await setup();
    await request(a).patch('/v1/admin/settings').set(bearer(sa)).send(await withV(a, sa, SECRETS)).expect(200);
    const masked = (await request(a).get('/v1/admin/settings').set(bearer(sa))).body;
    // the admin UI posts the whole (masked) form back
    await request(a).patch('/v1/admin/settings').set(bearer(sa)).send(await withV(a, sa, { courierConfig: masked.courierConfig, notificationConfig: { telegram: { botToken: '__keep__' } } })).expect(200);
    expect(await getSecret('courierConfig.steadfast.apiKey')).toBe(SECRETS.courierConfig.steadfast.apiKey);
    expect(await getSecret('notificationConfig.telegram.botToken')).toBe(SECRETS.notificationConfig.telegram.botToken);
    await request(a).patch('/v1/admin/settings').set(bearer(sa)).send(await withV(a, sa, { courierConfig: { steadfast: { apiKey: '' } } })).expect(200);
    expect(await getSecret('courierConfig.steadfast.apiKey')).toBeUndefined();
    await request(a).patch('/v1/admin/settings').set(bearer(sa)).send(await withV(a, sa, { courierConfig: { steadfast: { secretKey: 'brand-new-secret-key-9999' } } })).expect(200);
    expect(await getSecret('courierConfig.steadfast.secretKey')).toBe('brand-new-secret-key-9999');
    expect(await getSecret('courierConfig.pathao.clientSecret')).toBe(SECRETS.courierConfig.pathao.clientSecret); // untouched
  });

  it('a PATCH of one section keeps the others (deep merge); non-secret values round-trip', async () => {
    const { a, sa } = await setup();
    await request(a).patch('/v1/admin/settings').set(bearer(sa)).send(await withV(a, sa, { deliveryConfig: { insideDhakaCharge: 70 }, storeName: 'Store X', enableCoupons: true })).expect(200);
    await request(a).patch('/v1/admin/settings').set(bearer(sa)).send(await withV(a, sa, { deliveryConfig: { outsideDhakaCharge: 200 } })).expect(200);
    const g = (await request(a).get('/v1/admin/settings').set(bearer(sa))).body;
    expect(g.deliveryConfig).toMatchObject({ insideDhakaCharge: 70, outsideDhakaCharge: 200, freeDeliveryThreshold: 2000 });
    expect(g.storeName).toBe('Store X');
    expect(g.enableCoupons).toBe(true);
    const pub = (await request(a).get('/v1/settings/public')).body;
    expect(pub.deliveryConfig.outsideDhakaCharge).toBe(200);
  });

  it('validation: wrong types, non-https courier URLs, base64 images anywhere -> 400', async () => {
    const { a, sa } = await setup();
    const patch = async (b: Record<string, unknown>) => request(a).patch('/v1/admin/settings').set(bearer(sa)).send(await withV(a, sa, b));
    expect((await patch({ deliveryConfig: { insideDhakaCharge: 'free' } })).body.error).toBe('VALIDATION_ERROR');
    expect((await patch({ courierConfig: { steadfast: { baseUrl: 'http://evil.test' } } })).status).toBe(400);
    expect((await patch({ courierConfig: { steadfast: { baseUrl: 'https://portal.steadfast.com.bd' } } })).status).toBe(200);
    const b64 = 'data:image/png;base64,iVBORw0KGgo=';
    expect((await patch({ seoConfig: { ogImage: b64 } })).status).toBe(400);
    expect((await patch({ heroBanners: { slides: [{ id: 's', title: 't', image: b64, enabled: true, targetType: 'all', targetValue: '' }], promoCard: { id: 'p', title: 't', image: 'https://res.cloudinary.com/x/y.jpg', enabled: true, targetType: 'all', targetValue: '' } } })).status).toBe(400);
    expect((await patch({ topSelling: { enabled: true, title: 'T', items: [{ id: 'i', name: 'n', price: 1, image: b64 }] } })).status).toBe(400);
    expect((await patch({ seoConfig: { ogImage: 'https://res.cloudinary.com/demo/image/upload/v1/albarakah/seo/og.jpg' } })).status).toBe(200);
    expect((await patch({ bkashConfig: { mode: 'BOGUS' } })).status).toBe(400);
  });

  it('audit trail records section + secret FIELD NAMES only - never a secret value', async () => {
    const { a, sa } = await setup();
    await request(a).patch('/v1/admin/settings').set(bearer(sa)).send(await withV(a, sa, { ...SECRETS, storeName: 'S' })).expect(200);
    await request(a).patch('/v1/admin/settings').set(bearer(sa)).send(await withV(a, sa, { courierConfig: { steadfast: { apiKey: '' } } })).expect(200);
    const rows = await AuditLogModel.find({ action: 'settings.update' }).sort({ createdAt: 1 }).lean();
    expect(rows[0].details!.credentialFieldsUpdated).toEqual(expect.arrayContaining(['courierConfig.steadfast.apiKey', 'notificationConfig.telegram.botToken']));
    expect(rows[1].details!.credentialFieldsCleared).toEqual(['courierConfig.steadfast.apiKey']);
    const dump = JSON.stringify(rows);
    for (const v of plainValues()) expect(dump).not.toContain(v);
  });

  it('key rotation: ciphertexts written under the old key stay readable, and reencryptSecrets() moves them to the new key', async () => {
    const { a, sa } = await setup();
    await request(a).patch('/v1/admin/settings').set(bearer(sa)).send(await withV(a, sa, SECRETS)).expect(200);
    const oldKey = process.env.SETTINGS_ENCRYPTION_KEY!;
    process.env.SETTINGS_ENCRYPTION_KEY = crypto.randomBytes(32).toString('hex');
    process.env.SETTINGS_ENCRYPTION_KEY_PREVIOUS = oldKey;
    resetEnvCacheForTests();
    expect(await getSecret('facebookPixelConfig.accessToken')).toBe(SECRETS.facebookPixelConfig.accessToken);
    expect((await reencryptSecrets()).reencrypted).toBe(SECRET_PATHS.length);
    expect((await reencryptSecrets()).reencrypted).toBe(0);
    delete process.env.SETTINGS_ENCRYPTION_KEY_PREVIOUS; // old key retired
    resetEnvCacheForTests();
    expect(await getSecret('facebookPixelConfig.accessToken')).toBe(SECRETS.facebookPixelConfig.accessToken);
    process.env.SETTINGS_ENCRYPTION_KEY = oldKey;
  });
});

describe('settings - optimistic locking', () => {
  it('GET returns the version; each successful write increments it; a stale or missing version is a 409/400 with the current version', async () => {
    const { a, sa, adm } = await setup();
    const v0 = (await request(a).get('/v1/admin/settings').set(bearer(sa))).body.version;
    expect(v0).toBe(0);
    const w1 = await request(a).patch('/v1/admin/settings').set(bearer(sa)).send({ version: 0, storeName: 'One' });
    expect(w1.status).toBe(200);
    expect(w1.body.version).toBe(1);
    // the second admin still holds version 0 -> conflict, nothing changes
    const stale = await request(a).patch('/v1/admin/settings').set(bearer(adm)).send({ version: 0, storeName: 'Two' });
    expect(stale.status).toBe(409);
    expect(stale.body).toMatchObject({ error: 'VERSION_CONFLICT', details: { currentVersion: 1, yourVersion: 0 } });
    expect((await request(a).get('/v1/admin/settings').set(bearer(sa))).body.storeName).toBe('One');
    // after reloading, the write succeeds
    const w2 = await request(a).patch('/v1/admin/settings').set(bearer(adm)).send({ version: 1, storeName: 'Two' });
    expect(w2.body).toMatchObject({ version: 2, storeName: 'Two' });
    // version is mandatory
    expect((await request(a).patch('/v1/admin/settings').set(bearer(sa)).send({ storeName: 'x' })).body.error).toBe('VALIDATION_ERROR');
    // a version from the future is also a conflict
    expect((await request(a).patch('/v1/admin/settings').set(bearer(sa)).send({ version: 99, storeName: 'x' })).status).toBe(409);
  });

  it('two racing writers with the same version: exactly one wins', async () => {
    const { a, sa, adm } = await setup();
    const [r1, r2] = await Promise.all([
      request(a).patch('/v1/admin/settings').set(bearer(sa)).send({ version: 0, storeName: 'A' }),
      request(a).patch('/v1/admin/settings').set(bearer(adm)).send({ version: 0, storeName: 'B' }),
    ]);
    expect([r1.status, r2.status].sort()).toEqual([200, 409]);
    expect((await request(a).get('/v1/admin/settings').set(bearer(sa))).body.version).toBe(1);
  });
});

describe('rotate-settings-key script', () => {
  it('re-encrypts every secret under the current key using OLD_SETTINGS_ENCRYPTION_KEY; --dry-run changes nothing; idempotent', async () => {
    const { rotateSettingsKey } = await import('../scripts/rotate-settings-key');
    const { a, sa } = await setup();
    await request(a).patch('/v1/admin/settings').set(bearer(sa)).send(await withV(a, sa, SECRETS)).expect(200);
    const oldKey = process.env.SETTINGS_ENCRYPTION_KEY!;
    const newKey = crypto.randomBytes(32).toString('hex');
    process.env.OLD_SETTINGS_ENCRYPTION_KEY = oldKey;
    process.env.SETTINGS_ENCRYPTION_KEY = newKey;
    resetEnvCacheForTests();
    const before = JSON.stringify(await mongoose.connection.db!.collection('settings').findOne({ _id: 'general' as never }));
    expect((await rotateSettingsKey({ dryRun: true })).reencrypted).toBe(SECRET_PATHS.length);
    expect(JSON.stringify(await mongoose.connection.db!.collection('settings').findOne({ _id: 'general' as never }))).toBe(before);
    expect((await rotateSettingsKey()).reencrypted).toBe(SECRET_PATHS.length);
    expect((await rotateSettingsKey()).reencrypted).toBe(0);
    // afterwards the OLD key is no longer needed
    delete process.env.OLD_SETTINGS_ENCRYPTION_KEY;
    delete process.env.SETTINGS_ENCRYPTION_KEY_PREVIOUS;
    resetEnvCacheForTests();
    expect(await getSecret('bkashConfig.gateway.appSecret')).toBe(SECRETS.bkashConfig.gateway.appSecret);
    process.env.SETTINGS_ENCRYPTION_KEY = oldKey;
    resetEnvCacheForTests();
    await expect(getSecret('bkashConfig.gateway.appSecret')).rejects.toThrow(/No encryption key/); // proves the data really is under the new key
  });
});
