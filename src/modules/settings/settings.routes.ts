import { Router } from 'express';
import { authenticate, requireRole } from '../../middleware/authenticate';
import { validateBody } from '../../middleware/validate';
import { ApiResponse } from '../../utils/ApiResponse';
import { asyncHandler } from '../../utils/asyncHandler';
import * as svc from './settings.service';
import { updateSettingsSchema } from './settings.validation';

/** Mounted at /v1/settings - no authentication, whitelisted projection only. */
export function publicSettingsRoutes() {
  const r = Router();
  r.get('/public', asyncHandler(async (_req, res) => {
    res.setHeader('Cache-Control', 'public, max-age=30, stale-while-revalidate=120');
    ApiResponse.ok(res, await svc.getPublicSettings());
  }));
  return r;
}

/** Mounted at /v1/admin/settings. Reads/writes: admin + super_admin (secrets masked). Decrypted secrets: super_admin only. */
export function adminSettingsRoutes() {
  const r = Router();
  const admin = [authenticate('admin'), requireRole('admin', 'super_admin')];
  r.get('/', ...admin, asyncHandler(async (_req, res) => ApiResponse.ok(res, await svc.getAdminSettings())));
  r.patch('/', ...admin, validateBody(updateSettingsSchema), asyncHandler(async (req, res) => ApiResponse.ok(res, await svc.updateSettings(req.authUser!, req.body, req))));
  r.get('/secrets', authenticate('admin'), requireRole('super_admin'), asyncHandler(async (req, res) => {
    const secrets = await svc.getDecryptedSecrets();
    await svc.auditSecretsRead(req.authUser!, req);
    res.setHeader('Cache-Control', 'no-store');
    ApiResponse.ok(res, secrets);
  }));
  return r;
}
