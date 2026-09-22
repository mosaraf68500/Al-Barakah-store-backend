/**
 * Which delivery zone an order falls into (BACKEND_PLAN's intent has no explicit `zone` field - it is read from the free-text
 * `customer.city`, the same string the storefront checkout already writes there). Robustness fix (Module 5c): the match is
 * case-insensitive and trims whitespace; when the city can't be confidently classified, the zone defaults to `outside` (the
 * higher delivery fee - the safer default for the store) and `uncertain:true` is returned so the order can be flagged for an
 * admin to double-check, rather than silently guessing `inside` for an unrecognised address.
 */
export type DeliveryZone = 'inside' | 'outside';
export interface ZoneResult { zone: DeliveryZone; uncertain: boolean }

const OUTSIDE_RE = /outside/;
const INSIDE_RE = /inside/;
const DHAKA_ONLY_RE = /^dhaka(\s*city)?$/;

export function deriveZone(cityRaw: string | undefined | null): ZoneResult {
  const city = (cityRaw ?? '').trim().toLowerCase();
  if (OUTSIDE_RE.test(city)) return { zone: 'outside', uncertain: false };
  if (INSIDE_RE.test(city) || DHAKA_ONLY_RE.test(city)) return { zone: 'inside', uncertain: false };
  // blank, an actual district/area name, or anything else we don't recognise
  return { zone: 'outside', uncertain: true };
}
