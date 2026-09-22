/**
 * Wishlist (BACKEND_PLAN §2.13/§3.1, module 12, Q11 = confirmed GO). Legacy's own Express server had a wishlist API, but the
 * storefront SPA never called it - the wishlist was (and in `al-barakah-frontend` still is) local-only, `store/wishlistStore.ts`
 * (Zustand + localStorage, `toggle()` returning whether the item ended up added). There is no `lib/api/wishlist.ts` to match, so
 * this module's contract is built straight from BACKEND_PLAN's spec: `GET /wishlist` -> `Product[]`, `POST /wishlist/:productId`
 * -> `{added}` (a toggle, matching the existing Zustand action's own semantics exactly). A `DELETE` is added for an explicit,
 * idempotent remove alongside the toggle.
 */
import { ApiError } from '../../utils/ApiError';
import { ProductModel } from '../products/product.model';
import { toPublicProduct } from '../products/product.serializer';
import { WishlistItemModel } from './wishlist.model';

async function categoryNameMap(categoryIds: string[]): Promise<Map<string, string>> {
  const { CategoryModel } = await import('../categories/category.model');
  const cats = await CategoryModel.find({ _id: { $in: categoryIds } }).lean();
  return new Map(cats.map((c) => [c._id, c.name]));
}

/** `GET /wishlist` - the customer's wishlisted products, newest-first, in the public `Product` shape (no `costPrice`). An
 * archived (soft-deleted) product silently drops out of the list - the wishlist ROW is not deleted, so it reappears if the
 * product is ever restored. */
export async function listWishlist(userId: string) {
  const items = await WishlistItemModel.find({ userId }).sort({ createdAt: -1 }).lean();
  if (items.length === 0) return [];
  const products = await ProductModel.find({ _id: { $in: items.map((i) => i.productId) }, deletedAt: null }).lean();
  const names = await categoryNameMap(products.map((p) => p.categoryId));
  const byId = new Map(products.map((p) => [p._id, p]));
  return items.map((i) => byId.get(i.productId)).filter((p): p is NonNullable<typeof p> => Boolean(p)).map((p) => toPublicProduct(p, names.get(p.categoryId) ?? ''));
}

/** `POST /wishlist/:productId` - toggles membership; returns `{added}` exactly like the frontend's own `toggle()`. 404 if the product doesn't exist or is archived (nothing public to wishlist). */
export async function toggleWishlist(userId: string, productId: string): Promise<{ added: boolean }> {
  const removed = await WishlistItemModel.findOneAndDelete({ userId, productId });
  if (removed) return { added: false };
  const exists = await ProductModel.exists({ _id: productId, deletedAt: null });
  if (!exists) throw ApiError.notFound('PRODUCT_NOT_FOUND');
  try {
    await WishlistItemModel.create({ userId, productId });
  } catch (e) {
    if ((e as { code?: number }).code !== 11000) throw e; // lost a concurrent add race - already added, treat as success
  }
  return { added: true };
}

/** `DELETE /wishlist/:productId` - explicit remove (idempotent; not itself in BACKEND_PLAN's route table, added alongside the toggle for a normal REST DELETE). */
export async function removeFromWishlist(userId: string, productId: string): Promise<{ ok: true }> {
  await WishlistItemModel.deleteOne({ userId, productId });
  return { ok: true };
}
