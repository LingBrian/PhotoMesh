import sharp from 'sharp';
import type { MediaVersionTransform } from '../db/repository.js';

export type SupportedImageMime = 'image/jpeg' | 'image/png' | 'image/webp';
export type ImageTransformFailureCode = 'UNSUPPORTED_MEDIA' | 'TOO_LARGE' | 'PROCESSING_FAILED';

export interface ImageProbe {
  format: string;
  width: number;
  height: number;
  pages: number;
  orientation?: number;
}

export interface TransformedImage {
  bytes: Buffer;
  mimeType: SupportedImageMime;
  width: number;
  height: number;
}

export interface MediaImageTransformer {
  inspect(bytes: Buffer): Promise<ImageProbe>;
  transform(bytes: Buffer, transform: MediaVersionTransform): Promise<TransformedImage>;
}

export class ImageTransformError extends Error {
  constructor(readonly code: ImageTransformFailureCode) {
    super(code);
    this.name = 'ImageTransformError';
  }
}

export const maxMediaVersionInputBytes = 32 * 1024 * 1024;
export const maxMediaVersionOutputBytes = 32 * 1024 * 1024;
export const maxMediaVersionPixels = 25_000_000;
export const mediaVersionProcessingTimeoutSeconds = 30;

sharp.concurrency(1);
sharp.cache({ memory: 64, files: 0, items: 20 });

export class SharpMediaImageTransformer implements MediaImageTransformer {
  async inspect(bytes: Buffer): Promise<ImageProbe> {
    if (bytes.byteLength > maxMediaVersionInputBytes) throw new ImageTransformError('TOO_LARGE');
    try {
      const metadata = await sharp(bytes, { failOn: 'warning', limitInputPixels: maxMediaVersionPixels })
        .timeout({ seconds: mediaVersionProcessingTimeoutSeconds }).metadata();
      const width = metadata.width ?? 0;
      const height = metadata.height ?? 0;
      if (width < 1 || height < 1 || width * height > maxMediaVersionPixels) {
        throw new ImageTransformError('TOO_LARGE');
      }
      return {
        format: metadata.format ?? '', width, height, pages: metadata.pages ?? 1,
        ...(metadata.orientation === undefined ? {} : { orientation: metadata.orientation })
      };
    } catch (error) {
      if (error instanceof ImageTransformError) throw error;
      if (isPixelLimitError(error)) throw new ImageTransformError('TOO_LARGE');
      throw new ImageTransformError('UNSUPPORTED_MEDIA');
    }
  }

  async transform(bytes: Buffer, transform: MediaVersionTransform): Promise<TransformedImage> {
    const probe = await this.inspect(bytes);
    const mimeType = mimeForFormat(probe.format);
    if (!mimeType || probe.pages > 1) throw new ImageTransformError('UNSUPPORTED_MEDIA');
    const swapsDimensions = probe.orientation !== undefined && probe.orientation >= 5 && probe.orientation <= 8;
    const orientedWidth = swapsDimensions ? probe.height : probe.width;
    const orientedHeight = swapsDimensions ? probe.width : probe.height;
    const crop = transform.crop;
    const left = Math.floor(crop.x * orientedWidth / 1_000_000);
    const top = Math.floor(crop.y * orientedHeight / 1_000_000);
    const right = Math.ceil((crop.x + crop.width) * orientedWidth / 1_000_000);
    const bottom = Math.ceil((crop.y + crop.height) * orientedHeight / 1_000_000);
    const width = right - left;
    const height = bottom - top;
    if (left < 0 || top < 0 || width < 1 || height < 1 || right > orientedWidth || bottom > orientedHeight) {
      throw new ImageTransformError('PROCESSING_FAILED');
    }

    try {
      let pipeline = sharp(bytes, { failOn: 'warning', limitInputPixels: maxMediaVersionPixels })
        .timeout({ seconds: mediaVersionProcessingTimeoutSeconds })
        .autoOrient()
        .extract({ left, top, width, height });
      if (transform.rotation !== 0) pipeline = pipeline.rotate(transform.rotation);
      const encoded = pipeline.keepIccProfile();
      const output = mimeType === 'image/jpeg'
        ? await encoded.jpeg({ quality: 92 }).toBuffer({ resolveWithObject: true })
        : mimeType === 'image/png'
          ? await encoded.png({ compressionLevel: 6 }).toBuffer({ resolveWithObject: true })
          : await encoded.webp({ quality: 90 }).toBuffer({ resolveWithObject: true });
      if (output.data.byteLength < 1 || output.data.byteLength > maxMediaVersionOutputBytes) {
        throw new ImageTransformError('TOO_LARGE');
      }
      return { bytes: output.data, mimeType, width: output.info.width, height: output.info.height };
    } catch (error) {
      if (error instanceof ImageTransformError) throw error;
      if (isPixelLimitError(error)) throw new ImageTransformError('TOO_LARGE');
      throw new ImageTransformError('PROCESSING_FAILED');
    }
  }
}

function mimeForFormat(format: string): SupportedImageMime | undefined {
  switch (format) {
    case 'jpeg': return 'image/jpeg';
    case 'png': return 'image/png';
    case 'webp': return 'image/webp';
    default: return undefined;
  }
}

function isPixelLimitError(error: unknown): boolean {
  return error instanceof Error && /pixel limit|exceeds.*pixels/i.test(error.message);
}
