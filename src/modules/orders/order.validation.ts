import { z } from 'zod';
import { ORDER_STATUSES } from './order.model';

const itemInput = z.object({
  productId: z.string().trim().min(1).max(80),
  quantity: z.number().int().min(1).max(100),
  selectedSize: z.string().trim().max(120).optional(),
  selectedColor: z.string().trim().max(60).optional(),
});
const customerInput = z.object({
  fullName: z.string().trim().min(1).max(200),
  phone: z.string().trim().max(40),
  email: z.union([z.string().trim().toLowerCase().email().max(254), z.literal('')]).optional(),
  address: z.string().trim().min(1).max(1000),
  city: z.string().trim().max(120).default(''),
});

/**
 * The order INTENT (BACKEND_PLAN §3.1 `POST /orders`). Extra/unknown fields (client price, total, id, ...) are silently
 * dropped by Zod's default "strip" mode - the server never reads a client-computed amount from this body.
 */
export const createOrderSchema = z.object({
  items: z.array(itemInput).min(1).max(50),
  customer: customerInput,
  paymentChoice: z.enum(['FULL_COD', 'ADVANCE_DELIVERY', 'FULL_BKASH']),
  bkashTrxId: z.string().trim().max(60).optional(),
  senderBkashNumber: z.string().trim().max(40).optional(),
  couponCode: z.string().trim().max(60).optional(),
  notes: z.string().trim().max(2000).optional(),
});
export type CreateOrderInput = z.infer<typeof createOrderSchema>;

export const myOrdersQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

/* ------------------------------------------------------------------------------------------------------ admin (Module 5c) */

export const adminOrderListQuery = z.object({ status: z.enum(ORDER_STATUSES).optional() });

// ADVANCE_PAID and FAKE_SUSPECTED are each reachable only through their own guarded action (verify-payment, toggleFakeSuspicion) -
// never through this generic override, so a claim of "paid" or "fake" always goes through the check that action performs.
const deliveryPaymentStatusOverride = z.enum(['ADVANCE_PENDING', 'FULL_PAID', 'COD_PENDING', 'VERIFIED']);
export const adminOrderPatchSchema = z
  .object({ status: z.enum(ORDER_STATUSES).optional(), deliveryPaymentStatus: deliveryPaymentStatusOverride.optional(), toggleFakeSuspicion: z.boolean().optional() })
  .refine((v) => v.status !== undefined || v.deliveryPaymentStatus !== undefined || v.toggleFakeSuspicion !== undefined, 'at least one of status, deliveryPaymentStatus, toggleFakeSuspicion is required');
export type AdminOrderPatchInput = z.infer<typeof adminOrderPatchSchema>;

export const dispatchSchema = z.object({ provider: z.enum(['steadfast', 'pathao']).optional() });
