import { describe, expect, it } from 'vitest';
import { computeSubtotal, priceOrder, round2, type PricingInput } from '../src/domain/pricing';

const base: PricingInput = { lines: [{ unitPrice: 500, quantity: 2 }, { unitPrice: 250, quantity: 1 }], zone: 'inside', paymentChoice: 'FULL_COD', delivery: {} };
const price = (o: Partial<PricingInput> = {}) => priceOrder({ ...base, ...o });

describe('priceOrder - golden numbers (same maths as the storefront CheckoutModal)', () => {
  it('full COD inside Dhaka: subtotal 1250 + 80 delivery; nothing paid in advance, all due on delivery', () => {
    expect(price()).toEqual({ subtotal: 1250, discount: 0, netProductTotal: 1250, freeDelivery: false, deliveryFee: 80, total: 1330, advanceAmount: 0, dueAmountOnDelivery: 1330, advancePaymentType: 'NONE', deliveryPaymentStatus: 'COD_PENDING' });
  });
  it('outside Dhaka uses the outside charge (160 default)', () => {
    expect(price({ zone: 'outside' })).toMatchObject({ deliveryFee: 160, total: 1410, dueAmountOnDelivery: 1410 });
  });
  it('configured charges override the defaults; an explicit 0 is respected (?? not ||)', () => {
    expect(price({ delivery: { insideDhakaCharge: 60, outsideDhakaCharge: 130 } }).deliveryFee).toBe(60);
    expect(price({ zone: 'outside', delivery: { insideDhakaCharge: 60, outsideDhakaCharge: 130 } }).deliveryFee).toBe(130);
    expect(price({ delivery: { insideDhakaCharge: 0 } })).toMatchObject({ deliveryFee: 0, total: 1250 });
  });
  it('ADVANCE_DELIVERY: the delivery fee is paid up front (claimed, not yet admin-verified), the product total is due on delivery', () => {
    expect(price({ paymentChoice: 'ADVANCE_DELIVERY', hasTrxId: true })).toMatchObject({ advanceAmount: 80, dueAmountOnDelivery: 1250, total: 1330, advancePaymentType: 'DELIVERY_ONLY', deliveryPaymentStatus: 'ADVANCE_PENDING' });
  });
  it('FULL_BKASH: everything paid in advance, nothing due', () => {
    expect(price({ paymentChoice: 'FULL_BKASH', hasTrxId: true })).toMatchObject({ advanceAmount: 1330, dueAmountOnDelivery: 0, advancePaymentType: 'FULL_PAYMENT', deliveryPaymentStatus: 'FULL_PAID' });
  });
});

describe('priceOrder - coupon discount + free-delivery threshold', () => {
  const free = { enableFreeDelivery: true, freeDeliveryThreshold: 1000 };
  it('the threshold is checked on the NET amount (after the coupon), inclusive', () => {
    const l = (n: number) => [{ unitPrice: n, quantity: 1 }];
    expect(price({ lines: l(1100), discount: 100, delivery: free })).toMatchObject({ netProductTotal: 1000, freeDelivery: true, deliveryFee: 0, total: 1000 }); // exactly at the threshold
    expect(price({ lines: l(1000), discount: 100, delivery: free })).toMatchObject({ netProductTotal: 900, freeDelivery: false, deliveryFee: 80, total: 980 }); // subtotal qualifies, net does not
    expect(price({ lines: l(1000), delivery: free })).toMatchObject({ freeDelivery: true, deliveryFee: 0 });
    expect(price({ lines: l(999.99), delivery: free }).freeDelivery).toBe(false);
  });
  it('free delivery is off when disabled or when the threshold is 0/absent', () => {
    expect(price({ delivery: { enableFreeDelivery: false, freeDeliveryThreshold: 100 } }).freeDelivery).toBe(false);
    expect(price({ delivery: { enableFreeDelivery: true, freeDeliveryThreshold: 0 } }).freeDelivery).toBe(false);
    expect(price({ delivery: { enableFreeDelivery: true } }).freeDelivery).toBe(false);
  });
  it('free delivery + advance-delivery payment: nothing to pay up front, the whole net is due, and NO TrxID is required', () => {
    const delivery = { enableFreeDelivery: true, freeDeliveryThreshold: 100 };
    expect(price({ paymentChoice: 'ADVANCE_DELIVERY', delivery })).toMatchObject({ deliveryFee: 0, advanceAmount: 0, dueAmountOnDelivery: 1250, deliveryPaymentStatus: 'COD_PENDING' });
    expect(() => price({ paymentChoice: 'ADVANCE_DELIVERY', delivery })).not.toThrow(); // no hasTrxId at all - still fine
  });
  it('discount is clamped to [0, subtotal]: a huge or negative value cannot make the order negative or increase the price', () => {
    expect(price({ discount: 99_999 })).toMatchObject({ discount: 1250, netProductTotal: 0, total: 80 });
    expect(price({ discount: -500 })).toMatchObject({ discount: 0, total: 1330 });
    expect(price({ discount: 100, paymentChoice: 'FULL_BKASH', hasTrxId: true })).toMatchObject({ discount: 100, total: 1230, advanceAmount: 1230, dueAmountOnDelivery: 0 });
    // a still-nonzero total but a waived delivery fee: advance-delivery needs no TrxID once the fee itself is 0
    expect(price({ paymentChoice: 'ADVANCE_DELIVERY', delivery: { enableFreeDelivery: true, freeDeliveryThreshold: 1 } }).deliveryPaymentStatus).toBe('COD_PENDING');
  });
});

describe('priceOrder - TrxID trust (decisions #2 and #3)', () => {
  it('a claimed TrxID is ADVANCE_PENDING / stays FULL_PAID (legacy) - never auto ADVANCE_PAID; admin verification is a separate step (Module 5c)', () => {
    expect(price({ paymentChoice: 'ADVANCE_DELIVERY', hasTrxId: true }).deliveryPaymentStatus).toBe('ADVANCE_PENDING');
    expect(price({ paymentChoice: 'FULL_BKASH', hasTrxId: true }).deliveryPaymentStatus).toBe('FULL_PAID');
  });
  it('TrxID is required whenever something is actually payable in advance (400 TRX_ID_REQUIRED, Bengali message with the exact amount)', () => {
    expect(() => price({ paymentChoice: 'ADVANCE_DELIVERY' })).toThrowError(expect.objectContaining({ status: 400, code: 'TRX_ID_REQUIRED', details: { requiredAmount: 80 } }));
    expect(() => price({ paymentChoice: 'FULL_BKASH' })).toThrowError(expect.objectContaining({ status: 400, code: 'TRX_ID_REQUIRED', details: { requiredAmount: 1330 } }));
    expect(() => price({ paymentChoice: 'ADVANCE_DELIVERY', hasTrxId: false })).toThrow();
  });
  it('when the computed advance is 0 (free delivery), no TrxID is required for ADVANCE_DELIVERY', () => {
    const delivery = { enableFreeDelivery: true, freeDeliveryThreshold: 1 };
    expect(() => price({ paymentChoice: 'ADVANCE_DELIVERY', delivery })).not.toThrow();
    expect(() => price({ paymentChoice: 'ADVANCE_DELIVERY', hasTrxId: false, delivery })).not.toThrow();
  });
  it('FULL_COD never needs a TrxID (nothing is ever advance-payable there)', () => {
    expect(() => price({ paymentChoice: 'FULL_COD' })).not.toThrow();
  });
});

describe('priceOrder - policy + validation', () => {
  it('requireAdvanceDeliveryCharge forbids FULL_COD but allows the advance options', () => {
    const delivery = { requireAdvanceDeliveryCharge: true };
    expect(() => price({ delivery })).toThrowError(expect.objectContaining({ status: 400, code: 'ADVANCE_DELIVERY_REQUIRED' }));
    expect(() => price({ delivery, paymentChoice: 'ADVANCE_DELIVERY', hasTrxId: true })).not.toThrow();
    expect(() => price({ delivery, paymentChoice: 'FULL_BKASH', hasTrxId: true })).not.toThrow();
  });
  it('rejects empty orders and malformed lines', () => {
    expect(() => price({ lines: [] })).toThrowError(expect.objectContaining({ code: 'EMPTY_ORDER' }));
    for (const bad of [{ unitPrice: 10, quantity: 0 }, { unitPrice: 10, quantity: 1.5 }, { unitPrice: 10, quantity: -1 }, { unitPrice: -1, quantity: 1 }, { unitPrice: NaN, quantity: 1 }, { unitPrice: Infinity, quantity: 1 }]) {
      expect(() => price({ lines: [bad] }), JSON.stringify(bad)).toThrowError(expect.objectContaining({ code: 'INVALID_ORDER_LINE' }));
    }
  });
});

describe('priceOrder - rounding and invariants', () => {
  it('floating-point noise never leaks: 0.1 x 3 = 0.3, 19.99 x 3 = 59.97', () => {
    expect(computeSubtotal([{ unitPrice: 0.1, quantity: 3 }])).toBe(0.3);
    expect(computeSubtotal([{ unitPrice: 19.99, quantity: 3 }])).toBe(59.97);
    expect(round2(1.005)).toBe(1.01);
  });
  it('2,000 pseudo-random orders: total = net + fee, advance + due = total, discount <= subtotal, everything has at most 2 decimals and is >= 0', () => {
    let seed = 42;
    const rnd = () => ((seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296);
    const choices = ['FULL_COD', 'ADVANCE_DELIVERY', 'FULL_BKASH'] as const;
    const dp2 = (n: number) => Math.abs(n * 100 - Math.round(n * 100)) < 1e-6;
    for (let i = 0; i < 2000; i++) {
      const lines = Array.from({ length: 1 + Math.floor(rnd() * 4) }, () => ({ unitPrice: Math.round(rnd() * 500000) / 100, quantity: 1 + Math.floor(rnd() * 6) }));
      const r = priceOrder({
        lines, discount: rnd() < 0.5 ? Math.round(rnd() * 300000) / 100 : 0, zone: rnd() < 0.5 ? 'inside' : 'outside', paymentChoice: choices[Math.floor(rnd() * 3)],
        hasTrxId: true, // TrxID policy has its own describe block; a fuzz-random false would throw TRX_ID_REQUIRED here and abort the loop
        delivery: { enableFreeDelivery: rnd() < 0.5, freeDeliveryThreshold: Math.round(rnd() * 2000), insideDhakaCharge: 80, outsideDhakaCharge: 160 },
      });
      expect(r.total).toBe(round2(r.netProductTotal + r.deliveryFee));
      expect(round2(r.advanceAmount + r.dueAmountOnDelivery)).toBe(r.total);
      expect(r.discount).toBeLessThanOrEqual(r.subtotal);
      for (const v of [r.subtotal, r.discount, r.netProductTotal, r.deliveryFee, r.total, r.advanceAmount, r.dueAmountOnDelivery]) {
        expect(v).toBeGreaterThanOrEqual(0);
        expect(dp2(v)).toBe(true);
      }
    }
  });
});
