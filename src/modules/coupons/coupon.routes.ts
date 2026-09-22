import { Router } from 'express';
import { authenticate, requireRole } from '../../middleware/authenticate';
import { LIMITS, makeLimiter } from '../../middleware/rateLimiter';
import { validateBody } from '../../middleware/validate';
import { ApiResponse } from '../../utils/ApiResponse';
import { asyncHandler } from '../../utils/asyncHandler';
import * as svc from './coupon.service';
import { adminCouponListQuery, couponInput, couponPatch, validateBodySchema } from './coupon.validation';

/** Mounted at /v1/coupons - public. Only `POST /validate` exists: coupon codes are never listable. 30 requests / 15 min / IP. */
export function publicCouponRoutes(rateLimits: boolean) {
  const r = Router();
  r.post('/validate', makeLimiter(LIMITS.couponValidate, rateLimits), validateBody(validateBodySchema), asyncHandler(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    ApiResponse.ok(res, await svc.validateCoupon(req.body.code, req.body.subtotal));
  }));
  return r;
}

/** Mounted at /v1/admin/coupons - admin + super_admin. Reads hide archived coupons unless `?deleted=include|only`. */
export function adminCouponRoutes() {
  const r = Router();
  r.use(authenticate('admin'), requireRole('admin', 'super_admin'));
  r.get('/', asyncHandler(async (req, res) => ApiResponse.ok(res, await svc.listAdminCoupons(adminCouponListQuery.parse(req.query).deleted))));
  r.post('/', validateBody(couponInput), asyncHandler(async (req, res) => ApiResponse.created(res, await svc.createCoupon(req.authUser!, req.body, req))));
  r.patch('/:id', validateBody(couponPatch), asyncHandler(async (req, res) => ApiResponse.ok(res, await svc.updateCoupon(req.authUser!, req.params.id, req.body, req))));
  r.delete('/:id', asyncHandler(async (req, res) => ApiResponse.ok(res, await svc.softDeleteCoupon(req.authUser!, req.params.id, req))));
  r.post('/:id/restore', asyncHandler(async (req, res) => ApiResponse.ok(res, await svc.restoreCoupon(req.authUser!, req.params.id, req))));
  return r;
}
