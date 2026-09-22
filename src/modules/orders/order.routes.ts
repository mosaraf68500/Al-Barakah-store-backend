import { Router } from 'express';
import { getEnv } from '../../config/env';
import { authenticate, authenticateOptional, requireRole } from '../../middleware/authenticate';
import { LIMITS, makeLimiter } from '../../middleware/rateLimiter';
import { validateBody } from '../../middleware/validate';
import { ApiError } from '../../utils/ApiError';
import { ApiResponse } from '../../utils/ApiResponse';
import { asyncHandler } from '../../utils/asyncHandler';
import { safeEqual } from '../../utils/crypto';
import { logger } from '../../utils/logger';
import * as svc from './order.service';
import { adminOrderListQuery, adminOrderPatchSchema, createOrderSchema, dispatchSchema, myOrdersQuery } from './order.validation';

/** Mounted at /v1/orders. `POST /` works for guests and logged-in customers alike (`authenticateOptional`); `GET /my` is customer-only. */
export function orderRoutes(rateLimits: boolean) {
  const r = Router();

  r.post(
    '/',
    makeLimiter(LIMITS.orderCreateIp, rateLimits),
    authenticateOptional,
    validateBody(createOrderSchema),
    asyncHandler(async (req, res) => {
      const order = await svc.createOrder(req.body, req.authUser ?? null, req);
      ApiResponse.created(res, { order });
    }),
  );

  r.get(
    '/track/:code',
    makeLimiter(LIMITS.orderTracking, rateLimits),
    asyncHandler(async (req, res) => {
      res.setHeader('Cache-Control', 'no-store');
      ApiResponse.ok(res, await svc.trackOrder(req.params.code));
    }),
  );

  r.get(
    '/my',
    authenticate('customer'),
    asyncHandler(async (req, res) => {
      const q = myOrdersQuery.parse(req.query);
      res.setHeader('Cache-Control', 'no-store');
      ApiResponse.ok(res, await svc.myOrders(req.authUser!, q.page, q.limit));
    }),
  );

  return r;
}

/** Mounted at /v1/admin/orders - admin + super_admin (Module 5c). Soft-deleted orders are excluded from every read. */
export function adminOrderRoutes() {
  const r = Router();
  r.use(authenticate('admin'), requireRole('admin', 'super_admin'));

  r.get('/', asyncHandler(async (req, res) => {
    const q = adminOrderListQuery.parse(req.query);
    ApiResponse.ok(res, await svc.listAdminOrders(q.status));
  }));
  r.get('/:id', asyncHandler(async (req, res) => ApiResponse.ok(res, await svc.getAdminOrder(req.params.id))));
  r.patch('/:id', validateBody(adminOrderPatchSchema), asyncHandler(async (req, res) => ApiResponse.ok(res, await svc.patchOrder(req.authUser!, req.params.id, req.body, req))));
  r.delete('/:id', asyncHandler(async (req, res) => ApiResponse.ok(res, await svc.softDeleteOrder(req.authUser!, req.params.id, req))));
  r.post('/:id/dispatch', validateBody(dispatchSchema), asyncHandler(async (req, res) => ApiResponse.ok(res, await svc.dispatchOrder(req.authUser!, req.params.id, req.body.provider, req))));
  r.post('/:id/verify-payment', asyncHandler(async (req, res) => ApiResponse.ok(res, await svc.verifyOrderPayment(req.authUser!, req.params.id, req))));

  return r;
}

/**
 * Cron-only: Vercel Cron calls this with `Authorization: Bearer $CRON_SECRET` (same convention as `/internal/cron/cleanup`), kept
 * as its own small route in the `orders` module rather than the generic cleanup job since it is order-state logic, not
 * housekeeping. This is now a DAILY BACKSTOP (the Vercel Hobby plan allows at most one run/day per cron job) - the real-time
 * path is the lazy expiry that runs inside stock reservation and the admin order list (Module 5c), see `order.service.ts`.
 */
export function orderCronRoutes() {
  const r = Router();
  r.get(
    '/expire-pending',
    asyncHandler(async (req, res) => {
      const h = req.headers.authorization ?? '';
      if (!h.startsWith('Bearer ') || !safeEqual(h.slice(7), getEnv().CRON_SECRET)) throw ApiError.unauthorized('CRON_AUTH_REQUIRED');
      const result = await svc.expirePendingOrders();
      logger.info(result, 'cron order-expiry done');
      res.json({ ok: true, ...result });
    }),
  );
  return r;
}
