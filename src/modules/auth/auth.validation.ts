import { z } from 'zod';

// Loose on purpose: the service turns problems into the specific error codes the storefront UI already switches on
// (INVALID_BD_PHONE, PIN_REQUIRED, PIN_TOO_SHORT, ...).
export const registerSchema = z.object({
  phone: z.string().max(40).default(''),
  name: z.string().trim().min(1, 'name required').max(120),
  pin: z.string().max(128).default(''),
  address: z.string().trim().max(1000).optional(),
  email: z.string().trim().toLowerCase().email().max(254).optional(),
});
export const loginSchema = z.object({ phone: z.string().max(40).default(''), pin: z.string().max(128).default('') });
export type RegisterInput = z.infer<typeof registerSchema>;
export type LoginInput = z.infer<typeof loginSchema>;
export const changePinSchema = z.object({ currentPin: z.string().max(128).default(''), newPin: z.string().max(128).default('') });

/** `PATCH /auth/me`: `phone` is the login identity (like legacy's e-mail) and is NOT editable here - only `name`/`email`/`avatarUrl`, the fields legacy's own profile form let a customer change. */
export const updateProfileSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  email: z.string().trim().toLowerCase().email().max(254).optional(),
  avatarUrl: z.string().trim().max(2000).optional(),
});
export type UpdateProfileInput = z.infer<typeof updateProfileSchema>;

/** Address book (BACKEND_PLAN §2.2 `addresses[] {id,label?,name,phone,address,district,isDefault}`) - the same light validation orders already use for these fields, not new rules. */
export const addressInput = z.object({
  label: z.string().trim().max(60).optional(),
  name: z.string().trim().min(1).max(200),
  phone: z.string().trim().max(40),
  address: z.string().trim().min(1).max(1000),
  district: z.string().trim().max(120).default(''),
  isDefault: z.boolean().default(false),
});
export type AddressInput = z.infer<typeof addressInput>;
export const addressPatch = addressInput.partial();
export type AddressPatch = z.infer<typeof addressPatch>;
