/**
 * Fire-and-forget order-event notifications (Module 10/7). ONE function, `notifyOrderPlaced`, fans out to every channel legacy
 * had for a new order (owner e-mail, Telegram alert, Facebook CAPI Purchase event) plus one new addition (a customer
 * confirmation e-mail, only when an e-mail address exists). Every channel is independently try/caught so one failing channel
 * can never affect another, and the whole function never throws - by the time this runs the order is already committed
 * (called from `order.service.ts` WITHOUT being awaited), so a notification failure must never fail or roll back an order that
 * has already succeeded.
 *
 * Both order e-mails are gated by `ENABLE_LIVE_INTEGRATIONS`, same as Telegram/Facebook CAPI (logged only below the flag) -
 * this is ORDER-notification traffic, not core auth functionality, so it follows the "simulated unless live" rule every other
 * integration in this backend follows. This does NOT affect admin OTP/invite e-mails (`notifications.service.ts`'s other
 * senders), which stay always-on via the mailer's own `MAIL_TRANSPORT` switch, since login must always actually work.
 */
import { logger } from '../../utils/logger';
import { getEnv } from '../../config/env';
import { derivePaymentMethodText } from '../orders/order.serializer';
import type { OrderDoc } from '../orders/order.model';
import type { CapiResult } from './facebookCapi';
import { sendFacebookPurchaseEvent } from './facebookCapi';
import { sendCustomerOrderConfirmationEmail, sendOrderNotificationEmail } from './notifications.service';
import type { TelegramResult } from './telegram';
import { sendTelegramOrderAlert } from './telegram';
import type { OrderEmailInput } from './templates';

function toEmailInput(o: OrderDoc): OrderEmailInput {
  return {
    id: o._id,
    trackingCode: o._id,
    customerName: o.customer.fullName,
    customerEmail: o.customer.email,
    customerPhone: o.customer.phone,
    deliveryAddress: o.customer.address,
    cityDistrict: o.customer.city,
    subtotalAmount: o.subtotal,
    discountAmount: o.discount,
    deliveryFee: o.shipping,
    totalAmount: o.total,
    paymentMethod: derivePaymentMethodText(o),
    items: o.items.map((i) => ({ name: i.name, quantity: i.quantity, price: i.price, selectedColor: i.selectedColor, selectedSize: i.selectedSize })),
    notes: o.notes,
    createdAt: o.createdAt.toISOString(),
  };
}

type EmailOutcome = 'sent' | 'simulated' | 'skipped' | 'failed';
export interface OrderNotifyResult { ownerEmail: EmailOutcome; customerEmail: EmailOutcome; telegram: TelegramResult; facebookCapi: CapiResult }

async function sendOwnerEmail(order: OrderDoc, emailInput: OrderEmailInput): Promise<EmailOutcome> {
  if (!getEnv().ENABLE_LIVE_INTEGRATIONS) {
    logger.info({ orderId: order._id, simulated: true }, '[SIMULATED] owner order-notification e-mail');
    return 'simulated';
  }
  try {
    await sendOrderNotificationEmail(emailInput);
    return 'sent';
  } catch (err) {
    logger.warn({ err, orderId: order._id }, 'owner order-notification e-mail failed (ignored - order already succeeded)');
    return 'failed';
  }
}

async function sendCustomerEmail(order: OrderDoc, emailInput: OrderEmailInput): Promise<EmailOutcome> {
  if (!order.customer.email) return 'skipped';
  if (!getEnv().ENABLE_LIVE_INTEGRATIONS) {
    logger.info({ orderId: order._id, simulated: true }, '[SIMULATED] customer order-confirmation e-mail');
    return 'simulated';
  }
  try {
    await sendCustomerOrderConfirmationEmail(order.customer.email, emailInput);
    return 'sent';
  } catch (err) {
    logger.warn({ err, orderId: order._id }, 'customer order-confirmation e-mail failed (ignored - order already succeeded)');
    return 'failed';
  }
}

export async function notifyOrderPlaced(order: OrderDoc): Promise<OrderNotifyResult> {
  const emailInput = toEmailInput(order);
  const [ownerEmail, customerEmail, telegram, facebookCapi] = await Promise.all([
    sendOwnerEmail(order, emailInput),
    sendCustomerEmail(order, emailInput),
    sendTelegramOrderAlert(order),
    sendFacebookPurchaseEvent(order),
  ]);
  return { ownerEmail, customerEmail, telegram, facebookCapi };
}
