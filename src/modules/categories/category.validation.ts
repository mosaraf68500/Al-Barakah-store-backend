import { z } from 'zod';

const slug = z.string().trim().min(1).max(120).regex(/^[\p{L}\p{N}]+(?:-[\p{L}\p{N}]+)*$/u, 'slug: letters, digits and single dashes only');
const image = z.string().max(1000).default('');
const id = z.string().regex(/^cat-[A-Za-z0-9-]{1,60}$/, 'id must look like cat-…');

/** Shape the admin app sends (`CategoryItem`). `order` is ignored: the server owns ordering. */
export const categoryInput = z.object({
  id: id.optional(),
  name: z.string().trim().min(1).max(120),
  slug: slug.optional(),
  image,
  enabled: z.boolean().default(true),
  badge: z.string().trim().max(40).optional().or(z.literal('')),
  order: z.number().optional(),
  description: z.string().max(500).optional(),
});
export type CategoryInput = z.infer<typeof categoryInput>;
export const categoryPatch = categoryInput.partial().extend({ id: id.optional() });
export const categoryList = z.object({ categories: z.array(categoryInput).min(1).max(200) });
