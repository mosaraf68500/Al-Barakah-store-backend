/**
 * Real Steadfast adapter (Module 11). Request/response shape ported field-for-field from legacy
 * `server/routes/api.ts` POST /courier/steadfast/send (`create_order`) - same endpoint path, same payload keys, same response
 * parsing (a `consignment` object, or a few top-level fallbacks legacy also tolerated).
 */
import type { OrderDoc } from '../orders/order.model';
import { assertAllowedCourierHost } from './hostAllowList';

export interface SteadfastCredentials { apiKey: string; secretKey: string; baseUrl: string }
export interface CourierDispatchResult { success: boolean; consignmentId?: string; trackingCode?: string; status?: string; error?: string; raw?: unknown }

export async function dispatchToSteadfast(order: OrderDoc, codAmount: number, creds: SteadfastCredentials): Promise<CourierDispatchResult> {
  assertAllowedCourierHost('steadfast', creds.baseUrl);
  const endpoint = `${creds.baseUrl.replace(/\/$/, '')}/api/v1/create_order`;
  const payload = {
    invoice: order._id.slice(-20),
    recipient_name: order.customer.fullName,
    recipient_phone: order.customer.phone.replace(/[^0-9]/g, ''),
    recipient_address: order.customer.address,
    cod_amount: codAmount, // BUG_FIXES B1: due-on-delivery, never the raw total (see order.service.dispatchOrder)
    note: order.notes || 'Al Barakah Premium Order',
  };
  let res: Response;
  try {
    res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Api-Key': creds.apiKey, 'Secret-Key': creds.secretKey },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(10_000),
    });
  } catch (err) {
    return { success: false, error: (err as Error).message || 'Failed to reach the Steadfast API' };
  }
  const data = (await res.json().catch(() => null)) as { status?: number | string; consignment?: { tracking_code?: string; consignment_id?: string; status?: string }; tracking_code?: string; consignment_id?: string; message?: string; errors?: unknown } | null;

  if (!res.ok || (data && data.status !== 200 && data.status !== 'success' && !data.consignment)) {
    const errMsg = data?.message || data?.errors || `Steadfast API error (HTTP ${res.status})`;
    return { success: false, error: typeof errMsg === 'object' ? JSON.stringify(errMsg) : String(errMsg), raw: data };
  }
  const consignment = data?.consignment || {};
  const trackingCode = consignment.tracking_code || consignment.consignment_id || data?.tracking_code || '';
  const consignmentId = consignment.consignment_id || data?.consignment_id || trackingCode;
  return { success: true, consignmentId: String(consignmentId), trackingCode: String(trackingCode), status: consignment.status || 'in_review', raw: data };
}
