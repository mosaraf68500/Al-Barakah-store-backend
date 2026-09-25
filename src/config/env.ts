import { z } from 'zod';

const bool = z.enum(['true', 'false']).default('false').transform((v) => v === 'true');
const emptyToUndef = (v: unknown) => (typeof v === 'string' && v.trim() === '' ? undefined : v);
const optStr = z.preprocess(emptyToUndef, z.string().optional());
const secret = (name: string) => z.string({ required_error: `${name} is required` }).min(32, `${name} must be at least 32 characters`);

/** 32-byte key from 64 hex chars or base64/base64url; null when invalid. */
export function decodeKey(v: string): Buffer | null {
  if (/^[a-f0-9]{64}$/i.test(v)) return Buffer.from(v, 'hex');
  try {
    const b = Buffer.from(v, 'base64url');
    return b.length === 32 ? b : null;
  } catch {
    return null;
  }
}

const schema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: z.coerce.number().int().positive().default(4000),
    MONGODB_URI: z.string().min(1, 'MONGODB_URI is required'),

    JWT_ACCESS_SECRET: secret('JWT_ACCESS_SECRET'),
    JWT_REFRESH_SECRET: secret('JWT_REFRESH_SECRET'),
    OTP_PEPPER: secret('OTP_PEPPER'),
    /** AES-256-GCM key for secrets stored in MongoDB (32 bytes: 64 hex chars or base64/base64url). */
    SETTINGS_ENCRYPTION_KEY: z.string({ required_error: 'SETTINGS_ENCRYPTION_KEY is required' }),
    /** Previous key(s), comma separated - only needed while rotating (old ciphertexts stay readable). */
    SETTINGS_ENCRYPTION_KEY_PREVIOUS: optStr,
    BCRYPT_COST: z.coerce.number().int().min(4).max(15).default(12),
    CUSTOMER_ACCESS_TTL_MIN: z.coerce.number().int().positive().default(15),
    ADMIN_IDLE_MIN: z.coerce.number().int().positive().default(10),
    ADMIN_SESSION_MAX_HOURS: z.coerce.number().int().positive().default(12),
    CUSTOMER_SESSION_MAX_DAYS: z.coerce.number().int().positive().default(30),

    COOKIE_DOMAIN: optStr,
    CORS_ORIGINS: z.string().default(''),
    ADMIN_APP_URL: z.string().url().default('http://localhost:3002'),
    TRUST_PROXY_HOPS: z.coerce.number().int().min(0).default(1),

    MAIL_TRANSPORT: z.enum(['smtp', 'memory']).default('smtp'),
    SMTP_HOST: optStr,
    SMTP_PORT: z.preprocess(emptyToUndef, z.coerce.number().int().positive().optional()),
    SMTP_SECURE: bool,
    SMTP_USER: optStr,
    SMTP_PASS: optStr,
    SMTP_FROM: optStr,
    ORDER_NOTIFY_EMAILS: z.string().default(''),

    CLOUDINARY_CLOUD_NAME: optStr,
    CLOUDINARY_API_KEY: optStr,
    CLOUDINARY_API_SECRET: optStr,

    STEADFAST_API_KEY: optStr,
    STEADFAST_SECRET_KEY: optStr,
    PATHAO_CLIENT_ID: optStr,
    PATHAO_CLIENT_SECRET: optStr,
    PATHAO_USERNAME: optStr,
    PATHAO_PASSWORD: optStr,
    PATHAO_STORE_ID: optStr,
    ENABLE_LIVE_INTEGRATIONS: bool,

    CRON_SECRET: secret('CRON_SECRET'),
    /** A `pending` order older than this is auto-expired by the cron and its reserved stock released (Module 5b). */
    PENDING_ORDER_TIMEOUT_HOURS: z.coerce.number().positive().default(24),

    SUPER_ADMIN_EMAIL: optStr,
    SUPER_ADMIN_PASSWORD: optStr,

    /** Public OAuth client id. Audience check for Google ID tokens. The client secret is not used. */
    GOOGLE_CLIENT_ID: z.string().min(1).default('947073184687-9303rtcuomi8it4t3nv0l6f75ndm3ofq.apps.googleusercontent.com'),
  })
  .superRefine((e, ctx) => {
    const keys = [e.SETTINGS_ENCRYPTION_KEY, ...(e.SETTINGS_ENCRYPTION_KEY_PREVIOUS ? e.SETTINGS_ENCRYPTION_KEY_PREVIOUS.split(',') : [])];
    keys.forEach((k, i) => {
      if (!decodeKey(k.trim())) ctx.addIssue({ code: 'custom', path: [i === 0 ? 'SETTINGS_ENCRYPTION_KEY' : 'SETTINGS_ENCRYPTION_KEY_PREVIOUS'], message: 'encryption key must decode to exactly 32 bytes (64 hex chars or base64)' });
    });
    const distinct = new Set([e.JWT_ACCESS_SECRET, e.JWT_REFRESH_SECRET, e.OTP_PEPPER, e.CRON_SECRET]);
    if (distinct.size !== 4) ctx.addIssue({ code: 'custom', message: 'JWT_ACCESS_SECRET, JWT_REFRESH_SECRET, OTP_PEPPER and CRON_SECRET must all be different' });
    if (e.NODE_ENV === 'production') {
      if (e.NODE_ENV === 'production' && !e.CLOUDINARY_CLOUD_NAME) ctx.addIssue({ code: 'custom', path: ['CLOUDINARY_CLOUD_NAME'], message: 'Cloudinary credentials are required in production' });
      if (e.BCRYPT_COST < 12) ctx.addIssue({ code: 'custom', path: ['BCRYPT_COST'], message: 'BCRYPT_COST must be >= 12 in production' });
      if (e.MAIL_TRANSPORT === 'memory') ctx.addIssue({ code: 'custom', path: ['MAIL_TRANSPORT'], message: 'MAIL_TRANSPORT=memory is not allowed in production' });
      if (!e.CORS_ORIGINS.trim()) ctx.addIssue({ code: 'custom', path: ['CORS_ORIGINS'], message: 'CORS_ORIGINS is required in production' });
    }
    if (e.MAIL_TRANSPORT === 'smtp' && e.NODE_ENV !== 'test') {
      for (const k of ['SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASS', 'SMTP_FROM'] as const) {
        if (!e[k]) ctx.addIssue({ code: 'custom', path: [k], message: `${k} is required when MAIL_TRANSPORT=smtp` });
      }
    }
  });

export type Env = z.infer<typeof schema> & { corsOrigins: string[]; orderNotifyEmails: string[]; settingsKeys: Buffer[] };

export function parseEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = schema.safeParse(source);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  - ${i.path.join('.') || 'env'}: ${i.message}`);
    throw new Error(`Invalid environment configuration:\n${lines.join('\n')}`);
  }
  const list = (s: string) => s.split(',').map((x) => x.trim()).filter(Boolean);
  const keyList = [parsed.data.SETTINGS_ENCRYPTION_KEY, ...list(parsed.data.SETTINGS_ENCRYPTION_KEY_PREVIOUS ?? '')].map((k) => decodeKey(k.trim())!);
  return { ...parsed.data, corsOrigins: list(parsed.data.CORS_ORIGINS), orderNotifyEmails: list(parsed.data.ORDER_NOTIFY_EMAILS), settingsKeys: keyList };
}

let cached: Env | undefined;
/** Validated once, on first use (fail-fast: a bad deployment never serves a request). */
export function getEnv(): Env {
  return (cached ??= parseEnv());
}
export const resetEnvCacheForTests = () => {
  cached = undefined;
};
