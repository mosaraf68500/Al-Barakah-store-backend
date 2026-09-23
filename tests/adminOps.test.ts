import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { AuditLogModel } from '../src/modules/audit/audit.model';
import { CategoryModel } from '../src/modules/categories/category.model';
import { CouponModel } from '../src/modules/coupons/coupon.model';
import { OrderModel } from '../src/modules/orders/order.model';
import { ProductModel } from '../src/modules/products/product.model';
import { ReviewModel } from '../src/modules/reviews/review.model';
import { SettingsModel } from '../src/modules/settings/settings.model';
import { UserModel } from '../src/modules/users/user.model';
import { adminCtx, adminSignIn, app, auth, makeUser, mkCategory, mkMedia, mkProduct, patchSettings, registerCustomer } from './helpers';

async function superAdminCtx() {
  const a = app();
  await makeUser('super_admin');
  return { a, tok: (await adminSignIn(a)).accessToken };
}

describe('GET /admin/health', () => {
  it('requires admin auth; reports DB connectivity and the live-integrations flag', async () => {
    const { a, tok } = await adminCtx();
    expect((await request(a).get('/v1/admin/health')).status).toBe(401);
    const res = await request(a).get('/v1/admin/health').set(auth(tok));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, mode: 'mongo', liveIntegrations: false });
    expect(typeof res.body.latencyMs).toBe('number');
  });
});

describe('admin backup/restore - super_admin only', () => {
  it('GET /admin/backup and POST .../restore both reject a plain admin (not super_admin) and anonymous callers', async () => {
    const { a, tok } = await adminCtx(); // plain admin
    expect((await request(a).get('/v1/admin/backup')).status).toBe(401); // anonymous
    expect((await request(a).get('/v1/admin/backup').set(auth(tok))).status).toBe(403); // authenticated, wrong role
    expect((await request(a).post('/v1/admin/backup/restore').set(auth(tok)).send({})).status).toBe(403);
  });

  it('round trip: export from a populated DB, wipe, restore, and every collection matches exactly (incl. costPrice, deletedAt, image refs)', async () => {
    const { a, tok } = await superAdminCtx();
    await patchSettings(a, tok, { storeName: 'Backup Test Store' }); // ensure a settings doc actually exists to back up
    const img = await mkMedia('backup-test');
    const cat = await mkCategory(a, tok, 'Backup Category');
    const prod = (await request(a).post('/v1/admin/products').set(auth(tok)).send({ name: 'Backup Product', category: 'Backup Category', price: 500, costPrice: 300, stockCount: 7, image: img })).body;
    await request(a).post('/v1/admin/coupons').set(auth(tok)).send({ code: 'BKUP10', discountPercent: 10 }).expect(201);
    await request(a).delete(`/v1/admin/products/${prod.id}`).set(auth(tok)).expect(200); // an archived product too - must round-trip its deletedAt

    const before = await request(a).get('/v1/admin/backup').set(auth(tok));
    expect(before.status).toBe(200);
    expect(before.body).toMatchObject({ version: expect.any(String), storeName: expect.any(String) });
    expect(before.body.data.products).toHaveLength(1);
    expect(before.body.data.products[0]).toMatchObject({ _id: prod.id, costPrice: 300, image: { url: img, publicId: expect.any(String) } });
    expect(before.body.data.products[0].deletedAt).toBeTruthy();
    expect(before.body.data.categories).toHaveLength(1);
    expect(before.body.data.coupons).toHaveLength(1);
    expect(before.body.data.settings.config).toBeTruthy();
    expect(before.body.data.settings).not.toHaveProperty('secrets'); // never exported, even the encrypted envelope

    // wipe everything the backup covers
    await Promise.all([ProductModel.deleteMany({}), CategoryModel.deleteMany({}), CouponModel.deleteMany({})]);
    expect(await ProductModel.countDocuments()).toBe(0);

    const restored = await request(a).post('/v1/admin/backup/restore?confirm=RESTORE').set(auth(tok)).send(before.body);
    expect(restored.status).toBe(200);
    expect(restored.body).toMatchObject({ ok: true, dryRun: false, counts: { products: 1, categories: 1, coupons: 1, settingsRestored: true } });

    const prodAfter = await ProductModel.findById(prod.id).select('+costPrice').lean();
    expect(prodAfter).toMatchObject({ name: 'Backup Product', costPrice: 300, stockCount: 7, image: { url: img } });
    expect(prodAfter!.deletedAt).toBeTruthy(); // the archived state round-tripped too
    expect(await CategoryModel.countDocuments()).toBe(1);
    expect((await CouponModel.findOne({ code: 'BKUP10' }))!.discountPercent).toBe(10);

    expect(await AuditLogModel.countDocuments({ action: 'admin.backup_downloaded' })).toBe(1);
    expect(await AuditLogModel.countDocuments({ action: 'admin.backup_restored' })).toBe(1);
  });

  it('restore is an UPSERT, never a wipe: a live document NOT mentioned in the backup survives untouched', async () => {
    const { a, tok } = await superAdminCtx();
    await mkCategory(a, tok, 'Stays');
    const backup = (await request(a).get('/v1/admin/backup').set(auth(tok))).body; // backup has 1 category
    await mkCategory(a, tok, 'Also Stays'); // created AFTER the backup - not in it
    await request(a).post('/v1/admin/backup/restore?confirm=RESTORE').set(auth(tok)).send(backup).expect(200);
    const names = (await CategoryModel.find().lean()).map((c) => c.name).sort();
    expect(names).toEqual(['Also Stays', 'Stays']); // neither was deleted
  });

  it('dryRun previews counts and writes NOTHING; the real restore without confirm=RESTORE is refused', async () => {
    const { a, tok } = await superAdminCtx();
    await mkCategory(a, tok, 'Dry Run Cat');
    const backup = (await request(a).get('/v1/admin/backup').set(auth(tok))).body;
    await CategoryModel.deleteMany({});
    const dry = await request(a).post('/v1/admin/backup/restore?dryRun=true').set(auth(tok)).send(backup);
    expect(dry.status).toBe(200);
    expect(dry.body).toMatchObject({ ok: true, dryRun: true, counts: { categories: 1 } });
    expect(await CategoryModel.countDocuments()).toBe(0); // nothing written

    const noConfirm = await request(a).post('/v1/admin/backup/restore').set(auth(tok)).send(backup);
    expect(noConfirm.status).toBe(400);
    expect(noConfirm.body.error).toBe('CONFIRMATION_REQUIRED');
    expect(await CategoryModel.countDocuments()).toBe(0);

    const wrongConfirm = await request(a).post('/v1/admin/backup/restore?confirm=YES').set(auth(tok)).send(backup);
    expect(wrongConfirm.status).toBe(400);
    expect(await CategoryModel.countDocuments()).toBe(0);
  });

  it('a malformed backup file is rejected with a clear error, not a 500', async () => {
    const { a, tok } = await superAdminCtx();
    expect((await request(a).post('/v1/admin/backup/restore?confirm=RESTORE').set(auth(tok)).send({})).body.error).toBe('INVALID_BACKUP_FORMAT');
    expect((await request(a).post('/v1/admin/backup/restore?confirm=RESTORE').set(auth(tok)).send({ data: { products: 'not-an-array' } })).body.error).toBe('INVALID_BACKUP_FORMAT');
    expect((await request(a).post('/v1/admin/backup/restore?confirm=RESTORE').set(auth(tok)).send({ data: { products: [{ noId: true }] } })).body.error).toBe('INVALID_BACKUP_FORMAT');
  });

  it('a failed restore rolls back completely (a real MongoDB unique-index violation aborts the WHOLE transaction, not just that one write)', async () => {
    const { a, tok } = await superAdminCtx();
    await mkCategory(a, tok, 'Should Not Change');
    const backup = (await request(a).get('/v1/admin/backup').set(auth(tok))).body;
    const now = new Date().toISOString();
    // two DIFFERENT categories restored with the SAME name - violates the case-insensitive unique-name index for real,
    // a genuine MongoDB-level failure (not something Mongoose-layer validation would have caught, since restore bypasses it)
    backup.data.categories = [
      { _id: 'cat-dup-a', name: 'Duplicate', slug: 'duplicate-a', enabled: true, order: 0, image: null, createdAt: now, updatedAt: now },
      { _id: 'cat-dup-b', name: 'Duplicate', slug: 'duplicate-b', enabled: true, order: 1, image: null, createdAt: now, updatedAt: now },
    ];
    const res = await request(a).post('/v1/admin/backup/restore?confirm=RESTORE').set(auth(tok)).send(backup);
    expect(res.status).not.toBe(200);
    const names = (await CategoryModel.find().lean()).map((c) => c.name);
    expect(names).toEqual(['Should Not Change']); // rolled back completely - not even "Duplicate" #1 was left behind
  });

  it('revives JSON date strings to BSON Dates so product reads and pending-order expiry still work', async () => {
    const { a, tok } = await superAdminCtx();
    await patchSettings(a, tok, { deliveryConfig: { requireAdvanceDeliveryCharge: false } });
    await mkCategory(a, tok, 'Date Category');
    const prod = await mkProduct(a, tok, { category: 'Date Category', price: 100, stockCount: 5 });
    const expiresAt = new Date(Date.now() + 86_400_000).toISOString();
    await request(a).post('/v1/admin/coupons').set(auth(tok)).send({ code: 'DATE10', discountPercent: 10, expiresAt }).expect(201);
    const order = await request(a).post('/v1/orders').send({
      items: [{ productId: prod.id, quantity: 1 }],
      customer: { fullName: 'Date Buyer', phone: '01300000999', address: '1 Road', city: 'Inside Dhaka' },
      paymentChoice: 'FULL_COD',
    });
    expect(order.status).toBe(201);
    const orderId = order.body.order.id as string;

    const backup = (await request(a).get('/v1/admin/backup').set(auth(tok))).body;
    expect(typeof backup.data.products.find((p: { _id: string }) => p._id === prod.id).createdAt).toBe('string');
    expect(typeof backup.data.orders[0].createdAt).toBe('string');
    expect(typeof backup.data.settings.version).toBe('number');

    await request(a).post('/v1/admin/backup/restore?confirm=RESTORE').set(auth(tok)).send(backup).expect(200);

    expect((await ProductModel.findById(prod.id).lean())!.createdAt).toBeInstanceOf(Date);
    expect((await CouponModel.findOne({ code: 'DATE10' }).lean())!.expiresAt).toBeInstanceOf(Date);
    const orderAfter = await OrderModel.findById(orderId).lean();
    expect(orderAfter!.createdAt).toBeInstanceOf(Date);
    expect(orderAfter!.status).toBe('pending');

    const listed = await request(a).get('/v1/admin/products').set(auth(tok));
    expect(listed.status).toBe(200);
    expect(listed.body.map((p: { id: string }) => p.id)).toContain(prod.id);
    const coupons = await request(a).get('/v1/admin/coupons').set(auth(tok));
    expect(coupons.status).toBe(200);
    expect(coupons.body.find((c: { code: string }) => c.code === 'DATE10').expiresAt).toEqual(expect.any(String));
    const pending = await request(a).get('/v1/admin/orders?status=pending').set(auth(tok));
    expect(pending.body.find((o: { id: string }) => o.id === orderId)).toMatchObject({ status: 'pending' });
  });

  it('writes settings.version back, so a save after restore onto an empty settings doc is not stuck', async () => {
    const { a, tok } = await superAdminCtx();
    await patchSettings(a, tok, { storeName: 'Versioned Store' });
    const backup = (await request(a).get('/v1/admin/backup').set(auth(tok))).body;
    await SettingsModel.deleteMany({});
    await request(a).post('/v1/admin/backup/restore?confirm=RESTORE').set(auth(tok)).send(backup).expect(200);
    expect(typeof (await SettingsModel.findById('general').lean())!.version).toBe('number');
    const saved = await patchSettings(a, tok, { storeName: 'Versioned Store 2' });
    expect(saved.status).toBe(200);
    expect(saved.body.storeName).toBe('Versioned Store 2');
  });

  it('rejects an unknown backup version, a non-string _id, and an invalid date without writing', async () => {
    const { a, tok } = await superAdminCtx();
    await mkCategory(a, tok, 'Keep Me');
    const backup = (await request(a).get('/v1/admin/backup').set(auth(tok))).body;

    const legacy = await request(a).post('/v1/admin/backup/restore?confirm=RESTORE').set(auth(tok)).send({ ...backup, version: '1.0' });
    expect(legacy.status).toBe(400);
    expect(legacy.body.error).toBe('INVALID_BACKUP_FORMAT');

    const badId = structuredClone(backup);
    badId.data.products = [{ _id: { $gt: '' }, name: 'injected' }];
    expect((await request(a).post('/v1/admin/backup/restore?confirm=RESTORE').set(auth(tok)).send(badId)).body.error).toBe('INVALID_BACKUP_FORMAT');

    const badDate = structuredClone(backup);
    badDate.data.categories[0].createdAt = 'not-a-date';
    expect((await request(a).post('/v1/admin/backup/restore?dryRun=true').set(auth(tok)).send(badDate)).body.error).toBe('INVALID_BACKUP_FORMAT');

    expect((await CategoryModel.find().lean()).map((c) => c.name)).toEqual(['Keep Me']);
    expect(await ProductModel.countDocuments()).toBe(0);
  });
});
