/**
 * Vercel Function entrypoint. vercel.json rewrites every path to /api, so Express sees the ORIGINAL url (/v1/...).
 * The handler is the same default export Vercel also loads from src/app.ts.
 */
export { default } from '../src/app';
