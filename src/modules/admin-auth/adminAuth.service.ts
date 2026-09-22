import type { Request, Response } from 'express';
import { Types } from 'mongoose';
import { ACCOUNT_LOGIN_LIMIT, OTP } from '../../config/constants';
import { getEnv } from '../../config/env';
import { ApiError } from '../../utils/ApiError';
import { hmacSha256, randomDigits, randomToken, safeEqual, sha256 } from '../../utils/crypto';
import { burnComparison, compareSecret, hashSecret } from '../../utils/password';
import { recordAudit } from '../audit/audit.service';
import { MailDeliveryError } from '../notifications/mailer';
import { sendAdminInviteEmail, sendAdminOtpEmail } from '../notifications/notifications.service';
import { assertNotLocked, clearFailures, consumeLimit, recordFailure } from '../security';
import { UserModel, type UserDocument } from '../users/user.model';
import { toAdminSession, toStaffMember } from '../users/user.serializer';
import { issueSession, revokeAllForUser } from '../users/token.service';
import { OtpModel } from './otp.model';

const INVITE_TTL_HOURS = 48;
const isAdminRole = (r: string) => r === 'admin' || r === 'super_admin';
const otpHash = (email: string, code: string) => hmacSha256(getEnv().OTP_PEPPER, `${email}:${code}`);
const lockKey = (email: string) => `admin:${email}`;

/** Create + e-mail a fresh OTP. On delivery failure the OTP is removed and the failure is surfaced (never reported as sent). */
async function issueOtp(user: UserDocument, req: Request) {
  const email = user.email!;
  const code = randomDigits(OTP.digits);
  await OtpModel.deleteMany({ email, purpose: 'admin_login' });
  const otp = await OtpModel.create({ email, codeHash: otpHash(email, code), expiresAt: new Date(Date.now() + OTP.ttlMs) });
  try {
    await sendAdminOtpEmail(email, user.name, code);
  } catch (err) {
    await OtpModel.deleteOne({ _id: otp._id });
    await recordAudit({ actor: { id: user._id, email, role: user.role }, action: 'admin.otp.delivery_failed', entity: 'User', entityId: String(user._id), status: 'FAILED', req });
    throw err instanceof MailDeliveryError ? new ApiError(502, 'OTP_DELIVERY_FAILED', 'Could not send the verification e-mail. Try again shortly.') : err;
  }
}

/** Step 1: e-mail + password. The response is identical for unknown user / wrong password / valid credentials. */
export async function adminLogin(input: { email: string; password: string }, req: Request) {
  const { email, password } = input;
  await assertNotLocked(lockKey(email));
  const acct = await consumeLimit(`login-account:${lockKey(email)}`, ACCOUNT_LOGIN_LIMIT.limit, ACCOUNT_LOGIN_LIMIT.windowMs);
  if (!acct.allowed) throw ApiError.tooMany('TOO_MANY_REQUESTS', 'Too many sign-in attempts. Try again later.', acct.retryAfterSeconds);

  const user = await UserModel.findOne({ email, role: { $in: ['admin', 'super_admin'] } }).select('+passwordHash');
  const valid = Boolean(user?.passwordHash && user.isActive && (await compareSecret(password, user.passwordHash)));
  if (!user?.passwordHash) await burnComparison(password);

  const generic = { otpRequired: true, expiresInSeconds: OTP.ttlMs / 1000 };
  if (!valid || !user) {
    const f = await recordFailure(lockKey(email));
    await recordAudit({ actor: { id: user?._id, email, role: user?.role }, action: 'admin.login.password_failed', entity: 'User', entityId: user ? String(user._id) : undefined, status: 'FAILED', req });
    if (f.locked) throw ApiError.tooMany('ACCOUNT_LOCKED', 'Too many failed attempts. Try again later.', f.retryAfterSeconds, { retryAfterSeconds: f.retryAfterSeconds });
    return generic;
  }

  // valid password: throttle e-mails (cooldown + hourly cap)
  const recent = await OtpModel.findOne({ email, consumedAt: null, expiresAt: { $gt: new Date() } }).sort({ createdAt: -1 });
  if (recent && Date.now() - recent.createdAt.getTime() < OTP.resendCooldownMs) return generic; // a code was just sent
  const cap = await consumeLimit(`otp-send:${email}`, OTP.maxSendsPerHour, 60 * 60_000);
  if (!cap.allowed) throw ApiError.tooMany('TOO_MANY_OTP_REQUESTS', 'Too many verification codes requested. Try again later.', cap.retryAfterSeconds);

  await issueOtp(user, req);
  await recordAudit({ actor: { id: user._id, email, role: user.role }, action: 'admin.login.password_ok', entity: 'User', entityId: String(user._id), req });
  return generic;
}

/** Resend only works while a pending (password-verified) OTP exists - it cannot be used to mail arbitrary addresses. Always 200. */
export async function adminResendOtp(email: string, req: Request) {
  const pending = await OtpModel.findOne({ email, consumedAt: null, expiresAt: { $gt: new Date() } }).sort({ createdAt: -1 });
  if (!pending || Date.now() - pending.createdAt.getTime() < OTP.resendCooldownMs) return;
  const user = await UserModel.findOne({ email, role: { $in: ['admin', 'super_admin'] }, isActive: true });
  if (!user) return;
  const cap = await consumeLimit(`otp-send:${email}`, OTP.maxSendsPerHour, 60 * 60_000);
  if (!cap.allowed) return;
  await issueOtp(user, req);
}

/** Step 2: verify the single-use code and issue the session. */
export async function adminVerifyOtp(input: { email: string; code: string }, req: Request, res: Response) {
  const { email, code } = input;
  await assertNotLocked(lockKey(email));

  const fail = async (): Promise<never> => {
    const f = await recordFailure(lockKey(email));
    await recordAudit({ actor: { email }, action: 'admin.login.otp_failed', entity: 'User', status: 'FAILED', req });
    if (f.locked) throw ApiError.tooMany('ACCOUNT_LOCKED', 'Too many failed attempts. Try again later.', f.retryAfterSeconds, { retryAfterSeconds: f.retryAfterSeconds });
    throw new ApiError(401, 'INVALID_OTP', 'Invalid or expired code', { attemptsRemaining: f.remaining });
  };

  const pending = await OtpModel.findOne({ email, purpose: 'admin_login', consumedAt: null, expiresAt: { $gt: new Date() } }).sort({ createdAt: -1 });
  if (!pending) return fail();
  // count the attempt BEFORE comparing (atomic) so parallel guesses cannot exceed the cap
  const counted = await OtpModel.findOneAndUpdate({ _id: pending._id, consumedAt: null, attempts: { $lt: OTP.maxAttempts } }, { $inc: { attempts: 1 } }, { new: true });
  if (!counted) return fail();
  if (!safeEqual(counted.codeHash, otpHash(email, code))) {
    if (counted.attempts >= OTP.maxAttempts) await OtpModel.deleteOne({ _id: counted._id }); // code burned after 5 wrong guesses
    return fail();
  }
  const consumed = await OtpModel.findOneAndUpdate({ _id: counted._id, consumedAt: null }, { $set: { consumedAt: new Date() } });
  if (!consumed) return fail(); // single use: a concurrent request already used it

  const user = await UserModel.findOne({ email, role: { $in: ['admin', 'super_admin'] }, isActive: true });
  if (!user) return fail();
  await clearFailures(lockKey(email));
  user.lastLoginAt = new Date();
  await user.save();
  const { token, expiresIn } = await issueSession(user, 'admin', req, res);
  await recordAudit({ actor: { id: user._id, email, role: user.role }, action: 'admin.login.success', entity: 'User', entityId: String(user._id), req });
  return { accessToken: token, expiresIn, session: toAdminSession(user) };
}

/** super_admin: create (or re-activate a previously revoked) admin and send a one-time set-password invite. */
export async function grantAccess(actor: UserDocument, input: { name: string; email: string }, req: Request) {
  const existing = await UserModel.findOne({ email: input.email });
  if (existing && isAdminRole(existing.role)) throw ApiError.conflict('ALREADY_ADMIN');
  if (existing && !existing.revokedAdminAt) throw ApiError.conflict('EMAIL_IN_USE_BY_CUSTOMER', 'This e-mail belongs to a customer account; use a dedicated admin address.');

  const token = randomToken(32);
  const patch = { role: 'admin' as const, isActive: true, passwordHash: null, passwordSetTokenHash: sha256(token), passwordSetExpires: new Date(Date.now() + INVITE_TTL_HOURS * 3600_000), name: input.name, createdBy: actor._id };
  let user: UserDocument;
  const snapshot = existing ? { role: existing.role, isActive: existing.isActive, name: existing.name } : null;
  if (existing) {
    Object.assign(existing, patch);
    user = await existing.save();
  } else {
    user = await UserModel.create({ ...patch, email: input.email });
  }

  const link = `${getEnv().ADMIN_APP_URL.replace(/\/$/, '')}/set-password?token=${encodeURIComponent(token)}`;
  try {
    await sendAdminInviteEmail(input.email, input.name, link, INVITE_TTL_HOURS);
  } catch (err) {
    // roll back so a failed invite never leaves a half-created admin
    if (snapshot && existing) {
      existing.role = snapshot.role; existing.isActive = snapshot.isActive; existing.passwordSetTokenHash = null; existing.passwordSetExpires = null;
      await existing.save();
    } else await UserModel.deleteOne({ _id: user._id });
    await recordAudit({ actor: { id: actor._id, email: actor.email, role: actor.role }, action: 'admin.grant.invite_failed', entity: 'User', details: { email: input.email }, status: 'FAILED', req });
    throw err instanceof MailDeliveryError ? new ApiError(502, 'INVITE_DELIVERY_FAILED', 'Could not send the invitation e-mail.') : err;
  }
  await recordAudit({ actor: { id: actor._id, email: actor.email, role: actor.role }, action: 'admin.grant', entity: 'User', entityId: String(user._id), details: { email: input.email, role: 'admin' }, req });
  return toStaffMember(user);
}

export async function setPassword(input: { token: string; password: string }, req: Request) {
  const user = await UserModel.findOne({ passwordSetTokenHash: sha256(input.token), passwordSetExpires: { $gt: new Date() }, role: 'admin', isActive: true }).select('+passwordSetTokenHash');
  if (!user) throw ApiError.badRequest('INVALID_OR_EXPIRED_TOKEN');
  user.passwordHash = await hashSecret(input.password);
  user.passwordSetTokenHash = null;
  user.passwordSetExpires = null;
  user.revokedAdminAt = null;
  user.tokenVersion += 1;
  await user.save();
  await recordAudit({ actor: { id: user._id, email: user.email, role: user.role }, action: 'admin.password.set', entity: 'User', entityId: String(user._id), req });
}

/** super_admin: demote + kill credentials + revoke every refresh token and (via tokenVersion) every access token, instantly. */
export async function revokeAccess(actor: UserDocument, userId: string, req: Request) {
  if (String(actor._id) === userId) throw ApiError.badRequest('CANNOT_REVOKE_SELF');
  const target = await UserModel.findById(new Types.ObjectId(userId));
  if (!target || !isAdminRole(target.role)) throw ApiError.notFound('ADMIN_NOT_FOUND');
  if (target.role === 'super_admin') throw ApiError.forbidden('CANNOT_REVOKE_SUPER_ADMIN');

  target.role = 'customer';
  target.isActive = false;
  target.passwordHash = null;
  target.passwordSetTokenHash = null;
  target.passwordSetExpires = null;
  target.revokedAdminAt = new Date();
  await target.save();
  await revokeAllForUser(target._id);
  await OtpModel.deleteMany({ email: target.email });
  await recordAudit({ actor: { id: actor._id, email: actor.email, role: actor.role }, action: 'admin.revoke', entity: 'User', entityId: String(target._id), details: { email: target.email }, req });
}

export async function listStaff() {
  const users = await UserModel.find({ role: { $in: ['admin', 'super_admin'] } }).sort({ createdAt: 1 });
  return users.map((u) => toStaffMember(u));
}
