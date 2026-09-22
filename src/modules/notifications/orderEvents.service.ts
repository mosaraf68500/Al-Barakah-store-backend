/**
 * Fire-and-forget order-event notifications (Module 10). ONE function, `notifyOrderPlaced`, fans out to every channel legacy
 * had for a new order (owner e-mail, Telegram alert, Facebook CAPI Purchase event) plus one new addition (a customer
 * confirmation e-mail, only when an e-mail address exists). Every channel is independently try/caught so one failing channel
 * can never affect another, and the whole function never throws - by the time this runs the order is already committed
 * (called from `order.service.ts` WITHOUT being awaited), so a notification failure must never fail or roll back an order that
 * has already succeeded.
 */
import { logger } from '../../utils/logger';
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

type EmailOutcome = 'sent' | 'skipped' | 'failed';
export interface OrderNotifyResult { ownerEmail: EmailOutcome; customerEmail: EmailOutcome; telegram: TelegramResult; facebookCapi: CapiResult }

export async function notifyOrderPlaced(order: OrderDoc): Promise<OrderNotifyResult> {
  const emailInput = toEmailInput(order);

  const ownerEmail = sendOrderNotificationEmail(emailInput)
    .then((): EmailOutcome => 'sent')
    .catch((err: unknown): EmailOutcome => {
      logger.warn({ err, orderId: order._id }, 'owner order-notification e-mail failed (ignored - order already succeeded)');
      return 'failed';
    });

  const customerEmail = order.customer.email
    ? sendCustomerOrderConfirmationEmail(order.customer.email, emailInput)
        .then((): EmailOutcome => 'sent')
        .catch((err: unknown): EmailOutcome => {
          logger.warn({ err, orderId: order._id }, 'customer order-confirmation e-mail failed (ignored - order already succeeded)');
          return 'failed';
        })
    : Promise.resolve<EmailOutcome>('skipped');

  const [ownerEmailResult, customerEmailResult, telegram, facebookCapi] = await Promise.all([
    ownerEmail,
    customerEmail,
    sendTelegramOrderAlert(order),
    sendFacebookPurchaseEvent(order),
  ]);
  return { ownerEmail: ownerEmailResult, customerEmail: customerEmailResult, telegram, facebookCapi };
}
