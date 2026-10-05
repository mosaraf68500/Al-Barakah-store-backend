import { createHash } from 'crypto';
import { disableRedisForInstance, getRedis } from './redis';
import { logger } from '../utils/logger';

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
    // One bad connection should not brick every subsequent request on a warm instance.
    try {
      redis.disconnect();
    } catch {
      /* ignore */
    }
    disableRedisForInstance();
    return undefined;
  }
}

/** Stable short hash for query objects used in cache keys. */
export function hashQuery(q: unknown): string {
  return createHash('sha1').update(JSON.stringify(q ?? {})).digest('hex').slice(0, 16);
}

/**
 * Cache-aside: return cached JSON value, or run `loader`, store with TTL, return.
 * Silently falls through to `loader` when Redis is unavailable.
 */
export async function cacheGetOrSet<T>(key: string, ttlSeconds: number, loader: () => Promise<T>, indexKey?: string): Promise<T> {
  const hit = await withClient(async (redis) => {
    const raw = await redis.get(key);
    if (raw == null) return undefined;
    return JSON.parse(raw) as T;
  });
  if (hit !== undefined) return hit;

  const value = await loader();

  await withClient(async (redis) => {
    const payload = JSON.stringify(value);
    const multi = redis.multi();
    multi.set(key, payload, 'EX', ttlSeconds);
    if (indexKey) multi.sadd(indexKey, key);
    await multi.exec();
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
