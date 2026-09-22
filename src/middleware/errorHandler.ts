import type { ErrorRequestHandler, RequestHandler } from 'express';
import { ZodError } from 'zod';
import { ApiError } from '../utils/ApiError';
import { logger } from '../utils/logger';

export const notFound: RequestHandler = (_req, res) => {
  res.status(404).json({ error: 'NOT_FOUND' });
};

/** Single place that turns errors into `{ error, message?, details? }` JSON. Internals never leak. */
export const errorHandler: ErrorRequestHandler = (err, req, res, _next) => {
  if (res.headersSent) return;
  if (err instanceof ApiError) {
    if (err.headers) for (const [k, v] of Object.entries(err.headers)) res.setHeader(k, v);
    return void res.status(err.status).json({ error: err.code, ...(err.message !== err.code ? { message: err.message } : {}), ...(err.details !== undefined ? { details: err.details } : {}) });
  }
  if (err instanceof ZodError) {
    return void res.status(400).json({ error: 'VALIDATION_ERROR', details: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })) });
  }
  const e = err as { type?: string; status?: number; message?: string };
  if (e?.type === 'entity.too.large') return void res.status(413).json({ error: 'PAYLOAD_TOO_LARGE' });
  if (e?.type === 'entity.parse.failed') return void res.status(400).json({ error: 'INVALID_JSON' });
  if (e?.message === 'CORS_ORIGIN_NOT_ALLOWED') return void res.status(403).json({ error: 'ORIGIN_NOT_ALLOWED' });
  logger.error({ err, path: String(req.url).split('?')[0] }, 'unhandled error');
  res.status(500).json({ error: 'INTERNAL_ERROR' });
};
