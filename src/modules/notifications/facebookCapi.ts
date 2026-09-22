/**
 * Facebook Conversions API "Purchase" event (BACKEND_PLAN module 10/11). Trigger ported from legacy
 * `facebookPixelService.trackFbPurchase` ("when the order is successfully submitted") - moved fully server-side now that orders
 * are created server-side (Module 5b), so the event fires reliably even if the browser tab closes right after checkout, and the
 * access token never touches the browser (SECURITY_RISKS #5, already partly addressed in Phase 1's `/api/analytics/fb-capi`
 * relay). FIX vs legacy: `user_data` (phone/e-mail/name) is SHA-256 HASHED, as Meta's API actually requires - legacy sent it in
 * clear text, which was never a working integration, just an unnoticed bug (BACKEND_PLAN §3.1 already called for hashing here).
 */
import crypto from 'node:crypto';
import { logger } from '../../utils/logger';
import { getEnv } from '../../config/env';
import { getConfig, getSecret } from '../settings/settings.service';
import type { OrderDoc } from '../orders/order.model';

const sha256 = (v: string) => crypto.createHash('sha256').update(v).digest('hex');

export interface PixelConfig { enabled?: boolean; enableCapi?: boolean; trackPurchase?: boolean; pixelId?: string; testEventCode?: string; customCurrency?: string }
export interface CapiResult { sent: boolean; simulated: boolean; reason?: string }

/** Pure - no I/O - so the hashing and event shape can be tested without a network call or live settings. */
export function buildPurchasePayload(order: OrderDoc, cfg: Pick<PixelConfig, 'customCurrency' | 'testEventCode'>) {
  const contentIds = order.items.filter((i) => i.productId).map((i) => i.productId as string);
  const userData: Record<string, string> = {};
  if (order.customer.phone) userData.ph = sha256(order.customer.phone.replace(/[^0-9]/g, ''));
  if (order.customer.email) userData.em = sha256(order.customer.email.trim().toLowerCase());
  if (order.customer.fullName) userData.fn = sha256(order.customer.fullName.trim().toLowerCase());

  return {
    data: [{
      event_name: 'Purchase',
      event_time: Math.floor(order.createdAt.getTime() / 1000),
      event_id: `pur-${order._id}`,
      action_source: 'website' as const,
      user_data: userData,
      custom_data: { content_ids: contentIds.length ? contentIds : [order._id], content_type: 'product', value: order.total, currency: cfg.customCurrency || order.currency, num_items: order.items.reduce((n, i) => n + i.quantity, 0), order_id: order._id },
    }],
    ...(cfg.testEventCode?.trim() ? { test_event_code: cfg.testEventCode.trim() } : {}),
  };
}

/** Never throws. Skipped when the flag/credentials aren't configured. Simulated (logged only) below `ENABLE_LIVE_INTEGRATIONS`. */
export async function sendFacebookPurchaseEvent(order: OrderDoc): Promise<CapiResult> {
  try {
    const cfg = (await getConfig()).facebookPixelConfig as PixelConfig | undefined;
    if (!cfg?.enabled || !cfg.enableCapi || !cfg.trackPurchase || !cfg.pixelId) return { sent: false, simulated: false, reason: 'NOT_CONFIGURED' };
    const accessToken = await getSecret('facebookPixelConfig.accessToken');
    if (!accessToken) return { sent: false, simulated: false, reason: 'NOT_CONFIGURED' };

    const payload = buildPurchasePayload(order, cfg);
    if (!getEnv().ENABLE_LIVE_INTEGRATIONS) {
      logger.info({ orderId: order._id, simulated: true }, '[SIMULATED] facebook CAPI purchase event');
      return { sent: false, simulated: true };
    }
    const res = await fetch(`https://graph.facebook.com/v19.0/${cfg.pixelId.trim()}/events?access_token=${accessToken.trim()}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(5000),
    });
    const data = (await res.json().catch(() => ({}))) as { events_received?: number; error?: { message?: string } };
    if (data.error) logger.warn({ orderId: order._id, error: data.error.message }, 'facebook CAPI event rejected');
    return { sent: Boolean(data.events_received), simulated: false, ...(data.error ? { reason: data.error.message } : {}) };
  } catch (err) {
    logger.warn({ err, orderId: order._id }, 'facebook CAPI event failed (ignored - never blocks the order)');
    return { sent: false, simulated: false, reason: 'ERROR' };
  }
}
