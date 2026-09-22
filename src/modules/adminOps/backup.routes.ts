import { Router } from 'express';
import { authenticate, requireRole } from '../../middleware/authenticate';
import { ApiResponse } from '../../utils/ApiResponse';
import { asyncHandler } from '../../utils/asyncHandler';
import * as svc from './backup.service';

/** Mounted at /v1/admin/backup - super_admin only (full, unmasked order PII in the export). */
export function adminBackupRoutes() {
  const r = Router();
  r.use(authenticate('admin'), requireRole('super_admin'));
  r.get('/', asyncHandler(async (req, res) => ApiResponse.ok(res, await svc.createBackup(req.authUser!, req))));
  r.post(
    '/restore',
    asyncHandler(async (req, res) => {
      const dryRun = req.query.dryRun === 'true';
      const confirm = typeof req.query.confirm === 'string' ? req.query.confirm : undefined;
      ApiResponse.ok(res, await svc.restoreBackup(req.authUser!, req.body, { dryRun, confirm }, req));
    }),
  );
  return r;
}
