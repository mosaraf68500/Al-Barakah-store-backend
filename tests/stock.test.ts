import { describe, expect, it } from 'vitest';
import { ProductModel } from '../src/modules/products/product.model';
import { OrderModel, type OrderDoc } from '../src/modules/orders/order.model';
import { releaseStock, reserveStock, setOrderStock, stockActionForTransition, withTransaction, type StockLine } from '../src/modules/orders/stock.service';

async function mkProduct(id: string, stockCount: number, extra: Record<string, unknown> = {}) {
  await ProductModel.create({ _id: id, name: `Product ${id}`, slug: id, categoryId: 'cat-x', price: 100, stockCount, inStock: stockCount > 0, ...extra });
}
const stockOf = async (id: string) => (await ProductModel.findById(id).lean())!;
async function mkOrder(id: string, items: Array<{ productId?: string; quantity: number }>, stockDeducted: boolean) {
  await OrderModel.create({
    _id: id, customer: { fullName: 'T', phone: '+8801712345678', address: 'x' }, phoneKey: '1712345678', subtotal: 100, total: 100, stockDeducted,
    items: items.map((i) => ({ name: 'n', price: 100, totalPrice: 100 * i.quantity, ...i })),
  } as Partial<OrderDoc>);
}
const reserve = (lines: StockLine[]) => withTransaction((s) => reserveStock(lines, s));
const release = (lines: StockLine[]) => withTransaction((s) => releaseStock(lines, s));

describe('test database supports transactions (replica set, like Atlas)', () => {
  it('commits together, and a throw rolls EVERY write back', async () => {
    await mkProduct('p1', 5);
    await mkProduct('p2', 5);
    await withTransaction(async (s) => {
      await ProductModel.updateOne({ _id: 'p1' }, { $inc: { stockCount: -1 } }, { session: s });
      await ProductModel.updateOne({ _id: 'p2' }, { $inc: { stockCount: -1 } }, { session: s });
    });
    expect([(await stockOf('p1')).stockCount, (await stockOf('p2')).stockCount]).toEqual([4, 4]);
    await expect(withTransaction(async (s) => {
      await ProductModel.updateOne({ _id: 'p1' }, { $inc: { stockCount: -1 } }, { session: s });
      throw new Error('boom');
    })).rejects.toThrow('boom');
    expect((await stockOf('p1')).stockCount).toBe(4); // rolled back
  });
});

describe('reserveStock', () => {
  it('subtracts every line, merges the same product on several lines (sizes/colours), and flips inStock at zero', async () => {
    await mkProduct('a', 10);
    await mkProduct('b', 3);
    await reserve([{ productId: 'a', quantity: 2 }, { productId: 'b', quantity: 3 }, { productId: 'a', quantity: 5 }]);
    expect(await stockOf('a')).toMatchObject({ stockCount: 3, inStock: true });
    expect(await stockOf('b')).toMatchObject({ stockCount: 0, inStock: false });
  });

  it('ALL-OR-NOTHING: when the 2nd line lacks stock the 1st line is rolled back and the error names the product', async () => {
    await mkProduct('a', 10);
    await mkProduct('z', 1);
    const err = await reserve([{ productId: 'a', quantity: 4 }, { productId: 'z', quantity: 2 }]).catch((e) => e);
    expect(err).toMatchObject({ status: 409, code: 'INSUFFICIENT_STOCK', details: { productId: 'z', available: 1, requested: 2 } });
    expect((await stockOf('a')).stockCount).toBe(10);
    expect((await stockOf('z')).stockCount).toBe(1);
  });

  it('archived and unknown products are PRODUCT_UNAVAILABLE (and nothing else is touched)', async () => {
    await mkProduct('a', 10);
    await mkProduct('old', 10, { deletedAt: new Date() });
    for (const id of ['old', 'ghost']) {
      expect(await reserve([{ productId: 'a', quantity: 1 }, { productId: id, quantity: 1 }]).catch((e) => e)).toMatchObject({ status: 409, code: 'PRODUCT_UNAVAILABLE' });
    }
    expect((await stockOf('a')).stockCount).toBe(10);
    expect((await stockOf('old')).stockCount).toBe(10);
  });

  it('exact-fit works, one more than available does not, and invalid quantities are rejected', async () => {
    await mkProduct('a', 4);
    await expect(reserve([{ productId: 'a', quantity: 5 }])).rejects.toMatchObject({ code: 'INSUFFICIENT_STOCK' });
    await reserve([{ productId: 'a', quantity: 4 }]);
    expect(await stockOf('a')).toMatchObject({ stockCount: 0, inStock: false });
    for (const q of [0, -1, 1.5]) await expect(reserve([{ productId: 'a', quantity: q }])).rejects.toMatchObject({ code: 'INVALID_ORDER_LINE' });
  });
});

describe('reserveStock - CONCURRENCY (no overselling)', () => {
  it('30 parallel single-unit orders on 10 units: exactly 10 succeed, the rest are INSUFFICIENT_STOCK, stock ends at exactly 0', async () => {
    await mkProduct('hot', 10);
    const r = await Promise.allSettled(Array.from({ length: 30 }, () => reserve([{ productId: 'hot', quantity: 1 }])));
    expect(r.filter((x) => x.status === 'fulfilled')).toHaveLength(10);
    const rejected = r.filter((x): x is PromiseRejectedResult => x.status === 'rejected');
    expect(rejected).toHaveLength(20);
    expect(rejected.every((x) => x.reason.code === 'INSUFFICIENT_STOCK')).toBe(true); // never a raw WriteConflict / transaction error
    expect(await stockOf('hot')).toMatchObject({ stockCount: 0, inStock: false });
  });

  it('20 parallel orders of 7 units on 100 units: exactly 14 succeed, 2 units remain', async () => {
    await mkProduct('bulk', 100);
    const r = await Promise.allSettled(Array.from({ length: 20 }, () => reserve([{ productId: 'bulk', quantity: 7 }])));
    expect(r.filter((x) => x.status === 'fulfilled')).toHaveLength(14);
    expect((await stockOf('bulk')).stockCount).toBe(2);
  });

  it('opposite-order multi-item orders ([P,Q] vs [Q,P]) neither deadlock nor oversell: 40 orders on 20+20 units -> exactly 20 succeed', async () => {
    await mkProduct('p', 20);
    await mkProduct('q', 20);
    const r = await Promise.allSettled(Array.from({ length: 40 }, (_, i) => reserve(i % 2 ? [{ productId: 'p', quantity: 1 }, { productId: 'q', quantity: 1 }] : [{ productId: 'q', quantity: 1 }, { productId: 'p', quantity: 1 }])));
    expect(r.filter((x) => x.status === 'fulfilled')).toHaveLength(20);
    expect(r.filter((x): x is PromiseRejectedResult => x.status === 'rejected').every((x) => x.reason.code === 'INSUFFICIENT_STOCK')).toBe(true);
    expect([(await stockOf('p')).stockCount, (await stockOf('q')).stockCount]).toEqual([0, 0]);
  });

  it('a failing order never leaks its partial reservation under load: A has plenty, B has 5; 20 orders need [A,B] -> 5 succeed and A drops by exactly 5', async () => {
    await mkProduct('a', 100);
    await mkProduct('b', 5);
    const r = await Promise.allSettled(Array.from({ length: 20 }, () => reserve([{ productId: 'a', quantity: 1 }, { productId: 'b', quantity: 1 }])));
    expect(r.filter((x) => x.status === 'fulfilled')).toHaveLength(5);
    expect([(await stockOf('a')).stockCount, (await stockOf('b')).stockCount]).toEqual([95, 0]);
  });
});

describe('releaseStock', () => {
  it('adds the units back, flips inStock on, restores archived products too, and skips unknown ones', async () => {
    await mkProduct('a', 0);
    await mkProduct('old', 1, { deletedAt: new Date() });
    await release([{ productId: 'a', quantity: 3 }, { productId: 'old', quantity: 2 }, { productId: 'ghost', quantity: 9 }]);
    expect(await stockOf('a')).toMatchObject({ stockCount: 3, inStock: true });
    expect((await stockOf('old')).stockCount).toBe(3);
  });
});

describe('setOrderStock - flag + stock move together, exactly once', () => {
  it('release: restores the items and clears stockDeducted; calling it again (or 5x in parallel) restores only ONCE', async () => {
    await mkProduct('a', 0);
    await mkOrder('AB-100001', [{ productId: 'a', quantity: 4 }, { quantity: 9 }], true); // a line without productId is ignored
    const many = await Promise.all(Array.from({ length: 5 }, () => setOrderStock('AB-100001', 'release')));
    expect(many.filter((m) => m.changed)).toHaveLength(1);
    expect(await stockOf('a')).toMatchObject({ stockCount: 4, inStock: true });
    expect((await OrderModel.findById('AB-100001').lean())!.stockDeducted).toBe(false);
    expect(await setOrderStock('AB-100001', 'release')).toEqual({ changed: false });
    expect((await stockOf('a')).stockCount).toBe(4);
  });

  it('reserve on an order that already holds its stock is a no-op', async () => {
    await mkProduct('a', 10);
    await mkOrder('AB-100002', [{ productId: 'a', quantity: 4 }], true);
    expect(await setOrderStock('AB-100002', 'reserve')).toEqual({ changed: false });
    expect((await stockOf('a')).stockCount).toBe(10);
  });

  it('cancel then re-open: stock goes back, then is taken again; the round trip is lossless', async () => {
    await mkProduct('a', 6);
    await mkProduct('b', 6);
    await mkOrder('AB-100003', [{ productId: 'a', quantity: 2 }, { productId: 'b', quantity: 3 }], false);
    await setOrderStock('AB-100003', 'reserve');
    expect([(await stockOf('a')).stockCount, (await stockOf('b')).stockCount]).toEqual([4, 3]);
    await setOrderStock('AB-100003', 'release');
    expect([(await stockOf('a')).stockCount, (await stockOf('b')).stockCount]).toEqual([6, 6]);
    await setOrderStock('AB-100003', 'reserve');
    expect([(await stockOf('a')).stockCount, (await stockOf('b')).stockCount]).toEqual([4, 3]);
    expect((await OrderModel.findById('AB-100003').lean())!.stockDeducted).toBe(true);
  });

  it('re-opening a cancelled order when the stock was sold meanwhile FAILS (409) and leaves BOTH the flag and the stock untouched', async () => {
    await mkProduct('a', 5);
    await mkProduct('b', 1);
    await mkOrder('AB-100004', [{ productId: 'a', quantity: 2 }, { productId: 'b', quantity: 2 }], false); // cancelled earlier, stock already returned
    const err = await setOrderStock('AB-100004', 'reserve').catch((e) => e);
    expect(err).toMatchObject({ status: 409, code: 'INSUFFICIENT_STOCK' });
    expect((await OrderModel.findById('AB-100004').lean())!.stockDeducted).toBe(false);
    expect([(await stockOf('a')).stockCount, (await stockOf('b')).stockCount]).toEqual([5, 1]);
  });

  it('parallel reserve + release on the same order never double-moves stock', async () => {
    await mkProduct('a', 10);
    await mkOrder('AB-100005', [{ productId: 'a', quantity: 3 }], false);
    await Promise.allSettled([setOrderStock('AB-100005', 'reserve'), setOrderStock('AB-100005', 'release'), setOrderStock('AB-100005', 'reserve'), setOrderStock('AB-100005', 'release')]);
    const o = (await OrderModel.findById('AB-100005').lean())!;
    expect((await stockOf('a')).stockCount).toBe(o.stockDeducted ? 7 : 10); // stock always agrees with the flag
  });

  it('unknown order -> 404, and the caller can run it inside its own transaction together with other writes', async () => {
    await expect(setOrderStock('AB-999999', 'release')).rejects.toMatchObject({ status: 404, code: 'ORDER_NOT_FOUND' });
    await mkProduct('a', 5);
    await mkOrder('AB-100006', [{ productId: 'a', quantity: 2 }], false);
    await expect(withTransaction(async (s) => {
      await setOrderStock('AB-100006', 'reserve', s);
      throw new Error('later step failed');
    })).rejects.toThrow('later step failed');
    expect((await stockOf('a')).stockCount).toBe(5);
    expect((await OrderModel.findById('AB-100006').lean())!.stockDeducted).toBe(false);
  });
});

describe('stockActionForTransition', () => {
  it('only entering or leaving "cancelled" moves stock', () => {
    const S = ['pending', 'processing', 'shipped', 'delivered', 'cancelled'] as const;
    for (const from of S) for (const to of S) {
      const expected = from === to ? 'none' : to === 'cancelled' ? 'release' : from === 'cancelled' ? 'reserve' : 'none';
      expect(stockActionForTransition(from, to), `${from}->${to}`).toBe(expected);
    }
  });
});
