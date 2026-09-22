import { escapeHtml, safePhoneHref } from '../../utils/escapeHtml';

/** Every dynamic value below goes through `escapeHtml` (or a stricter sanitiser for hrefs). Layout mirrors the legacy e-mails. */
const wrap = (inner: string, maxWidth = 540) => `
<div style="font-family:'Segoe UI',Arial,sans-serif;max-width:${maxWidth}px;margin:0 auto;background-color:#03251a;color:#ffffff;padding:28px;border-radius:18px;border:1px solid #0d5c40;">
  <div style="text-align:center;margin-bottom:24px;">
    <h1 style="color:#D4AF37;margin:0;font-size:22px;letter-spacing:2px;font-weight:900;text-transform:uppercase;">AL BARAKAH</h1>
  </div>
  ${inner}
</div>`;

export function renderOtpEmail(o: { adminName: string; code: string; ttlMinutes: number }) {
  const html = wrap(`
  <div style="background-color:#053324;padding:24px;border-radius:16px;border:1px solid #14532d;text-align:center;">
    <h2 style="color:#ffffff;font-size:18px;margin:0 0 10px 0;">Admin 2-Factor Authentication</h2>
    <p style="color:#cbd5e1;font-size:13px;line-height:1.6;margin:0 0 20px 0;">Hello ${escapeHtml(o.adminName)},<br/>A sign-in was attempted for the <strong>AL BARAKAH Admin Panel</strong>. Use this code to complete it:</p>
    <div style="background-color:#021a12;border:2px dashed #D4AF37;border-radius:12px;padding:16px;display:inline-block;margin:0 auto 20px auto;">
      <span style="color:#D4AF37;font-size:32px;font-weight:bold;letter-spacing:8px;font-family:monospace;">${escapeHtml(o.code)}</span>
    </div>
    <p style="color:#94a3b8;font-size:11px;margin:0;">This code expires in <strong>${o.ttlMinutes} minutes</strong> and can be used once. If you did not try to sign in, ignore this e-mail.</p>
  </div>`);
  return {
    // The code is deliberately NOT in the subject (visible in lock screens / notification previews / logs).
    subject: '[AL BARAKAH] Your admin verification code',
    text: `Your AL BARAKAH admin verification code is ${o.code}. It expires in ${o.ttlMinutes} minutes and can be used once.`,
    html,
  };
}

export function renderAdminInviteEmail(o: { name: string; link: string; ttlHours: number }) {
  const html = wrap(`
  <div style="background-color:#053324;padding:24px;border-radius:16px;border:1px solid #14532d;text-align:center;">
    <h2 style="color:#ffffff;font-size:18px;margin:0 0 10px 0;">You have been given admin access</h2>
    <p style="color:#cbd5e1;font-size:13px;line-height:1.6;margin:0 0 20px 0;">Hello ${escapeHtml(o.name)}, choose your password to activate your AL BARAKAH admin account. The link works once and expires in ${o.ttlHours} hours.</p>
    <a href="${escapeHtml(o.link)}" style="display:inline-block;background:#D4AF37;color:#03251a;font-weight:bold;padding:12px 22px;border-radius:10px;text-decoration:none;">Set password</a>
  </div>`);
  return { subject: '[AL BARAKAH] Set your admin password', text: `Hello ${o.name}, set your AL BARAKAH admin password (expires in ${o.ttlHours} hours): ${o.link}`, html };
}

export interface OrderEmailInput {
  id: string;
  trackingCode?: string;
  customerName: string;
  customerEmail?: string;
  customerPhone: string;
  deliveryAddress: string;
  cityDistrict?: string;
  subtotalAmount?: number;
  discountAmount?: number;
  deliveryFee?: number;
  totalAmount: number;
  paymentMethod?: string;
  items: Array<{ name: string; quantity: number; price: number; selectedColor?: string; selectedSize?: string }>;
  notes?: string;
  createdAt?: string;
}
const money = (n: number) => `৳${Number(n || 0).toLocaleString('en-US')}`;

/** New-order e-mail for the owners (legacy layout, every field escaped). */
export function renderOrderNotificationEmail(o: OrderEmailInput) {
  const code = o.trackingCode || o.id;
  const items = o.items
    .map(
      (i) => `<tr style="border-bottom:1px solid #14532d;">
      <td style="padding:12px 8px;color:#ffffff;font-size:13px;"><strong>${escapeHtml(i.name)}</strong>${i.selectedSize ? `<br/><span style="color:#94a3b8;font-size:11px;">সাইজ: ${escapeHtml(i.selectedSize)}</span>` : ''}${i.selectedColor ? `<span style="color:#94a3b8;font-size:11px;"> | কালার: ${escapeHtml(i.selectedColor)}</span>` : ''}</td>
      <td style="padding:12px 8px;text-align:center;color:#D4AF37;font-weight:bold;font-size:13px;">${escapeHtml(i.quantity)}x</td>
      <td style="padding:12px 8px;text-align:right;color:#4ade80;font-weight:bold;font-size:13px;">${money(i.price * i.quantity)}</td></tr>`,
    )
    .join('');
  const row = (label: string, value: string, extra = '') => `<tr><td style="padding:4px 0;width:30%;color:#94a3b8;">${label}</td><td style="padding:4px 0;${extra}">${value}</td></tr>`;
  const html = wrap(
    `<div style="background-color:#053324;padding:20px;border-radius:14px;border:1px solid #14532d;margin-bottom:20px;">
    <p style="color:#4ade80;margin:0 0 12px 0;font-size:12px;letter-spacing:2px;text-transform:uppercase;font-weight:bold;">🎉 নতুন অর্ডার নোটিফিকেশন</p>
    <h3 style="color:#D4AF37;margin:2px 0 12px 0;font-size:16px;font-family:monospace;">#${escapeHtml(code)}</h3>
    <table style="width:100%;font-size:13px;color:#cbd5e1;margin-bottom:16px;">
      ${row('নাম:', escapeHtml(o.customerName), 'font-weight:bold;color:#ffffff;')}
      ${row('মোবাইল:', `<a href="tel:${escapeHtml(safePhoneHref(o.customerPhone))}" style="color:#4ade80;text-decoration:none;">${escapeHtml(o.customerPhone)}</a>`, 'font-weight:bold;')}
      ${o.customerEmail ? row('ইমেইল:', escapeHtml(o.customerEmail)) : ''}
      ${row('ঠিকানা:', `${escapeHtml(o.deliveryAddress)}${o.cityDistrict ? ` (${escapeHtml(o.cityDistrict)})` : ''}`, 'color:#ffffff;')}
      ${o.notes ? row('বিশেষ নোট:', `"${escapeHtml(o.notes)}"`, 'color:#fbbf24;font-style:italic;') : ''}
    </table>
    <table style="width:100%;border-collapse:collapse;margin-bottom:16px;"><tbody>${items}</tbody></table>
    <table style="width:100%;font-size:13px;">
      ${o.subtotalAmount ? row('সাবটোটাল:', money(o.subtotalAmount), 'text-align:right;color:#ffffff;') : ''}
      ${o.deliveryFee ? row('ডেলিভারি চার্জ:', money(o.deliveryFee), 'text-align:right;color:#ffffff;') : ''}
      ${o.discountAmount ? row('ডিসকাউন্ট:', `-${money(o.discountAmount)}`, 'text-align:right;color:#ef4444;') : ''}
      ${row('সর্বমোট বিল:', money(o.totalAmount), 'text-align:right;color:#D4AF37;font-weight:900;font-size:18px;')}
      ${row('পেমেন্ট মেথড:', escapeHtml(o.paymentMethod || 'Cash On Delivery'), 'text-align:right;color:#4ade80;font-weight:bold;')}
    </table></div>`,
    600,
  );
  return {
    subject: `[নতুন অর্ডার] ${money(o.totalAmount)} - ${o.customerName} (#${code})`,
    text: `New order ${code} from ${o.customerName} for ${money(o.totalAmount)}. Phone: ${o.customerPhone}`,
    html,
  };
}

/**
 * Order confirmation for the CUSTOMER (Module 10). Legacy had no equivalent - the only order e-mail it ever sent was the owner
 * notification above; this is a new, small addition, only sent when the order actually has an e-mail address (most guest
 * checkouts don't). Same escaping discipline as every other template here.
 */
export function renderCustomerOrderConfirmationEmail(o: OrderEmailInput) {
  const code = o.trackingCode || o.id;
  const items = o.items
    .map((i) => `<tr style="border-bottom:1px solid #14532d;"><td style="padding:10px 8px;color:#ffffff;font-size:13px;">${escapeHtml(i.name)}</td><td style="padding:10px 8px;text-align:center;color:#D4AF37;font-size:13px;">${escapeHtml(i.quantity)}x</td><td style="padding:10px 8px;text-align:right;color:#4ade80;font-size:13px;">${money(i.price * i.quantity)}</td></tr>`)
    .join('');
  const html = wrap(`
  <div style="background-color:#053324;padding:20px;border-radius:14px;border:1px solid #14532d;">
    <p style="color:#4ade80;margin:0 0 8px 0;font-size:12px;letter-spacing:2px;text-transform:uppercase;font-weight:bold;">✅ অর্ডার কনফার্মেশন</p>
    <p style="color:#cbd5e1;font-size:13px;line-height:1.6;margin:0 0 12px 0;">প্রিয় ${escapeHtml(o.customerName)}, আপনার অর্ডারটি সফলভাবে গ্রহণ করা হয়েছে। ধন্যবাদ Al Barakah Premium-এ অর্ডার করার জন্য।</p>
    <h3 style="color:#D4AF37;margin:2px 0 12px 0;font-size:15px;font-family:monospace;">#${escapeHtml(code)}</h3>
    <table style="width:100%;border-collapse:collapse;margin-bottom:14px;"><tbody>${items}</tbody></table>
    <table style="width:100%;font-size:13px;color:#cbd5e1;">
      <tr><td style="padding:4px 0;">সর্বমোট বিল:</td><td style="text-align:right;color:#D4AF37;font-weight:900;font-size:16px;">${money(o.totalAmount)}</td></tr>
      <tr><td style="padding:4px 0;">ডেলিভারি ঠিকানা:</td><td style="text-align:right;color:#ffffff;">${escapeHtml(o.deliveryAddress)}${o.cityDistrict ? ` (${escapeHtml(o.cityDistrict)})` : ''}</td></tr>
    </table>
  </div>`);
  return {
    subject: `[Al Barakah] আপনার অর্ডার #${code} নিশ্চিত হয়েছে`,
    text: `Your order #${code} for ${money(o.totalAmount)} has been received. Thank you for shopping with Al Barakah Premium.`,
    html,
  };
}
