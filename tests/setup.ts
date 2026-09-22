import http from 'node:http';
import mongoose from 'mongoose';
import { MongoClient } from 'mongodb';
import { afterAll, afterEach, beforeAll, beforeEach, expect } from 'vitest';
import { connectDb, disconnectDb } from '../src/config/db';
import { memoryOutbox } from '../src/modules/notifications/mailer';
import { inflight } from './helpers';

/**
 * supertest starts a throw-away server per request with `listen(0)` (wildcard address) but then connects to http://127.0.0.1:<port>.
 * On macOS a wildcard bind may reuse an ephemeral port that ANOTHER local process already holds on 127.0.0.1 (VS Code helpers, dev servers,
 * ...); the request then goes to that other process and hangs or gets a stray 400 - a ~1-in-6000 flake that surfaces as a random 30 s
 * timeout or a bogus 400 in an unrelated test (diagnosed in MODULE_5A_REPORT.md, section 1).
 * Fix: a pool of servers explicitly bound to 127.0.0.1 (the OS refuses ports another process holds there). supertest's `listen(0)` is
 * redirected to a free pool member, which forwards to the app under test. Same behaviour, no wildcard sockets, no port churn.
 */
interface Slot { server: http.Server; port: number; handler?: http.RequestListener }
const POOL_SIZE = 32;
const freeSlots: Slot[] = [];
const nativeListen = http.Server.prototype.listen;
beforeAll(async () => {
  for (let i = 0; i < POOL_SIZE; i++) {
    const slot = { handler: undefined } as unknown as Slot;
    slot.server = http.createServer((req, res) => (slot.handler ? slot.handler(req, res) : ((res.statusCode = 503), res.end())));
    await new Promise<void>((resolve) => nativeListen.call(slot.server, { port: 0, host: '127.0.0.1' }, resolve));
    slot.port = (slot.server.address() as { port: number }).port;
    freeSlots.push(slot);
  }
});
http.Server.prototype.listen = function patchedListen(this: http.Server, ...args: unknown[]) {
  const handler = this.listeners('request')[0] as http.RequestListener | undefined;
  const slot = args[0] === 0 && typeof args[1] !== 'string' && handler ? freeSlots.pop() : undefined;
  if (!slot) return (nativeListen as (...a: unknown[]) => http.Server).apply(this, args);
  slot.handler = handler;
  (this as unknown as { _handle: unknown })._handle = {}; // supertest only calls close() on servers that look bound
  this.address = () => ({ address: '127.0.0.1', family: 'IPv4', port: slot.port });
  this.close = ((cb?: (err?: Error) => void) => {
    slot.handler = undefined;
    (this as unknown as { _handle: unknown })._handle = null;
    freeSlots.push(slot);
    cb?.();
    return this;
  }) as typeof this.close;
  return this;
} as typeof http.Server.prototype.listen;

/**
 * TEST_WATCHDOG=<seconds>: if a hook/test runs longer than that, dump what MongoDB is doing (currentOp via a SEPARATE connection)
 * and the state of the app's pool. Used to diagnose stalls; off by default.
 */
const WATCHDOG_S = Number(process.env.TEST_WATCHDOG ?? 0);
let phase = 'idle';
let timer: NodeJS.Timeout | undefined;
function arm(name: string) {
  phase = name;
  if (!WATCHDOG_S) return;
  clearTimeout(timer);
  timer = setTimeout(async () => {
    const t = expect.getState().currentTestName;
    const out: string[] = [`\n[WATCHDOG] >${WATCHDOG_S}s in ${phase} of "${t}"`];
    let probe: MongoClient | undefined;
    try {
      probe = new MongoClient(process.env.MONGODB_URI!, { serverSelectionTimeoutMS: 3000 });
      await probe.connect();
      const ops = await probe.db('admin').command({ currentOp: 1, $all: true });
      const active = (ops.inprog as Array<Record<string, unknown>>).filter((o) => o.active && !String(o.ns ?? '').startsWith('local.') && o.op !== 'none' && !(o.desc as string)?.startsWith('conn') === false ? true : o.active && o.ns && !String(o.ns).startsWith('admin.$cmd'));
      out.push(`currentOp (${ops.inprog.length} total, ${active.length} active w/ ns):`);
      for (const o of active.slice(0, 15)) out.push('  ' + JSON.stringify({ op: o.op, ns: o.ns, secs: o.secs_running, waitingForLock: o.waitingForLock, locks: o.locks, cmd: JSON.stringify(o.command).slice(0, 200), msg: o.msg }));
      const st = await probe.db('admin').command({ serverStatus: 1 });
      out.push('connections ' + JSON.stringify(st.connections) + ' globalLock ' + JSON.stringify(st.globalLock?.currentQueue));
    } catch (e) {
      out.push('probe failed: ' + (e as Error).message);
    } finally {
      await probe?.close().catch(() => {});
    }
    const pool = (mongoose.connection.getClient() as unknown as { topology?: { s?: { servers?: Map<string, { pool?: { totalConnectionCount?: number; availableConnectionCount?: number; pendingConnectionCount?: number; currentCheckedOutCount?: number } }> } } }).topology?.s?.servers;
    if (pool) for (const [k, s] of pool) out.push(`app pool ${k}: total=${s.pool?.totalConnectionCount} avail=${s.pool?.availableConnectionCount} checkedOut=${s.pool?.currentCheckedOutCount} pending=${s.pool?.pendingConnectionCount}`);
    out.push(`readyState=${mongoose.connection.readyState}`);
    out.push('in-flight HTTP requests: ' + JSON.stringify([...inflight.values()].map((r) => ({ ...r, ageMs: Date.now() - r.since }))));
    out.push('active resources: ' + JSON.stringify((process as unknown as { getActiveResourcesInfo(): string[] }).getActiveResourcesInfo().reduce<Record<string, number>>((a, k) => ((a[k] = (a[k] ?? 0) + 1), a), {})));
    console.error(out.join('\n'));
  }, WATCHDOG_S * 1000);
}

beforeEach(async () => {
  arm('beforeEach');
  await connectDb();
  await mongoose.connection.dropDatabase();
  await Promise.all(Object.values(mongoose.models).map((m) => m.syncIndexes())); // unique/partial indexes
  memoryOutbox.length = 0;
  arm('test body');
});
afterEach(() => {
  clearTimeout(timer);
});
afterAll(async () => {
  clearTimeout(timer);
  await Promise.all(freeSlots.splice(0).map((s) => new Promise<void>((r) => s.server.close(() => r()))));
  await disconnectDb();
});
