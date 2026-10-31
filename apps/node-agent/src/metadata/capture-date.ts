export const maxCaptureDatePrefixBytes = 1024 * 1024;
const maxIfdEntries = 512;
export const unknownCaptureDateMetadata: CaptureDateMetadata = {
  capturedAt: null, localTime: null, offsetMinutes: null, source: 'unknown', confidence: 'unknown'
};

export type CaptureDateSource = 'exif_offset' | 'exif_floating' | 'legacy_unknown' | 'unknown';
export type CaptureDateConfidence = 'high' | 'medium' | 'unknown';

export interface CaptureDateMetadata {
  capturedAt: string | null;
  localTime: string | null;
  offsetMinutes: number | null;
  source: CaptureDateSource;
  confidence: CaptureDateConfidence;
}

interface TiffReader {
  littleEndian: boolean;
  readU16(offset: number): number | undefined;
  readU32(offset: number): number | undefined;
  readAscii(entryOffset: number, type: number, count: number): string | undefined;
}

export function parseCaptureDatePrefix(prefix: Uint8Array): CaptureDateMetadata {
  if (prefix.byteLength === 0 || prefix.byteLength > maxCaptureDatePrefixBytes) return { ...unknownCaptureDateMetadata };
  const tiffOffset = findTiffOffset(prefix);
  if (tiffOffset === undefined) return { ...unknownCaptureDateMetadata };
  const tiff = createTiffReader(prefix, tiffOffset);
  if (!tiff) return { ...unknownCaptureDateMetadata };
  const firstIfdOffset = tiff.readU32(tiffOffset + 4);
  if (firstIfdOffset === undefined) return { ...unknownCaptureDateMetadata };
  const firstIfd = readIfd(prefix, tiff, tiffOffset + firstIfdOffset);
  if (!firstIfd) return { ...unknownCaptureDateMetadata };
  const exifPointer = firstIfd.find((entry) => entry.tag === 0x8769 && entry.type === 4 && entry.count === 1);
  const exifOffset = exifPointer ? tiff.readU32(exifPointer.offset + 8) : undefined;
  if (exifOffset === undefined) return { ...unknownCaptureDateMetadata };
  const exifIfd = readIfd(prefix, tiff, tiffOffset + exifOffset);
  if (!exifIfd) return { ...unknownCaptureDateMetadata };
  const dateEntry = exifIfd.find((entry) => entry.tag === 0x9003 && entry.type === 2);
  if (!dateEntry) return { ...unknownCaptureDateMetadata };
  const dateValue = tiff.readAscii(dateEntry.offset, dateEntry.type, dateEntry.count);
  if (!dateValue) return { ...unknownCaptureDateMetadata };
  const local = parseExifWallTime(dateValue);
  if (!local) return { ...unknownCaptureDateMetadata };
  const offsetEntry = exifIfd.find((entry) => entry.tag === 0x9011);
  if (!offsetEntry) {
    return { capturedAt: null, localTime: local.localTime, offsetMinutes: null, source: 'exif_floating', confidence: 'medium' };
  }
  const offsetValue = tiff.readAscii(offsetEntry.offset, offsetEntry.type, offsetEntry.count);
  const offsetMinutes = offsetValue === undefined ? undefined : parseOffsetMinutes(offsetValue);
  if (offsetMinutes === undefined) return { ...unknownCaptureDateMetadata };
  const instant = new Date(local.wallClockUtc.getTime() - offsetMinutes * 60_000);
  if (!Number.isFinite(instant.getTime())) return { ...unknownCaptureDateMetadata };
  return {
    capturedAt: instant.toISOString(), localTime: local.localTime, offsetMinutes,
    source: 'exif_offset', confidence: 'high'
  };
}

export function isCaptureDateMetadata(value: unknown): value is CaptureDateMetadata {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  const keys = ['capturedAt', 'confidence', 'localTime', 'offsetMinutes', 'source'];
  if (Object.keys(candidate).length !== keys.length || keys.some((key) => !Object.hasOwn(candidate, key))) return false;
  if (candidate.source === 'exif_offset') {
    if (candidate.confidence !== 'high' || !isCanonicalUtc(candidate.capturedAt) || !isCanonicalLocal(candidate.localTime) ||
        !Number.isInteger(candidate.offsetMinutes) || Number(candidate.offsetMinutes) < -840 || Number(candidate.offsetMinutes) > 840) return false;
    const local = parseCanonicalLocal(candidate.localTime as string);
    if (!local) return false;
    const expected = new Date(local.wallClockUtc.getTime() - Number(candidate.offsetMinutes) * 60_000).toISOString();
    return candidate.capturedAt === expected;
  }
  if (candidate.source === 'exif_floating') {
    return candidate.confidence === 'medium' && candidate.capturedAt === null && isCanonicalLocal(candidate.localTime) &&
      candidate.offsetMinutes === null;
  }
  if (candidate.source === 'legacy_unknown') {
    return candidate.confidence === 'unknown' && (candidate.capturedAt === null || isCanonicalUtc(candidate.capturedAt)) &&
      candidate.localTime === null && candidate.offsetMinutes === null;
  }
  return candidate.source === 'unknown' && candidate.confidence === 'unknown' && candidate.capturedAt === null &&
    candidate.localTime === null && candidate.offsetMinutes === null;
}

function findTiffOffset(bytes: Uint8Array): number | undefined {
  if (isTiffHeader(bytes, 0)) return 0;
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) return undefined;
  let offset = 2;
  while (offset + 4 <= bytes.byteLength) {
    if (bytes[offset] !== 0xff) return undefined;
    while (bytes[offset] === 0xff) offset += 1;
    if (offset >= bytes.byteLength) return undefined;
    const marker = bytes[offset]!;
    offset += 1;
    if (marker === 0xd9 || marker === 0xda) return undefined;
    if (marker === 0x01 || marker >= 0xd0 && marker <= 0xd7) continue;
    if (offset + 2 > bytes.byteLength) return undefined;
    const segmentLength = readBigEndianU16(bytes, offset);
    if (segmentLength < 2 || offset + segmentLength > bytes.byteLength) return undefined;
    const payloadOffset = offset + 2;
    const payloadEnd = offset + segmentLength;
    if (marker === 0xe1 && payloadOffset + 6 <= payloadEnd &&
        bytes[payloadOffset] === 0x45 && bytes[payloadOffset + 1] === 0x78 && bytes[payloadOffset + 2] === 0x69 &&
        bytes[payloadOffset + 3] === 0x66 && bytes[payloadOffset + 4] === 0 && bytes[payloadOffset + 5] === 0) {
      const tiffOffset = payloadOffset + 6;
      return isTiffHeader(bytes, tiffOffset) ? tiffOffset : undefined;
    }
    offset += segmentLength;
  }
  return undefined;
}

function isTiffHeader(bytes: Uint8Array, offset: number): boolean {
  if (offset + 8 > bytes.byteLength) return false;
  const littleEndian = bytes[offset] === 0x49 && bytes[offset + 1] === 0x49;
  const bigEndian = bytes[offset] === 0x4d && bytes[offset + 1] === 0x4d;
  if (!littleEndian && !bigEndian) return false;
  return (readEndianU16(bytes, offset + 2, littleEndian) === 42);
}

function createTiffReader(bytes: Uint8Array, baseOffset: number): TiffReader | undefined {
  const littleEndian = bytes[baseOffset] === 0x49 && bytes[baseOffset + 1] === 0x49;
  if (!littleEndian && !(bytes[baseOffset] === 0x4d && bytes[baseOffset + 1] === 0x4d)) return undefined;
  return {
    littleEndian,
    readU16: (offset) => offset >= 0 && offset + 2 <= bytes.byteLength
      ? readEndianU16(bytes, offset, littleEndian) : undefined,
    readU32: (offset) => offset >= 0 && offset + 4 <= bytes.byteLength
      ? readEndianU32(bytes, offset, littleEndian) : undefined,
    readAscii: (entryOffset, type, count) => {
      if (type !== 2 || count < 1 || count > 128) return undefined;
      const dataOffset = count <= 4 ? entryOffset + 8 : (() => {
        const pointer = readEndianU32(bytes, entryOffset + 8, littleEndian);
        return pointer === undefined ? -1 : baseOffset + pointer;
      })();
      if (dataOffset < 0 || dataOffset + count > bytes.byteLength) return undefined;
      const slice = bytes.subarray(dataOffset, dataOffset + count);
      let text = '';
      for (const byte of slice) {
        if (byte === 0) break;
        if (byte > 0x7f) return undefined;
        text += String.fromCharCode(byte);
      }
      return text.trim();
    }
  };
}

interface IfdEntry { tag: number; type: number; count: number; offset: number }
function readIfd(bytes: Uint8Array, tiff: TiffReader, offset: number): IfdEntry[] | undefined {
  const count = tiff.readU16(offset);
  if (count === undefined || count > maxIfdEntries || offset + 2 + count * 12 + 4 > bytes.byteLength) return undefined;
  const entries: IfdEntry[] = [];
  for (let index = 0; index < count; index += 1) {
    const entryOffset = offset + 2 + index * 12;
    const tag = tiff.readU16(entryOffset);
    const type = tiff.readU16(entryOffset + 2);
    const valueCount = tiff.readU32(entryOffset + 4);
    if (tag === undefined || type === undefined || valueCount === undefined) return undefined;
    entries.push({ tag, type, count: valueCount, offset: entryOffset });
  }
  return entries;
}

function parseExifWallTime(value: string): { localTime: string; wallClockUtc: Date } | undefined {
  const match = /^(\d{4}):(\d{2}):(\d{2}) (\d{2}):(\d{2}):(\d{2})$/.exec(value);
  if (!match) return undefined;
  const [, y, mo, d, h, mi, s] = match;
  const year = Number(y); const month = Number(mo); const day = Number(d);
  const hour = Number(h); const minute = Number(mi); const second = Number(s);
  if (!isValidCalendarTime(year, month, day, hour, minute, second)) return undefined;
  const localTime = `${y}-${mo}-${d}T${h}:${mi}:${s}.000`;
  const wallClockUtc = new Date(0);
  wallClockUtc.setUTCFullYear(year, month - 1, day);
  wallClockUtc.setUTCHours(hour, minute, second, 0);
  return Number.isFinite(wallClockUtc.getTime()) ? { localTime, wallClockUtc } : undefined;
}

function parseCanonicalLocal(value: string): { wallClockUtc: Date } | undefined {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})\.(\d{3})$/.exec(value);
  if (!match) return undefined;
  const [, y, mo, d, h, mi, s, ms] = match;
  const year = Number(y); const month = Number(mo); const day = Number(d);
  const hour = Number(h); const minute = Number(mi); const second = Number(s);
  if (!isValidCalendarTime(year, month, day, hour, minute, second)) return undefined;
  const wallClockUtc = new Date(0);
  wallClockUtc.setUTCFullYear(year, month - 1, day);
  wallClockUtc.setUTCHours(hour, minute, second, Number(ms));
  return Number.isFinite(wallClockUtc.getTime()) ? { wallClockUtc } : undefined;
}

function isCanonicalLocal(value: unknown): value is string {
  return typeof value === 'string' && parseCanonicalLocal(value) !== undefined;
}

export function isCanonicalCaptureLocalTime(value: unknown): value is string {
  return isCanonicalLocal(value);
}

function isCanonicalUtc(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return false;
  try { return new Date(value).toISOString() === value; } catch { return false; }
}

function parseOffsetMinutes(value: string): number | undefined {
  if (value === 'Z') return 0;
  const match = /^([+-])(\d{2}):(\d{2})$/.exec(value);
  if (!match) return undefined;
  const hours = Number(match[2]); const minutes = Number(match[3]);
  if (minutes > 59 || hours > 14 || hours === 14 && minutes !== 0) return undefined;
  const total = hours * 60 + minutes;
  return match[1] === '-' ? -total : total;
}

function isValidCalendarTime(year: number, month: number, day: number, hour: number, minute: number, second: number): boolean {
  if (year < 1 || year > 9999 || month < 1 || month > 12 || hour > 23 || minute > 59 || second > 59) return false;
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return day >= 1 && day <= days[month - 1]!;
}

function readBigEndianU16(bytes: Uint8Array, offset: number): number {
  return bytes[offset]! * 256 + bytes[offset + 1]!;
}

function readEndianU16(bytes: Uint8Array, offset: number, little: boolean): number {
  return little ? bytes[offset]! + bytes[offset + 1]! * 256 : readBigEndianU16(bytes, offset);
}

function readEndianU32(bytes: Uint8Array, offset: number, little: boolean): number | undefined {
  if (offset < 0 || offset + 4 > bytes.byteLength) return undefined;
  if (little) return bytes[offset]! + bytes[offset + 1]! * 0x100 + bytes[offset + 2]! * 0x10000 + bytes[offset + 3]! * 0x1000000;
  return bytes[offset]! * 0x1000000 + bytes[offset + 1]! * 0x10000 + bytes[offset + 2]! * 0x100 + bytes[offset + 3]!;
}
