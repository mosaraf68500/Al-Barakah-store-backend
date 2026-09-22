/** Same rule as the storefront's `lib/validation/phone.ts`: BD mobile 01[3-9]XXXXXXXX (accepts +880 / 880 prefixes). */
export function normalizeBdMobile(input: string): string | null {
  let digits = (input || '').replace(/\D/g, '');
  if (digits.startsWith('880')) digits = digits.slice(2);
  return /^01[3-9]\d{8}$/.test(digits) ? digits : null;
}
/** Last 10 digits - the key orders/users are matched on. */
export const phoneKey = (normalized: string) => normalized.slice(-10);
