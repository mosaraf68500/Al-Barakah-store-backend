/**
 * Import the Firestore seed snapshot into MongoDB.
 *   npm run import:seed -- --dry-run
 *   npm run import:seed
 *   npm run import:seed -- --force
 *   npm run import:seed -- --dir /path/to/data/seed
 *
 * --dry-run validates and reports counts. It does not upload images or write documents.
 * An existing document with the same _id is skipped unless --force is set.
 * Image bytes are content-addressed, so a re-run does not upload the same file twice.
 */
import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { v2 as cloudinary } from 'cloudinary';
import { connectDb, disconnectDb } from '../src/config/db';
import { getEnv } from '../src/config/env';
import { SeedImportError, runImport, type ImageUploader, type PlannedImage, type SeedFiles } from '../src/modules/seedImport/importSeed';

function readJson(dir: string, name: string): unknown {
  const file = path.join(dir, name);
  if (!fs.existsSync(file)) throw new Error(`Missing ${file}`);
  return JSON.parse(fs.readFileSync(file, 'utf8')) as unknown;
}

function loadSeed(dir: string): SeedFiles {
  return {
    products: readJson(dir, 'products.json'),
    categories: readJson(dir, 'categories.json'),
    orders: readJson(dir, 'orders.json'),
    reviews: readJson(dir, 'reviews.json'),
    settings: readJson(dir, 'settings.json'),
  };
}

const uploadToCloudinary: ImageUploader = async (image: PlannedImage) => {
  const env = getEnv();
  if (!env.CLOUDINARY_CLOUD_NAME || !env.CLOUDINARY_API_KEY || !env.CLOUDINARY_API_SECRET) {
    throw new Error('Cloudinary is not configured (CLOUDINARY_CLOUD_NAME / API_KEY / API_SECRET)');
  }
  cloudinary.config({ cloud_name: env.CLOUDINARY_CLOUD_NAME, api_key: env.CLOUDINARY_API_KEY, api_secret: env.CLOUDINARY_API_SECRET, secure: true });
  type Asset = { secure_url?: string; url?: string; format?: string; bytes?: number; width?: number; height?: number };
  let asset: Asset;
  try {
    asset = (await cloudinary.uploader.upload(image.dataUrl, {
      public_id: image.publicId,
      overwrite: false,
      resource_type: 'image',
      unique_filename: false,
    })) as Asset;
  } catch (err) {
    const e = err as { message?: string; http_code?: number };
    const message = e.message ?? 'unknown error';
    if ((e.http_code === 400 || e.http_code === 409) && /already exists/i.test(message)) {
      asset = (await cloudinary.api.resource(image.publicId, { resource_type: 'image' })) as Asset;
    } else {
      throw new Error(`Cloudinary upload failed for ${image.publicId}: ${message}`);
    }
  }
  if (!asset.secure_url) throw new Error(`Cloudinary returned no URL for ${image.publicId}`);
  return { secureUrl: asset.secure_url, url: asset.url, format: asset.format, bytes: asset.bytes, width: asset.width, height: asset.height };
};

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const force = args.includes('--force');
  const dirFlag = args.indexOf('--dir');
  const dir = dirFlag >= 0 ? args[dirFlag + 1] : path.resolve(__dirname, '../../al-barakah-frontend/data/seed');
  if (!dir) throw new Error('--dir needs a path');
  const files = loadSeed(dir);
  await connectDb();
  const report = await runImport(files, { dryRun, force, uploader: dryRun ? undefined : uploadToCloudinary });
  console.log(JSON.stringify({ source: dir, ...report }, null, 2));
}

if (require.main === module) {
  main()
    .catch((e) => {
      if (e instanceof SeedImportError) {
        console.error(e.problems.join('\n'));
      } else {
        console.error(e instanceof Error ? e.message : e);
      }
      process.exitCode = 1;
    })
    .finally(() => disconnectDb());
}
