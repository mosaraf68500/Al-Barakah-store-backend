import { getCustomerAddress, getCustomerName, getCustomerPhone, getOrderStatus, getOrderTotal, type OrderLike } from './orderAccessors';

/** Ported 1:1 from `al-barakah-admin/lib/domain/metrics.ts` + `customers.ts` (BUG_FIXES A2 / A3 / A5). Pure functions, no I/O. */

export interface DashboardMetrics { deliveredCount: number; pendingCount: number; deliveredSales: number; pendingRevenue: number; uniqueCustomers: number }

export function computeMetrics(orders: OrderLike[]): DashboardMetrics {
  const delivered = orders.filter((o) => getOrderStatus(o) === 'delivered');
  const pending = orders.filter((o) => ['pending', 'processing'].includes(getOrderStatus(o)));
  return {
    deliveredCount: delivered.length,
    pendingCount: pending.length,
    deliveredSales: delivered.reduce((s, o) => s + getOrderTotal(o), 0),
    pendingRevenue: pending.reduce((s, o) => s + getOrderTotal(o), 0),
    // the legacy fake `|| 12` fallback is gone (A3): the real count, 0 when there are no customers
    uniqueCustomers: new Set(orders.map((o) => getCustomerPhone(o) || getCustomerName(o))).size,
  };
}

export interface SalesBar { day: string; amount: number; height: string }

/**
 * Real revenue per calendar day for the last 7 days (oldest first, weekday labels) - replaces the hard-coded fake chart (A3).
 * Cancelled orders are excluded; heights are relative to the busiest day (minimum 4% so an empty day still shows a stub).
 */
export function computeWeeklySales(orders: OrderLike[], now: Date = new Date()): SalesBar[] {
  const labels = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const days: { start: number; label: string; amount: number }[] = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i);
    days.push({ start: d.getTime(), label: labels[d.getDay()], amount: 0 });
  }
  const DAY = 24 * 60 * 60 * 1000;
  for (const o of orders) {
    if (getOrderStatus(o) === 'cancelled') continue;
    const t = new Date(o.createdAt).getTime();
    if (Number.isNaN(t)) continue;
    const bucket = days.find((d) => t >= d.start && t < d.start + DAY);
    if (bucket) bucket.amount += getOrderTotal(o);
  }
  const max = Math.max(...days.map((d) => d.amount), 0);
  return days.map((d) => ({ day: d.label, amount: d.amount, height: max > 0 ? `${Math.max(4, Math.round((d.amount / max) * 100))}%` : '4%' }));
}

/** "Recent orders": newest first by createdAt (legacy sliced the raw array = document-id order) - A2. */
export function sortOrdersNewestFirst<T extends OrderLike>(orders: T[]): T[] {
  return [...orders].sort((a, b) => (Date.parse(String(b.createdAt)) || 0) - (Date.parse(String(a.createdAt)) || 0));
}

export interface CustomerRow { key: string; name: string; phone: string; address: string; orderCount: number; totalSpent: number; lastOrderAt: string }

/** One row per customer (phone, else name) with the REAL order count and total spent - legacy showed one row per order with "1 Order" (A5). */
export function groupCustomers(orders: OrderLike[]): CustomerRow[] {
  const map = new Map<string, CustomerRow>();
  for (const o of sortOrdersNewestFirst(orders)) {
    const phone = getCustomerPhone(o);
    const key = phone && phone !== 'N/A' ? phone.replace(/\D/g, '').slice(-10) || phone : getCustomerName(o);
    const row = map.get(key);
    if (row) {
      row.orderCount += 1;
      row.totalSpent += getOrderTotal(o);
    } else {
      map.set(key, { key, name: getCustomerName(o), phone, address: getCustomerAddress(o), orderCount: 1, totalSpent: getOrderTotal(o), lastOrderAt: String(o.createdAt) });
    }
  }
  return [...map.values()];
}
