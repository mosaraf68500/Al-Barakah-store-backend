import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    globalSetup: ['tests/globalSetup.ts'],
    setupFiles: ['tests/setup.ts'],
    include: ['tests/**/*.test.ts'],
    fileParallelism: false, // one shared in-memory MongoDB
    testTimeout: 30_000,
    hookTimeout: 120_000,
    env: {
      NODE_ENV: 'test',
      JWT_ACCESS_SECRET: 'test-access-secret-0123456789-0123456789-abc',
      JWT_REFRESH_SECRET: 'test-refresh-secret-0123456789-0123456789-xyz',
      SETTINGS_ENCRYPTION_KEY: '00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff',
      CLOUDINARY_CLOUD_NAME: 'test-cloud',
      CLOUDINARY_API_KEY: '123456789012345',
      CLOUDINARY_API_SECRET: 'test-cloudinary-api-secret-value',
      OTP_PEPPER: 'test-otp-pepper-0123456789-0123456789-pepper',
      CRON_SECRET: 'test-cron-secret-0123456789-0123456789-cron',
      BCRYPT_COST: '4',
      COOKIE_DOMAIN: '',
      CORS_ORIGINS: 'https://shop.test,https://admin.test',
      ADMIN_APP_URL: 'https://admin.test',
      MAIL_TRANSPORT: 'memory',
      SMTP_FROM: 'Al Barakah <no-reply@albarakah.test>',
      ORDER_NOTIFY_EMAILS: 'owner@albarakah.test',
      ENABLE_LIVE_INTEGRATIONS: 'false',
      GOOGLE_CLIENT_ID: 'test-google-client.apps.googleusercontent.com',
    },
  },
});
