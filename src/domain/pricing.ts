/**
 * Order pricing (BACKEND_PLAN B5) - PURE. Reproduces the storefront's `CheckoutModal` maths, but is the authority: the server
 * prices every order from ITS OWN product prices and settings; client-sent prices/totals are never an input here.
 *
 *   subtotal      = sum(unitPrice x quantity)
 *   discount      = coupon discount (already computed and capped by the coupon layer), clamped to [0, subtotal]
 *   net           = subtotal - discount
 *   free delivery = enableFreeDelivery && threshold > 0 && net >= threshold          (checked on the NET amount, after the coupon)
 *   deliveryFee   = free ? 0 : inside ? insideDhakaCharge ?? 80 : outsideDhakaCharge ?? 160
 *   total         = net + deliveryFee
 *   FULL_BKASH        advance = total,        due = 0
 *   ADVANCE_DELIVERY  advance = deliveryFee,  due = net
 *   FULL_COD          advance = 0,            due = total          (forbidden when requireAdvanceDeliveryCharge)
 * Money is rounded to 2 decimals at every step so `advance + due === total` always holds.
 *
 * Trust: a customer-claimed bKash TrxID is never taken as paid. `ADVANCE_DELIVERY` lands in `ADVANCE_PENDING`, not
 * `ADVANCE_PAID` - an admin verifies it later (Module 5c) and moves it to `ADVANCE_PAID`. A TrxID is required whenever
 * something is actually payable in advance (`advanceAmount > 0`); when the computed advance is 0 (e.g. free delivery
 * waives the delivery fee) no TrxID is asked for and the order behaves like COD (`COD_PENDING`).
 */
import { ApiError } from '../utils/ApiError';

export type PaymentChoice = 'FULL_COD' | 'ADVANCE_DELIVERY' | 'FULL_BKASH';
export type DeliveryZone = 'inside' | 'outside';
export type AdvancePaymentType = 'NONE' | 'DELIVERY_ONLY' | 'FULL_PAYMENT';
export type DeliveryPaymentStatus = 'ADVANCE_PAID' | 'ADVANCE_PENDING' | 'FULL_PAID' | 'COD_PENDING';

export interface PricingDeliveryConfig {
  insideDhakaCharge?: number;
  outsideDhakaCharge?: number;
  enableFreeDelivery?: boolean;
  freeDeliveryThreshold?: number;
  requireAdvanceDeliveryCharge?: boolean;
}
export interface PricingLine { unitPrice: number; quantity: number }
export interface PricingInput {
  lines: PricingLine[];
  /** Discount amount from the coupon layer (0 when no coupon). */
  discount?: number;
  zone: DeliveryZone;
  paymentChoice: PaymentChoice;
  delivery: PricingDeliveryConfig;
  /** Whether the customer supplied a bKash TrxID. Required whenever `advanceAmount > 0`, else `TRX_ID_REQUIRED` is thrown. */
  hasTrxId?: boolean;
}
export interface PricingResult {
  subtotal: number;
  discount: number;
  netProductTotal: number;
  freeDelivery: boolean;
  deliveryFee: number;
  total: number;
  advanceAmount: number;
  dueAmountOnDelivery: number;
  advancePaymentType: AdvancePaymentType;
  deliveryPaymentStatus: DeliveryPaymentStatus;
}

export const DEFAULT_INSIDE_DHAKA = 80;
export const DEFAULT_OUTSIDE_DHAKA = 160;

export const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

export function computeSubtotal(lines: PricingLine[]): number {
  return round2(lines.reduce((sum, l) => sum + round2(l.unitPrice * l.quantity), 0));
}

export function priceOrder(input: PricingInput): PricingResult {
  if (input.lines.length === 0) throw ApiError.badRequest('EMPTY_ORDER');
  for (const l of input.lines) {
    if (!Number.isFinite(l.unitPrice) || l.unitPrice < 0 || !Number.isInteger(l.quantity) || l.quantity < 1) throw ApiError.badRequest('INVALID_ORDER_LINE');
  }
  const d = input.delivery;
  if (d.requireAdvanceDeliveryCharge && input.paymentChoice === 'FULL_COD') {
    throw ApiError.badRequest('ADVANCE_DELIVERY_REQUIRED', 'ফেক অর্ডার প্রতিরোধে ডেলিভারি চার্জ অগ্রিম পরিশোধ করা বাধ্যতামূলক। অনুগ্রহ করে বিকাশ অপশন সিলেক্ট করুন।');
  }

  const subtotal = computeSubtotal(input.lines);
  const discount = round2(Math.min(Math.max(input.discount ?? 0, 0), subtotal));
  const netProductTotal = round2(subtotal - discount);

  const freeDelivery = Boolean(d.enableFreeDelivery && (d.freeDeliveryThreshold ?? 0) > 0 && netProductTotal >= (d.freeDeliveryThreshold as number));
  const zoneCharge = input.zone === 'inside' ? d.insideDhakaCharge ?? DEFAULT_INSIDE_DHAKA : d.outsideDhakaCharge ?? DEFAULT_OUTSIDE_DHAKA;
  const deliveryFee = freeDelivery ? 0 : round2(Math.max(0, zoneCharge));
  const total = round2(netProductTotal + deliveryFee);

  let advanceAmount: number;
  let dueAmountOnDelivery: number;
  let advancePaymentType: AdvancePaymentType;
  let deliveryPaymentStatus: DeliveryPaymentStatus;
  switch (input.paymentChoice) {
    case 'FULL_BKASH':
      advanceAmount = total; dueAmountOnDelivery = 0; advancePaymentType = 'FULL_PAYMENT'; deliveryPaymentStatus = 'FULL_PAID';
      break;
    case 'ADVANCE_DELIVERY':
      advanceAmount = deliveryFee; dueAmountOnDelivery = netProductTotal; advancePaymentType = 'DELIVERY_ONLY';
      deliveryPaymentStatus = advanceAmount > 0 ? 'ADVANCE_PENDING' : 'COD_PENDING';
      break;
    default:
      advanceAmount = 0; dueAmountOnDelivery = total; advancePaymentType = 'NONE'; deliveryPaymentStatus = 'COD_PENDING';
  }
  if (advanceAmount > 0 && input.paymentChoice !== 'FULL_COD' && !input.hasTrxId) {
    throw ApiError.badRequest(
      'TRX_ID_REQUIRED',
      input.paymentChoice === 'FULL_BKASH'
        ? `অনুগ্রহ করে সম্পূর্ণ বিল (৳${total}) বিকাশে পাঠিয়ে TrxID প্রদান করুন।`
        : `অনুগ্রহ করে ডেলিভারি চার্জ (৳${advanceAmount}) বিকাশে পাঠিয়ে TrxID প্রদান করুন।`,
      { requiredAmount: advanceAmount },
    );
  }
  return { subtotal, discount, netProductTotal, freeDelivery, deliveryFee, total, advanceAmount, dueAmountOnDelivery, advancePaymentType, deliveryPaymentStatus };
}
