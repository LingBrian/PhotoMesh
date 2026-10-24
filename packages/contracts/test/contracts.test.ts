import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import SwaggerParser from '@apidevtools/swagger-parser';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';

const packageDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = path.resolve(packageDir, '../..');
const registerFormats = addFormats as unknown as (ajv: InstanceType<typeof Ajv2020.default>) => void;

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
    registerFormats(ajv);
    const upload = ajv.compile(api.components.schemas.UploadCreate!);
    const complete = ajv.compile(api.components.schemas.UploadComplete!);
    expect(upload({ libraryId: 'lib_1', filename: '原图.jpg', sourceKind: 'import', totalBytes: 2, sha256: 'a'.repeat(64) })).toBe(true);
    expect(upload({ libraryId: 'lib_1', filename: '原图.jpg', sourceKind: 'other', totalBytes: 2, sha256: 'a'.repeat(64) })).toBe(false);
    expect(complete({ sessionId: 's1', assetId: 'a1', fileId: 'f1', sha256: 'b'.repeat(64), byteLength: 2, storageRef: 'objects/s1/original.blob' })).toBe(true);
    expect(complete({ sessionId: 's1', assetId: 'a1', fileId: 'f1', sha256: 'bad', byteLength: 2, storageRef: 'objects/s1/original.blob' })).toBe(false);
  });

  it('validates immutable media-version requests and exposes version routes', async () => {
    const apiPath = path.join(repoRoot, 'contracts/openapi_draft.yaml');
    const api = parse(await readFile(apiPath, 'utf8')) as {
      components: { schemas: Record<string, object> };
      paths: Record<string, Record<string, unknown>>;
    };
    const ajv = new Ajv2020.default({ allErrors: true });
    registerFormats(ajv);
    const dereferenced = await SwaggerParser.dereference(apiPath) as {
      components: { schemas: Record<string, object> };
    };
    const createVersion = ajv.compile(dereferenced.components.schemas.MediaVersionCreate!);
    const transform = ajv.compile(dereferenced.components.schemas.MediaTransform!);
    expect(createVersion({
      sourceVersionId: null,
      sourceSha256: 'a'.repeat(64),
      idempotencyKey: '01J9M4TESTIDEMPOTENCYKEY',
      transform: { crop: { x: 0, y: 0, width: 1_000_000, height: 1_000_000 }, rotation: 90 }
    })).toBe(true);
    expect(createVersion({
      sourceVersionId: null,
      sourceSha256: 'not-a-sha',
      idempotencyKey: 'short',
      transform: { crop: { x: -1, y: 0, width: 1_000_001, height: 1_000_000 }, rotation: 45 }
    })).toBe(false);
    expect(transform({ crop: { x: 100, y: 100, width: 900_000, height: 900_000 }, rotation: 0 })).toBe(true);
    expect(transform({ crop: { x: 0, y: 0, width: 1_000_001, height: 1_000_000 }, rotation: 0 })).toBe(false);
    expect(api.paths['/v1/libraries/{libraryId}/assets/{assetId}/versions']?.get).toBeDefined();
    expect(api.paths['/v1/libraries/{libraryId}/assets/{assetId}/versions']?.post).toBeDefined();
    expect(api.paths['/v1/libraries/{libraryId}/assets/{assetId}/versions/{versionId}']?.get).toBeDefined();
    expect(api.paths['/v1/libraries/{libraryId}/assets/{assetId}/versions/{versionId}/content']?.get).toBeDefined();
  });

  it('validates one-time LAN invitation and administrator approval payloads', async () => {
    const apiPath = path.join(repoRoot, 'contracts/openapi_draft.yaml');
    const api = parse(await readFile(apiPath, 'utf8')) as {
      components: { schemas: Record<string, object> };
    };
    const ajv = new Ajv2020.default({ allErrors: true });
    registerFormats(ajv);
    const invite = ajv.compile(api.components.schemas.PairingInvite!);
    const join = ajv.compile(api.components.schemas.PairingJoin!);
    const approval = ajv.compile(api.components.schemas.PairingApproval!);
    expect(invite({
      protocol: 'photomesh-pairing', version: 1, hostPeerId: '12D3KooWExample', addresses: [],
      inviteId: 'e8b66476-4102-47ce-b246-81a391c48cc2', secret: 'a'.repeat(43),
      expiresAt: '2026-10-21T00:02:00.000Z', qrDataUrl: 'data:image/png;base64,ZmFrZQ=='
    })).toBe(true);
    expect(invite({ protocol: 'photomesh-pairing', version: 1, secret: 'replay' })).toBe(false);
    expect(invite({
      protocol: 'photomesh-pairing', version: 1, hostPeerId: '12D3KooWExample', addresses: [], inviteId: 'invalid',
      secret: 'a'.repeat(43), expiresAt: '2026-10-21T00:02:00.000Z', qrDataUrl: 'data:image/png;base64,ZmFrZQ=='
    })).toBe(false);
    expect(join({
      invite: {
        protocol: 'photomesh-pairing', version: 1, hostPeerId: '12D3KooWExample', addresses: [],
        inviteId: 'e8b66476-4102-47ce-b246-81a391c48cc2', secret: 'a'.repeat(43), expiresAt: '2026-10-21T00:02:00.000Z'
      }, label: 'Laptop'
    })).toBe(true);
    expect(join({ invite: { secret: 'replay' }, label: 'Laptop' })).toBe(false);
    expect(approval({ approved: true, libraryIds: ['private-library'] })).toBe(true);
    expect(approval({ approved: true, libraryIds: ['x'.repeat(129)] })).toBe(false);
  });
});
