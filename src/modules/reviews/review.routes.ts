import { Router } from 'express';
import { authenticate, requireRole } from '../../middleware/authenticate';
import { LIMITS, makeLimiter } from '../../middleware/rateLimiter';
import { validateBody } from '../../middleware/validate';
import { ApiResponse } from '../../utils/ApiResponse';
import { asyncHandler } from '../../utils/asyncHandler';
import * as svc from './review.service';
import { adminReviewListQuery, createReviewSchema, publicReviewQuery } from './review.validation';

/** Mounted at /v1/reviews - public read, customer-only write. */
export function publicReviewRoutes(rateLimits = true) {
  const r = Router();
  r.get('/', asyncHandler(async (req, res) => {
    res.setHeader('Cache-Control', 'public, max-age=10, stale-while-revalidate=60');
    ApiResponse.ok(res, await svc.listPublicReviews(publicReviewQuery.parse(req.query)));
  }));
  r.post(
    '/',
    authenticate('customer'),
    makeLimiter({ ...LIMITS.reviewCreate, key: (req) => String(req.authUser?._id ?? 'anonymous') }, rateLimits),
    validateBody(createReviewSchema),
    asyncHandler(async (req, res) => ApiResponse.created(res, await svc.createReview(req.authUser!, req.body, req))),
  );
  return r;
}

/** Mounted at /v1/admin/reviews - admin + super_admin. */
export function adminReviewRoutes() {
  const r = Router();
  r.use(authenticate('admin'), requireRole('admin', 'super_admin'));
  r.get('/', asyncHandler(async (req, res) => ApiResponse.ok(res, await svc.listAdminReviews(adminReviewListQuery.parse(req.query).deleted))));
  r.delete('/:id', asyncHandler(async (req, res) => ApiResponse.ok(res, await svc.softDeleteReview(req.authUser!, req.params.id, req))));
  return r;
}
