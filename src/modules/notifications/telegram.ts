/**
 * Telegram new-order alert (BACKEND_PLAN module 10). Content/trigger ported from legacy `utils/telegramNotifier.ts`
 * `formatOrderForTelegram` (same Bengali copy/layout, same emoji, same fields) - the only difference is that every
 * user-supplied value is HTML-escaped before going into a `parse_mode=HTML` message (legacy interpolated them raw;
 * already flagged and fixed for the storefront in Phase 1's `lib/server/telegramFormat.ts` - this ports that fixed version).
 */
import { escapeHtml } from '../../utils/escapeHtml';
import { logger } from '../../utils/logger';
import { getEnv } from '../../config/env';
import { getConfig, getSecret } from '../settings/settings.service';
import type { OrderDoc } from '../orders/order.model';

const money = (n: number) => `৳${Number(n || 0).toLocaleString('en-US')}`;

export function formatOrderForTelegram(o: OrderDoc): string {
  const code = o._id;
  const itemsText = o.items.length
    ? o.items
        .map((it, i) => {
          const variant = it.selectedColor || it.selectedSize ? ` [${[it.selectedColor, it.selectedSize].filter(Boolean).map(escapeHtml).join(', ')}]` : '';
          return `  ${i + 1}. <b>${escapeHtml(it.name)}</b>${variant} x ${it.quantity} = ${money(it.price * it.quantity)}`;
        })
        .join('\n')
    : '  • পণ্য বিবরণ সংরক্ষিত';
  const notes = o.notes ? `\n📝 <b>নোট:</b> <i>"${escapeHtml(o.notes)}"</i>` : '';
  const city = o.customer.city ? ` (${escapeHtml(o.customer.city)})` : '';

  return `🎉 <b>নতুন অর্ডার এসেছে! [AL BARAKAH PREMIUM]</b>
━━━━━━━━━━━━━━━━━━━━
🆔 <b>অর্ডার আইডি:</b> #${escapeHtml(code)}
👤 <b>গ্রাহকের নাম:</b> ${escapeHtml(o.customer.fullName)}
📞 <b>মোবাইল নম্বর:</b> <code>${escapeHtml(o.customer.phone)}</code>
📍 <b>ঠিকানা:</b> ${escapeHtml(o.customer.address)}${city}
💰 <b>মোট বিল:</b> ${money(o.total)}
💳 <b>পেমেন্ট স্ট্যাটাস:</b> ${escapeHtml(o.deliveryPaymentStatus)}${notes}

🛍️ <b>অর্ডারকৃত পণ্যসমূহ:</b>
${itemsText}
━━━━━━━━━━━━━━━━━━━━
⏰ <i>${o.createdAt.toLocaleString('bn-BD', { timeZone: 'Asia/Dhaka' })}</i>
👉 <i>অর্ডার প্রসেস করতে অ্যাডমিন ড্যাশবোর্ডে লগইন করুন</i>`;
}

export interface TelegramResult { sent: boolean; simulated: boolean; reason?: string }

/**
 * Never throws. Skipped (not an error) when Telegram isn't configured. Below `ENABLE_LIVE_INTEGRATIONS` the message is only
 * logged (matches the courier-dispatch and admin telegram-test simulation pattern used everywhere else in this backend) -
 * there is no safe test double for a real external chat the way `MAIL_TRANSPORT=memory` stands in for SMTP.
 */
export async function sendTelegramOrderAlert(order: OrderDoc): Promise<TelegramResult> {
  try {
    const cfg = (await getConfig()).notificationConfig as { telegram?: { enabled?: boolean } } | undefined;
    if (!cfg?.telegram?.enabled) return { sent: false, simulated: false, reason: 'NOT_CONFIGURED' };
    const [botToken, chatId] = await Promise.all([getSecret('notificationConfig.telegram.botToken'), getSecret('notificationConfig.telegram.chatId')]);
    if (!botToken || !chatId) return { sent: false, simulated: false, reason: 'NOT_CONFIGURED' };

    const text = formatOrderForTelegram(order);
    if (!getEnv().ENABLE_LIVE_INTEGRATIONS) {
      logger.info({ orderId: order._id, chatId, simulated: true }, '[SIMULATED] telegram order alert');
      return { sent: false, simulated: true };
    }
    const res = await fetch(`https://api.telegram.org/bot${botToken.trim()}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId.trim(), text, parse_mode: 'HTML' }),
      signal: AbortSignal.timeout(5000),
    });
    const data = (await res.json().catch(() => ({}))) as { ok?: boolean; description?: string };
    if (!data.ok) logger.warn({ orderId: order._id, description: data.description }, 'telegram order alert rejected');
    return { sent: Boolean(data.ok), simulated: false, ...(data.ok ? {} : { reason: data.description ?? 'REJECTED' }) };
  } catch (err) {
    logger.warn({ err, orderId: order._id }, 'telegram order alert failed (ignored - never blocks the order)');
    return { sent: false, simulated: false, reason: 'ERROR' };
  }
}
