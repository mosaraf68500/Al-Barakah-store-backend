import { Router } from 'express';
import { authenticate, requireRole } from '../../middleware/authenticate';
import { validateBody } from '../../middleware/validate';
import { ApiResponse } from '../../utils/ApiResponse';
import { asyncHandler } from '../../utils/asyncHandler';
import * as svc from './media.service';
import { listQuery, registerSchema, signSchema } from './media.validation';

/** Mounted at /v1/admin/media (admin or super_admin). */
export function adminMediaRoutes() {
  const r = Router();
  r.use(authenticate('admin'), requireRole('admin', 'super_admin'));
  r.post('/sign', validateBody(signSchema), asyncHandler(async (req, res) => ApiResponse.ok(res, svc.createUploadSignature(req.body.folder))));
  r.post('/', validateBody(registerSchema), asyncHandler(async (req, res) => ApiResponse.created(res, await svc.registerMedia(req.authUser!, req.body, req))));
  r.get('/', asyncHandler(async (req, res) => ApiResponse.ok(res, await svc.listMedia(listQuery.parse(req.query)))));
  r.delete('/:id', asyncHandler(async (req, res) => {
    await svc.deleteMedia(req.authUser!, req.params.id, req);
    ApiResponse.noContent(res);
  }));
  return r;
}
