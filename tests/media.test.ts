import crypto from 'node:crypto';
import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { resetEnvCacheForTests } from '../src/config/env';
import { AuditLogModel } from '../src/modules/audit/audit.model';
import { __setCloudinaryForTests, type CloudinaryAdapter } from '../src/modules/media/cloudinary.client';
import { MediaModel } from '../src/modules/media/media.model';
import { adminSignIn, app, withV, makeUser, registerCustomer } from './helpers';

const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });
const SECRET = process.env.CLOUDINARY_API_SECRET!;
const CLOUD = process.env.CLOUDINARY_CLOUD_NAME!;
/** Independent implementation of Cloudinary's documented scheme: sha1( "k1=v1&k2=v2" (sorted) + api_secret ). */
const sha1Sign = (p: Record<string, string | number>) =>
  crypto.createHash('sha1').update(Object.keys(p).sort().map((k) => `${k}=${p[k]}`).join('&') + SECRET).digest('hex');

async function signedIn() {
  const a = app();
  await makeUser('admin');
  return { a, tok: (await adminSignIn(a)).accessToken };
}
const uploadResponse = (folder = 'products', name = 'bottle') => {
  const publicId = `albarakah/${folder}/${name}`;
  const version = 1700000000;
  return { publicId, version, signature: sha1Sign({ public_id: publicId, version }), secureUrl: `https://res.cloudinary.com/${CLOUD}/image/upload/v${version}/${publicId}.jpg`, format: 'jpg', bytes: 12345, width: 800, height: 800 };
};
const fakeAdapter = (destroy: CloudinaryAdapter['destroy']): CloudinaryAdapter => ({ cloudName: () => CLOUD, apiKey: () => process.env.CLOUDINARY_API_KEY!, sign: sha1Sign, destroy });
afterEach(() => {
  __setCloudinaryForTests(undefined);
  vi.restoreAllMocks();
});

describe('media - signed upload signature (real Cloudinary SDK signer)', () => {
  it('returns a signature equal to the documented SHA-1 over the sorted params + secret, with the folder allow-listed and locked', async () => {
    const { a, tok } = await signedIn();
    const res = await request(a).post('/v1/admin/media/sign').set(bearer(tok)).send({ folder: 'products' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ cloudName: CLOUD, apiKey: process.env.CLOUDINARY_API_KEY, folder: 'albarakah/products', allowedFormats: 'jpg,jpeg,png,webp,avif', uploadUrl: `https://api.cloudinary.com/v1_1/${CLOUD}/image/upload` });
    const expected = sha1Sign({ allowed_formats: 'jpg,jpeg,png,webp,avif', folder: 'albarakah/products', timestamp: res.body.timestamp });
    expect(res.body.signature).toBe(expected);
    expect(Math.abs(res.body.timestamp - Date.now() / 1000)).toBeLessThan(10);
    expect(JSON.stringify(res.body)).not.toContain(SECRET); // the API secret never leaves the server
    // a different folder yields a different signature (params are bound to the signature)
    const other = await request(a).post('/v1/admin/media/sign').set(bearer(tok)).send({ folder: 'banners' });
    expect(other.body.signature).not.toBe(res.body.signature);
  });

  it('rejects unknown folders, anonymous and customer callers; reports 503 when Cloudinary is not configured', async () => {
    const { a, tok } = await signedIn();
    expect((await request(a).post('/v1/admin/media/sign').set(bearer(tok)).send({ folder: '../etc' })).status).toBe(400);
    expect((await request(a).post('/v1/admin/media/sign').send({})).status).toBe(401);
    const cust = await registerCustomer(a);
    expect((await request(a).post('/v1/admin/media/sign').set(bearer(cust.body.accessToken)).send({})).status).toBe(401);
    const saved = process.env.CLOUDINARY_API_SECRET;
    process.env.CLOUDINARY_API_SECRET = '';
    resetEnvCacheForTests();
    expect((await request(a).post('/v1/admin/media/sign').set(bearer(tok)).send({})).body.error).toBe('MEDIA_NOT_CONFIGURED');
    process.env.CLOUDINARY_API_SECRET = saved;
    resetEnvCacheForTests();
  });
});

describe('media - registering an uploaded asset', () => {
  it('stores URL + public_id + metadata when Cloudinary\'s response signature verifies (idempotent per public_id)', async () => {
    const { a, tok } = await signedIn();
    const body = uploadResponse();
    const res = await request(a).post('/v1/admin/media').set(bearer(tok)).send(body);
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ publicId: 'albarakah/products/bottle', secureUrl: body.secureUrl, folder: 'products', bytes: 12345, width: 800, format: 'jpg' });
    expect((await request(a).post('/v1/admin/media').set(bearer(tok)).send(body)).status).toBe(201);
    expect(await MediaModel.countDocuments()).toBe(1);
    expect((await request(a).get('/v1/admin/media?folder=products').set(bearer(tok))).body).toHaveLength(1);
    expect((await request(a).get('/v1/admin/media?folder=banners').set(bearer(tok))).body).toHaveLength(0);
  });

  it('refuses forged registrations: bad signature, foreign folder, foreign host, mismatched URL', async () => {
    const { a, tok } = await signedIn();
    const post = (b: object) => request(a).post('/v1/admin/media').set(bearer(tok)).send(b);
    const ok = uploadResponse();
    expect((await post({ ...ok, signature: 'a'.repeat(40) })).body.error).toBe('INVALID_UPLOAD_SIGNATURE');
    expect((await post({ ...ok, version: ok.version + 1 })).body.error).toBe('INVALID_UPLOAD_SIGNATURE'); // signature is bound to the version
    const foreign = { publicId: 'someone-else/img', version: 1, signature: sha1Sign({ public_id: 'someone-else/img', version: 1 }), secureUrl: `https://res.cloudinary.com/${CLOUD}/image/upload/v1/someone-else/img.jpg` };
    expect((await post(foreign)).body.error).toBe('INVALID_PUBLIC_ID');
    expect((await post({ ...ok, secureUrl: 'https://evil.test/albarakah/products/bottle.jpg' })).body.error).toBe('INVALID_MEDIA_URL');
    expect((await post({ ...ok, secureUrl: `https://res.cloudinary.com/other-cloud/image/upload/v1/albarakah/products/bottle.jpg` })).body.error).toBe('INVALID_MEDIA_URL');
    expect(await MediaModel.countDocuments()).toBe(0);
  });
});

describe('media - delete cascades to Cloudinary AND the Media collection', () => {
  async function withMedia() {
    const ctx = await signedIn();
    const id = (await request(ctx.a).post('/v1/admin/media').set(bearer(ctx.tok)).send(uploadResponse())).body.id as string;
    return { ...ctx, id };
  }

  it('destroys the asset on Cloudinary, removes the row, audits it, and a second delete is a 404', async () => {
    const destroy = vi.fn().mockResolvedValue('ok');
    __setCloudinaryForTests(fakeAdapter(destroy));
    const { a, tok, id } = await withMedia();
    expect((await request(a).delete(`/v1/admin/media/${id}`).set(bearer(tok))).status).toBe(204);
    expect(destroy).toHaveBeenCalledWith('albarakah/products/bottle', 'image');
    expect(await MediaModel.countDocuments()).toBe(0);
    expect(await AuditLogModel.countDocuments({ action: 'media.delete' })).toBe(1);
    expect((await request(a).delete(`/v1/admin/media/${id}`).set(bearer(tok))).status).toBe(404);
    expect(destroy).toHaveBeenCalledTimes(1);
  });

  it('if Cloudinary fails or refuses, NOTHING is deleted locally (502); "not found" on Cloudinary still removes the row', async () => {
    const destroy = vi.fn().mockRejectedValueOnce(new Error('network')).mockResolvedValueOnce('error').mockResolvedValueOnce('not found');
    __setCloudinaryForTests(fakeAdapter(destroy));
    const { a, tok, id } = await withMedia();
    expect((await request(a).delete(`/v1/admin/media/${id}`).set(bearer(tok))).body.error).toBe('MEDIA_PROVIDER_ERROR');
    expect(await MediaModel.countDocuments()).toBe(1);
    expect((await request(a).delete(`/v1/admin/media/${id}`).set(bearer(tok))).status).toBe(502);
    expect(await MediaModel.countDocuments()).toBe(1);
    expect((await request(a).delete(`/v1/admin/media/${id}`).set(bearer(tok))).status).toBe(204);
    expect(await MediaModel.countDocuments()).toBe(0);
  });

  it('an asset still referenced by the settings cannot be deleted (409, Cloudinary untouched) until the reference is removed', async () => {
    const destroy = vi.fn().mockResolvedValue('ok');
    __setCloudinaryForTests(fakeAdapter(destroy));
    const { a, tok, id } = await withMedia();
    const url = uploadResponse().secureUrl;
    await request(a).patch('/v1/admin/settings').set(bearer(tok)).send(await withV(a, tok, { seoConfig: { ogImage: url } })).expect(200);
    const blocked = await request(a).delete(`/v1/admin/media/${id}`).set(bearer(tok));
    expect(blocked.status).toBe(409);
    expect(blocked.body).toMatchObject({ error: 'MEDIA_IN_USE', details: { usedBy: ['settings'] } });
    expect(destroy).not.toHaveBeenCalled();
    expect(await MediaModel.countDocuments()).toBe(1);
    await request(a).patch('/v1/admin/settings').set(bearer(tok)).send(await withV(a, tok, { seoConfig: { ogImage: 'https://images.unsplash.com/photo-x.jpg' } })).expect(200);
    expect((await request(a).delete(`/v1/admin/media/${id}`).set(bearer(tok))).status).toBe(204);
    expect(destroy).toHaveBeenCalledTimes(1);
  });

  it('delete requires an admin session; bad ids are 404', async () => {
    const { a, tok } = await withMedia();
    expect((await request(a).delete('/v1/admin/media/aaaaaaaaaaaaaaaaaaaaaaaa')).status).toBe(401);
    expect((await request(a).delete('/v1/admin/media/not-an-id').set(bearer(tok))).status).toBe(404);
  });
});
