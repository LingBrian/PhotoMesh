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

  it('exposes the optional fixed-profile thumbnail response as derived WebP bytes', async () => {
    const apiPath = path.join(repoRoot, 'contracts/openapi_draft.yaml');
    const api = parse(await readFile(apiPath, 'utf8')) as { paths: Record<string, unknown> };
    expect(api.paths['/v1/libraries/{libraryId}/assets/{assetId}/thumbnail']).toMatchObject({
      get: {
        parameters: [
          { in: 'path', name: 'libraryId' },
          { in: 'path', name: 'assetId' },
          { in: 'query', name: 'profile', schema: { enum: ['timeline-192'], default: 'timeline-192' } }
        ],
        responses: {
          '200': { content: { 'image/webp': { schema: { type: 'string', format: 'binary' } } } },
          '404': {}, '409': {}, '429': {}
        }
      }
    });
  });

  it('defines authenticated status-only diagnostics with bounded components', async () => {
    const apiPath = path.join(repoRoot, 'contracts/openapi_draft.yaml');
    const api = parse(await readFile(apiPath, 'utf8')) as {
      paths: Record<string, unknown>;
      components: { schemas: Record<string, object> };
    };
    const operation = api.paths['/v1/diagnostics'] as Record<string, unknown> | undefined;
    expect(operation).toMatchObject({
      get: {
        security: [{ nodeAdminBearer: [] }],
        responses: { '200': { description: expect.any(String) }, '403': { description: expect.any(String) } }
      }
    });

    const dereferenced = await SwaggerParser.dereference(apiPath) as {
      components: { schemas: Record<string, object> };
    };
    const validate = new Ajv2020.default({ allErrors: true }).compile(dereferenced.components.schemas.NodeDiagnostics!);
    const response = {
      status: 'ok',
      readiness: 'ready',
      components: {
        api: { status: 'ok', capabilities: ['rest'] },
        database: { status: 'ok', capabilities: ['sqlite'] },
        storage: { status: 'ok', capabilities: ['managedFiles'] },
        identity: { status: 'ok', capabilities: ['nodeIdentity', 'eventSigning'] }
      }
    };
    expect(validate(response)).toBe(true);
    const invalid = structuredClone(response) as typeof response & { components: { database: { path?: string } } };
    invalid.components.database.path = 'C:\\\\private';
    expect(validate(invalid)).toBe(false);
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

  it('documents persistent asset tags as a bounded additive API', async () => {
    const apiPath = path.join(repoRoot, 'contracts/openapi_draft.yaml');
    const api = parse(await readFile(apiPath, 'utf8')) as {
      components: { schemas: Record<string, unknown> };
      paths: Record<string, unknown>;
    };
    expect(api.components.schemas.Asset).toMatchObject({
      required: expect.arrayContaining(['tags']),
      properties: { tags: { type: 'array', maxItems: 4096, items: { type: 'string', minLength: 1, maxLength: 128 } } }
    });
    expect(api.paths['/v1/libraries/{libraryId}/assets/{assetId}/tags/{tag}']).toMatchObject({
      put: { responses: { '204': { headers: { 'X-Request-ID': { $ref: '#/components/headers/XRequestId' } } }, '400': {}, '403': {}, '404': {}, '503': {} } },
      delete: { responses: { '204': { headers: { 'X-Request-ID': { $ref: '#/components/headers/XRequestId' } } }, '400': {}, '403': {}, '404': {}, '503': {} } }
    });
    expect(api.paths['/v1/pairing/peers/{peerId}/libraries/{libraryId}/tag-write']).toMatchObject({
      put: { responses: { '204': {}, '403': {}, '409': {}, '503': {} } },
      delete: { responses: {
        '200': { content: { 'application/json': { schema: { required: ['status', 'replicatedEventsRemain'], properties: { replicatedEventsRemain: { const: true } } } } } },
        '403': {}, '503': {}
      } }
    });
    expect(api.paths['/v1/pairing/libraries/{libraryId}/tag-writers']).toMatchObject({ get: { responses: { '200': {}, '403': {}, '503': {} } } });
    expect(api.paths['/v1/pairing/peers/{peerId}/tag-sync-status']).toMatchObject({ get: { responses: { '200': {}, '403': {}, '503': {} } } });
  });

  it('documents the implemented security headers and non-success status codes', async () => {
    const apiPath = path.join(repoRoot, 'contracts/openapi_draft.yaml');
    type ContractResponse = { headers?: Record<string, { schema?: Record<string, unknown> }> };
    type ContractOperation = { responses: Record<string, ContractResponse> };
    const api = parse(await readFile(apiPath, 'utf8')) as { paths: Record<string, Record<string, ContractOperation>> };
    const original = api.paths['/v1/assets/{assetId}/original']!.get!.responses;
    expect(original['200']!.headers).toMatchObject({
      ETag: { schema: { type: 'string' } },
      'Content-Disposition': { schema: { type: 'string' } },
      'Cache-Control': { schema: { type: 'string', const: 'no-store' } },
      'X-Content-Type-Options': { schema: { type: 'string', const: 'nosniff' } }
    });
    expect(original['500']).toBeDefined();

    const thumbnail = api.paths['/v1/libraries/{libraryId}/assets/{assetId}/thumbnail']!.get!.responses;
    expect(thumbnail['200']!.headers).toMatchObject({
      'Cache-Control': { schema: { type: 'string', const: 'private, no-store' } },
      'X-Content-Type-Options': { schema: { type: 'string', const: 'nosniff' } },
      'Content-Disposition': { schema: { type: 'string', const: 'inline' } },
      Vary: { schema: { type: 'string', const: 'Authorization' } }
    });
    expect(thumbnail['429']!.headers?.['Retry-After']?.schema).toMatchObject({ const: '1' });

    const versionContent = api.paths['/v1/libraries/{libraryId}/assets/{assetId}/versions/{versionId}/content']!.get!.responses['200']!.headers;
    expect(versionContent).toMatchObject({
      'Cache-Control': { schema: { type: 'string', const: 'no-store' } },
      'X-Content-Type-Options': { schema: { type: 'string', const: 'nosniff' } },
      'Content-Disposition': { schema: { type: 'string', const: 'inline' } }
    });

    expect(api.paths['/v1/diagnostics']!.get!.responses.default!.headers?.['Cache-Control']?.schema).toMatchObject({ const: 'no-store' });
    expect(api.paths['/v1/pairing/manual-discovery']!.post!.responses['502']).toBeDefined();
    expect(api.paths['/v1/pairing/peers/{peerId}/approval']!.post!.responses['400']).toBeDefined();
    expect(api.paths['/v1/libraries']!.get!.responses['401']).toBeUndefined();
  });
});
