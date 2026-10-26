import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { ImageTransformError, SharpMediaImageTransformer } from '../src/media/image-transformer.js';

const transformer = new SharpMediaImageTransformer();
const fullCrop = { x: 0, y: 0, width: 1_000_000, height: 1_000_000 };

describe('SharpMediaImageTransformer', () => {
  it('applies crop in normalized upright coordinates, then rotates by 90 degrees', async () => {
    const input = await sharp({ create: { width: 4, height: 2, channels: 3, background: '#e53935' } })
      .jpeg().toBuffer();
    const output = await transformer.transform(input, { crop: fullCrop, rotation: 90 });
    const metadata = await sharp(output.bytes).metadata();
    expect(output.mimeType).toBe('image/jpeg');
    expect(output.width).toBe(2);
    expect(output.height).toBe(4);
    expect(metadata.format).toBe('jpeg');
  });

  it('normalizes EXIF orientation before applying the crop', async () => {
    const input = await sharp({ create: { width: 4, height: 2, channels: 3, background: '#00897b' } })
      .jpeg().withMetadata({ orientation: 6 }).toBuffer();
    const sourceMetadata = await sharp(input).metadata();
    expect(sourceMetadata.orientation).toBe(6);
    const output = await transformer.transform(input, { crop: fullCrop, rotation: 0 });
    expect(output.width).toBe(2);
    expect(output.height).toBe(4);
    const outputMetadata = await sharp(output.bytes).metadata();
    expect(outputMetadata.orientation).toBeUndefined();
  });

  it('strips EXIF while retaining ICC profile and PNG transparency', async () => {
    const jpeg = await sharp({ create: { width: 2, height: 2, channels: 3, background: '#1565c0' } })
      .jpeg().withIccProfile('srgb').withMetadata({ orientation: 1 }).toBuffer();
    const output = await transformer.transform(jpeg, { crop: fullCrop, rotation: 0 });
    const metadata = await sharp(output.bytes).metadata();
    expect(metadata.exif).toBeUndefined();
    expect(metadata.icc?.byteLength).toBeGreaterThan(0);

    const png = await sharp({ create: { width: 2, height: 2, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
      .png().toBuffer();
    const transparentOutput = await transformer.transform(png, { crop: fullCrop, rotation: 0 });
    expect(transparentOutput.mimeType).toBe('image/png');
    expect((await sharp(transparentOutput.bytes).metadata()).hasAlpha).toBe(true);
  });

  it('keeps WebP format, rounds normalized crop edges outward, and bounds input bytes', async () => {
    const input = await sharp({ create: { width: 5, height: 5, channels: 3, background: '#6a1b9a' } }).webp().toBuffer();
    const output = await transformer.transform(input, {
      crop: { x: 100_000, y: 0, width: 100_000, height: 1_000_000 }, rotation: 0
    });
    expect(output.mimeType).toBe('image/webp');
    expect(output.width).toBe(1);
    expect(output.height).toBe(5);
    expect((await sharp(output.bytes).metadata()).format).toBe('webp');

    await expect(transformer.inspect(Buffer.alloc(32 * 1024 * 1024 + 1)))
      .rejects.toMatchObject({ code: 'TOO_LARGE' });
  });

  it('creates a bounded 192px WebP thumbnail and strips source metadata', async () => {
    const input = await sharp({ create: { width: 640, height: 320, channels: 3, background: '#1565c0' } })
      .webp().withMetadata({ orientation: 6 }).toBuffer();
    const output = await transformer.createThumbnail(input);
    const metadata = await sharp(output.bytes).metadata();
    expect(output.mimeType).toBe('image/webp');
    expect(output.width).toBeLessThanOrEqual(192);
    expect(output.height).toBeLessThanOrEqual(192);
    expect(output.bytes.byteLength).toBeLessThanOrEqual(256 * 1024);
    expect(metadata.format).toBe('webp');
    expect(metadata.exif).toBeUndefined();
    expect(metadata.orientation).toBeUndefined();
  });

  it('rejects thumbnail input bytes and pixel dimensions above the approved limits', async () => {
    await expect(transformer.createThumbnail(Buffer.alloc(16 * 1024 * 1024 + 1)))
      .rejects.toMatchObject({ code: 'TOO_LARGE' });
    const large = await sharp({ create: { width: 3700, height: 3500, channels: 3, background: '#fff' } }).png().toBuffer();
    await expect(transformer.createThumbnail(large)).rejects.toMatchObject({ code: 'TOO_LARGE' });
  });

  it('rejects malformed and over-pixel-limit inputs', async () => {
    await expect(transformer.inspect(Buffer.from('not an image'))).rejects.toMatchObject({ code: 'UNSUPPORTED_MEDIA' });
    await expect(transformer.createThumbnail(Buffer.from('not an image'))).rejects.toMatchObject({ code: 'UNSUPPORTED_MEDIA' });
    const large = await sharp({ create: { width: 5001, height: 5000, channels: 3, background: '#fff' } }).png().toBuffer();
    await expect(transformer.inspect(large)).rejects.toMatchObject({ code: 'TOO_LARGE' });
    await expect(transformer.transform(Buffer.from('bad'), { crop: fullCrop, rotation: 0 }))
      .rejects.toBeInstanceOf(ImageTransformError);
  });
});
