import type { OrderDoc } from './order.model';

/* ------------------------------------------------------------------ PII masking (BACKEND_PLAN B8, ported from publicViews.ts) */
// Phone is stored as +880XXXXXXXXXX; masked against the LOCAL 11-digit form (017XXXXXXXX) so the visible pattern matches the
// Phase-1-verified legacy screenshots, which masked the number customers actually typed.

export function maskPhone(raw?: string | null): string {
  if (!raw) return 'N/A';
  let digits = raw.replace(/\D/g, '');
  if (digits.startsWith('880') && digits.length > 10) digits = digits.slice(3);
  if (digits.length < 7) return '***';
  return `${digits.slice(0, 3)}****${digits.slice(-3)}`;
}
export function maskEmail(raw?: string | null): string {
  if (!raw || !raw.includes('@')) return '***';
  const [local, domain] = raw.split('@');
  if (local.length <= 2) return `*@${domain}`;
  return `${local[0]}***${local.slice(-1)}@${domain}`;
}
export function maskAddress(address?: string | null, city?: string | null): string {
  const cityStr = city || 'Dhaka';
  if (!address) return cityStr;
  const parts = address.split(',').map((p) => p.trim()).filter(Boolean);
  if (parts.length > 1) return `***, ${parts[parts.length - 1]} (${cityStr})`;
  return `***, ${cityStr}`;
}

/** Display string for `customer.paymentMethod` (legacy showed this on the order confirmation / tracking page). */
export function derivePaymentMethodText(o: Pick<OrderDoc, 'deliveryPaymentStatus' | 'advanceAmount' | 'dueAmountOnDelivery' | 'total'>): string {
  switch (o.deliveryPaymentStatus) {
    case 'FULL_PAID':
      return `Full bKash Paid ৳${o.total}`;
    case 'ADVANCE_PAID':
      return `Advance Delivery Paid ৳${o.advanceAmount} (Due COD ৳${o.dueAmountOnDelivery})`;
    case 'ADVANCE_PENDING':
      return `Advance Delivery Payment Pending Verification (৳${o.advanceAmount})`;
    case 'VERIFIED':
      return `Payment Verified (৳${o.advanceAmount || o.total})`;
    case 'FAKE_SUSPECTED':
      return 'Payment Flagged as Suspicious';
    default:
      return 'Cash on Delivery (Full COD)';
  }
}

const items = (o: OrderDoc) => o.items.map((i) => ({ productId: i.productId, name: i.name, image: i.image, price: i.price, quantity: i.quantity, ...(i.selectedSize ? { selectedSize: i.selectedSize } : {}), ...(i.selectedColor ? { selectedColor: i.selectedColor } : {}), totalPrice: i.totalPrice }));

/** Full, UNMASKED order - `/orders/my` (the owner) and admin reads (Module 5c). Never sent to an anonymous caller. */
export function toFullOrder(o: OrderDoc) {
  return {
    id: o._id,
    trackingCode: o._id,
    userId: o.userId ?? undefined,
    createdAt: o.createdAt.toISOString(),
    status: o.status,
    items: items(o),
    subtotal: o.subtotal,
    discount: o.discount,
    shipping: o.shipping,
    total: o.total,
    currency: o.currency,
    ...(o.couponCode ? { couponCode: o.couponCode } : {}),
    customerEmail: o.customer.email,
    customerPhone: o.customer.phone,
    customer: { fullName: o.customer.fullName, email: o.customer.email ?? '', phone: o.customer.phone, address: o.customer.address, city: o.customer.city, postalCode: o.customer.postalCode, paymentMethod: derivePaymentMethodText(o) },
    advancePaymentType: o.advancePaymentType,
    advanceAmount: o.advanceAmount,
    dueAmountOnDelivery: o.dueAmountOnDelivery,
    deliveryPaymentStatus: o.deliveryPaymentStatus,
    ...(o.bkashTrxId ? { bkashTrxId: o.bkashTrxId } : {}),
    ...(o.senderBkashNumber ? { senderBkashNumber: o.senderBkashNumber } : {}),
    isFakeSuspected: o.isFakeSuspected,
    stockDeducted: o.stockDeducted,
    deliveryZone: o.deliveryZone,
    ...(o.zoneUncertain ? { zoneUncertain: true } : {}), // present only when true, so an admin UI can filter on its existence
    ...(o.notes ? { notes: o.notes } : {}),
    ...(o.courier ? { courier: o.courier } : {}),
    deletedAt: o.deletedAt ? o.deletedAt.toISOString() : null,
  };
}

/**
 * Public "track my order" result (BACKEND_PLAN B8): masked PII, no payment references (no TrxID/bKash number), no admin/internal
 * fields (no `userId`, `isFakeSuspected`, `stockDeducted`, `courier` credentials/raw responses, `notes`).
 */
export function toTrackedOrder(o: OrderDoc) {
  return {
    id: o._id,
    trackingCode: o._id,
    createdAt: o.createdAt.toISOString(),
    status: o.status,
    items: items(o),
    subtotal: o.subtotal,
    discount: o.discount,
    shipping: o.shipping,
    total: o.total,
    currency: o.currency,
    customerEmail: maskEmail(o.customer.email),
    customerPhone: maskPhone(o.customer.phone),
    customer: { fullName: o.customer.fullName, email: maskEmail(o.customer.email), phone: maskPhone(o.customer.phone), address: maskAddress(o.customer.address, o.customer.city), city: o.customer.city, paymentMethod: derivePaymentMethodText(o) },
  };
}
