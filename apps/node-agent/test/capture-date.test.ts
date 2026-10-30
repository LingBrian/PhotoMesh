import { describe, expect, it } from 'vitest';
import { parseCaptureDatePrefix } from '../src/metadata/capture-date.js';

type Endian = 'II' | 'MM';

function makeExifPayload(dateTime: string, offset: string | undefined, endian: Endian = 'II'): Uint8Array {
  const encoder = new TextEncoder();
  const dateBytes = encoder.encode(`${dateTime}\0`);
  const offsetBytes = offset === undefined ? undefined : encoder.encode(`${offset}\0`);
  const entryCount = offsetBytes ? 2 : 1;
  const exifIfdOffset = 26;
  const entriesEnd = exifIfdOffset + 2 + entryCount * 12 + 4;
  const dateOffset = entriesEnd;
  const offsetOffset = offsetBytes ? dateOffset + dateBytes.byteLength : 0;
  const bytes = new Uint8Array(dateOffset + dateBytes.byteLength + (offsetBytes?.byteLength ?? 0));
  const view = new DataView(bytes.buffer);
  const little = endian === 'II';
  bytes[0] = endian.charCodeAt(0);
  bytes[1] = endian.charCodeAt(1);
  view.setUint16(2, 42, little);
  view.setUint32(4, 8, little);
  view.setUint16(8, 1, little);
  view.setUint16(10, 0x8769, little);
  view.setUint16(12, 4, little);
  view.setUint32(14, 1, little);
  view.setUint32(18, exifIfdOffset, little);
  view.setUint32(22, 0, little);
  view.setUint16(exifIfdOffset, entryCount, little);
  const dateEntry = exifIfdOffset + 2;
  view.setUint16(dateEntry, 0x9003, little);
  view.setUint16(dateEntry + 2, 2, little);
  view.setUint32(dateEntry + 4, dateBytes.byteLength, little);
  view.setUint32(dateEntry + 8, dateOffset, little);
  if (offsetBytes) {
    const offsetEntry = dateEntry + 12;
    view.setUint16(offsetEntry, 0x9011, little);
    view.setUint16(offsetEntry + 2, 2, little);
    view.setUint32(offsetEntry + 4, offsetBytes.byteLength, little);
    view.setUint32(offsetEntry + 8, offsetOffset, little);
  }
  view.setUint32(exifIfdOffset + 2 + entryCount * 12, 0, little);
  bytes.set(dateBytes, dateOffset);
  if (offsetBytes) bytes.set(offsetBytes, offsetOffset);
  return bytes;
}

function jpegWithExif(tiff: Uint8Array): Uint8Array {
  const identifier = new Uint8Array([0x45, 0x78, 0x69, 0x66, 0, 0]);
  const segmentLength = 2 + identifier.byteLength + tiff.byteLength;
  const bytes = new Uint8Array(2 + 2 + 2 + identifier.byteLength + tiff.byteLength + 2);
  const view = new DataView(bytes.buffer);
  bytes.set([0xff, 0xd8, 0xff, 0xe1], 0);
  view.setUint16(4, segmentLength, false);
  bytes.set(identifier, 6);
  bytes.set(tiff, 12);
  bytes.set([0xff, 0xd9], bytes.byteLength - 2);
  return bytes;
}

describe('capture date EXIF parsing', () => {
  it('normalizes EXIF local time with an explicit positive offset to UTC', () => {
    const result = parseCaptureDatePrefix(jpegWithExif(makeExifPayload('2024:04:02 12:04:05', '+03:00')));
    expect(result).toEqual({
      capturedAt: '2024-04-02T09:04:05.000Z', localTime: '2024-04-02T12:04:05.000',
      offsetMinutes: 180, source: 'exif_offset', confidence: 'high'
    });
  });

  it('preserves an EXIF wall time without inventing an offset', () => {
    const result = parseCaptureDatePrefix(jpegWithExif(makeExifPayload('2024:04:02 12:04:05', undefined)));
    expect(result).toEqual({
      capturedAt: null, localTime: '2024-04-02T12:04:05.000', offsetMinutes: null,
      source: 'exif_floating', confidence: 'medium'
    });
  });

  it('supports zero and negative offsets and both TIFF byte orders', () => {
    expect(parseCaptureDatePrefix(jpegWithExif(makeExifPayload('2001:02:03 04:05:06', '+00:00', 'MM'))))
      .toMatchObject({ capturedAt: '2001-02-03T04:05:06.000Z', offsetMinutes: 0, source: 'exif_offset' });
    expect(parseCaptureDatePrefix(jpegWithExif(makeExifPayload('2001:02:03 04:05:06', '-05:30'))))
      .toMatchObject({ capturedAt: '2001-02-03T09:35:06.000Z', offsetMinutes: -330, source: 'exif_offset' });
  });

  it('returns unknown for invalid offsets and invalid calendar values', () => {
    const unknown = { capturedAt: null, localTime: null, offsetMinutes: null, source: 'unknown', confidence: 'unknown' };
    expect(parseCaptureDatePrefix(jpegWithExif(makeExifPayload('2024:04:02 12:04:05', '+15:00')))).toEqual(unknown);
    expect(parseCaptureDatePrefix(jpegWithExif(makeExifPayload('2024:04:02 12:04:05', 'invalid')))).toEqual(unknown);
    expect(parseCaptureDatePrefix(jpegWithExif(makeExifPayload('2023:02:29 12:04:05', '-08:00'))))
      .toMatchObject({ capturedAt: null, localTime: null, source: 'unknown', confidence: 'unknown' });
  });

  it('returns unknown for absent, unsupported, truncated, or oversized prefixes', () => {
    const unknown = { capturedAt: null, localTime: null, offsetMinutes: null, source: 'unknown', confidence: 'unknown' };
    expect(parseCaptureDatePrefix(new Uint8Array())).toEqual(unknown);
    expect(parseCaptureDatePrefix(new Uint8Array([0x89, 0x50, 0x4e, 0x47]))).toEqual(unknown);
    const jpeg = jpegWithExif(makeExifPayload('2024:04:02 12:04:05', '+03:00'));
    expect(parseCaptureDatePrefix(jpeg.slice(0, 15))).toEqual(unknown);
    expect(parseCaptureDatePrefix(new Uint8Array(1_048_577))).toEqual(unknown);
  });
});
