import { describe, expect, it } from 'vitest';
import { metadataRecordsToCsv, toMetadataExportRecord } from '../src/metadata/export.js';

describe('metadata export', () => {
  it('keeps a fixed safe field set and redacts paths by default', () => {
    const record = toMetadataExportRecord({ assetId: 'a', filename: '=SUM(A1)', sourcePath: 'C:\\private', secret: 'nope', tags: ['one'] }, false);
    expect(record.sourcePath).toBeNull();
    expect(record.filename).toBe('=SUM(A1)');
    expect(record).not.toHaveProperty('secret');
  });
  it('quotes CSV cells and neutralizes spreadsheet formulas', () => {
    const csv = metadataRecordsToCsv([toMetadataExportRecord({ assetId: 'a', filename: '=1+1', tags: ['x,y'], sourcePath: null }, true)]);
    expect(csv).toContain("'=1+1");
    expect(csv).toContain('"x,y"');
    expect(csv.split('\r\n')[0]).toContain('assetId');
  });
});
