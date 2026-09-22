import { ApiError } from '../../utils/ApiError';
import { MediaModel } from './media.model';

export interface ImageRef { url: string; publicId: string }

/**
 * Turn image URLs sent by the apps into stored `{url, publicId}` references - but ONLY for images that exist in the Media collection
 * (i.e. were uploaded through the signed-upload flow). Unknown URLs are rejected, so a document can never point at an arbitrary host.
 * The API keeps speaking plain URL strings (`serializeImage`).
 */
export async function resolveImages(urls: string[]): Promise<Map<string, ImageRef>> {
  const unique = [...new Set(urls.filter(Boolean))];
  if (unique.length === 0) return new Map();
  const found = await MediaModel.find({ $or: [{ secureUrl: { $in: unique } }, { url: { $in: unique } }] }).lean();
  const map = new Map<string, ImageRef>();
  for (const m of found) {
    map.set(m.secureUrl, { url: m.secureUrl, publicId: m.publicId });
    map.set(m.url, { url: m.secureUrl, publicId: m.publicId });
  }
  const missing = unique.filter((u) => !map.has(u));
  if (missing.length) throw ApiError.badRequest('IMAGE_NOT_REGISTERED', 'Every image must be uploaded through the media upload flow first', { urls: missing });
  return map;
}

export const serializeImage = (i?: ImageRef | null): string => i?.url ?? '';
