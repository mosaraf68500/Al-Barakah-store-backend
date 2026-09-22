import { Router } from 'express';
import { authenticate } from '../../middleware/authenticate';
import { LIMITS, makeLimiter } from '../../middleware/rateLimiter';
import { validateBody } from '../../middleware/validate';
import { asyncHandler } from '../../utils/asyncHandler';
import * as c from './auth.controller';
import { changePinSchema, loginSchema, registerSchema } from './auth.validation';

export function authRoutes(rateLimits: boolean) {
  const r = Router();
  r.post('/register', makeLimiter(LIMITS.customerRegister, rateLimits), validateBody(registerSchema), asyncHandler(c.register));
  r.post('/login', makeLimiter(LIMITS.customerLogin, rateLimits), validateBody(loginSchema), asyncHandler(c.login));
  r.post('/refresh', makeLimiter(LIMITS.customerRefresh, rateLimits), asyncHandler(c.refresh));
  r.post('/logout', asyncHandler(c.logout));
  r.post('/change-pin', makeLimiter(LIMITS.customerLogin, rateLimits), authenticate('customer'), validateBody(changePinSchema), asyncHandler(c.changePin));
  r.get('/me', authenticate('customer'), asyncHandler(c.me));
  return r;
}
