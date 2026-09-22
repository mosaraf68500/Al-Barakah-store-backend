/** Local development server only (production runs as a Vercel Function via api/index.ts). */
import 'dotenv/config';
import { createApp } from './app';
import { connectDb } from './config/db';
import { getEnv } from './config/env';
import { logger } from './utils/logger';

async function main() {
  const env = getEnv();
  await connectDb();
  createApp().listen(env.PORT, () => logger.info(`API listening on http://localhost:${env.PORT}/v1`));
}
main().catch((e) => {
  logger.error(e, 'startup failed');
  process.exit(1);
});
