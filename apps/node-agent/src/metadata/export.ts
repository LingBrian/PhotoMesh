export const metadataExportLimit = 5_000;

const exportFields = ['assetId', 'libraryId', 'originNodeId', 'kind', 'sha256', 'byteSize', 'filename', 'capturedAt', 'captureLocalTime', 'captureOffsetMinutes', 'captureSource', 'captureConfidence', 'sourcePath', 'sourceKind', 'availability', 'tags', 'favorite', 'rating'] as const;
type ExportField = typeof exportFields[number];
export type MetadataExportRecord = Record<ExportField, unknown>;

function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }

export function toMetadataExportRecord(value: unknown, includePath: boolean): MetadataExportRecord {
  const source = isRecord(value) ? value : {};
  return Object.fromEntries(exportFields.map((field) => [field, field === 'sourcePath' && !includePath ? null : source[field] ?? null])) as MetadataExportRecord;
}

export function toMetadataExportRecords(values: readonly unknown[], includePath: boolean): MetadataExportRecord[] {
  return values.slice(0, metadataExportLimit).map((value) => toMetadataExportRecord(value, includePath));
}

function csvCell(value: unknown): string {
  const raw = Array.isArray(value) ? value.join(', ') : value === null || value === undefined ? '' : String(value);
  const safe = /^[=+\-@]/.test(raw) ? `'${raw}` : raw;
  return /[",\r\n]/.test(safe) ? `"${safe.replaceAll('"', '""')}"` : safe;
}

export function metadataRecordsToCsv(records: readonly MetadataExportRecord[]): string {
  return [exportFields.join(','), ...records.map((record) => exportFields.map((field) => csvCell(record[field])).join(','))].join('\r\n') + '\r\n';
}

export function metadataExportFields(): readonly string[] { return exportFields; }
