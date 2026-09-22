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
});
