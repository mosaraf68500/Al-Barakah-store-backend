import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { LockoutModel } from '../src/modules/security/lockout.model';
import { RefreshTokenModel } from '../src/modules/users/refreshToken.model';
import { UserModel } from '../src/modules/users/user.model';
import { signAccessToken } from '../src/modules/users/token.service';
import { CLIENT, PHONE, PIN, app, cookieHeader, cookieOf, registerCustomer } from './helpers';

const RT = 'abp_rt_customer';

describe('customer auth - register', () => {
  it('registers with phone + a strong password, stores a bcrypt hash, returns access token + httpOnly refresh cookie', async () => {
    const a = app();
    const res = await registerCustomer(a, { address: 'House 1, Dhaka' });
    expect(res.status).toBe(201);
    expect(res.body.accessToken).toMatch(/^eyJ/);
    expect(res.body.user).toMatchObject({ name: 'Test Customer', phone: PHONE, role: 'customer' });
    expect(res.body.user.addresses[0].isDefault).toBe(true);
    expect(JSON.stringify(res.body.user)).not.toMatch(/passwordHash|"pin"|\$2[aby]\$/);
    expect(res.body.refreshToken).toMatch(/^eyJ/);
    expect(Object.keys(res.body).sort()).toEqual(['accessToken', 'expiresIn', 'refreshToken', 'user']);

    const setCookie = ([] as string[]).concat(res.headers['set-cookie']).find((c) => c.startsWith(RT))!;
    expect(setCookie).toMatch(/HttpOnly/i);
    expect(setCookie).toMatch(/SameSite=Lax/i);
    expect(setCookie).toMatch(/Path=\/v1\/auth/);

    const stored = await UserModel.findOne({ phone: PHONE }).select('+passwordHash');
    expect(stored!.passwordHash).toMatch(/^\$2[aby]\$/); // bcrypt
    expect(stored!.passwordHash).not.toContain(PIN);
  });

  it.each([
    [{ phone: '12345', pin: PIN }, 'INVALID_BD_PHONE'],
    [{ phone: PHONE, pin: '' }, 'PIN_REQUIRED'],
    [{ phone: PHONE, pin: '1234' }, 'PIN_TOO_SHORT'],
    [{ phone: PHONE, pin: '12345' }, 'PIN_TOO_SHORT'],
    [{ phone: PHONE, pin: '1234567' }, 'PIN_INVALID'],
    [{ phone: PHONE, pin: '12ab56' }, 'PIN_INVALID'],
  ])('rejects %j with %s', async (body, code) => {
    const res = await registerCustomer(app(), body);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe(code);
  });

  it('accepts +880 / 880 phone formats and rejects a duplicate account', async () => {
    const a = app();
    expect((await registerCustomer(a, { phone: '+8801712345678' })).status).toBe(201);
    const dup = await registerCustomer(a, { phone: '01712345678' });
    expect(dup.status).toBe(409);
    expect(dup.body.error).toBe('ACCOUNT_ALREADY_EXISTS');
  });
});

describe('customer auth - login + lockout', () => {
  it('logs in with the right PIN', async () => {
    const a = app();
    await registerCustomer(a);
    const res = await request(a).post('/v1/auth/login').send({ phone: '+8801712345678', pin: PIN });
    expect(res.status).toBe(200);
    expect(res.body.user.phone).toBe(PHONE);
    expect(cookieOf(res, RT)).toBeTruthy();
  });

  it('gives the SAME generic error for wrong PIN and unknown phone (no account enumeration)', async () => {
    const a = app();
    await registerCustomer(a);
    const wrong = await request(a).post('/v1/auth/login').send({ phone: PHONE, pin: '000000' });
    const unknown = await request(a).post('/v1/auth/login').send({ phone: '01899999999', pin: '000000' });
    expect(wrong.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(wrong.body).toEqual(unknown.body);
    expect(wrong.body.error).toBe('INVALID_CREDENTIALS');
  });

  it('locks after 5 failures - even the correct PIN is refused - with exponential backoff on repeat', async () => {
    const a = app();
    await registerCustomer(a);
    const bad = () => request(a).post('/v1/auth/login').send({ phone: PHONE, pin: '000000' });
    for (let i = 0; i < 4; i++) expect((await bad()).status).toBe(401);
    const fifth = await bad();
    expect(fifth.status).toBe(429);
    expect(fifth.body.error).toBe('ACCOUNT_LOCKED');
    const first = fifth.body.details.retryAfterSeconds as number;
    expect(first).toBeGreaterThan(14 * 60);

    const correct = await request(a).post('/v1/auth/login').send({ phone: PHONE, pin: PIN });
    expect(correct.status).toBe(429); // still locked
    expect(correct.headers['retry-after']).toBeTruthy();

    // lock expires -> a second round of 5 failures locks for TWICE as long
    await LockoutModel.updateOne({ key: 'customer:1712345678' }, { $set: { lockUntil: new Date(Date.now() - 1000) } });
    for (let i = 0; i < 4; i++) await bad();
    const second = await bad();
    expect(second.status).toBe(429);
    expect(second.body.details.retryAfterSeconds).toBeGreaterThan(first * 1.9);
  });

  it('counts failures for unknown phones too and a success resets the counter', async () => {
    const a = app();
    await registerCustomer(a);
    for (let i = 0; i < 3; i++) await request(a).post('/v1/auth/login').send({ phone: PHONE, pin: '000000' });
    expect((await request(a).post('/v1/auth/login').send({ phone: PHONE, pin: PIN })).status).toBe(200);
    expect(await LockoutModel.findOne({ key: 'customer:1712345678' })).toBeNull();
    for (let i = 0; i < 5; i++) await request(a).post('/v1/auth/login').send({ phone: '01611111111', pin: '000000' });
    expect((await request(a).post('/v1/auth/login').send({ phone: '01611111111', pin: '000000' })).status).toBe(429);
  });
});

describe('customer auth - refresh rotation, reuse detection, logout, access checks', () => {
  it('rotates the refresh token and issues a new access token', async () => {
    const a = app();
    const reg = await registerCustomer(a);
    const rt1 = cookieOf(reg, RT)!;
    const res = await request(a).post('/v1/auth/refresh').set(CLIENT).set('Cookie', cookieHeader(RT, rt1));
    expect(res.status).toBe(200);
    expect(res.body.accessToken).toMatch(/^eyJ/);
    const rt2 = cookieOf(res, RT)!;
    expect(rt2).not.toBe(rt1);
    expect(await RefreshTokenModel.countDocuments({ revokedAt: null })).toBe(1);
    // the stored value is a hash, never the token
    expect(await RefreshTokenModel.findOne({ tokenHash: rt1 })).toBeNull();
  });

  it('REUSE of a rotated token is rejected and burns the whole family (the new token dies too)', async () => {
    const a = app();
    const rt1 = cookieOf(await registerCustomer(a), RT)!;
    const rt2 = cookieOf(await request(a).post('/v1/auth/refresh').set(CLIENT).set('Cookie', cookieHeader(RT, rt1)), RT)!;
    const reuse = await request(a).post('/v1/auth/refresh').set(CLIENT).set('Cookie', cookieHeader(RT, rt1));
    expect(reuse.status).toBe(401);
    expect(reuse.body.error).toBe('REFRESH_TOKEN_REUSED');
    const after = await request(a).post('/v1/auth/refresh').set(CLIENT).set('Cookie', cookieHeader(RT, rt2));
    expect(after.status).toBe(401);
    expect(await RefreshTokenModel.countDocuments({ revokedAt: null })).toBe(0);
  });

  it('rotates from the X-Abp-Refresh header when no cookie is sent', async () => {
    const a = app();
    const reg = await registerCustomer(a);
    const rt1 = reg.body.refreshToken as string;
    const res = await request(a).post('/v1/auth/refresh').set(CLIENT).set('X-Abp-Refresh', rt1);
    expect(res.status).toBe(200);
    expect(res.body.accessToken).toMatch(/^eyJ/);
    expect(res.body.refreshToken).toMatch(/^eyJ/);
    expect(res.body.refreshToken).not.toBe(rt1);
    const again = await request(a).post('/v1/auth/refresh').set(CLIENT).set('X-Abp-Refresh', res.body.refreshToken);
    expect(again.status).toBe(200);
    expect(again.body.refreshToken).not.toBe(res.body.refreshToken);
  });

  it('logout via the header revokes that session even with no cookie', async () => {
    const a = app();
    const rt = (await registerCustomer(a)).body.refreshToken as string;
    const out = await request(a).post('/v1/auth/logout').set(CLIENT).set('X-Abp-Refresh', rt);
    expect(out.status).toBe(204);
    expect((await request(a).post('/v1/auth/refresh').set(CLIENT).set('X-Abp-Refresh', rt)).status).toBe(401);
  });

  it('refresh needs the CSRF header and an allowed Origin; forged / missing cookies fail', async () => {
    const a = app();
    const rt = cookieOf(await registerCustomer(a), RT)!;
    expect((await request(a).post('/v1/auth/refresh').set('Cookie', cookieHeader(RT, rt))).status).toBe(403);
    expect((await request(a).post('/v1/auth/refresh').set({ 'X-Abp-Client': 'x', Origin: 'https://evil.test' }).set('Cookie', cookieHeader(RT, rt))).status).toBe(403);
    expect((await request(a).post('/v1/auth/refresh').set(CLIENT)).status).toBe(401);
    expect((await request(a).post('/v1/auth/refresh').set(CLIENT).set('Cookie', cookieHeader(RT, 'not.a.token'))).status).toBe(401);
  });

  it('logout revokes the session: the refresh cookie no longer works', async () => {
    const a = app();
    const rt = cookieOf(await registerCustomer(a), RT)!;
    const out = await request(a).post('/v1/auth/logout').set(CLIENT).set('Cookie', cookieHeader(RT, rt));
    expect(out.status).toBe(204);
    expect((await request(a).post('/v1/auth/refresh').set(CLIENT).set('Cookie', cookieHeader(RT, rt))).status).toBe(401);
  });

  it('GET /auth/me requires a valid customer access token', async () => {
    const a = app();
    const reg = await registerCustomer(a);
    expect((await request(a).get('/v1/auth/me')).status).toBe(401);
    expect((await request(a).get('/v1/auth/me').set('Authorization', 'Bearer nope')).status).toBe(401);
    const ok = await request(a).get('/v1/auth/me').set('Authorization', `Bearer ${reg.body.accessToken}`);
    expect(ok.status).toBe(200);
    expect(ok.body.user.phone).toBe(PHONE);
  });

  it('a deactivated user or a bumped tokenVersion invalidates the access token immediately', async () => {
    const a = app();
    const reg = await registerCustomer(a);
    const auth = { Authorization: `Bearer ${reg.body.accessToken}` };
    await UserModel.updateOne({ phone: PHONE }, { $inc: { tokenVersion: 1 } });
    expect((await request(a).get('/v1/auth/me').set(auth)).status).toBe(401);
    const fresh = await request(a).post('/v1/auth/login').send({ phone: PHONE, pin: PIN });
    await UserModel.updateOne({ phone: PHONE }, { $set: { isActive: false } });
    expect((await request(a).get('/v1/auth/me').set('Authorization', `Bearer ${fresh.body.accessToken}`)).status).toBe(401);
  });

  it('an ADMIN-audience token cannot be used on customer routes (and roles come from the DB, not the token)', async () => {
    const a = app();
    await registerCustomer(a);
    const user = (await UserModel.findOne({ phone: PHONE }))!;
    const adminAud = signAccessToken(user, 'admin').token;
    expect((await request(a).get('/v1/auth/me').set('Authorization', `Bearer ${adminAud}`)).status).toBe(401);
  });
});

describe('IP rate limiting is DB-backed', () => {
  it('429s after the window limit and persists the counter in MongoDB', async () => {
    const a = app(true);
    await registerCustomer(a);
    let last = 0;
    for (let i = 0; i < 12; i++) last = (await request(a).post('/v1/auth/login').send({ phone: `019111111${String(10 + i)}`, pin: '000000' })).status;
    expect(last).toBe(429);
    const { RateLimitModel } = await import('../src/modules/security/rateLimit.model');
    const doc = await RateLimitModel.findOne({ key: /^cust-login:/ }).lean();
    expect(doc!.count).toBeGreaterThan(10);
  });
});

describe('lockout ceiling + account-level throttle (Module 1 follow-ups)', () => {
  it('the exponential lock is capped at 1 hour', async () => {
    const a = app();
    await registerCustomer(a);
    await LockoutModel.updateOne({ key: 'customer:1712345678' }, { $set: { strikes: 8, failedCount: 0 } }, { upsert: true });
    let last;
    for (let i = 0; i < 5; i++) last = await request(a).post('/v1/auth/login').send({ phone: PHONE, pin: '000000' });
    expect(last!.status).toBe(429);
    expect(last!.body.details.retryAfterSeconds).toBeLessThanOrEqual(3600);
    expect(last!.body.details.retryAfterSeconds).toBeGreaterThan(3590);
  });

  it('the SAME account tried from many different IPs is slowed (429 TOO_MANY_REQUESTS) even with valid credentials', async () => {
    const a = app();
    await registerCustomer(a);
    let status = 200;
    for (let i = 0; i < 22 && status === 200; i++) status = (await request(a).post('/v1/auth/login').set('X-Forwarded-For', `203.0.113.${i + 1}`).send({ phone: PHONE, pin: PIN })).status;
    expect(status).toBe(429);
    const res = await request(a).post('/v1/auth/login').set('X-Forwarded-For', '198.51.100.9').send({ phone: PHONE, pin: PIN });
    expect(res.body.error).toBe('TOO_MANY_REQUESTS');
  });

  it('MANY different phones from ONE IP are slowed by the per-IP limiter', async () => {
    const a = app(true);
    let last = 0;
    for (let i = 0; i < 12; i++) last = (await request(a).post('/v1/auth/login').set('X-Forwarded-For', '192.0.2.50').send({ phone: `018222222${String(10 + i)}`, pin: '000000' })).status;
    expect(last).toBe(429);
  });
});

describe('POST /v1/auth/change-pin', () => {
  const NEW = 'Bb2@bb';
  const change = (a: ReturnType<typeof app>, token: string, rt: string | undefined, body: object) => {
    const r = request(a).post('/v1/auth/change-pin').set('Authorization', `Bearer ${token}`);
    return (rt ? r.set('Cookie', cookieHeader(RT, rt)) : r).send(body);
  };

  it('needs a customer session; changes the PIN (bcrypt), old PIN stops working, new one works', async () => {
    const a = app();
    const reg = await registerCustomer(a);
    expect((await request(a).post('/v1/auth/change-pin').send({ currentPin: PIN, newPin: NEW })).status).toBe(401);
    const res = await change(a, reg.body.accessToken, cookieOf(reg, RT), { currentPin: PIN, newPin: NEW });
    expect(res.status).toBe(200);
    expect(res.body.accessToken).toMatch(/^eyJ/);
    const stored = await UserModel.findOne({ phone: PHONE }).select('+passwordHash');
    expect(stored!.passwordHash).toMatch(/^\$2[aby]\$/);
    expect((await request(a).post('/v1/auth/login').send({ phone: PHONE, pin: PIN })).status).toBe(401);
    expect((await request(a).post('/v1/auth/login').send({ phone: PHONE, pin: NEW })).status).toBe(200);
  });

  it('validation: same rules as registration, and the new PIN must differ', async () => {
    const a = app();
    const reg = await registerCustomer(a);
    const rt = cookieOf(reg, RT);
    const t = reg.body.accessToken;
    expect((await change(a, t, rt, { currentPin: PIN, newPin: '1234' })).body.error).toBe('PIN_TOO_SHORT');
    expect((await change(a, t, rt, { currentPin: PIN, newPin: '12345a' })).body.error).toBe('PIN_INVALID');
    expect((await change(a, t, rt, { currentPin: PIN, newPin: '' })).body.error).toBe('PIN_REQUIRED');
    expect((await change(a, t, rt, { currentPin: PIN, newPin: PIN })).body.error).toBe('PIN_UNCHANGED');
    expect((await change(a, t, rt, { currentPin: '', newPin: NEW })).body.error).toBe('PIN_REQUIRED');
  });

  it('a wrong current PIN is refused and counts toward the SAME lockout as login (5 -> locked)', async () => {
    const a = app();
    const reg = await registerCustomer(a);
    let last;
    for (let i = 0; i < 5; i++) last = await change(a, reg.body.accessToken, cookieOf(reg, RT), { currentPin: '000000', newPin: NEW });
    expect(last!.status).toBe(429);
    expect(last!.body.error).toBe('ACCOUNT_LOCKED');
    expect((await request(a).post('/v1/auth/login').send({ phone: PHONE, pin: PIN })).status).toBe(429); // locked for login too
  });

  it('OTHER sessions die (refresh + access token) while the caller\'s own session survives', async () => {
    const a = app();
    const first = await registerCustomer(a); // device 1
    const second = await request(a).post('/v1/auth/login').send({ phone: PHONE, pin: PIN }); // device 2
    const rt1 = cookieOf(first, RT)!;
    const rt2 = cookieOf(second, RT)!;
    const res = await change(a, second.body.accessToken, rt2, { currentPin: PIN, newPin: NEW });
    expect(res.status).toBe(200);
    // device 1: everything dead
    expect((await request(a).get('/v1/auth/me').set('Authorization', `Bearer ${first.body.accessToken}`)).status).toBe(401);
    expect((await request(a).post('/v1/auth/refresh').set(CLIENT).set('Cookie', cookieHeader(RT, rt1))).status).toBe(401);
    // device 2: the new access token works and its refresh cookie still rotates
    expect((await request(a).get('/v1/auth/me').set('Authorization', `Bearer ${res.body.accessToken}`)).status).toBe(200);
    expect((await request(a).post('/v1/auth/refresh').set(CLIENT).set('Cookie', cookieHeader(RT, rt2))).status).toBe(200);
    // the OLD access token of the calling device is superseded too
    expect((await request(a).get('/v1/auth/me').set('Authorization', `Bearer ${second.body.accessToken}`)).status).toBe(401);
  });

  it('is audit-logged (without any PIN); without the refresh cookie all sessions are revoked', async () => {
    const a = app();
    const reg = await registerCustomer(a);
    const res = await change(a, reg.body.accessToken, undefined, { currentPin: PIN, newPin: NEW });
    expect(res.status).toBe(200);
    const { AuditLogModel } = await import('../src/modules/audit/audit.model');
    const row = (await AuditLogModel.findOne({ action: 'customer.pin_changed' }).lean())!;
    expect(row.details).toEqual({ keptCurrentSession: false });
    expect(JSON.stringify(row)).not.toMatch(new RegExp(`${PIN}|${NEW}`));
    expect((await request(a).post('/v1/auth/refresh').set(CLIENT).set('Cookie', cookieHeader(RT, cookieOf(reg, RT)!))).status).toBe(401);
  });
});
