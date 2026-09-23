import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { buildOpenApi } from '../src/openapi/document';
import { app, adminSignIn, auth, makeUser, mkProduct, registerCustomer } from './helpers';

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return path.endsWith('.ts') ? [path] : [];
  });
}

describe('SECURITY_RISKS regression', () => {
  it('source and package.json do not reintroduce Firebase, plaintext session tokens, or disabled TLS', () => {
    const pkg = JSON.parse(readFileSync(join(__dirname, '../package.json'), 'utf8')) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };
    expect(Object.keys(deps).some((name) => name.includes('firebase'))).toBe(false);
    const src = sourceFiles(join(__dirname, '../src')).map((file) => readFileSync(file, 'utf8')).join('\n');
    expect(src).not.toMatch(/rejectUnauthorized\s*:\s*false/);
    expect(src).not.toMatch(/Bearer session:/);
    expect(src).not.toMatch(/from ['"]firebase/);
  });

  it('public settings and public products do not leak secrets or costPrice', async () => {
    const a = app();
    await makeUser('admin');
    const tok = (await adminSignIn(a)).accessToken;
    const product = await mkProduct(a, tok, { costPrice: 123 });
    const settings = await request(a).get('/v1/settings/public');
    const forbidden = ['botToken', 'apiSecret', 'secretKey', 'appSecret', 'appKey', 'accessToken', 'password', 'clientSecret'];
    const keys: string[] = [];
    const walk = (value: unknown) => {
      if (!value || typeof value !== 'object') return;
      for (const [key, child] of Object.entries(value)) {
        keys.push(key);
        walk(child);
      }
    };
    walk(settings.body);
    expect(keys.filter((key) => forbidden.includes(key))).toEqual([]);
    const pub = await request(a).get(`/v1/products/${product.id}`);
    expect(pub.status).toBe(200);
    expect(pub.body).not.toHaveProperty('costPrice');
  });
});

describe('Module 13 rate limits', () => {
  it('allows 5 reviews per customer per hour and still lets a different customer post', async () => {
    const a = app(true);
    await makeUser('admin');
    const adminTok = (await adminSignIn(a)).accessToken;
    const products = [];
    for (let i = 0; i < 6; i++) products.push(await mkProduct(a, adminTok, { name: `Review Product ${i}` }));
    const first = (await registerCustomer(a, { phone: '01600000001' })).body.accessToken as string;
    for (let i = 0; i < 5; i++) {
      const res = await request(a).post('/v1/reviews').set(auth(first)).send({ productId: products[i].id, rating: 5, comment: 'Excellent' });
      expect(res.status).toBe(201);
    }
    const blocked = await request(a).post('/v1/reviews').set(auth(first)).send({ productId: products[5].id, rating: 4, comment: 'One more' });
    expect(blocked.status).toBe(429);
    expect(blocked.body.error).toBe('TOO_MANY_REQUESTS');
    const second = (await registerCustomer(a, { phone: '01600000002' })).body.accessToken as string;
    expect((await request(a).post('/v1/reviews').set(auth(second)).send({ productId: products[5].id, rating: 5, comment: 'Also good' })).status).toBe(201);
  });

  it('caps public GETs at 300 per minute per IP', async () => {
    const a = app(true);
    let last = 0;
    for (let i = 0; i < 301; i++) last = (await request(a).get('/v1/health')).status;
    expect(last).toBe(429);
  }, 60_000);

  it('caps backup restores at 10 per 15 minutes', async () => {
    const a = app(true);
    await makeUser('super_admin');
    const tok = (await adminSignIn(a)).accessToken;
    let last = 0;
    for (let i = 0; i < 11; i++) last = (await request(a).post('/v1/admin/backup/restore').set(auth(tok)).send({})).status;
    expect(last).toBe(429);
  });
});

describe('OpenAPI generated from Zod', () => {
  it('describes the order intent, including the paymentChoice enum, and lists the backup and wishlist routes', () => {
    const doc = buildOpenApi();
    expect(doc.openapi).toBe('3.0.3');
    const order = doc.paths['/orders'].post as { requestBody: { content: { 'application/json': { schema: { properties: { paymentChoice: { enum: string[] } } } } } } };
    expect(order.requestBody.content['application/json'].schema.properties.paymentChoice.enum).toEqual(['FULL_COD', 'ADVANCE_DELIVERY', 'FULL_BKASH']);
    expect(doc.paths['/wishlist']).toBeTruthy();
    expect(doc.paths['/admin/backup/restore']).toBeTruthy();
    expect(doc.paths['/admin/settings/secrets'].get).toMatchObject({ security: [{ bearer: [] }] });
  });
});
