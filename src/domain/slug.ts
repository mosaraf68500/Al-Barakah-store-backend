/** Same as the admin/storefront `generateSlug`: strips non-latin characters (so a Bengali-only name yields '' and callers fall back to the id - BUG_FIXES A14). */
export function generateSlug(text: string): string {
  return text.toLowerCase().trim().replace(/[^\w\s-]/g, '').replace(/[\s_-]+/g, '-').replace(/^-+|-+$/g, '');
}
