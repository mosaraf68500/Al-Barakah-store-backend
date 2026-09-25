import jwt from 'jsonwebtoken';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { __setGoogleVerifierForTests, type GoogleIdentity } from '../src/modules/auth/googleIdentity';
import { OrderModel } from '../src/modules/orders/order.model';
import { UserModel } from '../src/modules/users/user.model';
import { PIN, app, auth, makeUser, registerCustomer } from './helpers';

const identity = (over: Partial<GoogleIdentity> = {}): GoogleIdentity => ({
  sub: 'google-sub-1',
  email: 'buyer@gmail.com',
  name: 'Buyer Khan',
  emailVerified: true,
  ...over,
});

function stub(profile: GoogleIdentity) {
  let audience = '';
  __setGoogleVerifierForTests(async (_token, aud) => {
    audience = aud;
    return profile;
  });
  return () => audience;
}

afterEach(() => {
  __setGoogleVerifierForTests(undefined);
});

describe('POST /v1/auth/google', () => {
  it('creates a customer with no phone, no PIN, and authProviders google', async () => {
    const seen = stub(identity());
    const a = app();
    const res = await request(a).post('/v1/auth/google').send({ idToken: 'verified-token' });
    expect(res.status).toBe(200);
    expect(seen()).toBe('test-google-client.apps.googleusercontent.com');
    expect(res.body.accessToken).toMatch(/^eyJ/);
    expect(res.body.refreshToken).toMatch(/^eyJ/);
    expect(res.body.user).toMatchObject({ name: 'Buyer Khan', email: 'buyer@gmail.com', role: 'customer' });
    expect(res.body.user.phone).toBeUndefined();

    const stored = await UserModel.findById(res.body.user.id).select('+passwordHash');
    expect(stored!.phone).toBeUndefined();
    expect(stored!.passwordHash).toBeNull();
    expect(stored!.googleId).toBe('google-sub-1');
    expect(stored!.authProviders).toEqual(['google']);
    expect(await UserModel.countDocuments({ email: 'buyer@gmail.com' })).toBe(1);
  });

  it('links a matching phone account, keeps the same userId and order, and phone+PIN still signs in', async () => {
    const a = app();
    const registered = await registerCustomer(a, { email: 'buyer@gmail.com', phone: '01700000991' });
    expect(registered.status).toBe(201);
    const userId = registered.body.user.id as string;
    await OrderModel.create({
      _id: 'AB-880001',
      userId,
      customer: { fullName: 'Test Customer', email: 'buyer@gmail.com', phone: '+8801700000991', address: 'House 1', city: 'Inside Dhaka' },
      phoneKey: '1700000991',
      items: [{ name: 'Attar', image: '', price: 100, quantity: 1, totalPrice: 100 }],
      subtotal: 100,
      total: 100,
      currency: 'BDT',
      stockDeducted: false,
    });

    stub(identity());
    const google = await request(a).post('/v1/auth/google').send({ idToken: 'verified-token' });
    expect(google.status).toBe(200);
    expect(google.body.user.id).toBe(userId);
    expect(google.body.user.phone).toBe('01700000991');

    const linked = await UserModel.findById(userId).select('+passwordHash');
    expect(linked!.googleId).toBe('google-sub-1');
    expect(linked!.authProviders).toEqual(['phone', 'google']);
    expect(linked!.passwordHash).toMatch(/^\$2/);
    expect(await UserModel.countDocuments({ email: 'buyer@gmail.com' })).toBe(1);

    const mine = await request(a).get('/v1/orders/my').set(auth(google.body.accessToken));
    expect(mine.status).toBe(200);
    expect(mine.body.items.map((o: { id: string }) => o.id)).toContain('AB-880001');

    const phone = await request(a).post('/v1/auth/login').send({ phone: '01700000991', pin: PIN });
    expect(phone.status).toBe(200);
    expect(phone.body.user.id).toBe(userId);
  });

  it('rejects an administrator email and does not create or change an account', async () => {
    const a = app();
    const admin = await makeUser('admin', 'boss-google@albarakah.test');
    stub(identity({ email: 'boss-google@albarakah.test', sub: 'google-sub-admin' }));
    const res = await request(a).post('/v1/auth/google').send({ idToken: 'verified-token' });
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ error: 'GOOGLE_EMAIL_IS_ADMIN', message: 'This email is used by an administrator account' });
    expect(await UserModel.countDocuments({ role: 'customer' })).toBe(0);
    const unchanged = await UserModel.findById(admin._id);
    expect(unchanged!.googleId).toBeUndefined();
    expect(unchanged!.authProviders).toBeUndefined();
    expect(unchanged!.role).toBe('admin');
  });

  it('rejects an unverified email and a tampered token', async () => {
    const a = app();
    stub(identity({ emailVerified: false }));
    const unverified = await request(a).post('/v1/auth/google').send({ idToken: 'unverified-token' });
    expect(unverified.status).toBe(401);
    expect(unverified.body.error).toBe('GOOGLE_EMAIL_UNVERIFIED');

    __setGoogleVerifierForTests(undefined);
    const tampered = await request(a).post('/v1/auth/google').send({ idToken: 'tampered' });
    expect(tampered.status).toBe(401);
    expect(tampered.body.error).toBe('INVALID_GOOGLE_TOKEN');
    expect(await UserModel.countDocuments({ role: 'customer' })).toBe(0);
  });

  it('issues the same customer JWT claims as phone+PIN login', async () => {
    const a = app();
    const phone = await registerCustomer(a, { phone: '01700000992' });
    stub(identity({ email: 'other@gmail.com', sub: 'google-sub-2' }));
    const google = await request(a).post('/v1/auth/google').send({ idToken: 'verified-token' });
    expect(google.status).toBe(200);

    const secret = process.env.JWT_ACCESS_SECRET!;
    const phoneClaims = jwt.verify(phone.body.accessToken, secret) as jwt.JwtPayload;
    const googleClaims = jwt.verify(google.body.accessToken, secret) as jwt.JwtPayload;
    expect(Object.keys(googleClaims).sort()).toEqual(Object.keys(phoneClaims).sort());
    expect(googleClaims).toMatchObject({ role: 'customer', aud: 'customer', tv: 0, sub: google.body.user.id });
    expect(googleClaims.jti).toEqual(expect.any(String));
    expect(googleClaims.exp).toBeGreaterThan(googleClaims.iat!);

    const me = await request(a).get('/v1/auth/me').set(auth(google.body.accessToken));
    expect(me.status).toBe(200);
    expect(me.body.user.id).toBe(google.body.user.id);
  });
});
