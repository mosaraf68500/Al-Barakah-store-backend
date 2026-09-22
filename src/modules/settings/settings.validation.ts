import { z } from 'zod';

const str = (max = 500) => z.string().max(max);
const httpsUrl = z.string().max(500).refine((u) => { try { return new URL(u).protocol === 'https:'; } catch { return false; } }, 'must be an https:// URL');
/** Images must be hosted URLs (Cloudinary) - base64 data URLs are rejected everywhere (see refuseInlineImages). */
const imageRef = z.string().max(1000).refine((v) => v === '' || /^https?:\/\//i.test(v), 'image must be an http(s) URL');

const deliveryConfig = z.object({
  insideDhakaCharge: z.number().min(0).max(100000),
  outsideDhakaCharge: z.number().min(0).max(100000),
  subDhakaCharge: z.number().min(0).max(100000),
  enableSubDhaka: z.boolean(),
  freeDeliveryThreshold: z.number().min(0).max(10_000_000),
  enableFreeDelivery: z.boolean(),
  estimatedInsideDhakaDays: str(100),
  estimatedOutsideDhakaDays: str(100),
  deliveryNotice: str(1000),
  requireAdvanceDeliveryCharge: z.boolean(),
  advanceDeliveryNotice: str(1000),
}).partial();

const bkashConfig = z.object({
  enabled: z.boolean(),
  mode: z.enum(['MANUAL', 'GATEWAY']),
  personalNumber: str(40),
  accountType: z.enum(['Personal', 'Agent', 'Merchant']),
  manualInstructions: str(3000),
  requireTrxId: z.boolean(),
  gateway: z.object({ isSandbox: z.boolean(), autoCapture: z.boolean(), callbackUrl: str(500), appKey: str(300), appSecret: str(300), username: str(300), password: str(300) }).partial(),
}).partial();

const seoConfig = z.object({
  metaTitle: str(200), metaDescription: str(500), ogImage: imageRef, keywords: str(1000), siteName: str(200), canonicalUrl: str(300), twitterHandle: str(100),
}).partial();

const facebookPixelConfig = z.object({
  pixelId: str(64), accessToken: str(600), testEventCode: str(64), domainVerificationCode: str(500), enabled: z.boolean(), enableCapi: z.boolean(),
  trackPageView: z.boolean(), trackViewContent: z.boolean(), trackAddToCart: z.boolean(), trackInitiateCheckout: z.boolean(), trackPurchase: z.boolean(), customCurrency: str(8),
}).partial();

const courierConfig = z.object({
  steadfast: z.object({ enabled: z.boolean(), baseUrl: httpsUrl, apiKey: str(300), secretKey: str(300) }).partial(),
  pathao: z.object({ enabled: z.boolean(), baseUrl: httpsUrl, storeId: str(64), clientId: str(300), clientSecret: str(300), username: str(300), password: str(300) }).partial(),
  defaultCourier: z.enum(['steadfast', 'pathao', 'manual']),
  autoSendOnConfirm: z.boolean(),
}).partial();

const notificationConfig = z.object({
  soundEnabled: z.boolean(), soundType: z.enum(['cash', 'chime', 'bell']), browserPushEnabled: z.boolean(),
  telegram: z.object({ enabled: z.boolean(), botToken: str(300), chatId: str(100) }).partial(),
}).partial();

const target = z.object({ targetType: z.enum(['category', 'product', 'all']), targetValue: str(300) });
const heroBanners = z.object({
  slides: z.array(z.object({ id: str(100), badge: str(100).optional(), title: str(300), subtitle: str(500).optional(), ctaText: str(100).optional(), image: imageRef, enabled: z.boolean(), order: z.number().optional() }).merge(target)).max(20),
  promoCard: z.object({ id: str(100), badge: str(100).optional(), title: str(300), subtitle: str(500).optional(), ctaText: str(100).optional(), image: imageRef, enabled: z.boolean() }).merge(target),
});
const topSelling = z.object({
  enabled: z.boolean(), title: str(200), subtitle: str(500).optional(), productIds: z.array(str(100)).max(50).optional(),
  items: z.array(z.object({
    id: str(100), productId: str(100).optional(), name: str(300), price: z.number().min(0), originalPrice: z.number().min(0).optional(), image: imageRef,
    badge: str(100).optional(), badgeText: str(100).optional(), badgeBgColor: str(40).optional(), badgeTextColor: str(40).optional(),
    overridePrice: z.number().min(0).optional(), overrideOriginalPrice: z.number().min(0).optional(), overrideWeight: str(100).optional(), enabled: z.boolean().optional(), order: z.number().optional(),
  })).max(50),
});

/** PATCH body for /v1/admin/settings (every section optional; unknown keys are stripped). Secret fields live inside their section. */
/** `version` (from the last GET) is REQUIRED: the write only succeeds if nobody changed the settings in between. */
export const updateSettingsSchema = z.object({
  storeName: str(200), supportPhone: str(40), enableCustomerReviews: z.boolean(), enableCoupons: z.boolean(),
  heroBanners: heroBanners.nullable(), topSelling: topSelling.nullable(),
  deliveryConfig, bkashConfig, seoConfig, facebookPixelConfig, courierConfig, notificationConfig,
}).partial().extend({ version: z.number().int().min(0) });
export type UpdateSettingsInput = z.infer<typeof updateSettingsSchema>;

export const containsInlineImage = (v: unknown): boolean =>
  typeof v === 'string' ? /^data:image\//i.test(v.trim()) : Array.isArray(v) ? v.some(containsInlineImage) : v && typeof v === 'object' ? Object.values(v).some(containsInlineImage) : false;
