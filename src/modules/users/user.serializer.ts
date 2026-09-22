import type { UserDoc } from './user.model';

/** Customer profile in the shape the storefront's `AuthProfile` uses (plus role). */
export const toCustomerProfile = (u: UserDoc) => ({
  id: String(u._id),
  name: u.name,
  email: u.email,
  phone: u.phone,
  avatarUrl: u.avatarUrl,
  role: u.role,
  addresses: u.addresses ?? [],
});

/** Session shape used by the admin app (`AdminSession`). */
export const toAdminSession = (u: UserDoc) => ({ userId: String(u._id), name: u.name, email: u.email ?? '', role: u.role });

/** `StaffMember` shape used by the admin app. */
export const toStaffMember = (u: UserDoc, opts: { isPrimary?: boolean } = {}) => ({
  id: String(u._id),
  name: u.name,
  email: u.email ?? '',
  role: u.role,
  status: u.isActive ? ('Active' as const) : ('Inactive' as const),
  isPrimary: opts.isPrimary ?? u.role === 'super_admin',
  createdAt: u.createdAt?.toISOString(),
});
