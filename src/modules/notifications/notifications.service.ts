import { getEnv } from '../../config/env';
import { sendMail } from './mailer';
import { renderAdminInviteEmail, renderOrderNotificationEmail, renderOtpEmail, type OrderEmailInput } from './templates';
import { OTP } from '../../config/constants';

/** Throws `MailDeliveryError` when the e-mail could not be sent - callers decide how to surface it. */
export const sendAdminOtpEmail = (to: string, name: string, code: string) => sendMail({ to, ...renderOtpEmail({ adminName: name, code, ttlMinutes: OTP.ttlMs / 60_000 }) });

export const sendAdminInviteEmail = (to: string, name: string, link: string, ttlHours: number) => sendMail({ to, ...renderAdminInviteEmail({ name, link, ttlHours }) });

/** Recipients come from configuration (ORDER_NOTIFY_EMAILS), never from request data or hard-coded addresses. */
export async function sendOrderNotificationEmail(order: OrderEmailInput) {
  const to = getEnv().orderNotifyEmails;
  if (to.length === 0) throw new Error('ORDER_NOTIFY_EMAILS is not configured');
  return sendMail({ to, ...renderOrderNotificationEmail(order) });
}
