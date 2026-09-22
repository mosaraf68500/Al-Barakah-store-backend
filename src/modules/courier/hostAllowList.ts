/**
 * Host allow-list for courier base URLs (SECURITY_RISKS #18/#25, closed in Module 11). Settings validation already required
 * `https://`, but an admin (or a compromised admin session) could still point `baseUrl` at an arbitrary host - which would then
 * receive the courier API key/secret in a header and the customer's name/phone/address in the body on every dispatch. These are
 * the ONLY hosts referenced anywhere in this codebase (legacy `server/routes/api.ts`, `al-barakah-admin`'s defaults, this
 * backend's `settings.defaults.ts`) - there is no evidence of a documented sandbox host for either provider to also allow.
 */
import { ApiError } from '../../utils/ApiError';

export const COURIER_ALLOWED_HOSTS: Record<'steadfast' | 'pathao', readonly string[]> = {
  steadfast: ['portal.steadfast.com.bd'],
  pathao: ['api-hermes.pathao.com'],
};

const hostnameOf = (url: string): string | null => {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
};

export function isAllowedCourierHost(provider: 'steadfast' | 'pathao', url: string): boolean {
  const host = hostnameOf(url);
  return host !== null && COURIER_ALLOWED_HOSTS[provider].includes(host);
}

/** Defence in depth: enforced again here even though `settings.validation.ts` already refuses to SAVE a disallowed host,
 * in case a row was written before this fix or by a direct DB edit. */
export function assertAllowedCourierHost(provider: 'steadfast' | 'pathao', url: string): void {
  if (!isAllowedCourierHost(provider, url)) {
    throw new ApiError(502, 'COURIER_HOST_NOT_ALLOWED', `${provider} base URL is not on the approved host list`, { provider, host: hostnameOf(url) ?? url, allowed: COURIER_ALLOWED_HOSTS[provider] });
  }
}
