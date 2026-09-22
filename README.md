# al-barakah-backend

Express + TypeScript + MongoDB (Mongoose), deployed as **Vercel Functions**. Status: **Modules 1–8 of Phase 3** — scaffold, config, DB, errors/logging, customer `auth`, `admin-auth`, audit, DB-backed rate limiting, fixed mailer, encrypted `settings` (optimistic locking), Cloudinary `media`, `categories`, `products`, `coupons`, order pricing engine + atomic stock (5a), order creation + tracking + `/my` (5b), admin order ops incl. dispatch/payment-verify + lazy stock-hold expiry (5c), `reviews` (login-required, atomic rating aggregate both ways) (6), full customer profile/address book + order notifications (owner+customer e-mail, Telegram, Facebook CAPI - simulated unless ENABLE_LIVE_INTEGRATIONS) (7), real Steadfast/Pathao courier adapters + host allow-list + auto-dispatch-on-confirm (8), `POST /v1/auth/change-pin`. See `../BACKEND_PLAN.md` and `../MODULE_1_REPORT.md`, `../MODULE_2_REPORT.md`, `../MODULE_3_REPORT.md`, `../MODULE_4_REPORT.md`, `../MODULE_5A_REPORT.md`, `../MODULE_5B_REPORT.md`, `../MODULE_5C_REPORT.md`, `../MODULE_6_REPORT.md`, `../MODULE_7_REPORT.md`, `../MODULE_8_REPORT.md`. Full module checklist: `../STATUS.md`.

```bash
npm install
cp .env.example .env        # fill in real values locally; never commit .env
npm run dev                 # http://localhost:4000/v1/health
npm test                    # Vitest + in-memory MongoDB (downloads a mongod binary on first run)
npm run seed:super-admin    # first super_admin from SUPER_ADMIN_EMAIL / SUPER_ADMIN_PASSWORD
```

## Vercel
`api/index.ts` exports the Express app; `vercel.json` rewrites every path to it (Express keeps the original `/v1/...` URL) and registers the daily cron `GET /v1/internal/cron/cleanup` (protected by `CRON_SECRET`). The MongoDB connection is cached on `globalThis` (`src/config/db.ts`); there are no in-process timers.

## Conventions
Raw JSON responses; errors are `{ "error": "CODE", "message"?, "details"? }`. Base path `/v1`. Refresh tokens live only in httpOnly cookies (Path-scoped, `Domain=.<parent>`), access tokens are returned in the body and kept **in memory** by the apps. Cookie endpoints (`/auth/refresh|logout`, `/admin-auth/refresh|logout`) require the `X-Abp-Client` header and an allow-listed `Origin`.

## Rotating the settings encryption key
```
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"        # new key
OLD_SETTINGS_ENCRYPTION_KEY=<old> SETTINGS_ENCRYPTION_KEY=<new> npm run rotate-settings-key -- --dry-run   # counts only
OLD_SETTINGS_ENCRYPTION_KEY=<old> SETTINGS_ENCRYPTION_KEY=<new> npm run rotate-settings-key
```
Then deploy the new `SETTINGS_ENCRYPTION_KEY` and discard the old key. Idempotent (a second run reports 0); no secret is printed.
(`SETTINGS_ENCRYPTION_KEY_PREVIOUS` may be used instead of `OLD_SETTINGS_ENCRYPTION_KEY`.)
