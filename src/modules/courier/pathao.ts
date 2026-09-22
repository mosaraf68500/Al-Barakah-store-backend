/**
 * Real Pathao adapter (Module 11). Two-step OAuth-then-create flow, request/response shape ported field-for-field from legacy
 * `server/routes/api.ts` POST /courier/pathao/send. `recipient_city`/`recipient_zone` stay hard-coded to Dhaka (1/1) - a
 * previously confirmed decision (BACKEND_PLAN Q16b): no real location mapping exists for the other 63 districts, and building
 * one is out of scope here.
 */
import type { OrderDoc } from '../orders/order.model';
import { assertAllowedCourierHost } from './hostAllowList';
import type { CourierDispatchResult } from './steadfast';

export interface PathaoCredentials { clientId: string; clientSecret: string; username: string; password: string; storeId?: string; baseUrl: string }

export async function dispatchToPathao(order: OrderDoc, codAmount: number, creds: PathaoCredentials): Promise<CourierDispatchResult> {
  assertAllowedCourierHost('pathao', creds.baseUrl);
  const host = creds.baseUrl.replace(/\/$/, '');

  let tokenRes: Response;
  try {
    tokenRes = await fetch(`${host}/aladdin/api/v1/issue-token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ client_id: creds.clientId, client_secret: creds.clientSecret, username: creds.username, password: creds.password, grant_type: 'password' }),
      signal: AbortSignal.timeout(10_000),
    });
  } catch (err) {
    return { success: false, error: (err as Error).message || 'Failed to reach the Pathao API' };
  }
  const tokenData = (await tokenRes.json().catch(() => null)) as { access_token?: string; message?: string; error_description?: string } | null;
  if (!tokenRes.ok || !tokenData?.access_token) {
    const errMsg = tokenData?.message || tokenData?.error_description || 'Pathao authentication failed';
    return { success: false, error: `Pathao auth error: ${errMsg}`, raw: tokenData };
  }

  const invoice = order._id.slice(-20);
  const payload = {
    store_id: creds.storeId ? Number(creds.storeId) : undefined,
    merchant_order_id: invoice,
    recipient_name: order.customer.fullName,
    recipient_phone: order.customer.phone.replace(/[^0-9]/g, ''),
    recipient_address: order.customer.address,
    recipient_city: 1, // hard-coded Dhaka (confirmed decision, see module doc-comment)
    recipient_zone: 1,
    delivery_type: 48, // 48-hour normal delivery
    item_type: 2, // 2 = parcel
    special_instruction: order.notes || 'Al Barakah Premium Delivery',
    item_quantity: order.items.length || 1,
    item_weight: '0.5',
    amount_to_collect: codAmount, // BUG_FIXES B1: due-on-delivery, never the raw total (see order.service.dispatchOrder)
    item_description: order.items.map((i) => i.name).join(', ') || 'Al Barakah Products',
  };
  let createRes: Response;
  try {
    createRes = await fetch(`${host}/aladdin/api/v1/orders`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', Authorization: `Bearer ${tokenData.access_token}` },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(10_000),
    });
  } catch (err) {
    return { success: false, error: (err as Error).message || 'Failed to reach the Pathao API' };
  }
  const createData = (await createRes.json().catch(() => null)) as { data?: { consignment_id?: string; order_status?: string }; message?: string; errors?: unknown } | null;
  if (!createRes.ok || !createData?.data?.consignment_id) {
    const errMsg = createData?.message || createData?.errors || 'Failed to create Pathao order';
    return { success: false, error: typeof errMsg === 'object' ? JSON.stringify(errMsg) : String(errMsg), raw: createData };
  }
  const d = createData.data;
  return { success: true, consignmentId: String(d.consignment_id), trackingCode: String(d.consignment_id), status: d.order_status || 'Pending', raw: createData };
}
