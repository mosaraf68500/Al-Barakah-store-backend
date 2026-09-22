import type { Request } from 'express';
import { generateSlug } from '../../domain/slug';
import { ApiError } from '../../utils/ApiError';
import { recordAudit } from '../audit/audit.service';
import { registerMediaUsageChecker } from '../media/media.service';
import { resolveImages, serializeImage, type ImageRef } from '../media/media.lookup';
import { ProductModel } from '../products/product.model';
import type { UserDocument } from '../users/user.model';
import { CategoryModel, type CategoryDoc } from './category.model';
import type { CategoryInput } from './category.validation';

/** Shape used by both apps (`CategoryItem`): plain image URL string, `enabled`, `order`. */
export const toCategory = (c: CategoryDoc) => ({ id: c._id, name: c.name, slug: c.slug, image: serializeImage(c.image), enabled: c.enabled, ...(c.badge ? { badge: c.badge } : {}), order: c.order });

export async function listCategories() {
  return (await CategoryModel.find().sort({ order: 1, _id: 1 }).lean()).map(toCategory);
}

const actorOf = (u: UserDocument) => ({ id: u._id, email: u.email, role: u.role });
const newId = () => `cat-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

async function renumber() {
  const all = await CategoryModel.find().sort({ order: 1, createdAt: 1, _id: 1 }).lean();
  await Promise.all(all.map((c, i) => (c.order === i ? null : CategoryModel.updateOne({ _id: c._id }, { $set: { order: i } }))));
}

async function imageFor(url: string): Promise<ImageRef | null> {
  if (!url) return null;
  return (await resolveImages([url])).get(url)!;
}
const slugFor = (i: { slug?: string; name: string }, id: string) => (i.slug?.trim() ? i.slug.trim() : generateSlug(i.name) || id);

async function assertUnique(name: string, slug: string, exceptId?: string) {
  const byName = await CategoryModel.findOne({ name }).collation({ locale: 'en', strength: 2 }).lean();
  if (byName && byName._id !== exceptId) throw ApiError.conflict('CATEGORY_NAME_TAKEN');
  const bySlug = await CategoryModel.findOne({ slug }).lean();
  if (bySlug && bySlug._id !== exceptId) throw ApiError.conflict('CATEGORY_SLUG_TAKEN');
}

export async function createCategory(actor: UserDocument, input: CategoryInput, req: Request) {
  const id = input.id ?? newId();
  if (await CategoryModel.exists({ _id: id })) throw ApiError.conflict('CATEGORY_ID_TAKEN');
  const slug = slugFor(input, id);
  await assertUnique(input.name, slug);
  const count = await CategoryModel.countDocuments();
  await CategoryModel.create({ _id: id, name: input.name, slug, image: await imageFor(input.image), enabled: input.enabled, badge: input.badge || undefined, description: input.description, order: count });
  await recordAudit({ actor: actorOf(actor), action: 'category.create', entity: 'Category', entityId: id, details: { name: input.name }, req });
  return listCategories();
}

/** Rename needs no cascade any more: products reference `categoryId`, and the API resolves the name at read time (BUG_FIXES A12). */
export async function updateCategory(actor: UserDocument, id: string, input: Partial<CategoryInput>, req: Request) {
  const current = await CategoryModel.findById(id);
  if (!current) throw ApiError.notFound('CATEGORY_NOT_FOUND');
  const name = input.name ?? current.name;
  const slug = input.slug?.trim() || current.slug;
  await assertUnique(name, slug, id);
  current.name = name;
  current.slug = slug;
  if (input.image !== undefined) current.image = await imageFor(input.image);
  if (input.enabled !== undefined) current.enabled = input.enabled;
  if (input.badge !== undefined) current.badge = input.badge || undefined;
  if (input.description !== undefined) current.description = input.description;
  await current.save();
  await recordAudit({ actor: actorOf(actor), action: 'category.update', entity: 'Category', entityId: id, details: { name }, req });
  return listCategories();
}

/** A category that still has products (active OR archived - restoring one must never orphan it) cannot be deleted. */
export async function assertDeletable(id: string, name: string) {
  const count = await ProductModel.countDocuments({ categoryId: id });
  if (count > 0) {
    throw new ApiError(409, 'CATEGORY_HAS_PRODUCTS', `এই ক্যাটাগরিতে ${count} টি প্রোডাক্ট আছে। আগে প্রোডাক্টগুলো অন্য ক্যাটাগরিতে সরান, তারপর ডিলিট করুন।`, { productCount: count, category: name });
  }
}

export async function deleteCategory(actor: UserDocument, id: string, req: Request) {
  const current = await CategoryModel.findById(id);
  if (!current) throw ApiError.notFound('CATEGORY_NOT_FOUND');
  await assertDeletable(id, current.name);
  await CategoryModel.deleteOne({ _id: id });
  await renumber();
  await recordAudit({ actor: actorOf(actor), action: 'category.delete', entity: 'Category', entityId: id, details: { name: current.name }, req });
  return listCategories();
}

/**
 * Bulk replace of the ORDERED list (reorder / turn all on-off / reset defaults). Matched by id: existing rows are updated and take the
 * array position as `order`, unknown ids are created, rows missing from the list are deleted - but only if they have no products
 * (otherwise the whole request is refused and nothing changes).
 */
export async function replaceCategories(actor: UserDocument, items: CategoryInput[], req: Request) {
  const list = items.map((i) => ({ ...i, id: i.id ?? newId() }));
  const ids = list.map((i) => i.id);
  if (new Set(ids).size !== ids.length) throw ApiError.badRequest('DUPLICATE_CATEGORY_ID');
  if (new Set(list.map((i) => i.name.toLowerCase())).size !== list.length) throw ApiError.conflict('CATEGORY_NAME_TAKEN');
  const slugs = list.map((i) => slugFor(i, i.id));
  if (new Set(slugs).size !== list.length) throw ApiError.conflict('CATEGORY_SLUG_TAKEN');

  const existing = await CategoryModel.find().lean();
  const keep = new Set(ids);
  const removed = existing.filter((c) => !keep.has(c._id));
  for (const c of removed) await assertDeletable(c._id, c.name); // all-or-nothing: check BEFORE writing anything
  const images = await resolveImages(list.map((i) => i.image));

  await CategoryModel.deleteMany({ _id: { $in: removed.map((c) => c._id) } });
  // phase 1: park every touched row under a throw-away unique name/slug so swapped names/slugs cannot collide mid-way
  await CategoryModel.bulkWrite(list.map((it) => ({ updateOne: { filter: { _id: it.id }, update: { $set: { name: `__tmp__${it.id}`, slug: `__tmp__${it.id}` } }, upsert: true } })));
  // phase 2: final values
  await CategoryModel.bulkWrite(
    list.map((it, idx) => ({
      updateOne: {
        filter: { _id: it.id },
        update: { $set: { name: it.name, slug: slugs[idx], image: it.image ? images.get(it.image)! : null, enabled: it.enabled, badge: it.badge || undefined, description: it.description, order: idx } },
      },
    })),
  );
  await recordAudit({ actor: actorOf(actor), action: 'category.replace', entity: 'Category', details: { count: list.length, removed: removed.map((c) => c.name) }, req });
  return listCategories();
}

// A Cloudinary asset used as a category picture cannot be deleted while in use.
registerMediaUsageChecker(async (m) => ((await CategoryModel.exists({ 'image.publicId': m.publicId })) ? ['categories'] : []));
