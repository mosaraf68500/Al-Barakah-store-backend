import express, { type Express } from 'express';
import request from 'supertest';
import { createApp } from '../src/app';
import { UserModel } from '../src/modules/users/user.model';
import { memoryOutbox } from '../src/modules/notifications/mailer';
import { hashSecret } from '../src/utils/password';

export const CLIENT = { 'X-Abp-Client': 'test', Origin: 'https://shop.test' };
export const ADMIN_CLIENT = { 'X-Abp-Client': 'test', Origin: 'https://admin.test' };
/** Requests currently being served (diagnostics for the TEST_WATCHDOG stall dump). */
export const inflight = new Map<number, { method: string; url: string; since: number; stage: string }>();
let reqSeq = 0;
export const app = (rateLimits = false): Express => {
  const inner = createApp({ rateLimits });
  const outer = express();
  outer.use((req, res, next) => {
    const id = ++reqSeq;
    inflight.set(id, { method: req.method, url: req.originalUrl, since: Date.now(), stage: 'received' });
    res.once('close', () => inflight.delete(id));
    next();
  });
  outer.use(inner);
  return outer;
};

export const cookieOf = (res: request.Response, name: string): string | undefined => {
  const raw = ([] as string[]).concat(res.headers['set-cookie'] ?? []).find((c) => c.startsWith(`${name}=`));
  if (!raw) return undefined;
  const v = raw.split(';')[0].slice(name.length + 1);
  return v ? v : undefined;
};
export const cookieHeader = (name: string, value: string) => `${name}=${value}`;

export const PHONE = '01712345678';
export const PIN = '123456';

export async function registerCustomer(a: Express, over: Record<string, unknown> = {}) {
  return request(a).post('/v1/auth/register').send({ phone: PHONE, name: 'Test Customer', pin: PIN, ...over });
}

export const ADMIN_EMAIL = 'boss@albarakah.test';
export const ADMIN_PASSWORD = 'correct-horse-battery-1';

export async function makeUser(role: 'admin' | 'super_admin', email = ADMIN_EMAIL, password = ADMIN_PASSWORD, name = 'Boss') {
  return UserModel.create({ role, name, email, passwordHash: await hashSecret(password), isActive: true });
}

export const lastMail = () => memoryOutbox[memoryOutbox.length - 1];
export const codeFromMail = (m = lastMail()) => /\b(\d{6})\b/.exec(m.text)![1];

/** Full admin sign-in (password -> OTP). Returns the access token + refresh cookie value. */
export async function adminSignIn(a: Express, email = ADMIN_EMAIL, password = ADMIN_PASSWORD) {
  await request(a).post('/v1/admin-auth/login').send({ email, password }).expect(200);
  const code = codeFromMail();
  const res = await request(a).post('/v1/admin-auth/verify-otp').send({ email, code }).expect(200);
  return { accessToken: res.body.accessToken as string, refresh: cookieOf(res, 'abp_rt_admin')!, res };
}

/** Settings PATCH requires the version from the last GET (optimistic locking) - this fetches it and merges it into the body. */
export async function withV(a: Express, token: string, body: Record<string, unknown> = {}) {
  const v = (await request(a).get('/v1/admin/settings').set({ Authorization: `Bearer ${token}` })).body.version as number;
  return { ...body, version: v };
}

/* ---- catalogue helpers ---- */
import { MediaModel } from '../src/modules/media/media.model';
export const CLOUD_URL = (name: string, folder = 'products') => `https://res.cloudinary.com/${process.env.CLOUDINARY_CLOUD_NAME}/image/upload/v1/albarakah/${folder}/${name}.jpg`;
/** Registers an image in the Media collection (as the signed upload flow would) and returns its URL. */
export async function mkMedia(name: string, folder = 'products') {
  const publicId = `albarakah/${folder}/${name}`;
  await MediaModel.create({ publicId, url: CLOUD_URL(name, folder).replace('https:', 'http:'), secureUrl: CLOUD_URL(name, folder), folder, resourceType: 'image' });
  return CLOUD_URL(name, folder);
}
export async function adminCtx() {
  const a = app();
  await makeUser('admin');
  return { a, tok: (await adminSignIn(a)).accessToken };
}
export const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
export async function mkCategory(a: Express, tok: string, name: string, extra: Record<string, unknown> = {}) {
  const r = await request(a).post('/v1/admin/categories').set(auth(tok)).send({ name, ...extra });
  return (r.body as Array<{ id: string; name: string }>).find((c) => c.name === name)!;
}

/** Admin: PATCH /admin/settings with the version auto-attached. */
export async function patchSettings(a: Express, tok: string, body: Record<string, unknown>) {
  return request(a).patch('/v1/admin/settings').set(auth(tok)).send(await withV(a, tok, body));
}
/** Creates a category (if needed) + a product with a known price/stock; returns the admin product record. */
export async function mkProduct(a: Express, tok: string, over: Record<string, unknown> = {}) {
  const category = (over.category as string) ?? 'Test Category';
  if (!(await request(a).get('/v1/categories')).body.some((c: { name: string }) => c.name === category)) await mkCategory(a, tok, category);
  const res = await request(a).post('/v1/admin/products').set(auth(tok)).send({ name: `Product ${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, price: 500, stockCount: 10, category, ...over });
  return res.body as { id: string; name: string; price: number; stockCount: number };
}
