import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import SwaggerParser from '@apidevtools/swagger-parser';
import Ajv2020 from 'ajv/dist/2020.js';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';

const packageDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = path.resolve(packageDir, '../..');

describe('source contracts', () => {
  it('validates the draft OpenAPI document', async () => {
    const apiPath = path.join(repoRoot, 'contracts/openapi_draft.yaml');
    await expect(SwaggerParser.validate(apiPath)).resolves.toBeDefined();
  });

  it('validates a JSON Schema component from the OpenAPI source', async () => {
    const apiPath = path.join(repoRoot, 'contracts/openapi_draft.yaml');
    const api = parse(await readFile(apiPath, 'utf8')) as {
      components: { schemas: Record<string, object> };
    };
    const schema = api.components.schemas.Library!;
    const validator = new Ajv2020.default({ allErrors: true }).compile(schema);
    expect(validator({ libraryId: 'lib_01', title: 'Family', encryptionPolicy: 'none' })).toBe(true);
    expect(validator({ libraryId: 'lib_01', title: 'Family', encryptionPolicy: 'invalid' })).toBe(false);
  });

  it('validates the resumable upload and completion schemas', async () => {
    const apiPath = path.join(repoRoot, 'contracts/openapi_draft.yaml');
    const api = parse(await readFile(apiPath, 'utf8')) as {
      components: { schemas: Record<string, object> };
    };
    const ajv = new Ajv2020.default({ allErrors: true });
    const upload = ajv.compile(api.components.schemas.UploadCreate!);
    const complete = ajv.compile(api.components.schemas.UploadComplete!);
    expect(upload({ libraryId: 'lib_1', filename: '原图.jpg', sourceKind: 'import', totalBytes: 2, sha256: 'a'.repeat(64) })).toBe(true);
    expect(upload({ libraryId: 'lib_1', filename: '原图.jpg', sourceKind: 'other', totalBytes: 2, sha256: 'a'.repeat(64) })).toBe(false);
    expect(complete({ sessionId: 's1', assetId: 'a1', fileId: 'f1', sha256: 'b'.repeat(64), byteLength: 2, storageRef: 'objects/s1/original.blob' })).toBe(true);
    expect(complete({ sessionId: 's1', assetId: 'a1', fileId: 'f1', sha256: 'bad', byteLength: 2, storageRef: 'objects/s1/original.blob' })).toBe(false);
  });
});
