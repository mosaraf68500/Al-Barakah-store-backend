import { v2 as cloudinary } from 'cloudinary';
import { getEnv } from '../../config/env';
import { ApiError } from '../../utils/ApiError';

/** Thin adapter around the Cloudinary SDK so the service (and the tests) never touch the network/SDK directly. */
export interface CloudinaryAdapter {
  cloudName(): string;
  apiKey(): string;
  /** SHA-1 signature over the sorted params + API secret (Cloudinary's signed-upload scheme). */
  sign(params: Record<string, string | number>): string;
  destroy(publicId: string, resourceType: string): Promise<'ok' | 'not found' | string>;
}

function configured() {
  const e = getEnv();
  if (!e.CLOUDINARY_CLOUD_NAME || !e.CLOUDINARY_API_KEY || !e.CLOUDINARY_API_SECRET) throw new ApiError(503, 'MEDIA_NOT_CONFIGURED', 'Cloudinary is not configured');
  return { cloud_name: e.CLOUDINARY_CLOUD_NAME, api_key: e.CLOUDINARY_API_KEY, api_secret: e.CLOUDINARY_API_SECRET };
}

const real: CloudinaryAdapter = {
  cloudName: () => configured().cloud_name,
  apiKey: () => configured().api_key,
  sign: (params) => {
    const c = configured();
    return cloudinary.utils.api_sign_request(params, c.api_secret);
  },
  async destroy(publicId, resourceType) {
    cloudinary.config({ ...configured(), secure: true });
    const r = await cloudinary.uploader.destroy(publicId, { resource_type: resourceType, invalidate: true });
    return r.result as string;
  },
};

let override: CloudinaryAdapter | undefined;
export const __setCloudinaryForTests = (a?: CloudinaryAdapter) => {
  override = a;
};
export const getCloudinary = (): CloudinaryAdapter => override ?? real;
