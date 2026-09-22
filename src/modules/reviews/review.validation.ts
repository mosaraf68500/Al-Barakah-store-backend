import { z } from 'zod';

export const createReviewSchema = z.object({
  productId: z.string().trim().min(1).max(80),
  rating: z.number().int().min(1).max(5),
  comment: z.string().trim().min(1).max(2000),
  city: z.string().trim().max(120).optional(),
});
export type CreateReviewInput = z.infer<typeof createReviewSchema>;

export const publicReviewQuery = z.object({
  productId: z.string().trim().min(1).max(80).optional(),
  page: z.coerce.number().int().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

export const adminReviewListQuery = z.object({ deleted: z.enum(['include', 'exclude', 'only']).default('exclude') });
