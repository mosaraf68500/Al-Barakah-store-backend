import { Router } from 'express';
import { authenticate, requireRole } from '../../middleware/authenticate';
import { validateBody } from '../../middleware/validate';
import { ApiResponse } from '../../utils/ApiResponse';
import { asyncHandler } from '../../utils/asyncHandler';
import * as svc from './category.service';
import { categoryInput, categoryList, categoryPatch } from './category.validation';

/** Mounted at /v1/categories - public, all categories (enabled + disabled) sorted by `order`, exactly what the storefront's `getCategories()` reads. */
export function publicCategoryRoutes() {
  const r = Router();
  r.get('/', asyncHandler(async (_req, res) => {
    res.setHeader('Cache-Control', 'public, max-age=15, stale-while-revalidate=60');
    ApiResponse.ok(res, await svc.listCategories());
  }));
  return r;
}

/** Mounted at /v1/admin/categories - admin + super_admin. Every write returns the full updated list (what the admin app expects). */
export function adminCategoryRoutes() {
  const r = Router();
  r.use(authenticate('admin'), requireRole('admin', 'super_admin'));
  r.get('/', asyncHandler(async (_req, res) => ApiResponse.ok(res, await svc.listCategories())));
  r.post('/', validateBody(categoryInput), asyncHandler(async (req, res) => ApiResponse.created(res, await svc.createCategory(req.authUser!, req.body, req))));
  r.put('/', validateBody(categoryList), asyncHandler(async (req, res) => ApiResponse.ok(res, await svc.replaceCategories(req.authUser!, req.body.categories, req))));
  r.patch('/:id', validateBody(categoryPatch), asyncHandler(async (req, res) => ApiResponse.ok(res, await svc.updateCategory(req.authUser!, req.params.id, req.body, req))));
  r.delete('/:id', asyncHandler(async (req, res) => ApiResponse.ok(res, await svc.deleteCategory(req.authUser!, req.params.id, req))));
  return r;
}
