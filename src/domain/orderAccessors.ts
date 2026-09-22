/** Order-shape tolerant accessors (copied from the admin app: orders were written in several shapes over the years). */
export interface OrderLike {
  id?: string;
  createdAt: string | Date;
  status?: string;
  orderStatus?: string;
  total?: number;
  totalAmount?: number;
  subtotal?: number;
  customer?: { fullName?: string; phone?: string; address?: string; postalCode?: string; city?: string; paymentMethod?: string };
  customerName?: string;
  customerPhone?: string;
  deliveryAddress?: string;
  items?: Array<Record<string, unknown>>;
  stockDeducted?: boolean;
  [k: string]: unknown;
}
export const getOrderTotal = (o: OrderLike): number => o.totalAmount ?? o.total ?? o.subtotal ?? 0;
export const getCustomerName = (o: OrderLike): string => o.customer?.fullName || o.customerName || 'Customer';
export const getCustomerPhone = (o: OrderLike): string => o.customer?.phone || o.customerPhone || 'N/A';
export const getCustomerAddress = (o: OrderLike): string => o.customer?.address || o.deliveryAddress || 'N/A';
/** Canonical lowercase status (legacy mixed 'Shipped' / 'shipped' - BUG_FIXES A9). */
export const getOrderStatus = (o: OrderLike): string => String(o.status ?? o.orderStatus ?? 'pending').trim().toLowerCase() || 'pending';
