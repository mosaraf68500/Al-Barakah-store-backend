import { Router } from 'express';
import { z } from 'zod';
import { authenticate, requireRole } from '../../middleware/authenticate';
import { validateBody } from '../../middleware/validate';
import { ApiResponse } from '../../utils/ApiResponse';
import { asyncHandler } from '../../utils/asyncHandler';
import { resetCustomerPin } from './customers.service';

const resetPinSchema = z
  .object({ userId: z.string().regex(/^[a-f0-9]{24}$/i).optional(), phone: z.string().max(40).optional() })
  .refine((b) => Boolean(b.userId) !== Boolean(b.phone), { message: 'provide exactly one of userId or phone' });

/** Mounted at /v1/admin/customers (admin or super_admin). */
export function adminCustomerRoutes() {
  const r = Router();
  r.post(
    '/reset-pin',
    authenticate('admin'),
    requireRole('admin', 'super_admin'),
    validateBody(resetPinSchema),
    asyncHandler(async (req, res) => ApiResponse.ok(res, await resetCustomerPin(req.authUser!, req.body, req))),
  );
  return r;
}
