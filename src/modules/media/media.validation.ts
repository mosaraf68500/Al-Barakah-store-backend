import { z } from 'zod';

export const MEDIA_FOLDERS = ['products', 'categories', 'banners', 'seo', 'misc'] as const;
export const ROOT_FOLDER = 'albarakah';

export const signSchema = z.object({ folder: z.enum(MEDIA_FOLDERS).default('products') });
/** Fields of Cloudinary's upload response that the browser passes back to register the asset. */
export const registerSchema = z.object({
  publicId: z.string().min(3).max(300),
  version: z.coerce.number().int().positive(),
  signature: z.string().regex(/^[a-f0-9]{40,64}$/i),
  secureUrl: z.string().url().max(1000),
  url: z.string().url().max(1000).optional(),
  resourceType: z.literal('image').default('image'),
  format: z.string().max(20).optional(),
  bytes: z.number().int().nonnegative().optional(),
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
});
export const listQuery = z.object({ folder: z.enum(MEDIA_FOLDERS).optional(), limit: z.coerce.number().int().min(1).max(200).default(50) });
