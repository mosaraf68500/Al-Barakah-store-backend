const MAP: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;', '`': '&#96;' };

/** Escape every user-controlled value before it is interpolated into HTML (SECURITY_RISKS #21). */
export const escapeHtml = (v: unknown): string => String(v ?? '').replace(/[&<>"'`]/g, (c) => MAP[c]);

/** For `tel:` hrefs: keep only digits and a leading plus. */
export const safePhoneHref = (v: unknown): string => String(v ?? '').replace(/[^\d+]/g, '');

/** Header values (e.g. mail subject): strip CR/LF and control characters, cap length. */
export const safeHeader = (v: unknown, max = 200): string => String(v ?? '').replace(/[\r\n\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, max);
