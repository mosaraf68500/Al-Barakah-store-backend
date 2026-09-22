import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { UserModel } from '../src/modules/users/user.model';
import { app, auth, registerCustomer } from './helpers';

let seq = 90_000_000;
const nextPhone = () => `017${String(seq++).padStart(8, '0')}`;
async function customer(a: ReturnType<typeof app>, over: Record<string, unknown> = {}) {
  const res = await registerCustomer(a, { phone: nextPhone(), ...over });
  return { token: res.body.accessToken as string, id: res.body.user.id as string };
}

describe('PATCH /auth/me - profile (closes the Module 4 gap)', () => {
  it('updates name/email/avatarUrl; phone is NOT accepted (it is the login identity, like legacy locked its e-mail field)', async () => {
    const a = app();
    const c = await customer(a);
    const res = await request(a).patch('/v1/auth/me').set(auth(c.token)).send({ name: 'New Name', email: 'new@example.com', avatarUrl: 'https://cdn.test/a.png', phone: '01799999999' });
    expect(res.status).toBe(200);
    expect(res.body.user).toMatchObject({ name: 'New Name', email: 'new@example.com', avatarUrl: 'https://cdn.test/a.png' });
    const stored = await UserModel.findById(c.id).lean();
    expect(stored!.phone).not.toBe('+8801799999999'); // untouched by the profile PATCH
    expect(stored!.name).toBe('New Name');
  });

  it('requires auth; an empty body is a harmless no-op; a taken e-mail is 409', async () => {
    const a = app();
    expect((await request(a).patch('/v1/auth/me').send({ name: 'X' })).status).toBe(401);
    const c1 = await customer(a);
    await request(a).patch('/v1/auth/me').set(auth(c1.token)).send({ email: 'taken@example.com' }).expect(200);
    const c2 = await customer(a);
    expect((await request(a).patch('/v1/auth/me').set(auth(c2.token)).send({})).status).toBe(200);
    const conflict = await request(a).patch('/v1/auth/me').set(auth(c2.token)).send({ email: 'taken@example.com' });
    expect(conflict.status).toBe(409);
    expect(conflict.body.error).toBe('EMAIL_IN_USE');
  });
});

describe('address book (new server-side persistence for what legacy kept in localStorage - SECURITY_RISKS #14)', () => {
  it('empty for a new customer; requires auth', async () => {
    const a = app();
    const c = await customer(a);
    expect((await request(a).get('/v1/auth/addresses').set(auth(c.token))).body).toEqual([]);
    expect((await request(a).get('/v1/auth/addresses')).status).toBe(401);
    expect((await request(a).post('/v1/auth/addresses').send({ name: 'X', phone: '01712345678', address: 'a' })).status).toBe(401);
  });

  it('adding the FIRST address makes it the default automatically, even if isDefault was not sent', async () => {
    const a = app();
    const c = await customer(a);
    const res = await request(a).post('/v1/auth/addresses').set(auth(c.token)).send({ name: 'Home', phone: '01712345678', address: '12 Road 5, Dhanmondi', district: 'Dhaka' });
    expect(res.status).toBe(201);
    expect(res.body).toEqual([expect.objectContaining({ name: 'Home', district: 'Dhaka', isDefault: true, id: expect.any(String) })]);
    expect(res.body[0].phone).toBe('01712345678'); // normalised to the same local format the account's own phone uses
  });

  it('setting isDefault:true on a new/updated address demotes every other one - exactly one default at a time', async () => {
    const a = app();
    const c = await customer(a);
    const r1 = await request(a).post('/v1/auth/addresses').set(auth(c.token)).send({ name: 'Home', phone: '01712345678', address: 'a' });
    const r2 = await request(a).post('/v1/auth/addresses').set(auth(c.token)).send({ name: 'Office', phone: '01712345678', address: 'b', isDefault: true });
    expect(r2.body.map((x: { name: string; isDefault: boolean }) => [x.name, x.isDefault])).toEqual([['Home', false], ['Office', true]]);
    const homeId = r1.body[0].id;
    const r3 = await request(a).put(`/v1/auth/addresses/${homeId}`).set(auth(c.token)).send({ isDefault: true });
    expect(r3.body.map((x: { name: string; isDefault: boolean }) => [x.name, x.isDefault])).toEqual([['Home', true], ['Office', false]]);
  });

  it('PUT updates individual fields (incl. re-validating a changed phone) and 404s for an unknown id', async () => {
    const a = app();
    const c = await customer(a);
    const added = await request(a).post('/v1/auth/addresses').set(auth(c.token)).send({ name: 'Home', phone: '01712345678', address: 'old address', label: 'House' });
    const id = added.body[0].id;
    const updated = await request(a).put(`/v1/auth/addresses/${id}`).set(auth(c.token)).send({ address: 'new address', phone: '01899999999' });
    expect(updated.body[0]).toMatchObject({ address: 'new address', phone: '01899999999', label: 'House', name: 'Home' }); // untouched fields survive a partial PUT
    expect((await request(a).put(`/v1/auth/addresses/${id}`).set(auth(c.token)).send({ phone: 'not-a-phone' })).body.error).toBe('INVALID_BD_PHONE');
    expect((await request(a).put('/v1/auth/addresses/ghost').set(auth(c.token)).send({ label: 'x' })).status).toBe(404);
  });

  it('DELETE removes one address; deleting the default promotes the next remaining one so there is never a silent zero-default state; 404 twice', async () => {
    const a = app();
    const c = await customer(a);
    const r1 = await request(a).post('/v1/auth/addresses').set(auth(c.token)).send({ name: 'Home', phone: '01712345678', address: 'a' }); // becomes default
    const r2 = await request(a).post('/v1/auth/addresses').set(auth(c.token)).send({ name: 'Office', phone: '01712345678', address: 'b' });
    const homeId = r1.body[0].id;
    const del = await request(a).delete(`/v1/auth/addresses/${homeId}`).set(auth(c.token));
    expect(del.status).toBe(200);
    expect(del.body).toEqual([expect.objectContaining({ name: 'Office', isDefault: true })]); // promoted automatically
    void r2;
    const officeId = del.body[0].id;
    expect((await request(a).delete(`/v1/auth/addresses/${officeId}`).set(auth(c.token))).body).toEqual([]);
    expect((await request(a).delete(`/v1/auth/addresses/${officeId}`).set(auth(c.token))).status).toBe(404);
  });

  it('one customer cannot see or modify another customer\'s addresses', async () => {
    const a = app();
    const c1 = await customer(a);
    const c2 = await customer(a);
    const added = await request(a).post('/v1/auth/addresses').set(auth(c1.token)).send({ name: 'Home', phone: '01712345678', address: 'a' });
    const id = added.body[0].id;
    expect((await request(a).get('/v1/auth/addresses').set(auth(c2.token))).body).toEqual([]);
    expect((await request(a).put(`/v1/auth/addresses/${id}`).set(auth(c2.token)).send({ label: 'stolen' })).status).toBe(404);
    expect((await request(a).delete(`/v1/auth/addresses/${id}`).set(auth(c2.token))).status).toBe(404);
    expect((await request(a).get('/v1/auth/addresses').set(auth(c1.token))).body[0]).not.toMatchObject({ label: 'stolen' });
  });

  it('validation: name/address required, phone must be a valid BD mobile', async () => {
    const a = app();
    const c = await customer(a);
    expect((await request(a).post('/v1/auth/addresses').set(auth(c.token)).send({ name: '', phone: '01712345678', address: 'a' })).body.error).toBe('VALIDATION_ERROR');
    expect((await request(a).post('/v1/auth/addresses').set(auth(c.token)).send({ name: 'X', phone: '01712345678', address: '' })).body.error).toBe('VALIDATION_ERROR');
    expect((await request(a).post('/v1/auth/addresses').set(auth(c.token)).send({ name: 'X', phone: '123', address: 'a' })).body.error).toBe('INVALID_BD_PHONE');
  });
});
