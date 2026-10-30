import { describe, expect, it } from 'vitest';
import {
  captureDateGroupKey, captureDateTimeValue, formatCaptureDate, formatCaptureDateGroup, formatCaptureTime,
  parseFloatingCaptureTime
} from '../src/capture-date-display.js';

const timezoneLabel = 'Time zone unknown';
const unknownLabel = 'Capture time unknown';

describe('timeline capture-date display', () => {
  it('formats absolute instants in the explicit system IANA timezone', () => {
    const asset = { capturedAt: '2024-01-01T01:30:00.000Z' };
    expect(captureDateGroupKey(asset, 'America/Los_Angeles')).toBe('absolute:2023-12-31');
    expect(formatCaptureDate(asset, 'en-US', 'America/Los_Angeles', unknownLabel, timezoneLabel)).toContain('Dec 31, 2023');
    expect(formatCaptureDateGroup(asset, 'en-US', 'America/Los_Angeles', unknownLabel, timezoneLabel)).toContain('December 31, 2023');
    expect(captureDateTimeValue(asset)).toBe('2024-01-01T01:30:00.000Z');
  });

  it('keeps floating wall time unchanged and isolates its date group', () => {
    const asset = { capturedAt: null, captureLocalTime: '2024-01-01T01:30:00.000' };
    expect(captureDateGroupKey(asset, 'America/Los_Angeles')).toBe('floating:2024-01-01');
    expect(formatCaptureDate(asset, 'en-US', 'America/Los_Angeles', unknownLabel, timezoneLabel)).toContain('Jan 1, 2024');
    expect(formatCaptureDate(asset, 'en-US', 'America/Los_Angeles', unknownLabel, timezoneLabel)).toContain(timezoneLabel);
    expect(formatCaptureTime(asset, 'en-US', 'America/Los_Angeles', unknownLabel, timezoneLabel)).toContain('1:30 AM');
    expect(formatCaptureDateGroup(asset, 'en-US', 'America/Los_Angeles', unknownLabel, timezoneLabel)).toContain('January 1, 2024');
    expect(captureDateTimeValue(asset)).toBe('2024-01-01T01:30:00.000');
  });

  it('rejects invalid floating calendar values and shows the unknown-date fallback', () => {
    const asset = { capturedAt: null, captureLocalTime: '2023-02-29T12:00:00.000' };
    expect(parseFloatingCaptureTime(asset.captureLocalTime)).toBeNull();
    expect(captureDateGroupKey(asset, 'UTC')).toBe('unknown');
    expect(captureDateTimeValue(asset)).toBeUndefined();
    expect(formatCaptureDate(asset, 'en-US', 'UTC', unknownLabel, timezoneLabel)).toBe(unknownLabel);
  });
});
