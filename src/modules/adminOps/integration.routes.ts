import { Router } from 'express';
import { getEnv } from '../../config/env';
import { authenticate, requireRole } from '../../middleware/authenticate';
import { asyncHandler } from '../../utils/asyncHandler';
import { ApiResponse } from '../../utils/ApiResponse';
import { getSecret } from '../settings/settings.service';

/**
 * The admin "test" buttons. Credentials come from encrypted settings, never from the request body.
 * With live integrations off, nothing is sent.
 */
export function adminIntegrationRoutes() {
  const r = Router();
  const admin = [authenticate('admin'), requireRole('admin', 'super_admin')];

  r.post('/telegram/test', ...admin, asyncHandler(async (_req, res) => {
    const token = await getSecret('notificationConfig.telegram.botToken');
    const chatId = await getSecret('notificationConfig.telegram.chatId');
    if (!token || !chatId) {
      ApiResponse.ok(res, { success: false, simulated: false, message: 'Telegram is not saved in settings yet.' });
      return;
    }
    if (!getEnv().ENABLE_LIVE_INTEGRATIONS) {
      ApiResponse.ok(res, { success: true, simulated: true, message: 'Simulated. Live integrations are off, so nothing was sent.' });
      return;
    }
    const tg = await fetch(`https://api.telegram.org/bot${token.trim()}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId.trim(), text: 'Al Barakah Premium test message' }),
      signal: AbortSignal.timeout(5000),
    });
    const data = (await tg.json().catch(() => ({}))) as { ok?: boolean; description?: string };
    ApiResponse.ok(res, { success: Boolean(data.ok), simulated: false, message: data.ok ? 'Sent.' : data.description || 'Telegram rejected the message' });
  }));

  r.post('/facebook/test', ...admin, asyncHandler(async (_req, res) => {
    const token = await getSecret('facebookPixelConfig.accessToken');
    if (!token) {
      ApiResponse.ok(res, { success: false, simulated: false, message: 'Facebook access token is not saved in settings yet.' });
      return;
    }
    ApiResponse.ok(res, { success: true, simulated: true, message: 'The access token is saved. This button does not send a live test event.' });
  }));

  return r;
}
