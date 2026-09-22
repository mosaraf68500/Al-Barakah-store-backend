/**
 * Vercel Function entrypoint. vercel.json rewrites every path to /api, so Express sees the ORIGINAL url (/v1/...).
 * One Express app per warm container; the MongoDB connection is cached on globalThis (src/config/db.ts).
 */
import { createApp } from '../src/app';

const app = createApp();
export default app;
