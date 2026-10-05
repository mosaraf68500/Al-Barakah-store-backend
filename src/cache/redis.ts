import Redis from 'ioredis';
import { getEnv } from '../config/env';
import { logger } from '../utils/logger';

/**
 * Serverless-safe Redis client (same warm-instance pattern as Mongo).
 * When REDIS_URL is unset, every call is a no-op so local/test without Redis keep hitting Mongo.
 * After a failure we soft-disable for a short cooldown, then retry — the API never depends on Redis being up.
 */
interface Cache {
  client: Redis | null;
  /** Soft-disable until this timestamp (ms). 0 = healthy. */
  disabledUntil: number;
  loggedReady: boolean;
}

const COOLDOWN_MS = 30_000;

const g = globalThis as unknown as { __abpRedis?: Cache };
const state: Cache = (g.__abpRedis ??= { client: null, disabledUntil: 0, loggedReady: false });

export function isRedisEnabled(): boolean {
  if (Date.now() < state.disabledUntil) return false;
  try {
    return Boolean(getEnv().REDIS_URL?.trim());
  } catch {
    return false;
  }
}

export function getRedis(): Redis | null {
  if (Date.now() < state.disabledUntil) return null;
  const url = getEnv().REDIS_URL?.trim();
  if (!url) return null;
  if (state.client) return state.client;

  try {
    const useTls = /^rediss:\/\//i.test(url);
    const client = new Redis(url, {
      maxRetriesPerRequest: 1,
      enableReadyCheck: true,
      lazyConnect: true,
      connectTimeout: 5_000,
      // Vercel: don't hang the function on a dead Redis forever.
      commandTimeout: 3_000,
      // Prefer IPv4 — some serverless DNS resolutions hang on AAAA for Redis Cloud.
      family: 4,
      keepAlive: 10_000,
      // Only enable TLS when the URL scheme is rediss://. Some Redis Cloud ports are plain redis://.
      ...(useTls ? { tls: { rejectUnauthorized: true } } : {}),
      retryStrategy: (times) => {
        if (times > 2) return null; // stop reconnect storm; caller falls through to DB
        return Math.min(times * 200, 1_000);
      },
    });
    client.on('error', (err) => {
      logger.warn({ err: err.message }, 'redis error');
    });
    client.on('ready', () => {
      if (!state.loggedReady) {
        state.loggedReady = true;
        logger.info('redis cache connected');
      }
    });
    state.client = client;
    return client;
  } catch (err) {
    logger.warn({ err: (err as Error).message }, 'redis init failed; continuing without cache');
    disableRedisForInstance();
    return null;
  }
}

/** Soft-disable for a cooldown so this warm instance falls through to Mongo, then retries Redis. */
export function disableRedisForInstance(cooldownMs = COOLDOWN_MS) {
  state.disabledUntil = Date.now() + cooldownMs;
  const c = state.client;
  state.client = null;
  state.loggedReady = false;
  if (c) {
    try {
      c.disconnect();
    } catch {
      /* ignore */
    }
  }
}

export async function disconnectRedis(): Promise<void> {
  const c = state.client;
  state.client = null;
  state.disabledUntil = 0;
  state.loggedReady = false;
  if (c) {
    try {
      await c.quit();
    } catch {
      c.disconnect();
    }
  }
}

/** Best-effort PING for admin health. Never throws. */
export async function pingRedis(): Promise<{ ok: boolean; latencyMs?: number; reason?: string }> {
  if (!getEnv().REDIS_URL?.trim()) return { ok: false, reason: 'REDIS_URL_UNSET' };
  if (Date.now() < state.disabledUntil) return { ok: false, reason: 'REDIS_COOLDOWN' };
  const redis = getRedis();
  if (!redis) return { ok: false, reason: 'REDIS_UNAVAILABLE' };
  const t0 = Date.now();
  try {
    if (redis.status !== 'ready' && redis.status !== 'connecting') {
      await redis.connect();
    }
    const pong = await redis.ping();
    if (pong !== 'PONG') return { ok: false, reason: 'UNEXPECTED_PING' };
    return { ok: true, latencyMs: Date.now() - t0 };
  } catch (err) {
    disableRedisForInstance();
    return { ok: false, reason: (err as Error).message || 'PING_FAILED' };
  }
}
