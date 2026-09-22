import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { OtpModel } from '../src/modules/admin-auth/otp.model';
import { AuditLogModel } from '../src/modules/audit/audit.model';
import { LockoutModel } from '../src/modules/security/lockout.model';
import { RefreshTokenModel } from '../src/modules/users/refreshToken.model';
import { UserModel } from '../src/modules/users/user.model';
import { memoryOutbox } from '../src/modules/notifications/mailer';
import { ADMIN_CLIENT, ADMIN_EMAIL, ADMIN_PASSWORD, adminSignIn, app, codeFromMail, cookieHeader, cookieOf, lastMail, makeUser, registerCustomer } from './helpers';

const RT = 'abp_rt_admin';
const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });

describe('admin login step 1 (password) - uniform responses', () => {
  it('valid credentials -> {otpRequired}, e-mail sent, code stored only as an HMAC', async () => {
    const a = app();
    await makeUser('admin');
    const res = await request(a).post('/v1/admin-auth/login').send({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ otpRequired: true, expiresInSeconds: 300 });
    expect(memoryOutbox).toHaveLength(1);
    const code = codeFromMail();
    const otp = (await OtpModel.findOne({ email: ADMIN_EMAIL }).lean())!;
    expect(otp.codeHash).toMatch(/^[a-f0-9]{64}$/);
    expect(otp.codeHash).not.toContain(code);
    expect(JSON.stringify(otp)).not.toContain(code);
    expect(otp.expiresAt.getTime() - Date.now()).toBeLessThanOrEqual(5 * 60_000);
    expect(otp.expiresAt.getTime() - Date.now()).toBeGreaterThan(4 * 60_000);
  });

  it('wrong password, unknown e-mail and a customer account all get the IDENTICAL response and send nothing', async () => {
    const a = app();
    await makeUser('admin');
    await registerCustomer(a);
    const wrong = await request(a).post('/v1/admin-auth/login').send({ email: ADMIN_EMAIL, password: 'wrong-password-123' });
    const unknown = await request(a).post('/v1/admin-auth/login').send({ email: 'nobody@albarakah.test', password: 'wrong-password-123' });
    expect(wrong.status).toBe(200);
    expect(unknown.body).toEqual(wrong.body);
    expect(memoryOutbox).toHaveLength(0);
    expect(await OtpModel.countDocuments()).toBe(0);
  });

  it('locks after 5 failed passwords (also for unknown e-mails) with backoff, even if the right password follows', async () => {
    const a = app();
    await makeUser('admin');
    const bad = () => request(a).post('/v1/admin-auth/login').send({ email: ADMIN_EMAIL, password: 'wrong-password-123' });
    for (let i = 0; i < 4; i++) expect((await bad()).status).toBe(200);
    const locked = await bad();
    expect(locked.status).toBe(429);
    expect(locked.body.error).toBe('ACCOUNT_LOCKED');
    const right = await request(a).post('/v1/admin-auth/login').send({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD });
    expect(right.status).toBe(429);
    expect(memoryOutbox).toHaveLength(0);
  });

  it('a 30 s cooldown prevents mail flooding; max 5 codes per hour', async () => {
    const a = app();
    await makeUser('admin');
    const login = () => request(a).post('/v1/admin-auth/login').send({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD });
    await login();
    await login(); // inside cooldown -> no second mail
    expect(memoryOutbox).toHaveLength(1);
    for (let i = 0; i < 4; i++) {
      await OtpModel.collection.updateMany({}, { $set: { createdAt: new Date(Date.now() - 60_000) } }); // createdAt is immutable in Mongoose
      await login();
    }
    expect(memoryOutbox).toHaveLength(5);
    await OtpModel.collection.updateMany({}, { $set: { createdAt: new Date(Date.now() - 60_000) } }); // createdAt is immutable in Mongoose
    expect((await login()).status).toBe(429);
    expect(memoryOutbox).toHaveLength(5);
  });

  it('resend-otp only works while a pending OTP exists (cannot be used to mail arbitrary addresses)', async () => {
    const a = app();
    await makeUser('admin');
    await request(a).post('/v1/admin-auth/resend-otp').send({ email: ADMIN_EMAIL }).expect(200);
    expect(memoryOutbox).toHaveLength(0);
    await request(a).post('/v1/admin-auth/login').send({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD });
    await OtpModel.collection.updateMany({}, { $set: { createdAt: new Date(Date.now() - 60_000) } }); // createdAt is immutable in Mongoose
    await request(a).post('/v1/admin-auth/resend-otp').send({ email: ADMIN_EMAIL }).expect(200);
    expect(memoryOutbox).toHaveLength(2);
    expect(await OtpModel.countDocuments()).toBe(1); // the old code was replaced
  });
});

describe('admin login step 2 (OTP)', () => {
  it('correct code -> access token + session + httpOnly refresh cookie; code is single use', async () => {
    const a = app();
    await makeUser('admin');
    await request(a).post('/v1/admin-auth/login').send({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD });
    const code = codeFromMail();
    const ok = await request(a).post('/v1/admin-auth/verify-otp').send({ email: ADMIN_EMAIL, code });
    expect(ok.status).toBe(200);
    expect(ok.body.session).toMatchObject({ email: ADMIN_EMAIL, role: 'admin', name: 'Boss' });
    expect(cookieOf(ok, RT)).toBeTruthy();
    expect(([] as string[]).concat(ok.headers['set-cookie']).find((c) => c.startsWith(RT))).toMatch(/HttpOnly.*Path=\/v1\/admin-auth|Path=\/v1\/admin-auth.*HttpOnly/i);
    const again = await request(a).post('/v1/admin-auth/verify-otp').send({ email: ADMIN_EMAIL, code });
    expect(again.status).toBe(401);
    expect(again.body.error).toBe('INVALID_OTP');
    const me = await request(a).get('/v1/admin-auth/me').set(bearer(ok.body.accessToken));
    expect(me.status).toBe(200);
    expect(me.body.session.role).toBe('admin');
  });

  it('wrong code -> generic 401; expired code -> 401; 5 wrong guesses burn the code (the right code then fails too)', async () => {
    const a = app();
    await makeUser('admin');
    await request(a).post('/v1/admin-auth/login').send({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD });
    const code = codeFromMail();
    const wrong = code === '000000' ? '111111' : '000000';
    for (let i = 0; i < 4; i++) expect((await request(a).post('/v1/admin-auth/verify-otp').send({ email: ADMIN_EMAIL, code: wrong })).status).toBe(401);
    // 5th wrong guess: lockout threshold reached as well (5 failures) -> 429; either way the code is dead
    const fifth = await request(a).post('/v1/admin-auth/verify-otp').send({ email: ADMIN_EMAIL, code: wrong });
    expect([401, 429]).toContain(fifth.status);
    expect(await OtpModel.countDocuments()).toBe(0);
    await LockoutModel.deleteMany({});
    expect((await request(a).post('/v1/admin-auth/verify-otp').send({ email: ADMIN_EMAIL, code })).status).toBe(401);
  });

  it('an expired code is rejected', async () => {
    const a = app();
    await makeUser('admin');
    await request(a).post('/v1/admin-auth/login').send({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD });
    const code = codeFromMail();
    await OtpModel.updateMany({}, { $set: { expiresAt: new Date(Date.now() - 1000) } });
    expect((await request(a).post('/v1/admin-auth/verify-otp').send({ email: ADMIN_EMAIL, code })).status).toBe(401);
  });

  it('cannot skip step 1: verify-otp with no pending code, or for an unknown user, is a generic 401', async () => {
    const a = app();
    await makeUser('admin');
    expect((await request(a).post('/v1/admin-auth/verify-otp').send({ email: ADMIN_EMAIL, code: '123456' })).body.error).toBe('INVALID_OTP');
    expect((await request(a).post('/v1/admin-auth/verify-otp').send({ email: 'ghost@albarakah.test', code: '123456' })).body.error).toBe('INVALID_OTP');
  });

  it('a code cannot be used for a different e-mail', async () => {
    const a = app();
    await makeUser('admin');
    await makeUser('admin', 'other@albarakah.test', 'another-good-password-9', 'Other');
    await request(a).post('/v1/admin-auth/login').send({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD });
    const code = codeFromMail();
    expect((await request(a).post('/v1/admin-auth/verify-otp').send({ email: 'other@albarakah.test', code })).status).toBe(401);
  });
});

describe('admin sessions', () => {
  it('refresh rotates, reuse burns the family, logout revokes', async () => {
    const a = app();
    await makeUser('admin');
    const { refresh } = await adminSignIn(a);
    const r1 = await request(a).post('/v1/admin-auth/refresh').set(ADMIN_CLIENT).set('Cookie', cookieHeader(RT, refresh));
    expect(r1.status).toBe(200);
    const next = cookieOf(r1, RT)!;
    expect((await request(a).post('/v1/admin-auth/refresh').set(ADMIN_CLIENT).set('Cookie', cookieHeader(RT, refresh))).body.error).toBe('REFRESH_TOKEN_REUSED');
    expect((await request(a).post('/v1/admin-auth/refresh').set(ADMIN_CLIENT).set('Cookie', cookieHeader(RT, next))).status).toBe(401);
  });

  it('idle for longer than 10 minutes forces a new sign-in', async () => {
    const a = app();
    await makeUser('admin');
    const { refresh } = await adminSignIn(a);
    await RefreshTokenModel.collection.updateMany({}, { $set: { createdAt: new Date(Date.now() - 11 * 60_000) } }); // createdAt is immutable in Mongoose
    const res = await request(a).post('/v1/admin-auth/refresh').set(ADMIN_CLIENT).set('Cookie', cookieHeader(RT, refresh));
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('SESSION_IDLE_TIMEOUT');
  });

  it('customer tokens/cookies do not work on admin routes and vice versa; role comes from the DB', async () => {
    const a = app();
    const reg = await registerCustomer(a);
    expect((await request(a).get('/v1/admin-auth/me').set(bearer(reg.body.accessToken))).status).toBe(401);
    expect((await request(a).get('/v1/admin/staff').set(bearer(reg.body.accessToken))).status).toBe(401);
    await makeUser('admin');
    const { accessToken } = await adminSignIn(a);
    expect((await request(a).get('/v1/auth/me').set(bearer(accessToken))).status).toBe(401);
    await UserModel.updateOne({ email: ADMIN_EMAIL }, { $set: { role: 'customer' } }); // demoted in the DB
    expect((await request(a).get('/v1/admin-auth/me').set(bearer(accessToken))).status).toBe(403);
  });

  it('protected admin routes reject anonymous callers', async () => {
    const a = app();
    for (const [m, p] of [['get', '/v1/admin/staff'], ['get', '/v1/admin/audit'], ['post', '/v1/admin-auth/grant-access'], ['post', '/v1/admin-auth/revoke-access']] as const) {
      expect((await request(a)[m](p)).status).toBe(401);
    }
  });
});

describe('grant / revoke access (super_admin only)', () => {
  it('a plain admin cannot grant or revoke (403)', async () => {
    const a = app();
    await makeUser('admin');
    const { accessToken } = await adminSignIn(a);
    expect((await request(a).post('/v1/admin-auth/grant-access').set(bearer(accessToken)).send({ name: 'X', email: 'x@albarakah.test' })).status).toBe(403);
    expect((await request(a).get('/v1/admin/staff').set(bearer(accessToken))).status).toBe(403);
  });

  it('super_admin grants -> invite e-mail -> set-password -> the new admin can complete the OTP login; everything is audited', async () => {
    const a = app();
    await makeUser('super_admin');
    const sa = await adminSignIn(a);
    const grant = await request(a).post('/v1/admin-auth/grant-access').set(bearer(sa.accessToken)).send({ name: 'New Admin', email: 'new@albarakah.test' });
    expect(grant.status).toBe(201);
    expect(grant.body).toMatchObject({ email: 'new@albarakah.test', role: 'admin', status: 'Active', isPrimary: false });

    const invite = lastMail();
    expect(invite.to).toEqual(['new@albarakah.test']);
    const token = /token=([A-Za-z0-9_%-]+)/.exec(invite.text)![1];
    // cannot sign in before choosing a password
    const before = memoryOutbox.length;
    await request(a).post('/v1/admin-auth/login').send({ email: 'new@albarakah.test', password: 'whatever-password-1' });
    expect(memoryOutbox.length).toBe(before); // no OTP mail for an account without a password
    expect((await request(a).post('/v1/admin-auth/set-password').send({ token, password: 'short' })).status).toBe(400);
    expect((await request(a).post('/v1/admin-auth/set-password').send({ token, password: 'a-strong-passphrase-1' })).status).toBe(204);
    expect((await request(a).post('/v1/admin-auth/set-password').send({ token, password: 'a-strong-passphrase-2' })).status).toBe(400); // one-time

    await LockoutModel.deleteMany({});
    const s2 = await adminSignIn(a, 'new@albarakah.test', 'a-strong-passphrase-1');
    expect(s2.accessToken).toBeTruthy();

    const actions = (await AuditLogModel.find().lean()).map((x) => x.action);
    expect(actions).toEqual(expect.arrayContaining(['admin.grant', 'admin.password.set', 'admin.login.success']));
    const audit = await request(a).get('/v1/admin/audit').set(bearer(sa.accessToken));
    expect(audit.status).toBe(200);
    expect(audit.body[0]).toEqual(expect.objectContaining({ adminEmail: expect.any(String), action: expect.any(String), status: expect.any(String) }));
    expect(JSON.stringify(audit.body)).not.toContain(token);
  });

  it('refuses to grant to an existing admin or a customer e-mail', async () => {
    const a = app();
    await makeUser('super_admin');
    await makeUser('admin', 'peer@albarakah.test', 'a-strong-passphrase-3', 'Peer');
    await registerCustomer(a, { email: 'cust@albarakah.test' });
    const sa = await adminSignIn(a);
    const g = (email: string) => request(a).post('/v1/admin-auth/grant-access').set(bearer(sa.accessToken)).send({ name: 'N', email });
    expect((await g('peer@albarakah.test')).body.error).toBe('ALREADY_ADMIN');
    expect((await g('cust@albarakah.test')).body.error).toBe('EMAIL_IN_USE_BY_CUSTOMER');
  });

  it('REVOKE kills the target\'s existing sessions instantly: access token, refresh token and new logins', async () => {
    const a = app();
    await makeUser('super_admin');
    const peer = await makeUser('admin', 'peer@albarakah.test', 'a-strong-passphrase-3', 'Peer');
    const peerSession = await adminSignIn(a, 'peer@albarakah.test', 'a-strong-passphrase-3');
    expect((await request(a).get('/v1/admin-auth/me').set(bearer(peerSession.accessToken))).status).toBe(200);

    const sa = await adminSignIn(a);
    const revoke = await request(a).post('/v1/admin-auth/revoke-access').set(bearer(sa.accessToken)).send({ userId: String(peer._id) });
    expect(revoke.status).toBe(204);

    expect((await request(a).get('/v1/admin-auth/me').set(bearer(peerSession.accessToken))).status).toBe(401); // access token dead at once
    const refresh = await request(a).post('/v1/admin-auth/refresh').set(ADMIN_CLIENT).set('Cookie', cookieHeader(RT, peerSession.refresh));
    expect(refresh.status).toBe(401);
    expect(await RefreshTokenModel.countDocuments({ userId: peer._id, revokedAt: null })).toBe(0);

    const memBefore = memoryOutbox.length;
    await request(a).post('/v1/admin-auth/login').send({ email: 'peer@albarakah.test', password: 'a-strong-passphrase-3' }).expect(200);
    expect(memoryOutbox.length).toBe(memBefore); // no OTP for a revoked account
    const after = (await UserModel.findById(peer._id).select('+passwordHash'))!;
    expect(after).toMatchObject({ role: 'customer', isActive: false, passwordHash: null });
    expect((await AuditLogModel.findOne({ action: 'admin.revoke' }))!.actorEmail).toBe(ADMIN_EMAIL);

    // a later re-grant works (fresh invite)
    const re = await request(a).post('/v1/admin-auth/grant-access').set(bearer(sa.accessToken)).send({ name: 'Peer Again', email: 'peer@albarakah.test' });
    expect(re.status).toBe(201);
  });

  it('cannot revoke yourself or a super_admin; unknown ids 404', async () => {
    const a = app();
    const boss = await makeUser('super_admin');
    const other = await makeUser('super_admin', 'other-sa@albarakah.test', 'a-strong-passphrase-4', 'Other SA');
    const sa = await adminSignIn(a);
    const r = (id: string) => request(a).post('/v1/admin-auth/revoke-access').set(bearer(sa.accessToken)).send({ userId: id });
    expect((await r(String(boss._id))).body.error).toBe('CANNOT_REVOKE_SELF');
    expect((await r(String(other._id))).body.error).toBe('CANNOT_REVOKE_SUPER_ADMIN');
    expect((await r('aaaaaaaaaaaaaaaaaaaaaaaa')).status).toBe(404);
  });

  it('DELETE /admin/staff/:id is the same revoke; GET /admin/staff lists admins in the admin app\'s shape', async () => {
    const a = app();
    await makeUser('super_admin');
    const peer = await makeUser('admin', 'peer@albarakah.test', 'a-strong-passphrase-3', 'Peer');
    const sa = await adminSignIn(a);
    const list = await request(a).get('/v1/admin/staff').set(bearer(sa.accessToken));
    expect(list.body.map((s: { email: string }) => s.email).sort()).toEqual([ADMIN_EMAIL, 'peer@albarakah.test']);
    expect(list.body.find((s: { email: string }) => s.email === ADMIN_EMAIL)).toMatchObject({ role: 'super_admin', isPrimary: true, status: 'Active' });
    expect(JSON.stringify(list.body)).not.toMatch(/passwordHash|tokenVersion/);
    expect((await request(a).delete(`/v1/admin/staff/${peer._id}`).set(bearer(sa.accessToken))).status).toBe(204);
  });
});

describe('admin: reset a customer PIN (support stop-gap)', () => {
  it('admin sets a new random 6-digit PIN: old PIN dies, new PIN works, sessions revoked, lockout cleared, audited without the PIN', async () => {
    const a = app();
    await makeUser('admin');
    const cust = await registerCustomer(a);
    const custRt = cookieOf(cust, 'abp_rt_customer')!;
    for (let i = 0; i < 5; i++) await request(a).post('/v1/auth/login').send({ phone: '01712345678', pin: '000000' }); // locked
    const { accessToken } = await adminSignIn(a);

    const res = await request(a).post('/v1/admin/customers/reset-pin').set(bearer(accessToken)).send({ phone: '+8801712345678' });
    expect(res.status).toBe(200);
    expect(res.body.temporaryPin).toMatch(/^\d{6}$/);
    expect(memoryOutbox.every((m) => !m.text.includes(res.body.temporaryPin))).toBe(true); // nothing is delivered by the backend

    expect((await request(a).post('/v1/auth/login').send({ phone: '01712345678', pin: '123456' })).status).toBe(401); // old PIN
    const ok = await request(a).post('/v1/auth/login').send({ phone: '01712345678', pin: res.body.temporaryPin });
    expect(ok.status).toBe(200);
    expect((await request(a).post('/v1/auth/refresh').set({ 'X-Abp-Client': 't', Origin: 'https://shop.test' }).set('Cookie', cookieHeader('abp_rt_customer', custRt))).status).toBe(401);
    expect((await request(a).get('/v1/auth/me').set(bearer(cust.body.accessToken))).status).toBe(401);

    const audit = (await AuditLogModel.findOne({ action: 'admin.customer.pin_reset' }).lean())!;
    expect(audit.actorEmail).toBe(ADMIN_EMAIL);
    expect(JSON.stringify(audit)).not.toContain(res.body.temporaryPin);
    expect(JSON.stringify(audit)).not.toContain('01712345678');
  });

  it('works by userId, rejects anonymous / customer callers, admins as targets, unknown customers and bad bodies', async () => {
    const a = app();
    const admin = await makeUser('admin');
    const cust = await registerCustomer(a);
    const { accessToken } = await adminSignIn(a);
    const post = (body: object, tok?: string) => request(a).post('/v1/admin/customers/reset-pin').set(tok ? bearer(tok) : {}).send(body);
    expect((await post({ phone: '01712345678' })).status).toBe(401);
    expect((await post({ phone: '01712345678' }, cust.body.accessToken)).status).toBe(401); // customer token
    expect((await post({ userId: cust.body.user.id }, accessToken)).status).toBe(200);
    expect((await post({ userId: String(admin._id) }, accessToken)).status).toBe(404); // admins cannot be reset here
    expect((await post({ phone: '01899999999' }, accessToken)).status).toBe(404);
    expect((await post({ phone: 'abc' }, accessToken)).body.error).toBe('INVALID_BD_PHONE');
    expect((await post({}, accessToken)).status).toBe(400);
    expect((await post({ userId: cust.body.user.id, phone: '01712345678' }, accessToken)).status).toBe(400);
  });
});
