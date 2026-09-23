import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { app, adminSignIn, auth, makeUser, registerCustomer } from './helpers';

type Role = 'anon' | 'customer' | 'admin' | 'super';
type Gate = 'open' | 'customer' | 'admin' | 'super' | 'cron';

/** Every mounted route, and who may pass the auth gate. A pass is any status other than 401/403 (validation 400 is a pass). */
const ROUTES: { method: 'get' | 'post' | 'put' | 'patch' | 'delete'; path: string; gate: Gate }[] = [
  { method: 'get', path: '/v1/health', gate: 'open' },
  { method: 'get', path: '/v1/products', gate: 'open' },
  { method: 'get', path: '/v1/products/missing', gate: 'open' },
  { method: 'get', path: '/v1/categories', gate: 'open' },
  { method: 'get', path: '/v1/settings/public', gate: 'open' },
  { method: 'get', path: '/v1/reviews', gate: 'open' },
  { method: 'post', path: '/v1/coupons/validate', gate: 'open' },
  { method: 'post', path: '/v1/orders', gate: 'open' },
  { method: 'get', path: '/v1/orders/track/AB-000000', gate: 'open' },
  { method: 'post', path: '/v1/auth/register', gate: 'open' },
  { method: 'post', path: '/v1/auth/login', gate: 'open' },
  { method: 'post', path: '/v1/admin-auth/login', gate: 'open' },
  { method: 'get', path: '/v1/auth/me', gate: 'customer' },
  { method: 'patch', path: '/v1/auth/me', gate: 'customer' },
  { method: 'get', path: '/v1/auth/addresses', gate: 'customer' },
  { method: 'post', path: '/v1/auth/addresses', gate: 'customer' },
  { method: 'post', path: '/v1/auth/change-pin', gate: 'customer' },
  { method: 'get', path: '/v1/orders/my', gate: 'customer' },
  { method: 'get', path: '/v1/wishlist', gate: 'customer' },
  { method: 'post', path: '/v1/wishlist/missing', gate: 'customer' },
  { method: 'delete', path: '/v1/wishlist/missing', gate: 'customer' },
  { method: 'post', path: '/v1/reviews', gate: 'customer' },
  { method: 'get', path: '/v1/admin/products', gate: 'admin' },
  { method: 'post', path: '/v1/admin/products', gate: 'admin' },
  { method: 'get', path: '/v1/admin/categories', gate: 'admin' },
  { method: 'post', path: '/v1/admin/categories', gate: 'admin' },
  { method: 'get', path: '/v1/admin/coupons', gate: 'admin' },
  { method: 'post', path: '/v1/admin/coupons', gate: 'admin' },
  { method: 'get', path: '/v1/admin/orders', gate: 'admin' },
  { method: 'get', path: '/v1/admin/reviews', gate: 'admin' },
  { method: 'get', path: '/v1/admin/settings', gate: 'admin' },
  { method: 'patch', path: '/v1/admin/settings', gate: 'admin' },
  { method: 'get', path: '/v1/admin/media', gate: 'admin' },
  { method: 'post', path: '/v1/admin/media/sign', gate: 'admin' },
  { method: 'get', path: '/v1/admin/health', gate: 'admin' },
  { method: 'post', path: '/v1/admin/customers/reset-pin', gate: 'admin' },
  { method: 'get', path: '/v1/admin/backup', gate: 'super' },
  { method: 'post', path: '/v1/admin/backup/restore', gate: 'super' },
  { method: 'get', path: '/v1/admin/settings/secrets', gate: 'super' },
  { method: 'get', path: '/v1/admin/staff', gate: 'super' },
  { method: 'get', path: '/v1/admin/audit', gate: 'super' },
  { method: 'post', path: '/v1/admin-auth/grant-access', gate: 'super' },
  { method: 'post', path: '/v1/admin-auth/revoke-access', gate: 'super' },
  { method: 'get', path: '/v1/internal/cron/cleanup', gate: 'cron' },
  { method: 'get', path: '/v1/internal/cron/orders/expire-pending', gate: 'cron' },
];

const ROLES: Role[] = ['anon', 'customer', 'admin', 'super'];

function allowed(gate: Gate, role: Role): boolean {
  if (gate === 'open') return true;
  if (gate === 'cron') return false;
  if (gate === 'customer') return role === 'customer';
  if (gate === 'admin') return role === 'admin' || role === 'super';
  return role === 'super';
}

describe('authz matrix — every route × anon / customer / admin / super_admin', () => {
  it('denies the wrong audience or role and lets the right one past the gate', async () => {
    const a = app();
    await makeUser('admin', 'staff@albarakah.test');
    await makeUser('super_admin', 'root@albarakah.test');
    const adminTok = (await adminSignIn(a, 'staff@albarakah.test')).accessToken;
    const superTok = (await adminSignIn(a, 'root@albarakah.test')).accessToken;
    const customerTok = (await registerCustomer(a, { phone: '01800000001' })).body.accessToken as string;
    const tokens: Record<Role, string> = { anon: '', customer: customerTok, admin: adminTok, super: superTok };

    const failures: string[] = [];
    for (const route of ROUTES) {
      for (const role of ROLES) {
        const req = request(a)[route.method](route.path);
        if (tokens[role]) req.set(auth(tokens[role]));
        if (route.method !== 'get') req.send({});
        const status = (await req).status;
        const denied = status === 401 || status === 403;
        const ok = allowed(route.gate, role);
        if (denied === ok) failures.push(`${role} ${route.method.toUpperCase()} ${route.path} → ${status} (gate ${route.gate})`);
        if (route.gate === 'super' && role === 'admin' && status !== 403) failures.push(`admin should be 403 on ${route.path}, got ${status}`);
        if ((route.gate === 'admin' || route.gate === 'super' || route.gate === 'customer' || route.gate === 'cron') && role === 'anon' && status !== 401) {
          failures.push(`anon should be 401 on ${route.path}, got ${status}`);
        }
      }
    }
    expect(failures).toEqual([]);
  }, 60_000);
});
