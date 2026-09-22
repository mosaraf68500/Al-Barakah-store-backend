import { z } from 'zod';

// Loose on purpose: the service turns problems into the specific error codes the storefront UI already switches on
// (INVALID_BD_PHONE, PIN_REQUIRED, PIN_TOO_SHORT, ...).
export const registerSchema = z.object({
  phone: z.string().max(40).default(''),
  name: z.string().trim().min(1, 'name required').max(120),
  pin: z.string().max(40).default(''),
  address: z.string().trim().max(1000).optional(),
  email: z.string().trim().toLowerCase().email().max(254).optional(),
});
export const loginSchema = z.object({ phone: z.string().max(40).default(''), pin: z.string().max(40).default('') });
export type RegisterInput = z.infer<typeof registerSchema>;
export type LoginInput = z.infer<typeof loginSchema>;
export const changePinSchema = z.object({ currentPin: z.string().max(40).default(''), newPin: z.string().max(40).default('') });
