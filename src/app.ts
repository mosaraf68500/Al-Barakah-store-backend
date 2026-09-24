import cookieParser from 'cookie-parser';
import cors from 'cors';
import express, { type Express, type Request, type Response } from 'express';
import helmet from 'helmet';
import { API_PREFIX } from './config/constants';
import { connectDb, pingDb } from './config/db';
import { getEnv } from './config/env';
import { errorHandler, notFound } from './middleware/errorHandler';
import { publicReadLimiter } from './middleware/rateLimiter';
import { requestLogger } from './middleware/requestLogger';
import { adminAuthRoutes, adminStaffRoutes } from './modules/admin-auth/adminAuth.routes';
import { authRoutes } from './modules/auth/auth.routes';
import { adminCustomerRoutes } from './modules/customers/customers.routes';
import { adminCategoryRoutes, publicCategoryRoutes } from './modules/categories/category.routes';
import { adminMediaRoutes } from './modules/media/media.routes';
import { adminCouponRoutes, publicCouponRoutes } from './modules/coupons/coupon.routes';
import { adminProductRoutes, publicProductRoutes } from './modules/products/product.routes';
import { adminOrderRoutes, orderCronRoutes, orderRoutes } from './modules/orders/order.routes';
import { adminReviewRoutes, publicReviewRoutes } from './modules/reviews/review.routes';
import { wishlistRoutes } from './modules/wishlist/wishlist.routes';
import { adminBackupRoutes } from './modules/adminOps/backup.routes';
import { adminHealthRoutes } from './modules/adminOps/health.routes';
import { adminIntegrationRoutes } from './modules/adminOps/integration.routes';
import { adminSettingsRoutes, publicSettingsRoutes } from './modules/settings/settings.routes';
import { cronRoutes } from './modules/cron/cleanup.routes';
import { asyncHandler } from './utils/asyncHandler';

export interface AppOptions {
  /** IP rate limiters on/off (tests turn them off except in the dedicated rate-limit test). Account lockouts are always on. */
  rateLimits?: boolean;
}

export function createApp(opts: AppOptions = {}): Express {
  const rateLimits = opts.rateLimits ?? true;
  const env = getEnv(); // fail fast on a bad configuration

  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', env.TRUST_PROXY_HOPS);

  app.use(requestLogger);
  // API JSON is not a document. CSP denies everything; CORP stays cross-origin so shop./admin. can read credentialed responses. CORS remains the allow-list.
  app.use(helmet({
    contentSecurityPolicy: { useDefaults: false, directives: { defaultSrc: ["'none'"], baseUri: ["'none'"], frameAncestors: ["'none'"] } },
    referrerPolicy: { policy: 'no-referrer' },
    crossOriginResourcePolicy: { policy: 'cross-origin' },
    crossOriginEmbedderPolicy: false,
  }));
  // SECURITY_RISKS #18: explicit allow-list (legacy reflected ANY origin with credentials)
  app.use(
    cors({
      origin: (origin, cb) => (!origin || env.corsOrigins.includes(origin) ? cb(null, true) : cb(new Error('CORS_ORIGIN_NOT_ALLOWED'))),
      credentials: true,
      methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
      allowedHeaders: ['Content-Type', 'Authorization', 'X-Abp-Client', 'X-Request-Id'],
      maxAge: 600,
    }),
  );
  // A full database backup can be several MB; the global 100kb JSON limit (DoS protection for every other route) would make
  // restoring one impossible. `express.json()` is idempotent - once a body is parsed, later instances just call next() - so
  // this larger, PATH-SCOPED parser runs first only for that one route, and every other route keeps the strict 100kb limit.
  app.use(`${API_PREFIX}/admin/backup/restore`, express.json({ limit: '25mb' }));
  app.use(express.json({ limit: '100kb' }));
  app.use(cookieParser());

  // Serverless: make sure the (cached) connection exists before any handler touches the database.
  app.use(asyncHandler(async (_req, _res, next) => {
    await connectDb();
    next();
  }));

  const v1 = express.Router();
  v1.use(publicReadLimiter(rateLimits));
  v1.get('/health', asyncHandler(async (_req, res) => {
    res.json({ status: 'ok', db: { ok: true, latencyMs: await pingDb() }, timestamp: new Date().toISOString() });
  }));
  v1.use('/auth', authRoutes(rateLimits));
  v1.use('/admin-auth', adminAuthRoutes(rateLimits));
  v1.use('/admin', adminStaffRoutes());
  v1.use('/admin/customers', adminCustomerRoutes());
  v1.use('/settings', publicSettingsRoutes());
  v1.use('/admin/settings', adminSettingsRoutes());
  v1.use('/admin/media', adminMediaRoutes());
  v1.use('/categories', publicCategoryRoutes());
  v1.use('/admin/categories', adminCategoryRoutes());
  v1.use('/coupons', publicCouponRoutes(rateLimits));
  v1.use('/admin/coupons', adminCouponRoutes());
  v1.use('/products', publicProductRoutes());
  v1.use('/admin/products', adminProductRoutes());
  v1.use('/orders', orderRoutes(rateLimits));
  v1.use('/admin/orders', adminOrderRoutes());
  v1.use('/reviews', publicReviewRoutes(rateLimits));
  v1.use('/admin/reviews', adminReviewRoutes());
  v1.use('/wishlist', wishlistRoutes());
  v1.use('/admin/backup', adminBackupRoutes(rateLimits));
  v1.use('/admin/integrations', adminIntegrationRoutes());
  v1.use('/admin', adminHealthRoutes());
  v1.use('/internal/cron', cronRoutes());
  v1.use('/internal/cron/orders', orderCronRoutes());
  app.use(API_PREFIX, v1);
  app.get('/', (_req, res) => {
    res.json({ status: 'ok', service: 'al-barakah-backend' });
  });

  app.use(notFound);
  app.use(errorHandler);
  return app;
}

/**
 * Vercel treats `src/app.ts` as the server entry and rejects the file unless the
 * default export is a function. The app is built on the first request so tests
 * can import `createApp` before their database URL exists.
 */
let vercelApp: Express | undefined;
export default function vercelHandler(req: Request, res: Response) {
  vercelApp ??= createApp();
  return vercelApp(req, res);
}
