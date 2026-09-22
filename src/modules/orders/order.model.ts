import { Schema, model, models, type Model } from 'mongoose';

export const ORDER_STATUSES = ['pending', 'processing', 'shipped', 'delivered', 'cancelled'] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];

export interface OrderItem {
  productId?: string;
  name: string;
  image: string;
  price: number; // unit price SNAPSHOT (server-side price at order time)
  quantity: number;
  selectedSize?: string;
  selectedColor?: string;
  totalPrice: number;
}
export interface OrderDoc {
  _id: string; // AB-###### (= tracking code)
  userId?: string | null;
  customer: { fullName: string; email?: string; phone: string; address: string; city: string; postalCode?: string };
  phoneKey: string; // last 10 digits of the phone, indexed for tracking / "my orders"
  items: OrderItem[];
  subtotal: number;
  discount: number;
  shipping: number;
  total: number;
  currency: 'BDT';
  couponCode?: string;
  status: OrderStatus;
  advancePaymentType: 'NONE' | 'DELIVERY_ONLY' | 'FULL_PAYMENT';
  advanceAmount: number;
  dueAmountOnDelivery: number;
  deliveryPaymentStatus: 'ADVANCE_PAID' | 'ADVANCE_PENDING' | 'FULL_PAID' | 'COD_PENDING' | 'VERIFIED' | 'FAKE_SUSPECTED';
  bkashTrxId?: string;
  senderBkashNumber?: string;
  isFakeSuspected: boolean;
  /** The `deliveryPaymentStatus` this order had the moment it was flagged fake-suspected - restored exactly on un-flag (Module 5c
   * bug fix: un-flagging used to always reset to COD_PENDING, silently losing an ADVANCE_PENDING/FULL_PAID/VERIFIED state). */
  statusBeforeFakeSuspicion?: OrderDoc['deliveryPaymentStatus'] | null;
  /** true while this order's items are subtracted from product stock (set on placement, cleared on cancel; the ONLY stock-accounting flag). */
  stockDeducted: boolean;
  notes?: string;
  courier?: Record<string, unknown> | null;
  /** Which delivery zone the order was priced under, and whether `deriveZone` could not confidently tell from `customer.city`
   * (defaults to 'outside' - the higher fee - and is flagged here so an admin can double-check and correct it manually). */
  deliveryZone: 'inside' | 'outside';
  zoneUncertain: boolean;
  /** Soft-delete (deletedAt): excluded from every read (admin list/detail, tracking, /my); stock is released on delete if still held. */
  deletedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

const itemSchema = new Schema<OrderItem>(
  { productId: String, name: { type: String, required: true }, image: { type: String, default: '' }, price: { type: Number, required: true, min: 0 }, quantity: { type: Number, required: true, min: 1 }, selectedSize: String, selectedColor: String, totalPrice: { type: Number, required: true, min: 0 } },
  { _id: false },
);
const schema = new Schema<OrderDoc>(
  {
    _id: { type: String },
    userId: { type: String, default: null },
    customer: {
      fullName: { type: String, required: true }, email: String, phone: { type: String, required: true }, address: { type: String, required: true }, city: { type: String, default: '' }, postalCode: String,
    },
    phoneKey: { type: String, required: true },
    items: { type: [itemSchema], validate: (v: unknown[]) => v.length > 0 },
    subtotal: { type: Number, required: true, min: 0 },
    discount: { type: Number, default: 0, min: 0 },
    shipping: { type: Number, default: 0, min: 0 },
    total: { type: Number, required: true, min: 0 },
    currency: { type: String, enum: ['BDT'], default: 'BDT' },
    couponCode: String,
    status: { type: String, enum: ORDER_STATUSES, default: 'pending' },
    advancePaymentType: { type: String, enum: ['NONE', 'DELIVERY_ONLY', 'FULL_PAYMENT'], default: 'NONE' },
    advanceAmount: { type: Number, default: 0, min: 0 },
    dueAmountOnDelivery: { type: Number, default: 0, min: 0 },
    deliveryPaymentStatus: { type: String, enum: ['ADVANCE_PAID', 'ADVANCE_PENDING', 'FULL_PAID', 'COD_PENDING', 'VERIFIED', 'FAKE_SUSPECTED'], default: 'COD_PENDING' },
    bkashTrxId: String,
    senderBkashNumber: String,
    isFakeSuspected: { type: Boolean, default: false },
    statusBeforeFakeSuspicion: { type: String, enum: ['ADVANCE_PAID', 'ADVANCE_PENDING', 'FULL_PAID', 'COD_PENDING', 'VERIFIED', 'FAKE_SUSPECTED'], default: null },
    stockDeducted: { type: Boolean, default: false },
    notes: String,
    courier: { type: Schema.Types.Mixed, default: null },
    deliveryZone: { type: String, enum: ['inside', 'outside'], default: 'inside' },
    zoneUncertain: { type: Boolean, default: false },
    deletedAt: { type: Date, default: null },
  },
  { timestamps: true },
);
schema.index({ phoneKey: 1, createdAt: -1 });
schema.index({ userId: 1, createdAt: -1 });
schema.index({ status: 1, createdAt: -1 });
schema.index({ createdAt: -1 });
schema.index({ deletedAt: 1 });
schema.index({ bkashTrxId: 1 }, { unique: true, partialFilterExpression: { bkashTrxId: { $type: 'string', $gt: '' } } }); // a TrxID can be used by one order only
export const OrderModel: Model<OrderDoc> = (models.Order as Model<OrderDoc>) ?? model<OrderDoc>('Order', schema);
