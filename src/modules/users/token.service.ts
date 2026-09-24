import type { Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import { Types } from 'mongoose';
import { CSRF_HEADER, REFRESH_COOKIE, REFRESH_COOKIE_PATH, type Audience, type Role } from '../../config/constants';
import { getEnv } from '../../config/env';
import { ApiError } from '../../utils/ApiError';
import { randomId, sha256 } from '../../utils/crypto';
import { RefreshTokenModel } from './refreshToken.model';
import { UserModel, type UserDoc } from './user.model';

export interface AccessClaims { sub: string; role: Role; aud: Audience; tv: number; jti: string }
interface RefreshClaims { sub: string; fam: string; jti: string; aud: Audience; ssa: number }

const accessTtlSeconds = (aud: Audience) => (aud === 'admin' ? getEnv().ADMIN_ACCESS_TTL_MIN : getEnv().CUSTOMER_ACCESS_TTL_MIN) * 60;
const sessionMaxMs = (aud: Audience) => (aud === 'admin' ? getEnv().ADMIN_SESSION_MAX_HOURS * 3600_000 : getEnv().CUSTOMER_SESSION_MAX_DAYS * 86400_000);
const adminIdleMs = () => getEnv().ADMIN_IDLE_MIN * 60_000;

export function signAccessToken(user: Pick<UserDoc, '_id' | 'role' | 'tokenVersion'>, aud: Audience): { token: string; expiresIn: number } {
  const expiresIn = accessTtlSeconds(aud);
  const claims: AccessClaims = { sub: String(user._id), role: user.role, aud, tv: user.tokenVersion, jti: randomId() };
  return { token: jwt.sign(claims, getEnv().JWT_ACCESS_SECRET, { algorithm: 'HS256', expiresIn }), expiresIn };
}

export function verifyAccessToken(token: string, aud: Audience): AccessClaims {
  try {
    const c = jwt.verify(token, getEnv().JWT_ACCESS_SECRET, { algorithms: ['HS256'] }) as AccessClaims;
    if (c.aud !== aud) throw new Error('aud');
    return c;
  } catch {
    throw ApiError.unauthorized('INVALID_TOKEN');
  }
}

function signRefresh(claims: RefreshClaims, expiresAt: Date): string {
  return jwt.sign(claims, getEnv().JWT_REFRESH_SECRET, { algorithm: 'HS256', expiresIn: Math.max(1, Math.floor((expiresAt.getTime() - Date.now()) / 1000)) });
}

/** Start a brand-new session (new token family). */
export async function issueSession(user: Pick<UserDoc, '_id' | 'role' | 'tokenVersion'>, aud: Audience, req: Request, res: Response) {
  const now = Date.now();
  const refresh = await createRefresh(String(user._id), aud, randomId(), now, req, res);
  return { ...signAccessToken(user, aud), refreshToken: refresh.token };
}

async function createRefresh(userId: string, aud: Audience, familyId: string, sessionStartedAt: number, req: Request, res: Response) {
  const expiresAt = new Date(Math.min(sessionStartedAt + sessionMaxMs(aud), Date.now() + sessionMaxMs(aud)));
  const jti = randomId();
  const token = signRefresh({ sub: userId, fam: familyId, jti, aud, ssa: sessionStartedAt }, expiresAt);
  const doc = await RefreshTokenModel.create({
    userId: new Types.ObjectId(userId),
    tokenHash: sha256(token),
    familyId,
    audience: aud,
    sessionStartedAt: new Date(sessionStartedAt),
    expiresAt,
    ip: req.ip,
    userAgent: req.get('user-agent')?.slice(0, 300),
  });
  setRefreshCookie(res, aud, token, expiresAt);
  return { token, id: doc._id };
}

function refreshCookieOptions(aud: Audience) {
  const env = getEnv();
  const crossSite = env.NODE_ENV === 'production';
  return {
    httpOnly: true,
    secure: crossSite,
    sameSite: crossSite ? ('none' as const) : ('lax' as const),
    ...(env.COOKIE_DOMAIN ? { domain: env.COOKIE_DOMAIN } : {}),
    path: REFRESH_COOKIE_PATH[aud],
  };
}

/** Cookie first. The header is the copy the browser can keep when two *.vercel.app hosts cannot share a cookie. */
export function readRefreshToken(req: Request, aud: Audience): string | undefined {
  const cookie = req.cookies?.[REFRESH_COOKIE[aud]];
  if (typeof cookie === 'string' && cookie) return cookie;
  const header = req.get('X-Abp-Refresh');
  return header || undefined;
}

export function setRefreshCookie(res: Response, aud: Audience, token: string, expiresAt: Date) {
  res.cookie(REFRESH_COOKIE[aud], token, { ...refreshCookieOptions(aud), expires: expiresAt });
}
export function clearRefreshCookie(res: Response, aud: Audience) {
  res.clearCookie(REFRESH_COOKIE[aud], refreshCookieOptions(aud));
}

export async function revokeFamily(familyId: string) {
  await RefreshTokenModel.updateMany({ familyId, revokedAt: null }, { $set: { revokedAt: new Date() } });
}
/** Instant revocation of everything a user holds: refresh tokens + (via tokenVersion) every access token. */
export async function revokeAllForUser(userId: string | Types.ObjectId) {
  await RefreshTokenModel.updateMany({ userId, revokedAt: null }, { $set: { revokedAt: new Date() } });
  await UserModel.updateOne({ _id: userId }, { $inc: { tokenVersion: 1 } });
}

/**
 * Rotate a refresh token. Any anomaly (bad signature, unknown token, REUSE of an already-rotated token, expired session,
 * admin idle timeout, deactivated user) ends the session; reuse additionally revokes the whole family (theft signal).
 */
export async function rotateRefreshToken(rawToken: string | undefined, aud: Audience, req: Request, res: Response) {
  const fail = (code = 'INVALID_REFRESH_TOKEN') => {
    clearRefreshCookie(res, aud);
    return ApiError.unauthorized(code);
  };
  if (!rawToken) throw fail();
  let claims: RefreshClaims;
  try {
    claims = jwt.verify(rawToken, getEnv().JWT_REFRESH_SECRET, { algorithms: ['HS256'] }) as RefreshClaims;
  } catch {
    throw fail();
  }
  if (claims.aud !== aud) throw fail();

  const stored = await RefreshTokenModel.findOne({ tokenHash: sha256(rawToken) });
  if (!stored) {
    await revokeFamily(claims.fam); // signed but unknown => forged/copied token, burn the family
    throw fail();
  }
  if (stored.revokedAt) {
    await revokeFamily(stored.familyId); // reuse of a rotated token
    throw fail('REFRESH_TOKEN_REUSED');
  }
  const now = Date.now();
  if (stored.expiresAt.getTime() <= now) throw fail('SESSION_EXPIRED');
  if (aud === 'admin' && now - stored.createdAt.getTime() > adminIdleMs()) {
    await revokeFamily(stored.familyId);
    throw fail('SESSION_IDLE_TIMEOUT');
  }

  const user = await UserModel.findById(stored.userId);
  if (!user || !user.isActive || (aud === 'admin' && user.role === 'customer') || (aud === 'customer' && user.role !== 'customer')) {
    await revokeFamily(stored.familyId);
    throw fail();
  }

  // atomically claim this token (two racing refreshes: the loser hits the reuse branch above next time)
  const claimed = await RefreshTokenModel.findOneAndUpdate({ _id: stored._id, revokedAt: null }, { $set: { revokedAt: new Date() } });
  if (!claimed) {
    await revokeFamily(stored.familyId);
    throw fail('REFRESH_TOKEN_REUSED');
  }
  const next = await createRefresh(String(user._id), aud, stored.familyId, stored.sessionStartedAt.getTime(), req, res);
  await RefreshTokenModel.updateOne({ _id: stored._id }, { $set: { replacedBy: next.id } });
  return { user, refreshToken: next.token, ...signAccessToken(user, aud) };
}

export async function revokeByRawToken(rawToken: string | undefined) {
  if (!rawToken) return;
  const stored = await RefreshTokenModel.findOne({ tokenHash: sha256(rawToken) });
  if (stored) await revokeFamily(stored.familyId);
}

/** CSRF defence for cookie-authenticated endpoints: custom header (forces a CORS preflight) + Origin allow-list when present. */
export function assertCsrf(req: Request) {
  const origin = req.get('origin');
  const allowed = getEnv().corsOrigins;
  if (!req.get(CSRF_HEADER)) throw ApiError.forbidden('CSRF_HEADER_REQUIRED');
  if (origin && !allowed.includes(origin)) throw ApiError.forbidden('ORIGIN_NOT_ALLOWED');
}
