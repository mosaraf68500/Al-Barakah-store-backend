import { createHash } from 'crypto';
import { disableRedisForInstance, getRedis } from './redis';
import { logger } from '../utils/logger';

/**
 * Run a Redis command. On any failure: log, soft-disable Redis briefly, return undefined.
 * Callers always fall through to Mongo — Redis must never break a request.
 */
async function withClient<T>(fn: (redis: NonNullable<ReturnType<typeof getRedis>>) => Promise<T>): Promise<T | undefined> {
  const redis = getRedis();
  if (!redis) return undefined;
  try {
    if (redis.status !== 'ready' && redis.status !== 'connecting') {
      await redis.connect();
    }
    return await fn(redis);
  } catch (err) {
    logger.warn({ err: (err as Error).message }, 'redis command failed; falling through to DB');
    disableRedisForInstance();
    return undefined;
  }
}

/** Stable short hash for query objects used in cache keys. */
export function hashQuery(q: unknown): string {
  return createHash('sha1').update(JSON.stringify(q ?? {})).digest('hex').slice(0, 16);
}

/**
 * Cache-aside: return cached JSON value, or run `loader` (Mongo), store with TTL, return.
 * Silently falls through to `loader` when Redis is unavailable or returns bad data.
 */
export async function cacheGetOrSet<T>(key: string, ttlSeconds: number, loader: () => Promise<T>, indexKey?: string): Promise<T> {
  const hit = await withClient(async (redis) => {
    const raw = await redis.get(key);
    if (raw == null) return undefined as T | undefined;
    try {
      return JSON.parse(raw) as T;
    } catch {
      // Corrupt entry — drop it and reload from DB.
      await redis.del(key);
      return undefined as T | undefined;
    }
  });
  // Distinguish "cache miss / redis down" (undefined) from a legitimate cached null/false if we ever store those.
  // We only ever cache JSON objects/arrays for public reads, so undefined always means miss.
  if (hit !== undefined) return hit;

  const value = await loader();

  // Best-effort write; failure only means the next request hits Mongo again.
  await withClient(async (redis) => {
    try {
      const payload = JSON.stringify(value);
      const multi = redis.multi();
      multi.set(key, payload, 'EX', ttlSeconds);
      if (indexKey) multi.sadd(indexKey, key);
      await multi.exec();
    } catch (err) {
      logger.warn({ err: (err as Error).message, key }, 'redis set failed; value still returned from DB');
      throw err; // withClient will soft-disable
    }
  });

  return value;
}

export async function cacheDel(...keys: string[]): Promise<void> {
  if (keys.length === 0) return;
  await withClient(async (redis) => {
    await redis.del(...keys);
  });
}

/** Delete every member of an index set, then the set itself. */
export async function cacheInvalidateIndex(indexKey: string): Promise<void> {
  await withClient(async (redis) => {
    const members = await redis.smembers(indexKey);
    if (members.length) await redis.del(...members);
    await redis.del(indexKey);
  });
}

export async function cacheDelAndUnindex(indexKey: string, ...keys: string[]): Promise<void> {
  if (keys.length === 0) return;
  await withClient(async (redis) => {
    const multi = redis.multi();
    multi.del(...keys);
    multi.srem(indexKey, ...keys);
    await multi.exec();
  });
}
