/**
 * Loads courier credentials from `settings` (encrypted, admin-managed - never hard-coded) and dispatches to the matching real
 * adapter. `settings.getConfig()` for the non-secret fields (`baseUrl`, `storeId`, `defaultCourier`, `autoSendOnConfirm`),
 * `settings.getSecret()` for the encrypted ones (`apiKey`/`secretKey`, `clientId`/`clientSecret`/`username`/`password`).
 */
import { getConfig, getSecret } from '../settings/settings.service';
import type { OrderDoc } from '../orders/order.model';
import { dispatchToSteadfast, type CourierDispatchResult } from './steadfast';
import { dispatchToPathao } from './pathao';

export type CourierProvider = 'steadfast' | 'pathao';
export interface CourierConfigShape { steadfast?: { enabled?: boolean; baseUrl?: string }; pathao?: { enabled?: boolean; baseUrl?: string; storeId?: string }; defaultCourier?: string; autoSendOnConfirm?: boolean }

export async function getCourierConfig(): Promise<CourierConfigShape> {
  return ((await getConfig()).courierConfig as CourierConfigShape | undefined) ?? {};
}

export async function dispatchViaLiveCourier(order: OrderDoc, provider: CourierProvider, codAmount: number): Promise<CourierDispatchResult> {
  const cfg = await getCourierConfig();
  if (provider === 'steadfast') {
    if (!cfg.steadfast?.enabled) return { success: false, error: 'Steadfast is not enabled in settings' };
    const [apiKey, secretKey] = await Promise.all([getSecret('courierConfig.steadfast.apiKey'), getSecret('courierConfig.steadfast.secretKey')]);
    if (!apiKey || !secretKey) return { success: false, error: 'Steadfast API credentials are not configured' };
    return dispatchToSteadfast(order, codAmount, { apiKey, secretKey, baseUrl: cfg.steadfast?.baseUrl || 'https://portal.steadfast.com.bd' });
  }
  if (!cfg.pathao?.enabled) return { success: false, error: 'Pathao is not enabled in settings' };
  const [clientId, clientSecret, username, password] = await Promise.all([
    getSecret('courierConfig.pathao.clientId'), getSecret('courierConfig.pathao.clientSecret'), getSecret('courierConfig.pathao.username'), getSecret('courierConfig.pathao.password'),
  ]);
  if (!clientId || !clientSecret || !username || !password) return { success: false, error: 'Pathao credentials are not configured' };
  return dispatchToPathao(order, codAmount, { clientId, clientSecret, username, password, storeId: cfg.pathao?.storeId, baseUrl: cfg.pathao?.baseUrl || 'https://api-hermes.pathao.com' });
}

export type { CourierDispatchResult };
