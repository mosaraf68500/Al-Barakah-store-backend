import { getEnv } from '../../config/env';
import { UserModel } from '../users/user.model';
import { sendMail } from './mailer';
import { renderAdminInviteEmail, renderCustomerOrderConfirmationEmail, renderOrderNotificationEmail, renderOtpEmail, type OrderEmailInput } from './templates';
import { OTP } from '../../config/constants';

/** Throws `MailDeliveryError` when the e-mail could not be sent - callers decide how to surface it. */
export const sendAdminOtpEmail = (to: string, name: string, code: string) => sendMail({ to, ...renderOtpEmail({ adminName: name, code, ttlMinutes: OTP.ttlMs / 60_000 }) });

export const sendAdminInviteEmail = (to: string, name: string, link: string, ttlHours: number) => sendMail({ to, ...renderAdminInviteEmail({ name, link, ttlHours }) });

/**
 * Same address the admin OTP is delivered to: `user.email` on the active `super_admin` account
 * (`adminAuth.service` passes that field to `sendAdminOtpEmail`). `SUPER_ADMIN_EMAIL` is only the
 * seed value copied onto that account, used here when the account does not exist yet.
 */
export async function ownerNotificationRecipients(): Promise<string[]> {
  const accounts = await UserModel.find({ role: 'super_admin', isActive: true }).select('email').lean();
  const fromAccounts = [...new Set(accounts.map((u) => (u.email ?? '').trim()).filter(Boolean))];
  if (fromAccounts.length > 0) return fromAccounts;
  const seeded = getEnv().SUPER_ADMIN_EMAIL?.trim();
  return seeded ? [seeded] : [];
}

/** Recipients are the super_admin account e-mail, never request data or a separate address list. */
export async function sendOrderNotificationEmail(order: OrderEmailInput) {
  const to = await ownerNotificationRecipients();
  if (to.length === 0) throw new Error('No super_admin e-mail is configured');
  return sendMail({ to, ...renderOrderNotificationEmail(order) });
}

/** New in Module 10 - only called when the order actually has an e-mail address. */
export const sendCustomerOrderConfirmationEmail = (to: string, order: OrderEmailInput) => sendMail({ to, ...renderCustomerOrderConfirmationEmail(order) });
