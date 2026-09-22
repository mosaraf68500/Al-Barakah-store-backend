import { MongoMemoryReplSet } from 'mongodb-memory-server';

let mongod: MongoMemoryReplSet | undefined;

/**
 * A single-node REPLICA SET, like Atlas: multi-document transactions (order placement + stock + coupon) need one.
 * All test files share this one server; they run one after another (`fileParallelism: false`) and each test starts from a dropped database.
 */
export async function setup() {
  mongod = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: 'wiredTiger' } });
  // inherited by the test workers (they are spawned after globalSetup)
  process.env.MONGODB_URI = mongod.getUri('albarakah_test');
}

export async function teardown() {
  await mongod?.stop();
}
