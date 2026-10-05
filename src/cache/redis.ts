import Redis from 'ioredis';
import { getEnv } from '../config/env';
import { logger } from '../utils/logger';

/**
 * Serverless-safe Redis client (same pattern as Mongo in db.ts).
 * When REDIS_URL is unset, every call is a no-op so local/test/prod without Redis keep working.
 */
interface Cache {
  client: Redis | null;
  disabled: boolean;
}

const g = globalThis as unknown as { __abpRedis?: Cache };
const state: Cache = (g.__abpRedis ??= { client: null, disabled: false });

export function isRedisEnabled(): boolean {
  if (state.disabled) return false;
  try {
    return Boolean(getEnv().REDIS_URL);
  } catch {
    return false;
  }
}

export function getRedis(): Redis | null {
  if (state.disabled) return null;
  const url = getEnv().REDIS_URL;
  if (!url) return null;
  if (state.client) return state.client;

  try {
    const client = new Redis(url, {
      maxRetriesPerRequest: 1,
      enableReadyCheck: true,
      lazyConnect: true,
      connectTimeout: 5_000,
      // Vercel: don't hang the function on a dead Redis forever.
      commandTimeout: 3_000,
      tls: url.startsWith('rediss://') ? {} : undefined,
    });
    client.on('error', (err) => {
      logger.warn({ err: err.message }, 'redis error');
    });
    state.client = client;
    return client;
  } catch (err) {
    logger.warn({ err: (err as Error).message }, 'redis init failed; continuing without cache');
    state.disabled = true;
    return null;
  }
}

/** Soft-disable for the rest of this instance after repeated failures. */
export function disableRedisForInstance() {
  state.disabled = true;
}

export async function disconnectRedis(): Promise<void> {
  const c = state.client;
  state.client = null;
  state.disabled = false;
  if (c) {
    try {
      await c.quit();
    } catch {
      c.disconnect();
    }
  }
}
