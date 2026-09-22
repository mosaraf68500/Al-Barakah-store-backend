import { z } from 'zod';

const email = z.string().trim().toLowerCase().email().max(254);
export const adminPassword = z.string().min(12, 'password must be at least 12 characters').max(128);

export const adminLoginSchema = z.object({ email, password: z.string().min(1).max(128) });
export const verifyOtpSchema = z.object({ email, code: z.string().regex(/^\d{6}$/, 'code must be 6 digits') });
export const resendOtpSchema = z.object({ email });
export const grantAccessSchema = z.object({ name: z.string().trim().min(1).max(120), email });
export const revokeAccessSchema = z.object({ userId: z.string().regex(/^[a-f0-9]{24}$/i, 'invalid user id') });
export const setPasswordSchema = z.object({ token: z.string().min(20).max(200), password: adminPassword });
