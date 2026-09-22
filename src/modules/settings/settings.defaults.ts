/** Defaults copied from the apps' `types/index.ts` (DEFAULT_*), so a fresh database behaves like the current UI defaults. */
export const SECRET_PATHS = [
  'bkashConfig.gateway.appKey',
  'bkashConfig.gateway.appSecret',
  'bkashConfig.gateway.username',
  'bkashConfig.gateway.password',
  'courierConfig.steadfast.apiKey',
  'courierConfig.steadfast.secretKey',
  'courierConfig.pathao.clientId',
  'courierConfig.pathao.clientSecret',
  'courierConfig.pathao.username',
  'courierConfig.pathao.password',
  'facebookPixelConfig.accessToken',
  'notificationConfig.telegram.botToken',
  'notificationConfig.telegram.chatId',
] as const;
export type SecretPath = (typeof SECRET_PATHS)[number];

export const DEFAULT_CONFIG = {
  storeName: 'Al Barakah Premium',
  supportPhone: '',
  enableCustomerReviews: true,
  enableCoupons: false,
  heroBanners: null as unknown,
  topSelling: null as unknown,
  deliveryConfig: {
    insideDhakaCharge: 80,
    outsideDhakaCharge: 160,
    subDhakaCharge: 100,
    enableSubDhaka: false,
    freeDeliveryThreshold: 2000,
    enableFreeDelivery: false,
    estimatedInsideDhakaDays: '১-২ কার্যদিবস',
    estimatedOutsideDhakaDays: '২-৪ কার্যদিবস',
    deliveryNotice: 'সারা বাংলাদেশে ক্যাশ অন ডেলিভারি সুবিধা রয়েছে।',
    requireAdvanceDeliveryCharge: true,
    advanceDeliveryNotice: 'ফেক অর্ডার ও রিটার্ন রোধে শুধুমাত্র ডেলিভারি চার্জ অগ্রিম বিকাশ করতে হবে। বাকি পণ্যের মূল্য পার্সেল হাতে পেয়ে পরিশোধ করবেন।',
  },
  bkashConfig: {
    enabled: true,
    mode: 'MANUAL',
    personalNumber: '01316534171',
    accountType: 'Personal',
    manualInstructions:
      'আপনার বিকাশ অ্যাপ বা ইউএসএসডি কোড *247# ডায়াল করে Send Money অপশনে গিয়ে উপরের নাম্বারে মোট বিল পাঠান। এরপর নিচে আপনার বিকাশ নাম্বার ও ট্রানজেকশন আইডি (TrxID) দিয়ে অর্ডার সম্পূর্ণ করুন।',
    requireTrxId: true,
    gateway: { isSandbox: true, autoCapture: true, callbackUrl: '' },
  },
  seoConfig: {
    metaTitle: 'Al Barakah Premium — Luxury Islamic Lifestyle & Organic Products',
    metaDescription:
      'An elegant, premium eCommerce platform for Al Barakah Premium in Bangladesh, featuring pure organic honey, extra virgin mustard oil, luxury attars, sunnah items, and premium lifestyle.',
    ogImage: 'https://images.unsplash.com/photo-1546548970-71785318a17b?auto=format&fit=crop&q=80&w=1200',
    keywords: 'Al Barakah Premium, Organic Mustard Oil, Pure Honey, Kalo Jeera Oil, Luxury Attar, Islamic Lifestyle, Bangladesh Organic Food',
    siteName: 'Al Barakah Premium',
    canonicalUrl: 'https://albarakahpremium.com',
    twitterHandle: '@albarakahpremium',
  },
  facebookPixelConfig: {
    pixelId: '', testEventCode: '', domainVerificationCode: '', enabled: true, enableCapi: false,
    trackPageView: true, trackViewContent: true, trackAddToCart: true, trackInitiateCheckout: true, trackPurchase: true, customCurrency: 'BDT',
  },
  courierConfig: {
    steadfast: { enabled: false, baseUrl: 'https://portal.steadfast.com.bd' },
    pathao: { enabled: false, baseUrl: 'https://api-hermes.pathao.com', storeId: '' },
    defaultCourier: 'steadfast',
    autoSendOnConfirm: false,
  },
  notificationConfig: { soundEnabled: true, soundType: 'cash', browserPushEnabled: true, telegram: { enabled: false } },
};
export type SettingsConfig = typeof DEFAULT_CONFIG & Record<string, unknown>;
