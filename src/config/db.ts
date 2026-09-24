import mongoose from 'mongoose';
import { getEnv } from './env';
import { logger } from '../utils/logger';

/**
 * Serverless-safe connection: on Vercel every invocation may land in a warm container that already holds a connection, or
 * a cold one that has none. The promise is cached on `globalThis` (survives module re-evaluation in dev/HMR) so concurrent
 * invocations share ONE connection attempt and we never open a connection per request.
 */
interface Cache {
  conn: typeof mongoose | null;
  promise: Promise<typeof mongoose> | null;
}
const g = globalThis as unknown as { __abpMongo?: Cache };
const cache: Cache = (g.__abpMongo ??= { conn: null, promise: null });

export async function connectDb(): Promise<typeof mongoose> {
  if (cache.conn && mongoose.connection.readyState === 1) return cache.conn;
  // A warm Vercel instance can wake up with a dead socket. The old promise must not be reused.
  if (mongoose.connection.readyState !== 2) {
    cache.conn = null;
    cache.promise = null;
  }
  if (!cache.promise) {
    mongoose.set('strictQuery', true);
    cache.promise = mongoose
      .connect(getEnv().MONGODB_URI, {
        bufferCommands: false, // fail fast instead of queueing forever when disconnected
        maxPoolSize: 5, // small pool: many function instances share one Atlas cluster
        serverSelectionTimeoutMS: 8_000,
        socketTimeoutMS: 30_000,
      })
      .then((m) => {
        logger.info('mongodb connected');
        return m;
      })
      .catch((err) => {
        cache.promise = null; // allow the next invocation to retry
        throw err;
      });
  }
  cache.conn = await cache.promise;
  return cache.conn;
}

export async function disconnectDb(): Promise<void> {
  cache.conn = null;
  cache.promise = null;
  await mongoose.disconnect();
}

export async function pingDb(): Promise<number> {
  await connectDb();
  const db = mongoose.connection.db;
  if (!db) throw new Error('mongodb not connected');
  const t = Date.now();
  await db.admin().ping();
  return Date.now() - t;
}
