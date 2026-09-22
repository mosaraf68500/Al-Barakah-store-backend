import { Router } from 'express';
import { pingDb } from '../../config/db';
import { getEnv } from '../../config/env';
import { authenticate, requireRole } from '../../middleware/authenticate';
import { ApiResponse } from '../../utils/ApiResponse';
import { asyncHandler } from '../../utils/asyncHandler';

/** `GET /admin/health` (BACKEND_PLAN §3.4) - admin/super_admin, a richer companion to the public `/health` (Module 1): also
 * reports whether this deployment is live-dispatching to real integrations, which matters for on-call/monitoring context. */
export function adminHealthRoutes() {
  const r = Router();
  r.get(
    '/health',
    authenticate('admin'), requireRole('admin', 'super_admin'),
    asyncHandler(async (_req, res) => {
      const latencyMs = await pingDb();
      ApiResponse.ok(res, { ok: true, latencyMs, mode: 'mongo', liveIntegrations: getEnv().ENABLE_LIVE_INTEGRATIONS });
    }),
  );
  return r;
}
