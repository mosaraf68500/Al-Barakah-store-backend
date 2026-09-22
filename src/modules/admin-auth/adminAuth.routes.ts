import { Router } from 'express';
import { authenticate, requireRole } from '../../middleware/authenticate';
import { LIMITS, makeLimiter } from '../../middleware/rateLimiter';
import { validateBody } from '../../middleware/validate';
import { asyncHandler } from '../../utils/asyncHandler';
import * as c from './adminAuth.controller';
import { adminLoginSchema, grantAccessSchema, resendOtpSchema, revokeAccessSchema, setPasswordSchema, verifyOtpSchema } from './adminAuth.validation';

const sa = [authenticate('admin'), requireRole('super_admin')];

/** Mounted at /v1/admin-auth */
export function adminAuthRoutes(rateLimits: boolean) {
  const r = Router();
  r.post('/login', makeLimiter(LIMITS.adminLoginIp, rateLimits), validateBody(adminLoginSchema), asyncHandler(c.login));
  r.post('/verify-otp', makeLimiter(LIMITS.adminOtpIp, rateLimits), validateBody(verifyOtpSchema), asyncHandler(c.verifyOtp));
  r.post('/resend-otp', makeLimiter(LIMITS.adminOtpIp, rateLimits), validateBody(resendOtpSchema), asyncHandler(c.resendOtp));
  r.post('/refresh', makeLimiter(LIMITS.adminRefresh, rateLimits), asyncHandler(c.refresh));
  r.post('/logout', asyncHandler(c.logout));
  r.get('/me', authenticate('admin'), asyncHandler(c.me));
  r.post('/set-password', makeLimiter(LIMITS.adminSetPassword, rateLimits), validateBody(setPasswordSchema), asyncHandler(c.setPassword));
  r.post('/grant-access', ...sa, validateBody(grantAccessSchema), asyncHandler(c.grantAccess));
  r.post('/revoke-access', ...sa, validateBody(revokeAccessSchema), asyncHandler(c.revokeAccess));
  return r;
}

/** Mounted at /v1/admin - the staff list / audit endpoints the admin app calls. */
export function adminStaffRoutes() {
  const r = Router();
  r.get('/staff', ...sa, asyncHandler(c.staff));
  r.delete('/staff/:id', ...sa, asyncHandler(c.revokeAccessById));
  r.get('/audit', ...sa, asyncHandler(c.audit));
  return r;
}
