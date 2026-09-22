import type { Request } from 'express';
import { Types } from 'mongoose';
import { ApiError } from '../../utils/ApiError';
import { safeEqual } from '../../utils/crypto';
import { logger } from '../../utils/logger';
import { recordAudit } from '../audit/audit.service';
import type { UserDocument } from '../users/user.model';
import { getCloudinary } from './cloudinary.client';
import { MediaModel, type MediaDoc } from './media.model';
import { MEDIA_FOLDERS, ROOT_FOLDER } from './media.validation';

const ALLOWED_FORMATS = 'jpg,jpeg,png,webp,avif';

export const toMedia = (m: MediaDoc) => ({
  id: String(m._id), publicId: m.publicId, url: m.url, secureUrl: m.secureUrl, resourceType: m.resourceType, format: m.format,
  bytes: m.bytes, width: m.width, height: m.height, folder: m.folder, createdAt: m.createdAt.toISOString(),
});

/**
 * Step 1 of the signed-upload flow. The browser uploads DIRECTLY to Cloudinary with these parameters; every parameter it may
 * use (folder, allowed formats, timestamp) is part of the signature, so it cannot upload elsewhere or bypass the format allow-list.
 */
export function createUploadSignature(folder: (typeof MEDIA_FOLDERS)[number]) {
  const c = getCloudinary();
  const timestamp = Math.floor(Date.now() / 1000);
  const params = { allowed_formats: ALLOWED_FORMATS, folder: `${ROOT_FOLDER}/${folder}`, timestamp };
  return {
    cloudName: c.cloudName(),
    apiKey: c.apiKey(),
    uploadUrl: `https://api.cloudinary.com/v1_1/${c.cloudName()}/image/upload`,
    timestamp,
    folder: params.folder,
    allowedFormats: ALLOWED_FORMATS,
    signature: c.sign(params),
  };
}

/**
 * Step 2: after the browser finished uploading, it sends Cloudinary's response fields back. The upload response carries its own
 * signature (SHA-1 of `public_id` + `version` + API secret) - verifying it proves this asset was created through OUR signed upload,
 * so nobody can register an arbitrary URL/public_id in the Media collection.
 */
export async function registerMedia(actor: UserDocument, input: import('zod').infer<typeof import('./media.validation').registerSchema>, req: Request) {
  const c = getCloudinary();
  const expected = c.sign({ public_id: input.publicId, version: input.version });
  if (!safeEqual(expected.toLowerCase(), input.signature.toLowerCase())) throw ApiError.badRequest('INVALID_UPLOAD_SIGNATURE');
  if (!input.publicId.startsWith(`${ROOT_FOLDER}/`)) throw ApiError.badRequest('INVALID_PUBLIC_ID');
  const folder = input.publicId.split('/')[1];
  if (!(MEDIA_FOLDERS as readonly string[]).includes(folder)) throw ApiError.badRequest('INVALID_PUBLIC_ID');
  const host = `https://res.cloudinary.com/${c.cloudName()}/`;
  if (!input.secureUrl.startsWith(host) || !input.secureUrl.includes(input.publicId)) throw ApiError.badRequest('INVALID_MEDIA_URL');

  const doc = await MediaModel.findOneAndUpdate(
    { publicId: input.publicId },
    { $setOnInsert: { uploadedBy: actor._id }, $set: { url: input.url ?? input.secureUrl.replace(/^https:/, 'http:'), secureUrl: input.secureUrl, resourceType: input.resourceType, format: input.format, bytes: input.bytes, width: input.width, height: input.height, folder } },
    { upsert: true, new: true },
  );
  await recordAudit({ actor: { id: actor._id, email: actor.email, role: actor.role }, action: 'media.register', entity: 'Media', entityId: String(doc._id), details: { publicId: input.publicId, bytes: input.bytes }, req });
  return toMedia(doc);
}

export async function listMedia(q: { folder?: string; limit: number }) {
  const docs = await MediaModel.find(q.folder ? { folder: q.folder } : {}).sort({ createdAt: -1 }).limit(q.limit).lean();
  return docs.map(toMedia);
}

/** Modules that store media URLs register a checker so a delete cannot leave dangling references. */
type UsageChecker = (m: Pick<MediaDoc, 'secureUrl' | 'url' | 'publicId'>) => Promise<string[]>;
const usageCheckers: UsageChecker[] = [];
export const registerMediaUsageChecker = (fn: UsageChecker) => void usageCheckers.push(fn);

/**
 * Delete from Cloudinary AND the Media collection. Refused (409) while something still references the asset. If Cloudinary fails,
 * the Media row is kept (no orphaned asset without a record); if Cloudinary says "not found" the row is removed (already gone).
 */
export async function deleteMedia(actor: UserDocument, id: string, req: Request) {
  const media = Types.ObjectId.isValid(id) ? await MediaModel.findById(id) : null;
  if (!media) throw ApiError.notFound('MEDIA_NOT_FOUND');

  const usedBy = (await Promise.all(usageCheckers.map((f) => f(media)))).flat();
  if (usedBy.length) throw new ApiError(409, 'MEDIA_IN_USE', 'This image is still used and cannot be deleted', { usedBy });

  let result: string;
  try {
    result = await getCloudinary().destroy(media.publicId, media.resourceType);
  } catch (err) {
    logger.warn({ publicId: media.publicId, reason: (err as Error).message }, 'cloudinary destroy failed');
    throw new ApiError(502, 'MEDIA_PROVIDER_ERROR', 'Could not delete the image from Cloudinary; nothing was changed');
  }
  if (result !== 'ok' && result !== 'not found') throw new ApiError(502, 'MEDIA_PROVIDER_ERROR', `Cloudinary refused the deletion (${result}); nothing was changed`);

  await MediaModel.deleteOne({ _id: media._id });
  await recordAudit({ actor: { id: actor._id, email: actor.email, role: actor.role }, action: 'media.delete', entity: 'Media', entityId: id, details: { publicId: media.publicId, cloudinary: result }, req });
}
