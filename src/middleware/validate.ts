import type { RequestHandler } from 'express';
import type { ZodTypeAny, z } from 'zod';

/** Validate + REPLACE `req.body` with the parsed value (unknown keys are stripped by the schemas). */
export const validateBody =
  <S extends ZodTypeAny>(schema: S): RequestHandler =>
  (req, _res, next) => {
    const r = schema.safeParse(req.body ?? {});
    if (!r.success) return next(r.error);
    req.body = r.data as z.infer<S>;
    next();
  };
