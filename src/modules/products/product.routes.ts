import { Router } from 'express';
import { authenticate, requireRole } from '../../middleware/authenticate';
import { validateBody } from '../../middleware/validate';
import { ApiResponse } from '../../utils/ApiResponse';
import { asyncHandler } from '../../utils/asyncHandler';
import * as svc from './product.service';
import { adminListQuery, productInput, publicListQuery } from './product.validation';

/** Mounted at /v1/products - public. Array by default (the storefront reads the whole catalogue); `?page&limit` returns `{items,total,page,limit,totalPages}`. */
export function publicProductRoutes() {
  const r = Router();
  r.get('/', asyncHandler(async (req, res) => {
    res.setHeader('Cache-Control', 'public, max-age=10, stale-while-revalidate=60');
    ApiResponse.ok(res, await svc.listPublicProducts(publicListQuery.parse(req.query)));
  }));
  r.get('/:key', asyncHandler(async (req, res) => {
    res.setHeader('Cache-Control', 'public, max-age=10, stale-while-revalidate=60');
    ApiResponse.ok(res, await svc.getPublicProduct(req.params.key));
  }));
  return r;
}

/** Mounted at /v1/admin/products - admin + super_admin. Reads EXCLUDE archived products by default; `?deleted=include` shows all, `?deleted=only` shows just the archived. */
export function adminProductRoutes() {
  const r = Router();
  r.use(authenticate('admin'), requireRole('admin', 'super_admin'));
  r.get('/', asyncHandler(async (req, res) => ApiResponse.ok(res, await svc.listAdminProducts(adminListQuery.parse(req.query)))));
  r.get('/:id', asyncHandler(async (req, res) => ApiResponse.ok(res, await svc.getAdminProduct(req.params.id))));
  r.post('/', validateBody(productInput), asyncHandler(async (req, res) => ApiResponse.created(res, await svc.createProduct(req.authUser!, req.body, req))));
  r.put('/:id', validateBody(productInput), asyncHandler(async (req, res) => ApiResponse.ok(res, await svc.updateProduct(req.authUser!, req.params.id, req.body, req))));
  r.delete('/:id', asyncHandler(async (req, res) => {
    await svc.softDeleteProduct(req.authUser!, req.params.id, req);
    ApiResponse.ok(res, { ok: true });
  }));
  r.post('/:id/restore', asyncHandler(async (req, res) => ApiResponse.ok(res, await svc.restoreProduct(req.authUser!, req.params.id, req))));
  return r;
}
