import type { Request, Response } from 'express';
import { randomUUID } from 'node:crypto';
import { ApiError } from '../../utils/ApiError';
import { burnComparison, compareSecret, hashSecret } from '../../utils/password';
import { normalizeBdMobile, phoneKey } from '../../utils/phone';
import { recordAudit } from '../audit/audit.service';
import { ACCOUNT_LOGIN_LIMIT } from '../../config/constants';
import { assertNotLocked, clearFailures, consumeLimit, recordFailure } from '../security';
import { RefreshTokenModel } from '../users/refreshToken.model';
import { UserModel, type UserDocument } from '../users/user.model';
import { sha256 } from '../../utils/crypto';
import { toCustomerProfile } from '../users/user.serializer';
import { issueSession, signAccessToken } from '../users/token.service';
import type { AddressInput, AddressPatch, LoginInput, RegisterInput, UpdateProfileInput } from './auth.validation';

const PIN_RE = /^\d{6}$/;

function assertPin(pin: string) {
  if (!pin) throw ApiError.badRequest('PIN_REQUIRED');
  if (!/^\d+$/.test(pin)) throw ApiError.badRequest('PIN_INVALID', 'PIN must contain digits only');
  if (pin.length < 6) throw ApiError.badRequest('PIN_TOO_SHORT', 'PIN must be exactly 6 digits');
  if (!PIN_RE.test(pin)) throw ApiError.badRequest('PIN_INVALID', 'PIN must be exactly 6 digits');
}

export async function registerCustomer(input: RegisterInput, req: Request, res: Response) {
  const phone = normalizeBdMobile(input.phone);
  if (!phone) throw ApiError.badRequest('INVALID_BD_PHONE');
  assertPin(input.pin);

  if (await UserModel.exists({ phone })) throw ApiError.conflict('ACCOUNT_ALREADY_EXISTS');
  if (input.email && (await UserModel.exists({ email: input.email }))) throw ApiError.conflict('EMAIL_IN_USE');

  let user;
  try {
    user = await UserModel.create({
      role: 'customer',
      name: input.name,
      phone,
      phoneKey: phoneKey(phone),
      email: input.email,
      passwordHash: await hashSecret(input.pin),
      addresses: input.address ? [{ id: randomUUID(), name: input.name, phone, address: input.address, district: 'Dhaka', isDefault: true }] : [],
      legacyUid: `phone_${phone}`,
    });
  } catch (e) {
    if ((e as { code?: number }).code === 11000) throw ApiError.conflict('ACCOUNT_ALREADY_EXISTS');
    throw e;
  }
  await recordAudit({ actor: { id: user._id, email: user.email, role: 'customer' }, action: 'customer.register', entity: 'User', entityId: String(user._id), req });
  const { token, expiresIn } = await issueSession(user, 'customer', req, res);
  return { accessToken: token, expiresIn, user: toCustomerProfile(user) };
}

export async function loginCustomer(input: LoginInput, req: Request, res: Response) {
  const phone = normalizeBdMobile(input.phone);
  if (!phone) throw ApiError.badRequest('INVALID_BD_PHONE');
  if (!input.pin) throw ApiError.badRequest('PIN_REQUIRED');

  const lockKey = `customer:${phoneKey(phone)}`;
  await assertNotLocked(lockKey);
  // secondary layer: the same account hammered from MANY IPs (the per-IP limiter on the route covers many accounts from ONE IP)
  const acct = await consumeLimit(`login-account:${lockKey}`, ACCOUNT_LOGIN_LIMIT.limit, ACCOUNT_LOGIN_LIMIT.windowMs);
  if (!acct.allowed) throw ApiError.tooMany('TOO_MANY_REQUESTS', 'Too many sign-in attempts for this account. Try again later.', acct.retryAfterSeconds);

  const user = await UserModel.findOne({ phone }).select('+passwordHash');
  let ok = false;
  if (user?.passwordHash) ok = (await compareSecret(input.pin, user.passwordHash)) && user.isActive && user.role === 'customer';
  else await burnComparison(input.pin);

  if (!ok) {
    const f = await recordFailure(lockKey);
    if (f.locked) {
      await recordAudit({ actor: { email: user?.email, id: user?._id, role: 'customer' }, action: 'customer.locked', entity: 'User', entityId: user ? String(user._id) : undefined, status: 'FAILED', details: { retryAfterSeconds: f.retryAfterSeconds }, req });
      throw ApiError.tooMany('ACCOUNT_LOCKED', 'Too many failed attempts. Try again later.', f.retryAfterSeconds, { retryAfterSeconds: f.retryAfterSeconds });
    }
    // identical for unknown phone / wrong PIN / deactivated account
    throw new ApiError(401, 'INVALID_CREDENTIALS', 'Invalid phone number or PIN', { attemptsRemaining: f.remaining });
  }
  await clearFailures(lockKey);
  user!.lastLoginAt = new Date();
  await user!.save();
  const { token, expiresIn } = await issueSession(user!, 'customer', req, res);
  return { accessToken: token, expiresIn, user: toCustomerProfile(user!) };
}


/**
 * Customer changes their own PIN (also how a temporary PIN issued by an admin gets replaced).
 * Same 6-digit rule as registration. Wrong current PINs count against the SAME lockout as login (a stolen access token must not
 * become a PIN-guessing oracle). Every OTHER session is invalidated; the caller's own session (refresh-token family) survives and
 * receives a fresh access token.
 */
export async function changeCustomerPin(user: UserDocument, input: { currentPin: string; newPin: string }, currentRefreshToken: string | undefined, req: Request) {
  if (!input.currentPin) throw ApiError.badRequest('PIN_REQUIRED');
  assertPin(input.newPin);
  if (input.currentPin === input.newPin) throw ApiError.badRequest('PIN_UNCHANGED', 'The new PIN must be different');

  const lockKey = `customer:${(user.phone ?? String(user._id)).slice(-10)}`;
  await assertNotLocked(lockKey);
  const acct = await consumeLimit(`login-account:${lockKey}`, ACCOUNT_LOGIN_LIMIT.limit, ACCOUNT_LOGIN_LIMIT.windowMs);
  if (!acct.allowed) throw ApiError.tooMany('TOO_MANY_REQUESTS', 'Too many attempts. Try again later.', acct.retryAfterSeconds);

  const withHash = await UserModel.findById(user._id).select('+passwordHash');
  if (!withHash?.passwordHash || !(await compareSecret(input.currentPin, withHash.passwordHash))) {
    const f = await recordFailure(lockKey);
    if (f.locked) throw ApiError.tooMany('ACCOUNT_LOCKED', 'Too many failed attempts. Try again later.', f.retryAfterSeconds, { retryAfterSeconds: f.retryAfterSeconds });
    throw new ApiError(401, 'INVALID_CREDENTIALS', 'Current PIN is incorrect', { attemptsRemaining: f.remaining });
  }
  await clearFailures(lockKey);

  withHash.passwordHash = await hashSecret(input.newPin);
  withHash.tokenVersion += 1; // kills every outstanding access token (other devices) at once
  await withHash.save();

  // revoke every refresh-token family except the caller's own
  let keepFamily: string | undefined;
  if (currentRefreshToken) keepFamily = (await RefreshTokenModel.findOne({ tokenHash: sha256(currentRefreshToken), userId: withHash._id, revokedAt: null }))?.familyId;
  await RefreshTokenModel.updateMany({ userId: withHash._id, revokedAt: null, ...(keepFamily ? { familyId: { $ne: keepFamily } } : {}) }, { $set: { revokedAt: new Date() } });

  await recordAudit({ actor: { id: withHash._id, email: withHash.email, role: 'customer' }, action: 'customer.pin_changed', entity: 'User', entityId: String(withHash._id), details: { keptCurrentSession: Boolean(keepFamily) }, req });
  const { token, expiresIn } = signAccessToken(withHash, 'customer');
  return { accessToken: token, expiresIn };
}

/* ------------------------------------------------------------------ profile + address book (closes the Module 4 gap) */

/** `PATCH /auth/me`. `phone` is not accepted here (it's the login identity); only `name`/`email`/`avatarUrl` change. */
export async function updateCustomerProfile(user: UserDocument, input: UpdateProfileInput, req: Request) {
  if (input.email !== undefined && input.email !== user.email) {
    if (await UserModel.exists({ email: input.email, _id: { $ne: user._id } })) throw ApiError.conflict('EMAIL_IN_USE');
    user.email = input.email;
  }
  if (input.name !== undefined) user.name = input.name;
  if (input.avatarUrl !== undefined) user.avatarUrl = input.avatarUrl;
  await user.save();
  await recordAudit({ actor: { id: user._id, email: user.email, role: 'customer' }, action: 'customer.profile_update', entity: 'User', entityId: String(user._id), req });
  return toCustomerProfile(user);
}

/** Legacy kept this in `localStorage.albarakah_user_addresses` (SECURITY_RISKS #14) - this is new server-side persistence for
 * an existing client-side convenience, not a behaviour regression. `isDefault:true` always demotes every other address; removing
 * the current default promotes the next one (if any) so the list never silently ends up with zero defaults. */
function reindexDefault(addresses: UserDocument['addresses'], keepId?: string) {
  for (const a of addresses) a.isDefault = a.id === keepId;
}

export async function listAddresses(user: UserDocument) {
  return user.addresses;
}

export async function addAddress(user: UserDocument, input: AddressInput, req: Request) {
  const phone = normalizeBdMobile(input.phone);
  if (!phone) throw ApiError.badRequest('INVALID_BD_PHONE');
  const address = { id: randomUUID(), label: input.label, name: input.name, phone, address: input.address, district: input.district, isDefault: input.isDefault };
  user.addresses.push(address);
  if (address.isDefault || user.addresses.length === 1) reindexDefault(user.addresses, address.id);
  await user.save();
  await recordAudit({ actor: { id: user._id, email: user.email, role: 'customer' }, action: 'customer.address_add', entity: 'User', entityId: String(user._id), details: { addressId: address.id }, req });
  return user.addresses;
}

export async function updateAddress(user: UserDocument, id: string, patch: AddressPatch, req: Request) {
  const a = user.addresses.find((x) => x.id === id);
  if (!a) throw ApiError.notFound('ADDRESS_NOT_FOUND');
  if (patch.phone !== undefined) {
    const phone = normalizeBdMobile(patch.phone);
    if (!phone) throw ApiError.badRequest('INVALID_BD_PHONE');
    a.phone = phone;
  }
  if (patch.label !== undefined) a.label = patch.label;
  if (patch.name !== undefined) a.name = patch.name;
  if (patch.address !== undefined) a.address = patch.address;
  if (patch.district !== undefined) a.district = patch.district;
  if (patch.isDefault) reindexDefault(user.addresses, a.id);
  await user.save();
  await recordAudit({ actor: { id: user._id, email: user.email, role: 'customer' }, action: 'customer.address_update', entity: 'User', entityId: String(user._id), details: { addressId: id }, req });
  return user.addresses;
}

export async function removeAddress(user: UserDocument, id: string, req: Request) {
  const existed = user.addresses.some((x) => x.id === id);
  if (!existed) throw ApiError.notFound('ADDRESS_NOT_FOUND');
  const wasDefault = user.addresses.find((x) => x.id === id)?.isDefault;
  user.addresses = user.addresses.filter((x) => x.id !== id) as UserDocument['addresses'];
  if (wasDefault && user.addresses.length > 0 && !user.addresses.some((x) => x.isDefault)) reindexDefault(user.addresses, user.addresses[0].id);
  await user.save();
  await recordAudit({ actor: { id: user._id, email: user.email, role: 'customer' }, action: 'customer.address_remove', entity: 'User', entityId: String(user._id), details: { addressId: id }, req });
  return user.addresses;
}
