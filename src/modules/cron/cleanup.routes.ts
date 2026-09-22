import { Router } from 'express';
import { getEnv } from '../../config/env';
import { ApiError } from '../../utils/ApiError';
import { asyncHandler } from '../../utils/asyncHandler';
import { safeEqual } from '../../utils/crypto';
import { logger } from '../../utils/logger';
import { runCleanup } from './cleanup.service';

/** Vercel Cron calls GET with `Authorization: Bearer $CRON_SECRET`. Anything else is rejected. */
export function cronRoutes() {
  const r = Router();
  r.get(
    '/cleanup',
    asyncHandler(async (req, res) => {
      const h = req.headers.authorization ?? '';
      if (!h.startsWith('Bearer ') || !safeEqual(h.slice(7), getEnv().CRON_SECRET)) throw ApiError.unauthorized('CRON_AUTH_REQUIRED');
      const result = await runCleanup();
      logger.info(result, 'cron cleanup done');
      res.json({ ok: true, ...result });
    }),
  );
  return r;
}
