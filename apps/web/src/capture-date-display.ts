export interface CaptureDateDisplayAsset {
  capturedAt: string | null;
  captureLocalTime?: string | null;
  captureConfidence?: 'high' | 'medium' | 'unknown';
}

function parsedInstant(value: string | null): Date | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function parseFloatingCaptureTime(value: string | null | undefined): Date | null {
  if (!value || !/^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}$/.test(value)) return null;
  const date = new Date(`${value}Z`);
  return Number.isNaN(date.getTime()) || date.toISOString().slice(0, -1) !== value ? null : date;
}

function dayKey(date: Date, timeZone: string): string {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    year: 'numeric', month: '2-digit', day: '2-digit', timeZone, calendar: 'gregory', numberingSystem: 'latn'
  }).formatToParts(date).map((part) => [part.type, part.value]));
  return `${(parts.year ?? '').padStart(4, '0')}-${parts.month ?? '00'}-${parts.day ?? '00'}`;
}

export function captureDateGroupKey(asset: CaptureDateDisplayAsset | undefined, systemTimeZone: string): string {
  if (!asset) return 'unknown';
  if (asset.capturedAt) {
    const date = parsedInstant(asset.capturedAt);
    return date ? `absolute:${dayKey(date, systemTimeZone)}` : 'unknown';
  }
  if (parseFloatingCaptureTime(asset.captureLocalTime)) return `floating:${asset.captureLocalTime!.slice(0, 10)}`;
  return 'unknown';
}

export function captureDateTimeValue(asset: CaptureDateDisplayAsset): string | undefined {
  if (asset.capturedAt) return parsedInstant(asset.capturedAt)?.toISOString();
  return parseFloatingCaptureTime(asset.captureLocalTime) ? asset.captureLocalTime ?? undefined : undefined;
}

export function formatCaptureDate(
  asset: CaptureDateDisplayAsset, locale: string, systemTimeZone: string, unknownLabel: string, timezoneUnknownLabel: string
): string {
  const instant = parsedInstant(asset.capturedAt);
  if (instant) return new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short', timeZone: systemTimeZone }).format(instant);
  const floating = parseFloatingCaptureTime(asset.captureLocalTime);
  return floating
    ? `${new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' }).format(floating)} · ${timezoneUnknownLabel}`
    : unknownLabel;
}

export function formatCaptureDateGroup(
  asset: CaptureDateDisplayAsset, locale: string, systemTimeZone: string, unknownLabel: string, timezoneUnknownLabel: string
): string {
  const instant = parsedInstant(asset.capturedAt);
  if (instant) return new Intl.DateTimeFormat(locale, { dateStyle: 'long', timeZone: systemTimeZone, calendar: 'gregory' }).format(instant);
  const floating = parseFloatingCaptureTime(asset.captureLocalTime);
  return floating
    ? `${new Intl.DateTimeFormat(locale, { dateStyle: 'long', timeZone: 'UTC', calendar: 'gregory' }).format(floating)} · ${timezoneUnknownLabel}`
    : unknownLabel;
}

export function formatCaptureTime(
  asset: CaptureDateDisplayAsset, locale: string, systemTimeZone: string, unknownLabel: string, timezoneUnknownLabel: string
): string {
  const instant = parsedInstant(asset.capturedAt);
  if (instant) return new Intl.DateTimeFormat(locale, { timeStyle: 'short', timeZone: systemTimeZone }).format(instant);
  const floating = parseFloatingCaptureTime(asset.captureLocalTime);
  return floating
    ? `${new Intl.DateTimeFormat(locale, { timeStyle: 'short', timeZone: 'UTC' }).format(floating)} · ${timezoneUnknownLabel}`
    : unknownLabel;
}
