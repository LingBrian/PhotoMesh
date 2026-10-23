const REQUIRED_ASSETS = 100_000;
const REQUIRED_QUERIES = 1_000;
const MAX_P95_MS = 1_000;

export function performanceReportPasses(report) {
  const assets = report?.dataset?.assets;
  const queries = report?.dataset?.queries;
  const p95Ms = report?.queryApi?.p95Ms;
  return assets === REQUIRED_ASSETS && queries === REQUIRED_QUERIES &&
    typeof p95Ms === 'number' && Number.isFinite(p95Ms) && p95Ms >= 0 && p95Ms < MAX_P95_MS;
}

export function reconnectDurationWithinLimit(durationMs) {
  return typeof durationMs === 'number' && Number.isFinite(durationMs) && durationMs >= 0 && durationMs <= 60_000;
}

const ISO_TIMESTAMP = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(Z|([+-])(\d{2}):(\d{2}))$/;

function parseIsoTimestamp(value) {
  if (typeof value !== 'string') return Number.NaN;
  const match = ISO_TIMESTAMP.exec(value);
  if (!match) return Number.NaN;
  const [, yearText, monthText, dayText, hourText, minuteText, secondText, , , offsetHourText, offsetMinuteText] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  const isLeapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, isLeapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth[month - 1] || hour > 23 || minute > 59 || second > 59) {
    return Number.NaN;
  }
  if (offsetHourText !== undefined && (Number(offsetHourText) > 23 || Number(offsetMinuteText) > 59)) return Number.NaN;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : Number.NaN;
}

export function reconnectEvidencePasses(evidence) {
  const reconnectSeconds = evidence?.reconnectSeconds;
  if (typeof reconnectSeconds !== 'number' || !Number.isFinite(reconnectSeconds) || reconnectSeconds < 0 || reconnectSeconds > 60) {
    return false;
  }
  const restoredAtMs = parseIsoTimestamp(evidence?.networkRestoredAt);
  const firstAckAtMs = parseIsoTimestamp(evidence?.firstEventAckAt);
  const measuredReconnectMs = firstAckAtMs - restoredAtMs;
  return reconnectDurationWithinLimit(measuredReconnectMs) &&
    Math.abs(measuredReconnectMs / 1_000 - reconnectSeconds) <= 1;
}
