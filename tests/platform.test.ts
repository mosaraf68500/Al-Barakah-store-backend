import mongoose from 'mongoose';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { connectDb } from '../src/config/db';
import { parseEnv } from '../src/config/env';
import { OtpModel } from '../src/modules/admin-auth/otp.model';
import { runCleanup } from '../src/modules/cron/cleanup.service';
import { LockoutModel } from '../src/modules/security/lockout.model';
import { RateLimitModel } from '../src/modules/security/rateLimit.model';
import { RefreshTokenModel } from '../src/modules/users/refreshToken.model';
import { UserModel } from '../src/modules/users/user.model';
import { seedSuperAdmin } from '../scripts/seed-super-admin';
import { resetEnvCacheForTests } from '../src/config/env';
import { ADMIN_EMAIL, ADMIN_PASSWORD, adminSignIn, app, makeUser } from './helpers';

const base = { ...process.env };

describe('env validation (fail fast)', () => {
  it('rejects missing/short/duplicated secrets and unsafe production settings', () => {
    expect(() => parseEnv({ ...base, JWT_ACCESS_SECRET: 'short' })).toThrow(/JWT_ACCESS_SECRET/);
    const { GOOGLE_CLIENT_ID: _google, ...noGoogle } = base;
    expect(parseEnv(noGoogle).GOOGLE_CLIENT_ID).toBe('947073184687-9303rtcuomi8it4t3nv0l6f75ndm3ofq.apps.googleusercontent.com');
    expect(() => parseEnv({ ...base, JWT_REFRESH_SECRET: base.JWT_ACCESS_SECRET })).toThrow(/must all be different/);
    const { MONGODB_URI: _m, ...noMongo } = base;
    expect(() => parseEnv(noMongo)).toThrow(/MONGODB_URI/);
    expect(() => parseEnv({ ...base, NODE_ENV: 'production', BCRYPT_COST: '10', MAIL_TRANSPORT: 'smtp', CORS_ORIGINS: 'https://a.test' })).toThrow(/BCRYPT_COST/);
    expect(() => parseEnv({ ...base, NODE_ENV: 'production', BCRYPT_COST: '12', MAIL_TRANSPORT: 'smtp', CORS_ORIGINS: '' })).toThrow(/CORS_ORIGINS/);
  });
  it('parses a good configuration (typed, with defaults)', () => {
    const e = parseEnv(base);
    expect(e.ENABLE_LIVE_INTEGRATIONS).toBe(false);
    expect(e.corsOrigins).toEqual(['https://shop.test', 'https://admin.test']);
    expect(e.ADMIN_SESSION_MAX_HOURS).toBe(12);
  });
});

describe('serverless MongoDB connection cache', () => {
  it('concurrent invocations share one connection (no connection per request)', async () => {
    const results = await Promise.all(Array.from({ length: 10 }, () => connectDb()));
    expect(new Set(results).size).toBe(1);
    expect(mongoose.connections.filter((c) => c.readyState === 1)).toHaveLength(1);
    for (let i = 0; i < 20; i++) await request(app()).get('/v1/health').expect(200);
    expect(mongoose.connections.filter((c) => c.readyState === 1)).toHaveLength(1);
  });
});

describe('http baseline', () => {
  it('health, JSON 404, helmet headers, CORS allow-list, body limit, JSON errors', async () => {
    const a = app();
    const h = await request(a).get('/v1/health');
    expect(h.body).toMatchObject({ status: 'ok', db: { ok: true } });
    expect(h.headers['x-content-type-options']).toBe('nosniff');
    expect(h.headers['x-powered-by']).toBeUndefined();
    expect(h.headers['content-security-policy']).toContain("default-src 'none'");
    expect(h.headers['cross-origin-resource-policy']).toBe('cross-origin');
    expect(h.headers['referrer-policy']).toBe('no-referrer');
    expect(h.headers['x-request-id']).toBeTruthy();
    const nf = await request(a).get('/v1/nope');
    expect(nf.status).toBe(404);
    expect(nf.body).toEqual({ error: 'NOT_FOUND' });

    const ok = await request(a).get('/v1/health').set('Origin', 'https://shop.test');
    expect(ok.headers['access-control-allow-origin']).toBe('https://shop.test');
    expect(ok.headers['access-control-allow-credentials']).toBe('true');
    const evil = await request(a).get('/v1/health').set('Origin', 'https://evil.test');
    expect(evil.status).toBe(403);
    expect(evil.headers['access-control-allow-origin']).toBeUndefined();

    const big = await request(a).post('/v1/auth/login').send({ phone: 'x'.repeat(200_000) });
    expect(big.status).toBe(413);
    const bad = await request(a).post('/v1/auth/login').set('Content-Type', 'application/json').send('{not json');
    expect(bad.status).toBe(400);
    expect(bad.body.error).toBe('INVALID_JSON');
    const val = await request(a).post('/v1/auth/register').send({ phone: '01712345678' });
    expect(val.status).toBe(400);
    expect(val.body.error).toBe('VALIDATION_ERROR');
  });
});

describe('Vercel Cron cleanup (no in-process timers)', () => {
  it('requires the bearer secret and deletes expired OTPs / refresh tokens / counters', async () => {
    const a = app();
    await makeUser('admin');
    await OtpModel.create({ email: 'x@y.test', codeHash: 'h', expiresAt: new Date(Date.now() - 1000) });
    await OtpModel.create({ email: 'z@y.test', codeHash: 'h', expiresAt: new Date(Date.now() + 60_000) });
    await RateLimitModel.create({ key: 'old', count: 1, resetAt: new Date(Date.now() - 1000) });
    const u = (await UserModel.findOne())!;
    const mk = (h: string, exp: number) => RefreshTokenModel.create({ userId: u._id, tokenHash: h, familyId: h, audience: 'admin', sessionStartedAt: new Date(), expiresAt: new Date(Date.now() + exp) });
    await mk('expired', -3 * 86_400_000);
    await mk('fresh', 3600_000);
    await LockoutModel.create({ key: 'stale', failedCount: 1, updatedAt: new Date(Date.now() - 10 * 86_400_000) });

    expect((await request(a).get('/v1/internal/cron/cleanup')).status).toBe(401);
    expect((await request(a).get('/v1/internal/cron/cleanup').set('Authorization', 'Bearer wrong')).status).toBe(401);
    const res = await request(a).get('/v1/internal/cron/cleanup').set('Authorization', `Bearer ${process.env.CRON_SECRET}`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, otps: 1, refreshTokens: 1, rateLimits: 1, lockouts: 1 });
    expect(await OtpModel.countDocuments()).toBe(1);
    expect(await RefreshTokenModel.countDocuments()).toBe(1);
    expect((await runCleanup()).otps).toBe(0);
  });

  it('vercel.json wires the cron path and no setInterval/setTimeout scheduler exists in src/', async () => {
    const fs = await import('node:fs');
    const cfg = JSON.parse(fs.readFileSync('vercel.json', 'utf8'));
    expect(cfg.crons[0].path).toBe('/v1/internal/cron/cleanup');
    const { execSync } = await import('node:child_process');
    expect(execSync('grep -rnE "setInterval|node-cron|cron\\.schedule" src api || true').toString().trim()).toBe('');
  });
});

describe('seed super_admin script', () => {
  const setEnv = (e: string | undefined, p: string | undefined) => {
    for (const [k, v] of [['SUPER_ADMIN_EMAIL', e], ['SUPER_ADMIN_PASSWORD', p]] as const) v === undefined ? delete process.env[k] : (process.env[k] = v);
    resetEnvCacheForTests();
  };
  it('creates the first super_admin, is idempotent, can sign in through the real OTP flow', async () => {
    setEnv('first@albarakah.test', 'a-long-seed-password-1');
    expect((await seedSuperAdmin()).created).toBe(true);
    expect((await seedSuperAdmin()).created).toBe(false);
    expect(await UserModel.countDocuments({ role: 'super_admin' })).toBe(1);
    const s = await adminSignIn(app(), 'first@albarakah.test', 'a-long-seed-password-1');
    expect(s.accessToken).toBeTruthy();
    setEnv(undefined, undefined);
  });
  it('validates input, refuses a second super_admin, and --reset-password revokes existing sessions', async () => {
    setEnv('first@albarakah.test', 'short');
    await expect(seedSuperAdmin()).rejects.toThrow(/at least 12/);
    setEnv('first@albarakah.test', 'a-long-seed-password-1');
    await seedSuperAdmin();
    setEnv('second@albarakah.test', 'another-long-password-2');
    await expect(seedSuperAdmin()).rejects.toThrow(/already exists/);
    setEnv('first@albarakah.test', 'a-long-seed-password-1');
    const s = await adminSignIn(app(), 'first@albarakah.test', 'a-long-seed-password-1');
    setEnv('first@albarakah.test', 'rotated-seed-password-3');
    await seedSuperAdmin({ resetPassword: true });
    expect((await request(app()).get('/v1/admin-auth/me').set('Authorization', `Bearer ${s.accessToken}`)).status).toBe(401);
    setEnv(undefined, undefined);
  });
  it('refuses to promote an existing non-super_admin account', async () => {
    await makeUser('admin', 'first@albarakah.test');
    setEnv('first@albarakah.test', 'a-long-seed-password-1');
    await expect(seedSuperAdmin()).rejects.toThrow(/refusing to promote/);
    setEnv(undefined, undefined);
    void ADMIN_EMAIL; void ADMIN_PASSWORD;
  });
});
