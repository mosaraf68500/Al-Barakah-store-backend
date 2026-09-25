/**
 * OpenAPI 3 document generated from the Zod schemas the routes already validate with.
 * Paths are listed here; request bodies are not hand-written JSON Schema.
 */
import { z } from 'zod';
import { registerSchema, loginSchema, googleLoginSchema, changePinSchema, updateProfileSchema, addressInput } from '../modules/auth/auth.validation';
import { adminLoginSchema, verifyOtpSchema, grantAccessSchema, setPasswordSchema } from '../modules/admin-auth/adminAuth.validation';
import { createOrderSchema } from '../modules/orders/order.validation';
import { createReviewSchema } from '../modules/reviews/review.validation';
import { validateBodySchema, couponInput } from '../modules/coupons/coupon.validation';
import { productInput } from '../modules/products/product.validation';
import { categoryInput } from '../modules/categories/category.validation';
import { updateSettingsSchema } from '../modules/settings/settings.validation';

export function zodToJsonSchema(schema: z.ZodTypeAny): Record<string, unknown> {
  if (schema instanceof z.ZodEffects) return zodToJsonSchema(schema.innerType());
  if (schema instanceof z.ZodOptional || schema instanceof z.ZodNullable) return zodToJsonSchema(schema.unwrap());
  if (schema instanceof z.ZodDefault) return zodToJsonSchema(schema.removeDefault());
  if (schema instanceof z.ZodObject) {
    const properties: Record<string, unknown> = {};
    const required: string[] = [];
    for (const [key, value] of Object.entries(schema.shape)) {
      const child = value as z.ZodTypeAny;
      properties[key] = zodToJsonSchema(child);
      if (!isSkippable(child)) required.push(key);
    }
    return { type: 'object', properties, ...(required.length ? { required } : {}) };
  }
  if (schema instanceof z.ZodArray) return { type: 'array', items: zodToJsonSchema(schema.element) };
  if (schema instanceof z.ZodEnum) return { type: 'string', enum: [...schema.options] };
  if (schema instanceof z.ZodString || schema instanceof z.ZodNumber || schema instanceof z.ZodBoolean) {
    return { type: schema instanceof z.ZodString ? 'string' : schema instanceof z.ZodNumber ? 'number' : 'boolean' };
  }
  if (schema instanceof z.ZodLiteral) return { const: schema.value };
  if (schema instanceof z.ZodUnion) return { anyOf: schema.options.map((option: z.ZodTypeAny) => zodToJsonSchema(option)) };
  return {};
}

function isSkippable(schema: z.ZodTypeAny): boolean {
  if (schema instanceof z.ZodOptional || schema instanceof z.ZodDefault) return true;
  if (schema instanceof z.ZodEffects) return isSkippable(schema.innerType());
  return false;
}

const jsonBody = (schema: z.ZodTypeAny) => ({
  required: true,
  content: { 'application/json': { schema: zodToJsonSchema(schema) } },
});

type Method = 'get' | 'post' | 'put' | 'patch' | 'delete';
interface Operation { method: Method; path: string; summary: string; auth: 'none' | 'customer' | 'admin' | 'super_admin' | 'cron'; body?: z.ZodTypeAny }

const OPERATIONS: Operation[] = [
  { method: 'get', path: '/health', summary: 'Process health', auth: 'none' },
  { method: 'get', path: '/products', summary: 'Public catalogue', auth: 'none' },
  { method: 'get', path: '/products/{key}', summary: 'Public product', auth: 'none' },
  { method: 'get', path: '/categories', summary: 'Public categories', auth: 'none' },
  { method: 'get', path: '/settings/public', summary: 'Public settings whitelist', auth: 'none' },
  { method: 'get', path: '/reviews', summary: 'Public reviews', auth: 'none' },
  { method: 'post', path: '/reviews', summary: 'Create a review', auth: 'customer', body: createReviewSchema },
  { method: 'post', path: '/coupons/validate', summary: 'Validate a coupon', auth: 'none', body: validateBodySchema },
  { method: 'post', path: '/orders', summary: 'Place an order', auth: 'customer', body: createOrderSchema },
  { method: 'get', path: '/orders/track/{code}', summary: 'Masked order tracking', auth: 'none' },
  { method: 'get', path: '/orders/my', summary: 'My orders', auth: 'customer' },
  { method: 'get', path: '/wishlist', summary: 'List wishlist', auth: 'customer' },
  { method: 'post', path: '/wishlist/{productId}', summary: 'Toggle wishlist', auth: 'customer' },
  { method: 'delete', path: '/wishlist/{productId}', summary: 'Remove wishlist item', auth: 'customer' },
  { method: 'post', path: '/auth/register', summary: 'Customer register', auth: 'none', body: registerSchema },
  { method: 'post', path: '/auth/login', summary: 'Customer login', auth: 'none', body: loginSchema },
  { method: 'post', path: '/auth/google', summary: 'Customer Google sign-in', auth: 'none', body: googleLoginSchema },
  { method: 'post', path: '/auth/change-pin', summary: 'Change PIN', auth: 'customer', body: changePinSchema },
  { method: 'get', path: '/auth/me', summary: 'Customer profile', auth: 'customer' },
  { method: 'patch', path: '/auth/me', summary: 'Update profile', auth: 'customer', body: updateProfileSchema },
  { method: 'get', path: '/auth/addresses', summary: 'Address book', auth: 'customer' },
  { method: 'post', path: '/auth/addresses', summary: 'Add address', auth: 'customer', body: addressInput },
  { method: 'post', path: '/admin-auth/login', summary: 'Admin password step', auth: 'none', body: adminLoginSchema },
  { method: 'post', path: '/admin-auth/verify-otp', summary: 'Admin OTP step', auth: 'none', body: verifyOtpSchema },
  { method: 'post', path: '/admin-auth/set-password', summary: 'Accept an invite', auth: 'none', body: setPasswordSchema },
  { method: 'post', path: '/admin-auth/grant-access', summary: 'Grant admin', auth: 'super_admin', body: grantAccessSchema },
  { method: 'get', path: '/admin/products', summary: 'Admin products', auth: 'admin' },
  { method: 'post', path: '/admin/products', summary: 'Create product', auth: 'admin', body: productInput },
  { method: 'get', path: '/admin/categories', summary: 'Admin categories', auth: 'admin' },
  { method: 'post', path: '/admin/categories', summary: 'Create category', auth: 'admin', body: categoryInput },
  { method: 'get', path: '/admin/coupons', summary: 'Admin coupons', auth: 'admin' },
  { method: 'post', path: '/admin/coupons', summary: 'Create coupon', auth: 'admin', body: couponInput },
  { method: 'get', path: '/admin/orders', summary: 'Admin orders', auth: 'admin' },
  { method: 'get', path: '/admin/reviews', summary: 'Admin reviews', auth: 'admin' },
  { method: 'get', path: '/admin/settings', summary: 'Admin settings (secrets masked)', auth: 'admin' },
  { method: 'patch', path: '/admin/settings', summary: 'Update settings', auth: 'admin', body: updateSettingsSchema },
  { method: 'get', path: '/admin/settings/secrets', summary: 'Decrypted secrets', auth: 'super_admin' },
  { method: 'get', path: '/admin/backup', summary: 'Download backup', auth: 'super_admin' },
  { method: 'post', path: '/admin/backup/restore', summary: 'Restore backup', auth: 'super_admin' },
  { method: 'get', path: '/admin/health', summary: 'Authenticated health', auth: 'admin' },
  { method: 'get', path: '/admin/staff', summary: 'Staff list', auth: 'super_admin' },
  { method: 'get', path: '/admin/audit', summary: 'Audit log', auth: 'super_admin' },
  { method: 'get', path: '/internal/cron/cleanup', summary: 'Cleanup cron', auth: 'cron' },
  { method: 'get', path: '/internal/cron/orders/expire-pending', summary: 'Expire pending orders', auth: 'cron' },
];

export function buildOpenApi() {
  const paths: Record<string, Record<string, unknown>> = {};
  for (const op of OPERATIONS) {
    const security = op.auth === 'none' ? [] : op.auth === 'cron' ? [{ cronBearer: [] }] : [{ bearer: [] }];
    paths[op.path] ??= {};
    paths[op.path][op.method] = {
      summary: op.summary,
      security,
      ...(op.body ? { requestBody: jsonBody(op.body) } : {}),
      responses: { '200': { description: 'Success' }, '400': { description: 'Validation error' }, '401': { description: 'Authentication required' }, '403': { description: 'Wrong role' } },
    };
  }
  return {
    openapi: '3.0.3',
    info: { title: 'Al Barakah Premium API', version: '0.1.0' },
    servers: [{ url: '/v1' }],
    components: {
      securitySchemes: {
        bearer: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
        cronBearer: { type: 'http', scheme: 'bearer' },
      },
    },
    paths,
  };
}
