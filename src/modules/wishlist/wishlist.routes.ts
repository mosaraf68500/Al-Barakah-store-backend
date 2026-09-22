import { Router } from 'express';
import { authenticate } from '../../middleware/authenticate';
import { ApiResponse } from '../../utils/ApiResponse';
import { asyncHandler } from '../../utils/asyncHandler';
import * as svc from './wishlist.service';

/** Mounted at /v1/wishlist - customer-only. */
export function wishlistRoutes() {
  const r = Router();
  r.use(authenticate('customer'));
  r.get('/', asyncHandler(async (req, res) => ApiResponse.ok(res, await svc.listWishlist(String(req.authUser!._id)))));
  r.post('/:productId', asyncHandler(async (req, res) => ApiResponse.ok(res, await svc.toggleWishlist(String(req.authUser!._id), req.params.productId))));
  r.delete('/:productId', asyncHandler(async (req, res) => ApiResponse.ok(res, await svc.removeFromWishlist(String(req.authUser!._id), req.params.productId))));
  return r;
}
