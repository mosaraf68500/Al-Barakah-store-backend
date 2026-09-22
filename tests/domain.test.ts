import { describe, expect, it } from 'vitest';
import { applyReviewToRating, ratingRemovalPipeline, ratingUpdatePipeline, removeReviewFromRating, round1 } from '../src/domain/rating';
import { computeMetrics, computeWeeklySales, groupCustomers, sortOrdersNewestFirst } from '../src/domain/salesMetrics';
import { generateSlug } from '../src/domain/slug';

const NOW = new Date(2026, 8, 21, 15, 0, 0); // Mon 21 Sep 2026, local time
const day = (offset: number, h = 12) => new Date(2026, 8, 21 + offset, h).toISOString();
const order = (o: Record<string, unknown>): any => ({ createdAt: day(0), status: 'delivered', total: 100, customer: { fullName: 'A', phone: '+8801711111111', address: 'x' }, ...o });

describe('rating aggregate (BUG_FIXES #3)', () => {
  it('round1((rating*count + new) / (count+1)); count+1; pipeline expresses the same maths', () => {
    expect(applyReviewToRating(5, 1, 3)).toEqual({ rating: 4, reviewCount: 2 });
    expect(applyReviewToRating(4.5, 2, 5)).toEqual({ rating: 4.7, reviewCount: 3 });
    expect(applyReviewToRating(0, 0, 4)).toEqual({ rating: 4, reviewCount: 1 });
    expect(round1(4.25)).toBe(4.3);
    expect(JSON.stringify(ratingUpdatePipeline(4))).toContain('$divide');
  });
  it('does not drift past 150 reviews (the legacy cap bug)', () => {
    let s = { rating: 5, reviewCount: 0 };
    for (let i = 0; i < 400; i++) s = applyReviewToRating(s.rating, s.reviewCount, 4);
    expect(s.reviewCount).toBe(400);
    expect(s.rating).toBe(4);
  });
});

describe('rating removal (Module 6 - the exact inverse, for a moderated-away review)', () => {
  it('undoes applyReviewToRating: apply then remove the SAME rating returns to (within 1-decimal rounding of) the starting point', () => {
    const start = { rating: 4, reviewCount: 4 }; // chosen so the round-trip is exact (no rounding loss)
    const after = applyReviewToRating(start.rating, start.reviewCount, 4);
    expect(removeReviewFromRating(after.rating, after.reviewCount, 4)).toEqual(start);

    // 1-decimal rounding at the intermediate step is lossy: applying then removing the same rating need not land back
    // EXACTLY on the start (4.2 -> 4.1 -> 4.3), but it always stays within one rounding step (0.1) of it.
    const lossy = applyReviewToRating(4.2, 7, 3);
    const back = removeReviewFromRating(lossy.rating, lossy.reviewCount, 3);
    expect(back).toEqual({ rating: 4.3, reviewCount: 7 });
    expect(Math.abs(back.rating - 4.2)).toBeLessThanOrEqual(0.1);
  });
  it('removing the LAST review resets to the creation baseline (5 / 0), not 0/0 or NaN', () => {
    expect(removeReviewFromRating(5, 1, 5)).toEqual({ rating: 5, reviewCount: 0 });
    expect(removeReviewFromRating(2, 1, 2)).toEqual({ rating: 5, reviewCount: 0 }); // whatever the single review's own rating was
    expect(removeReviewFromRating(3, 0, 3)).toEqual({ rating: 5, reviewCount: 0 }); // defensive: already empty
  });
  it('a long sequence of add/remove in any order always lands back at the baseline once every review is gone', () => {
    let s = { rating: 5, reviewCount: 0 };
    const applied: number[] = [];
    for (const r of [3, 4, 1, 5, 2, 4, 3]) {
      s = applyReviewToRating(s.rating, s.reviewCount, r);
      applied.push(r);
    }
    while (applied.length) s = removeReviewFromRating(s.rating, s.reviewCount, applied.pop()!);
    expect(s).toEqual({ rating: 5, reviewCount: 0 });
  });
  it('the atomic pipeline expresses the same maths and the same baseline-reset guard', () => {
    const pipeline = JSON.stringify(ratingRemovalPipeline(4));
    expect(pipeline).toContain('$subtract');
    expect(pipeline).toContain('$lte'); // the reviewCount<=1 guard that resets to the baseline
  });
});

describe('slug (BUG_FIXES A14)', () => {
  it('latin names slugify; non-latin-only names yield "" so callers fall back to the id', () => {
    expect(generateSlug('  Pure Honey 500g!  ')).toBe('pure-honey-500g');
    expect(generateSlug('A__B - C')).toBe('a-b-c');
    expect(generateSlug('খাঁটি মধু')).toBe('');
  });
});

describe('sales / dashboard calculations (BUG_FIXES A2, A3, A5) - ported from the admin app', () => {
  it('computeMetrics: delivered vs pending (pending+processing), real unique customers (no fake fallback)', () => {
    const m = computeMetrics([
      order({ total: 100 }), order({ total: 250, status: 'Delivered' }), order({ total: 40, status: 'pending' }), order({ total: 60, status: 'Processing' }),
      order({ total: 999, status: 'cancelled' }), order({ total: 5, customer: { fullName: 'B', phone: '+8801822222222' } }),
    ]);
    expect(m).toEqual({ deliveredCount: 3, pendingCount: 2, deliveredSales: 355, pendingRevenue: 100, uniqueCustomers: 2 });
    expect(computeMetrics([]).uniqueCustomers).toBe(0); // legacy showed a fake 12
  });

  it('computeWeeklySales: 7 real days oldest-first with weekday labels, cancelled excluded, relative heights (min 4%)', () => {
    const bars = computeWeeklySales([
      order({ createdAt: day(0), total: 400 }), order({ createdAt: day(0, 9), total: 100 }), order({ createdAt: day(-1), total: 250 }),
      order({ createdAt: day(-3), total: 999, status: 'cancelled' }), order({ createdAt: day(-6, 0), total: 50 }), order({ createdAt: day(-7), total: 777 }), order({ createdAt: 'garbage', total: 1 }),
    ], NOW);
    expect(bars.map((b) => b.day)).toEqual(['Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun', 'Mon']);
    expect(bars.map((b) => b.amount)).toEqual([50, 0, 0, 0, 0, 250, 500]);
    expect(bars.map((b) => b.height)).toEqual(['10%', '4%', '4%', '4%', '4%', '50%', '100%']);
    expect(computeWeeklySales([], NOW).every((b) => b.height === '4%' && b.amount === 0)).toBe(true);
  });

  it('sortOrdersNewestFirst does not mutate and orders by createdAt desc', () => {
    const input = [order({ id: 'a', createdAt: day(-2) }), order({ id: 'b', createdAt: day(0) }), order({ id: 'c', createdAt: day(-1) })];
    expect(sortOrdersNewestFirst(input).map((o) => o.id)).toEqual(['b', 'c', 'a']);
    expect(input.map((o) => o.id)).toEqual(['a', 'b', 'c']);
  });

  it('groupCustomers: one row per customer with the REAL order count and total (legacy "1 Order" bug)', () => {
    const rows = groupCustomers([
      order({ id: '1', createdAt: day(-2), total: 100, customer: { fullName: 'Halima', phone: '+8801711111111', address: 'old' } }),
      order({ id: '2', createdAt: day(0), total: 250, customer: { fullName: 'Halima A', phone: '01711111111', address: 'new' } }),
      order({ id: '3', createdAt: day(-1), total: 60, customer: { fullName: 'Rafiq', phone: '+8801933333333', address: 'r' } }),
      order({ id: '4', total: 10, customer: { fullName: 'NoPhone' }, customerPhone: undefined }),
    ]);
    const h = rows.find((r) => r.key === '1711111111')!;
    expect(h).toMatchObject({ orderCount: 2, totalSpent: 350, name: 'Halima A', address: 'new' }); // newest order supplies name/address
    expect(rows.find((r) => r.name === 'Rafiq')).toMatchObject({ orderCount: 1, totalSpent: 60 });
    expect(rows).toHaveLength(3);
  });
});
