import type { Request } from 'express';
import { ApiError } from '../../utils/ApiError';
import { decryptField, encryptField, isCurrentKey, looksMasked, maskSecret } from '../../utils/secretBox';
import { recordAudit } from '../audit/audit.service';
import { registerMediaUsageChecker } from '../media/media.service';
import type { UserDocument } from '../users/user.model';
import { DEFAULT_CONFIG, SECRET_PATHS, type SecretPath } from './settings.defaults';
import { SETTINGS_ID, SettingsModel } from './settings.model';
import { containsInlineImage, type UpdateSettingsInput } from './settings.validation';

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v);
const aad = (path: string) => `settings:${path}`;

export function getPath(o: Obj, path: string): unknown {
  return path.split('.').reduce<unknown>((acc, k) => (isObj(acc) ? acc[k] : undefined), o);
}
function setPath(o: Obj, path: string, value: unknown) {
  const keys = path.split('.');
  let cur = o;
  keys.slice(0, -1).forEach((k) => {
    if (!isObj(cur[k])) cur[k] = {};
    cur = cur[k] as Obj;
  });
  cur[keys[keys.length - 1]] = value;
}
function deletePath(o: Obj, path: string) {
  const keys = path.split('.');
  const parent = getPath(o, keys.slice(0, -1).join('.'));
  if (isObj(parent)) delete parent[keys[keys.length - 1]];
}
/** Objects merge recursively, arrays/primitives replace. */
function deepMerge(base: unknown, patch: unknown): unknown {
  if (!isObj(base) || !isObj(patch)) return patch;
  const out: Obj = { ...base };
  for (const [k, v] of Object.entries(patch)) out[k] = k in base ? deepMerge(base[k], v) : v;
  return out;
}
const withDefaults = (stored: Obj): Obj => deepMerge(structuredClone(DEFAULT_CONFIG), stored) as Obj;
const dbKey = (p: string) => p.replace(/\./g, '__'); // '.' is not allowed in Mongo field names

async function load(withSecrets: boolean) {
  const q = SettingsModel.findById(SETTINGS_ID);
  const doc = await (withSecrets ? q.select('+secrets') : q).lean();
  return { config: withDefaults((doc?.config as Obj) ?? {}), secrets: (doc?.secrets as Record<string, string>) ?? {}, version: doc?.version ?? 0, exists: !!doc };
}

/* ------------------------------------------------------------------ projections */

/** What ANY visitor may see. Explicit whitelist - a new config key is private until it is added here. */
export function toPublic(config: Obj) {
  const c = config as typeof DEFAULT_CONFIG;
  const { accessToken: _a, testEventCode: _t, ...fb } = c.facebookPixelConfig as Obj;
  const { gateway: _g, ...bkash } = c.bkashConfig as Obj;
  return {
    storeName: c.storeName,
    supportPhone: c.supportPhone,
    enableCustomerReviews: c.enableCustomerReviews,
    enableCoupons: c.enableCoupons,
    heroBanners: c.heroBanners ?? null,
    topSelling: c.topSelling ?? null,
    deliveryConfig: c.deliveryConfig,
    bkashConfig: bkash,
    seoConfig: c.seoConfig,
    facebookPixelConfig: fb,
  };
}

/** Full config for the admin app: non-secret fields as stored, every secret replaced by its mask (or '' when unset). */
export function toAdmin(config: Obj, secrets: Record<string, string>, version = 0) {
  const out = structuredClone(config);
  out.version = version;
  for (const p of SECRET_PATHS) {
    const env = secrets[dbKey(p)];
    setPath(out, p, env ? maskSecret(decryptField(env, aad(p))) : '');
  }
  return out;
}

export async function getPublicSettings() {
  return toPublic((await load(false)).config);
}
export async function getAdminSettings() {
  const { config, secrets, version } = await load(true);
  return toAdmin(config, secrets, version);
}
/** super_admin only: decrypted secrets in the same nested shape (audited by the caller). */
export async function getDecryptedSecrets(): Promise<Obj> {
  const { secrets } = await load(true);
  const out: Obj = {};
  for (const p of SECRET_PATHS) {
    const env = secrets[dbKey(p)];
    setPath(out, p, env ? decryptField(env, aad(p)) : '');
  }
  return out;
}
/** Server-side consumers (courier/notification adapters in later modules) read individual secrets through here. */
export async function getSecret(path: SecretPath): Promise<string | undefined> {
  const env = (await load(true)).secrets[dbKey(path)];
  return env ? decryptField(env, aad(path)) : undefined;
}

/* ---------------------------------------------------------------------- update */

export async function updateSettings(actor: UserDocument, input: UpdateSettingsInput, req: Request) {
  if (containsInlineImage(input)) throw ApiError.badRequest('INLINE_IMAGE_NOT_ALLOWED', 'Upload images to Cloudinary and store the URL - base64 images are not accepted');

  const { config, secrets, version } = await load(true);
  const { version: expectedVersion, ...rest } = input;
  if (expectedVersion !== version) throw new ApiError(409, 'VERSION_CONFLICT', 'Settings were changed by someone else. Reload and try again.', { currentVersion: version, yourVersion: expectedVersion });
  const patch = structuredClone(rest) as Obj;
  const changedSecrets: string[] = [];
  const clearedSecrets: string[] = [];
  const nextSecrets = { ...secrets };

  for (const p of SECRET_PATHS) {
    const v = getPath(patch, p);
    if (v === undefined) continue;
    deletePath(patch, p); // secrets never enter `config`
    if (typeof v !== 'string' || looksMasked(v)) continue; // "leave unchanged" (mask echoed back, or __keep__)
    const clean = v.trim();
    if (clean === '') {
      delete nextSecrets[dbKey(p)];
      clearedSecrets.push(p);
    } else {
      nextSecrets[dbKey(p)] = encryptField(clean, aad(p));
      changedSecrets.push(p);
    }
  }

  const nextConfig = deepMerge(config, patch) as Obj;
  const sections = Object.keys(patch);
  // Atomic compare-and-set: the filter pins the version, so two racing writers cannot both succeed.
  let saved;
  try {
    saved = await SettingsModel.findOneAndUpdate(
      { _id: SETTINGS_ID, version },
      { $set: { config: nextConfig, secrets: nextSecrets, updatedBy: actor._id }, $inc: { version: 1 } },
      { upsert: true, new: true },
    );
  } catch (e) {
    if ((e as { code?: number }).code !== 11000) throw e;
    saved = null; // filter did not match an existing document => someone else wrote first
  }
  if (!saved) throw new ApiError(409, 'VERSION_CONFLICT', 'Settings were changed by someone else. Reload and try again.', { currentVersion: (await load(false)).version, yourVersion: expectedVersion });
  await recordAudit({
    actor: { id: actor._id, email: actor.email, role: actor.role },
    action: 'settings.update',
    entity: 'Settings',
    entityId: SETTINGS_ID,
    details: { sections, credentialFieldsUpdated: changedSecrets, credentialFieldsCleared: clearedSecrets, version: version + 1 }, // field NAMES only, never values (key names avoid words the audit redactor treats as sensitive)
    req,
  });
  return toAdmin(nextConfig, nextSecrets, saved.version);
}

export async function auditSecretsRead(actor: UserDocument, req: Request) {
  await recordAudit({ actor: { id: actor._id, email: actor.email, role: actor.role }, action: 'settings.secrets.reveal', entity: 'Settings', entityId: SETTINGS_ID, req });
}

/** Key rotation: after adding the new key (and the old one to *_PREVIOUS) re-encrypt everything under the current key. */
export async function reencryptSecrets(opts: { dryRun?: boolean } = {}): Promise<{ reencrypted: number }> {
  const { secrets } = await load(true);
  let n = 0;
  const next: Record<string, string> = {};
  for (const p of SECRET_PATHS) {
    const env = secrets[dbKey(p)];
    if (!env) continue;
    if (isCurrentKey(env)) next[dbKey(p)] = env;
    else {
      next[dbKey(p)] = encryptField(decryptField(env, aad(p)), aad(p));
      n++;
    }
  }
  if (n && !opts.dryRun) await SettingsModel.updateOne({ _id: SETTINGS_ID }, { $set: { secrets: next } });
  return { reencrypted: n };
}

// A Cloudinary asset referenced by the settings (hero/promo/top-selling/OG image) cannot be deleted while it is in use.
registerMediaUsageChecker(async (m) => {
  const doc = await SettingsModel.findById(SETTINGS_ID).lean();
  const json = JSON.stringify(doc?.config ?? {});
  return json.includes(m.secureUrl) || json.includes(m.url) ? ['settings'] : [];
});
