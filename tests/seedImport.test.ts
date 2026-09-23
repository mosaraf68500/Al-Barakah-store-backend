import { describe, expect, it } from 'vitest';
import { CategoryModel } from '../src/modules/categories/category.model';
import { MediaModel } from '../src/modules/media/media.model';
import { OrderModel } from '../src/modules/orders/order.model';
import { ProductModel } from '../src/modules/products/product.model';
import { ReviewModel } from '../src/modules/reviews/review.model';
import { getSecret } from '../src/modules/settings/settings.service';
import { SettingsModel } from '../src/modules/settings/settings.model';
import { AuditLogModel } from '../src/modules/audit/audit.model';
import { SeedImportError, runImport, type ImageUploader, type PlannedImage, type SeedFiles } from '../src/modules/seedImport/importSeed';

const jpeg = (body: string) => `data:image/jpeg;base64,${Buffer.from(body).toString('base64')}`;
const IMG = jpeg('same-bytes');
const IMG2 = jpeg('other-bytes');
const TOKEN = 'bot-test-token-value';

function files(): SeedFiles {
  return {
    categories: [{ id: 'cat-1', name: 'Organic Foods', slug: 'organic-foods', enabled: true, order: 1, image: IMG }],
    products: [{ id: 'prod-1', name: 'Mustard Oil', category: 'Organic Foods', price: 100, stockCount: 4, inStock: true, image: IMG, images: [IMG], description: 'd', costPrice: 40, rating: 5, reviewCount: 0 }],
    orders: [{
      id: 'AB-100001',
      createdAt: '2020-01-01T00:00:00.000Z',
      status: 'pending',
      customer: { fullName: 'A', phone: '01712345678', address: 'House 1', city: 'Inside Dhaka' },
      items: [{ name: 'Mustard Oil', productId: 'prod-1', price: 100, quantity: 2, image: IMG }],
      subtotal: 200, discount: 0, shipping: 80, total: 280, currency: 'BDT',
      advancePaymentType: 'NONE', advanceAmount: 0, dueAmountOnDelivery: 280, deliveryPaymentStatus: 'COD_PENDING',
    }],
    reviews: [{ id: 'rev-1', productId: 'missing-prod', productName: 'Gone', customerName: 'R', rating: 5, comment: 'nice', city: 'Dhaka', approved: true, verifiedPurchase: true, createdAt: '2020-01-02T00:00:00.000Z' }],
    settings: [{
      id: 'general',
      seoConfig: { ogImage: IMG2, metaTitle: 'T' },
      notificationConfig: { telegram: { enabled: true, botToken: TOKEN, chatId: '99' } },
      heroBanners: { slides: [], promoCard: { id: 'promo', title: 'Promo', image: IMG, enabled: true, targetType: 'all', targetValue: '' } },
    }],
  };
}

function fakeUploader() {
  const calls: PlannedImage[] = [];
  const fn: ImageUploader = async (image) => {
    calls.push(image);
    return { secureUrl: `https://res.cloudinary.com/test-cloud/image/upload/${image.publicId}.${image.format}`, format: image.format, bytes: image.bytes };
  };
  return { fn, calls };
}

describe('seed import', () => {
  it('dry-run reports the plan and writes nothing', async () => {
    const up = fakeUploader();
    const report = await runImport(files(), { dryRun: true, force: false, uploader: up.fn });
    expect(report.dryRun).toBe(true);
    expect(report.planned).toMatchObject({ products: 1, categories: 1, orders: 1, reviews: 1, settings: 1, media: 2, coupons: 0 });
    expect(report.images.toUpload).toBe(2);
    expect(report.secrets.present).toEqual(expect.arrayContaining(['notificationConfig.telegram.botToken', 'notificationConfig.telegram.chatId']));
    expect(JSON.stringify(report)).not.toContain(TOKEN);
    expect(up.calls).toHaveLength(0);
    expect(await ProductModel.countDocuments()).toBe(0);
    expect(await MediaModel.countDocuments()).toBe(0);
  });

  it('imports catalogue, encrypts secrets, dedupes images, and skips a second run', async () => {
    const up = fakeUploader();
    const report = await runImport(files(), { dryRun: false, force: false, uploader: up.fn });
    expect(report.result?.inserted).toMatchObject({ products: 1, categories: 1, orders: 1, reviews: 1, settings: 1, media: 2 });
    expect(up.calls).toHaveLength(2);
    expect(JSON.stringify(report)).not.toContain(TOKEN);
    expect(report.warnings.some((w) => w.includes('prod-1') && w.includes('mustard-oil'))).toBe(true);
    expect(report.warnings.some((w) => w.includes('rev-1') && w.includes('missing-prod'))).toBe(true);
    expect(report.warnings.some((w) => w.includes('AB-100001'))).toBe(true);

    const product = await ProductModel.findById('prod-1').lean();
    const withCost = await ProductModel.findById('prod-1').select('+costPrice').lean();
    expect(product?.costPrice).toBeUndefined();
    expect(withCost?.costPrice).toBe(40);
    expect(product?.slug).toBe('mustard-oil');
    expect(product?.image?.url.startsWith('https://')).toBe(true);
    expect(product?.image?.publicId.startsWith('albarakah/categories/')).toBe(true);

    const category = await CategoryModel.findById('cat-1').lean();
    expect(category?.image?.publicId).toBe(product?.image?.publicId);

    const order = await OrderModel.findById('AB-100001').lean();
    expect(order?.createdAt).toBeInstanceOf(Date);
    expect(order?.phoneKey).toBe('1712345678');
    expect(order?.deliveryZone).toBe('inside');
    expect(order?.items[0].totalPrice).toBe(200);
    expect(order?.items[0].image.startsWith('https://')).toBe(true);
    expect(order?.stockDeducted).toBe(false);

    const review = await ReviewModel.findById('rev-1').lean();
    expect(review?.userId).toBe('legacy-guest:rev-1');

    const raw = await SettingsModel.findById('general').lean();
    const dumped = JSON.stringify(raw?.config);
    expect(dumped).not.toContain(TOKEN);
    expect(dumped).not.toContain('data:image');
    expect(dumped).not.toContain('seed-import');
    expect(dumped).toContain('https://res.cloudinary.com/test-cloud/');
    expect(await getSecret('notificationConfig.telegram.botToken')).toBe(TOKEN);
    const hidden = await SettingsModel.findById('general').lean();
    expect(hidden?.secrets).toBeUndefined();

    const again = fakeUploader();
    const second = await runImport(files(), { dryRun: false, force: false, uploader: again.fn });
    expect(again.calls).toHaveLength(0);
    expect(second.result?.inserted.products).toBe(0);
    expect(second.result?.skipped.products).toBe(1);
    expect(await ProductModel.countDocuments()).toBe(1);
    expect(await AuditLogModel.countDocuments({ action: 'seed.import' })).toBe(2);
  });

  it('refuses an unknown category and writes nothing', async () => {
    const up = fakeUploader();
    const bad = files();
    bad.products = [{ id: 'prod-x', name: 'X', category: 'No Such Category', price: 1, stockCount: 1, image: IMG, images: [IMG] }];
    await expect(runImport(bad, { dryRun: false, force: false, uploader: up.fn })).rejects.toBeInstanceOf(SeedImportError);
    expect(up.calls).toHaveLength(0);
    expect(await CategoryModel.countDocuments()).toBe(0);
    expect(await ProductModel.countDocuments()).toBe(0);
  });
});
