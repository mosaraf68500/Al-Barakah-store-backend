import mongoose, { type ClientSession } from 'mongoose';

/**
 * Runs `fn` inside a MongoDB transaction (needs a replica set - Atlas always is; tests use MongoMemoryReplSet). The callback may
 * be re-run by the driver on a transient error, so it must only touch the database through the `session` it is given.
 * Shared by every module that needs multi-document atomicity (orders, reviews, ...).
 */
export async function withTransaction<T>(fn: (session: ClientSession) => Promise<T>): Promise<T> {
  const session = await mongoose.startSession();
  try {
    let result!: T;
    await session.withTransaction(async () => {
      result = await fn(session);
    });
    return result;
  } finally {
    await session.endSession();
  }
}
