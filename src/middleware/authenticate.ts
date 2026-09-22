import type { RequestHandler } from 'express';
import type { Audience, Role } from '../config/constants';
import { UserModel } from '../modules/users/user.model';
import { verifyAccessToken } from '../modules/users/token.service';
import { ApiError } from '../utils/ApiError';

/**
 * Bearer access-token check. Beyond the signature it re-reads the user so that deactivation, role change and
 * `tokenVersion` bumps (revoke access, password change) take effect on the very next request.
 */
export const authenticate =
  (aud: Audience): RequestHandler =>
  async (req, _res, next) => {
    try {
      const h = req.headers.authorization;
      if (!h || !h.startsWith('Bearer ')) throw ApiError.unauthorized('AUTH_REQUIRED');
      const claims = verifyAccessToken(h.slice(7).trim(), aud);
      const user = await UserModel.findById(claims.sub);
      if (!user || !user.isActive || user.tokenVersion !== claims.tv) throw ApiError.unauthorized('INVALID_TOKEN');
      // role always comes from the DB, never from the token
      if (aud === 'admin' && user.role !== 'admin' && user.role !== 'super_admin') throw ApiError.forbidden('ADMIN_REQUIRED');
      if (aud === 'customer' && user.role !== 'customer') throw ApiError.forbidden('CUSTOMER_REQUIRED');
      req.authUser = user;
      next();
    } catch (e) {
      next(e);
    }
  };

/**
 * For endpoints that work for both guests and logged-in customers (e.g. `POST /orders`): attaches `req.authUser` when a valid
 * customer Bearer token is present, but never rejects the request - a missing, expired or malformed token is treated as "guest",
 * not an error, so checkout is never blocked by a stale token.
 */
export const authenticateOptional: RequestHandler = async (req, _res, next) => {
  const h = req.headers.authorization;
  if (!h || !h.startsWith('Bearer ')) return next();
  try {
    const claims = verifyAccessToken(h.slice(7).trim(), 'customer');
    const user = await UserModel.findById(claims.sub);
    if (user && user.isActive && user.role === 'customer' && user.tokenVersion === claims.tv) req.authUser = user;
  } catch {
    /* treated as guest */
  }
  next();
};

export const requireRole =
  (...roles: Role[]): RequestHandler =>
  (req, _res, next) => {
    if (!req.authUser) return next(ApiError.unauthorized('AUTH_REQUIRED'));
    if (!roles.includes(req.authUser.role)) return next(ApiError.forbidden('INSUFFICIENT_ROLE'));
    next();
  };
