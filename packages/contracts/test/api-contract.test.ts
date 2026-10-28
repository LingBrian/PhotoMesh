import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';
import { parse } from 'yaml';
import { afterAll, describe, expect, it } from 'vitest';
import { createNodeAgentServer, type GalleryServerControl, type PairingServerControl } from '../../../apps/node-agent/src/server.js';
import type { UploadService } from '../../../apps/node-agent/src/uploads/service.js';

const packageDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = path.resolve(packageDir, '../..');
const apiPath = path.join(repoRoot, 'contracts/openapi_draft.yaml');
const supportedMethods = new Set(['get', 'post', 'put', 'delete', 'patch', 'head', 'options', 'trace']);

type OperationMethod = 'get' | 'post' | 'put' | 'delete';
interface RouteCase {
  template: string;
  method: OperationMethod;
  path: string;
  status: number;
  error?: string;
  body?: unknown;
  headers?: Record<string, string>;
  authorization?: string;
  expectedTags?: string[];
  expectedAlbum?: { albumId: string; libraryId: string; title: string; createdByPeerId: string; createdAt: string };
  expectedAlbums?: Array<{ albumId: string; libraryId: string; title: string; createdByPeerId: string; createdAt: string }>;
  expectedMembers?: Array<{ assetId: string }>;
  requestHeaders?: Record<string, string>;
}

interface ContractAssetPage {
  items: Array<{ assetId: string; tags: string[] }>;
}

interface ContractResponse {
  headers?: Record<string, unknown>;
  content?: Record<string, { schema?: unknown }>;
}

interface ContractOperation {
  responses: Record<string, ContractResponse>;
  security?: unknown[];
  parameters?: Array<{ name?: string; in?: string; required?: boolean; $ref?: string }>;
  requestBody?: { required?: boolean; content?: Record<string, { schema?: unknown }> };
}

interface ApiErrorSchema {
  type: string;
  required: string[];
  additionalProperties?: boolean;
  properties: {
    error: { type: string; examples: string[] };
    requestId: { type: string };
  };
}

interface OpenApiContract {
  paths: Record<string, Record<string, ContractOperation>>;
  security?: unknown[];
  components: {
    schemas: Record<string, unknown> & { ApiError: ApiErrorSchema };
    parameters: Record<string, unknown>;
  };
}

const routes: RouteCase[] = [
  { template: '/v1/health', method: 'get', path: '/v1/health', status: 200 },
  { template: '/v1/diagnostics', method: 'get', path: '/v1/diagnostics', status: 403, error: 'forbidden', headers: { 'Cache-Control': 'no-store' } },
  { template: '/v1/diagnostics', method: 'get', path: '/v1/diagnostics', status: 200, authorization: 'Bearer contract-admin', headers: { 'Cache-Control': 'no-store' } },
  { template: '/v1/libraries', method: 'get', path: '/v1/libraries', status: 403, error: 'forbidden' },
  { template: '/v1/assets', method: 'get', path: '/v1/assets?libraryId=lib', status: 403, error: 'forbidden' },
  { template: '/v1/assets/{assetId}/original', method: 'get', path: '/v1/assets/asset/original', status: 404, error: 'not_found' },
  { template: '/v1/libraries/{libraryId}/assets/{assetId}/thumbnail', method: 'get', path: '/v1/libraries/lib/assets/asset/thumbnail', status: 404, error: 'not_found' },
  { template: '/v1/libraries/{libraryId}/assets/{assetId}/versions', method: 'get', path: '/v1/libraries/lib/assets/asset/versions', status: 403, error: 'forbidden' },
  { template: '/v1/libraries/{libraryId}/assets/{assetId}/versions', method: 'post', path: '/v1/libraries/lib/assets/asset/versions', status: 403, error: 'forbidden' },
  { template: '/v1/libraries/{libraryId}/assets/{assetId}/versions/{versionId}', method: 'get', path: '/v1/libraries/lib/assets/asset/versions/ver', status: 403, error: 'forbidden' },
  { template: '/v1/libraries/{libraryId}/assets/{assetId}/versions/{versionId}/content', method: 'get', path: '/v1/libraries/lib/assets/asset/versions/ver/content', status: 403, error: 'forbidden' },
  { template: '/v1/recycle-bin', method: 'get', path: '/v1/recycle-bin?libraryId=lib', status: 403, error: 'forbidden' },
  { template: '/v1/recycle-bin/restore', method: 'post', path: '/v1/recycle-bin/restore', status: 403, error: 'forbidden' },
  { template: '/v1/pairing/invitations', method: 'post', path: '/v1/pairing/invitations', status: 403, error: 'forbidden' },
  { template: '/v1/pairing/join', method: 'post', path: '/v1/pairing/join', status: 403, error: 'forbidden' },
  { template: '/v1/pairing/peers', method: 'get', path: '/v1/pairing/peers', status: 403, error: 'forbidden' },
  { template: '/v1/pairing/libraries/{libraryId}/tag-writers', method: 'get', path: '/v1/pairing/libraries/lib/tag-writers', status: 403, error: 'forbidden' },
  { template: '/v1/pairing/peers/{peerId}/tag-sync-status', method: 'get', path: '/v1/pairing/peers/peer/tag-sync-status', status: 403, error: 'forbidden' },
  { template: '/v1/pairing/peers/{peerId}/libraries/{libraryId}/album-write', method: 'put', path: '/v1/pairing/peers/peer/libraries/lib/album-write', status: 403, error: 'forbidden' },
  { template: '/v1/pairing/peers/{peerId}/libraries/{libraryId}/album-write', method: 'delete', path: '/v1/pairing/peers/peer/libraries/lib/album-write', status: 403, error: 'forbidden' },
  { template: '/v1/pairing/peers/{peerId}/libraries/{libraryId}/album-delete', method: 'put', path: '/v1/pairing/peers/peer/libraries/lib/album-delete', status: 403, error: 'forbidden' },
  { template: '/v1/pairing/peers/{peerId}/libraries/{libraryId}/album-delete', method: 'delete', path: '/v1/pairing/peers/peer/libraries/lib/album-delete', status: 403, error: 'forbidden' },
  { template: '/v1/pairing/libraries/{libraryId}/album-sync-grants', method: 'get', path: '/v1/pairing/libraries/lib/album-sync-grants', status: 403, error: 'forbidden' },
  { template: '/v1/pairing/peers/{peerId}/album-sync-status', method: 'get', path: '/v1/pairing/peers/peer/album-sync-status', status: 403, error: 'forbidden' },
  { template: '/v1/pairing/peers/{peerId}/libraries/{libraryId}/tag-write', method: 'put', path: '/v1/pairing/peers/peer/libraries/lib/tag-write', status: 403, error: 'forbidden' },
  { template: '/v1/pairing/peers/{peerId}/libraries/{libraryId}/tag-write', method: 'delete', path: '/v1/pairing/peers/peer/libraries/lib/tag-write', status: 403, error: 'forbidden' },
  { template: '/v1/pairing/peers/{peerId}/approval', method: 'post', path: '/v1/pairing/peers/peer/approval', status: 403, error: 'forbidden' },
  { template: '/v1/pairing/peers/{peerId}', method: 'delete', path: '/v1/pairing/peers/peer', status: 403, error: 'forbidden' },
  { template: '/v1/pairing/peers/{peerId}/libraries/{libraryId}', method: 'put', path: '/v1/pairing/peers/peer/libraries/lib', status: 403, error: 'forbidden' },
  { template: '/v1/pairing/discovered', method: 'get', path: '/v1/pairing/discovered', status: 403, error: 'forbidden' },
  { template: '/v1/pairing/manual-discovery', method: 'post', path: '/v1/pairing/manual-discovery', status: 403, error: 'forbidden' },
  { template: '/v1/pairing/manual-discovery', method: 'post', path: '/v1/pairing/manual-discovery', status: 400, error: 'invalid_request', body: {}, authorization: 'Bearer contract-admin' },
  {
    template: '/v1/pairing/manual-discovery', method: 'post', path: '/v1/pairing/manual-discovery', status: 502, error: 'peer_unreachable',
    body: { host: '192.168.1.23', port: 4567, peerId: '12D3KooWExample' }, authorization: 'Bearer contract-admin'
  },
  {
    template: '/v1/uploads', method: 'post', path: '/v1/uploads', status: 403, error: 'forbidden',
    body: { libraryId: 'lib', filename: 'photo.jpg', sourceKind: 'upload', totalBytes: 0, sha256: '0'.repeat(64) }
  },
  { template: '/v1/uploads', method: 'post', path: '/v1/uploads', status: 400, error: 'invalid_request', body: {} },
  { template: '/v1/uploads/{sessionId}', method: 'get', path: '/v1/uploads/session', status: 403, error: 'forbidden' },
  { template: '/v1/uploads/{sessionId}/chunks/{chunkIndex}', method: 'put', path: '/v1/uploads/session/chunks/0', status: 403, error: 'forbidden' },
  { template: '/v1/uploads/{sessionId}/complete', method: 'post', path: '/v1/uploads/session/complete', status: 403, error: 'forbidden' },
  { template: '/v1/libraries/{libraryId}/assets/{assetId}/tags/{tag}', method: 'put', path: '/v1/libraries/lib/assets/asset/tags/Summer', status: 403, error: 'forbidden' },
  { template: '/v1/libraries/{libraryId}/assets/{assetId}/tags/{tag}', method: 'put', path: '/v1/libraries/lib/assets/asset/tags/Summer', status: 204, authorization: 'Bearer contract-admin' },
  { template: '/v1/libraries/{libraryId}/assets/{assetId}/tags/{tag}', method: 'put', path: '/v1/libraries/lib/assets/asset/tags/Summer', status: 204, authorization: 'Bearer contract-admin' },
  { template: '/v1/libraries/{libraryId}/assets/{assetId}/tags/{tag}', method: 'put', path: '/v1/libraries/lib/assets/asset/tags/%20summer%20', status: 204, authorization: 'Bearer contract-admin' },
  { template: '/v1/assets', method: 'get', path: '/v1/assets?libraryId=lib', status: 200, authorization: 'Bearer contract-admin', expectedTags: ['Summer', 'summer'] },
  { template: '/v1/libraries/{libraryId}/assets/{assetId}/tags/{tag}', method: 'put', path: '/v1/libraries/lib/assets/asset/tags/%20%20', status: 400, error: 'invalid_request', authorization: 'Bearer contract-admin' },
  { template: '/v1/libraries/{libraryId}/assets/{assetId}/tags/{tag}', method: 'put', path: `/v1/libraries/lib/assets/asset/tags/${encodeURIComponent('图'.repeat(43))}`, status: 400, error: 'invalid_request', authorization: 'Bearer contract-admin' },
  { template: '/v1/libraries/{libraryId}/assets/{assetId}/tags/{tag}', method: 'put', path: '/v1/libraries/lib/assets/missing/tags/Hidden', status: 404, error: 'not_found', authorization: 'Bearer contract-admin' },
  { template: '/v1/libraries/{libraryId}/assets/{assetId}/tags/{tag}', method: 'delete', path: '/v1/libraries/lib/assets/asset/tags/Summer', status: 204, authorization: 'Bearer contract-admin' },
  { template: '/v1/libraries/{libraryId}/assets/{assetId}/tags/{tag}', method: 'delete', path: '/v1/libraries/lib/assets/asset/tags/Summer', status: 204, authorization: 'Bearer contract-admin' },
  { template: '/v1/assets', method: 'get', path: '/v1/assets?libraryId=lib', status: 200, authorization: 'Bearer contract-admin', expectedTags: ['summer'] },
  { template: '/v1/libraries/{libraryId}/assets/{assetId}/tags/{tag}', method: 'delete', path: '/v1/libraries/lib/assets/asset/tags/%20summer%20', status: 204, authorization: 'Bearer contract-admin' },
  { template: '/v1/libraries/{libraryId}/assets/{assetId}/tags/{tag}', method: 'delete', path: '/v1/libraries/lib/assets/asset/tags/summer', status: 204, authorization: 'Bearer contract-admin' },
  { template: '/v1/assets', method: 'get', path: '/v1/assets?libraryId=lib', status: 200, authorization: 'Bearer contract-admin', expectedTags: [] },
  { template: '/v1/libraries/{libraryId}/albums', method: 'get', path: '/v1/libraries/lib/albums', status: 403, error: 'forbidden', headers: { 'Cache-Control': 'private, no-store' } },
  { template: '/v1/libraries/{libraryId}/albums', method: 'get', path: '/v1/libraries/lib/albums', status: 200, authorization: 'Bearer contract-admin', expectedAlbums: [{ albumId: 'album-1', libraryId: 'lib', title: 'Family', createdByPeerId: 'node-local', createdAt: '2026-10-28T00:00:00.000Z' }], headers: { 'Cache-Control': 'private, no-store' } },
  { template: '/v1/libraries/{libraryId}/albums', method: 'post', path: '/v1/libraries/lib/albums', status: 403, error: 'forbidden', body: { title: 'Family' }, headers: { 'Cache-Control': 'private, no-store' } },
  { template: '/v1/libraries/{libraryId}/albums', method: 'post', path: '/v1/libraries/lib/albums', status: 400, error: 'invalid_request', body: {}, authorization: 'Bearer contract-admin', headers: { 'Cache-Control': 'private, no-store' } },
  { template: '/v1/libraries/{libraryId}/albums', method: 'post', path: '/v1/libraries/lib/albums', status: 201, authorization: 'Bearer contract-admin', body: { title: 'Family' }, requestHeaders: { 'idempotency-key': '123e4567-e89b-42d3-a456-426614174000' }, expectedAlbum: { albumId: 'album-1', libraryId: 'lib', title: 'Family', createdByPeerId: 'node-local', createdAt: '2026-10-28T00:00:00.000Z' }, headers: { 'Cache-Control': 'private, no-store' } },
  { template: '/v1/libraries/{libraryId}/albums/{albumId}/deletion', method: 'post', path: '/v1/libraries/lib/albums/album-1/deletion', status: 403, error: 'forbidden', headers: { 'Cache-Control': 'private, no-store' } },
  { template: '/v1/libraries/{libraryId}/albums/deleted', method: 'get', path: '/v1/libraries/lib/albums/deleted?scope=all', status: 403, error: 'forbidden', headers: { 'Cache-Control': 'private, no-store' } },
  { template: '/v1/libraries/{libraryId}/albums/{albumId}/restore', method: 'post', path: '/v1/libraries/lib/albums/album-1/restore', status: 403, error: 'forbidden', headers: { 'Cache-Control': 'private, no-store' } },
  { template: '/v1/libraries/{libraryId}/albums/{albumId}/members', method: 'get', path: '/v1/libraries/lib/albums/album-1/members', status: 403, error: 'forbidden', headers: { 'Cache-Control': 'private, no-store' } },
  { template: '/v1/libraries/{libraryId}/albums/{albumId}/members', method: 'get', path: '/v1/libraries/lib/albums/album-1/members', status: 200, authorization: 'Bearer contract-admin', expectedMembers: [{ assetId: 'asset' }], headers: { 'Cache-Control': 'private, no-store' } },
  { template: '/v1/libraries/{libraryId}/albums/{albumId}/members/{assetId}', method: 'put', path: '/v1/libraries/lib/albums/album-1/members/asset', status: 403, error: 'forbidden', headers: { 'Cache-Control': 'private, no-store' } },
  { template: '/v1/libraries/{libraryId}/albums/{albumId}/members/{assetId}', method: 'put', path: '/v1/libraries/lib/albums/album-1/members/asset', status: 400, error: 'invalid_request', authorization: 'Bearer contract-admin', headers: { 'Cache-Control': 'private, no-store' } },
  { template: '/v1/libraries/{libraryId}/albums/{albumId}/members/{assetId}', method: 'put', path: '/v1/libraries/lib/albums/album-1/members/asset', status: 204, authorization: 'Bearer contract-admin', requestHeaders: { 'idempotency-key': '223e4567-e89b-42d3-a456-426614174000' }, headers: { 'Cache-Control': 'private, no-store' } },
  { template: '/v1/libraries/{libraryId}/albums/{albumId}/members/{assetId}', method: 'delete', path: '/v1/libraries/lib/albums/album-1/members/asset', status: 403, error: 'forbidden', headers: { 'Cache-Control': 'private, no-store' } },
  { template: '/v1/libraries/{libraryId}/albums/{albumId}/members/{assetId}', method: 'delete', path: '/v1/libraries/lib/albums/album-1/members/asset', status: 400, error: 'invalid_request', authorization: 'Bearer contract-admin', headers: { 'Cache-Control': 'private, no-store' } },
  { template: '/v1/libraries/{libraryId}/albums/{albumId}/members/{assetId}', method: 'delete', path: '/v1/libraries/lib/albums/album-1/members/asset', status: 204, authorization: 'Bearer contract-admin', requestHeaders: { 'idempotency-key': '323e4567-e89b-42d3-a456-426614174000' }, headers: { 'Cache-Control': 'private, no-store' } }
];

const tagKey = 'lib:asset';
const visibleAssetTags = new Map<string, Set<string>>([[tagKey, new Set<string>()]]);
const server = createNodeAgentServer({
  authorizePairingAdmin: (token) => token === 'contract-admin',
  authorizeLibraryRead: (token, libraryId) => token === 'contract-admin' && libraryId === 'lib' ? 'local-admin' : undefined,
  authorizeLibraryList: () => false,
  authorizeUpload: () => undefined,
  diagnostics: {
    checkDatabase: () => undefined,
    checkStorage: () => undefined,
    apiCapabilities: () => [],
    storageCapabilities: () => [],
    identityCapabilities: () => []
  },
  pairingControl: { dialManualIp: async () => { throw new Error('peer unavailable'); } } as unknown as PairingServerControl,
  uploadService: {} as unknown as UploadService,
  gallery: {
    listLibraries: () => [{ libraryId: 'lib', title: 'lib' }],
    listAssets: (libraryId: string) => ({
      items: [{ assetId: 'asset', libraryId, tags: [...(visibleAssetTags.get(`${libraryId}:asset`) ?? [])].sort() }], nextCursor: null
    }),
    getOriginal: async () => undefined
  } as unknown as GalleryServerControl,
  albums: {
    listAlbums: () => ({ items: [{ albumId: 'album-1', libraryId: 'lib', title: 'Family', createdByPeerId: 'node-local', createdAt: '2026-10-28T00:00:00.000Z' }], nextCursor: null }),
    createAlbum: () => ({ albumId: 'album-1', libraryId: 'lib', title: 'Family', createdByPeerId: 'node-local', createdAt: '2026-10-28T00:00:00.000Z' }),
    listMembers: () => ({ items: [{ assetId: 'asset' }], nextCursor: null }),
    addMember: () => ({ status: 'added' }),
    removeMember: () => ({ status: 'removed', observedAddIds: ['add-1'] })
  },
  assetTags: {
    addAssetTag: (libraryId: string, assetId: string, tag: string) => {
      const key = `${libraryId}:${assetId}`;
      if (!visibleAssetTags.has(key)) return 'not_found';
      const tags = visibleAssetTags.get(key)!;
      if (tags.has(tag)) return 'already_present';
      if (tags.size >= 64) return 'limit_reached';
      tags.add(tag);
      return 'added';
    },
    removeAssetTag: (libraryId: string, assetId: string, tag: string) => {
      const key = `${libraryId}:${assetId}`;
      if (!visibleAssetTags.has(key)) return 'not_found';
      return visibleAssetTags.get(key)!.delete(tag) ? 'removed' : 'unchanged';
    }
  }
});

afterAll(async () => {
  if (server.listening) await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
});

async function loadContract(): Promise<OpenApiContract> {
  return parse(await readFile(apiPath, 'utf8')) as OpenApiContract;
}

describe('implemented Node HTTP API contract', () => {
  it('documents exactly the HTTP operations exercised against the Node Agent', async () => {
    const contract = await loadContract();
    const documented = Object.entries(contract.paths)
      .flatMap(([template, item]) => Object.keys(item).filter((method) => supportedMethods.has(method)).map((method) => `${method.toUpperCase()} ${template}`))
      .sort();
    const exercised = [...new Set(routes.map(({ template, method }) => `${method.toUpperCase()} ${template}`))].sort();

    expect(documented).toEqual(exercised);
    expect(contract.security).toEqual([{ nodeAdminBearer: [] }]);
    expect(contract.paths['/v1/health']!.get!.security).toEqual([]);
  });

  it('defines bounded, strict album DTOs and private album responses', async () => {
    const contract = await loadContract();
    const schemas = contract.components.schemas as Record<string, {
      additionalProperties?: boolean;
      required?: string[];
      properties?: Record<string, { type?: string | string[]; maxItems?: number; items?: { $ref?: string }; 'x-maxUtf8Bytes'?: number }>;
    }>;
    expect(schemas.Album?.additionalProperties).toBe(false);
    expect(Object.keys(schemas.Album?.properties ?? {}).sort()).toEqual(['albumId', 'createdAt', 'createdByPeerId', 'libraryId', 'title']);
    expect(schemas.CreateAlbumRequest?.additionalProperties).toBe(false);
    expect(schemas.CreateAlbumRequest?.properties?.title?.['x-maxUtf8Bytes']).toBe(256);
    expect(schemas.AlbumPage?.properties?.items?.maxItems).toBe(200);
    expect(schemas.AlbumPage?.properties?.nextCursor?.type).toEqual(['string', 'null']);
    expect(schemas.AlbumMemberPage?.properties?.totalCount).toBeUndefined();
    expect(schemas.AlbumMember?.additionalProperties).toBe(false);
    expect(Object.keys(schemas.AlbumMember?.properties ?? {})).toEqual(['assetId']);

    for (const template of [
      '/v1/libraries/{libraryId}/albums',
      '/v1/libraries/{libraryId}/albums/{albumId}/members',
      '/v1/libraries/{libraryId}/albums/{albumId}/members/{assetId}'
    ]) {
      const path = contract.paths[template]!;
      for (const method of Object.keys(path).filter((key) => ['get', 'post', 'put', 'delete'].includes(key))) {
        const operation = path[method]!;
        for (const response of Object.values(operation.responses)) {
          const cache = response.headers?.['Cache-Control'] as { schema?: { const?: string } } | undefined;
          expect(cache?.schema?.const, `${method} ${template}`).toBe('private, no-store');
        }
        if (method === 'post' || method === 'put' || method === 'delete') {
          expect(operation.parameters).toContainEqual({ $ref: '#/components/parameters/AlbumIdempotencyKey' });
        }
      }
    }
    expect(contract.components.parameters.AlbumIdempotencyKey).toMatchObject({
      name: 'Idempotency-Key', in: 'header', required: true
    });
  });

  it('documents PM-045 album soft-delete, restore, and separated sync grants', async () => {
    const contract = await loadContract();
    const paths = contract.paths;
    const deletion = paths['/v1/libraries/{libraryId}/albums/{albumId}/deletion']?.post;
    const deleted = paths['/v1/libraries/{libraryId}/albums/deleted']?.get;
    const restore = paths['/v1/libraries/{libraryId}/albums/{albumId}/restore']?.post;
    expect(deletion).toBeDefined();
    expect(deleted).toBeDefined();
    expect(restore).toBeDefined();
    expect(deletion?.parameters).toContainEqual({ $ref: '#/components/parameters/AlbumIdempotencyKey' });
    expect(deletion?.requestBody?.content?.['application/json']?.schema).toEqual({ $ref: '#/components/schemas/AlbumDeletionRequest' });
    expect(restore?.requestBody?.content?.['application/json']?.schema).toEqual({ $ref: '#/components/schemas/AlbumRestoreRequest' });
    expect(deleted?.parameters?.map(({ name }) => name)).toEqual(expect.arrayContaining(['scope', 'cursor', 'limit']));

    const schemas = contract.components.schemas as Record<string, {
      additionalProperties?: boolean;
      properties?: Record<string, { type?: string | string[]; enum?: string[]; minItems?: number; maxItems?: number; uniqueItems?: boolean }>;
    }>;
    for (const name of ['AlbumDeletionRequest', 'AlbumRestoreRequest', 'DeletedAlbumPage', 'DeletedAlbum', 'AlbumSyncGrantRequest', 'AlbumSyncGrantStatus']) {
      expect(schemas[name], `schema ${name}`).toBeDefined();
      expect(schemas[name]?.additionalProperties).toBe(false);
    }
    expect(schemas.AlbumDeletionRequest?.properties?.scope?.enum).toEqual(['local', 'global']);
    expect(schemas.DeletedAlbum?.properties?.scopes).toMatchObject({ type: 'array', minItems: 1, maxItems: 2, uniqueItems: true });
    expect(schemas.DeletedAlbumPage?.properties?.items?.maxItems).toBe(200);
    expect(deletion?.responses['204']).toBeDefined();
    expect(restore?.responses['204']).toBeDefined();

    for (const permission of ['album-write', 'album-delete']) {
      const path = `/v1/pairing/peers/{peerId}/libraries/{libraryId}/${permission}`;
      expect(paths[path]?.put, `${path} grant`).toBeDefined();
      expect(paths[path]?.delete, `${path} revoke`).toBeDefined();
      expect(paths[path]?.put?.requestBody?.content?.['application/json']?.schema).toEqual({ $ref: '#/components/schemas/AlbumSyncGrantRequest' });
    }
    expect(paths['/v1/pairing/libraries/{libraryId}/album-sync-grants']?.get).toBeDefined();
    expect(paths['/v1/pairing/peers/{peerId}/album-sync-status']?.get).toBeDefined();
  });

  it('declares an open error envelope and a request-id header for every response', async () => {
    const contract = await loadContract();
    const errorSchema = contract.components.schemas.ApiError!;
    expect(errorSchema).toMatchObject({
      type: 'object',
      required: ['error', 'requestId'],
      properties: { error: { type: 'string' }, requestId: { type: 'string' } }
    });
    expect(errorSchema.additionalProperties).not.toBe(false);

    for (const route of routes) {
      const operation = contract.paths[route.template]![route.method]!;
      for (const [status, response] of Object.entries(operation.responses)) {
        expect(response.headers?.['X-Request-ID'], `${route.method} ${route.template} response ${status}`).toBeDefined();
        if (status === 'default' || Number(status) >= 400) {
          expect(response.content?.['application/json']?.schema, `${route.method} ${route.template} error ${status}`)
            .toEqual({ $ref: '#/components/schemas/ApiError' });
        }
      }
    }
  });

  it('matches live route status, error body, request-id, and route-specific headers', async () => {
    const contract = await loadContract();
    const errorValidator = new Ajv2020.default({ allErrors: true }).compile(contract.components.schemas.ApiError!);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Expected an ephemeral TCP address');

    for (const [index, route] of routes.entries()) {
      const requestId = `pm040-contract-${index}`;
      const headers = {
        'x-request-id': requestId,
        ...(route.authorization ? { authorization: route.authorization } : {}),
        ...(route.body ? { 'content-type': 'application/json' } : {}),
        ...(route.requestHeaders ?? {})
      };
      const response = await fetch(`http://127.0.0.1:${address.port}${route.path}`, {
        method: route.method.toUpperCase(), headers,
        ...(route.body ? { body: JSON.stringify(route.body) } : {})
      });
      expect(response.status, `${route.method} ${route.path}`).toBe(route.status);
      const operation = contract.paths[route.template]![route.method]!;
      const responseContract = operation.responses[String(response.status)]!;
      expect(responseContract, `${route.method} ${route.template} status ${response.status}`).toBeDefined();
      expect(response.headers.get('x-request-id')).toBe(requestId);
      expect(responseContract.headers?.['X-Request-ID']).toBeDefined();
      for (const [name, value] of Object.entries(route.headers ?? {})) {
        expect(response.headers.get(name.toLowerCase())).toBe(value);
        expect(responseContract.headers?.[name]).toBeDefined();
      }
      if (route.error) {
        const body: unknown = await response.json();
        expect(errorValidator(body)).toBe(true);
        expect(contract.components.schemas.ApiError!.properties.error.examples).toContain(route.error);
        expect(body).toMatchObject({ error: route.error, requestId });
      }
      if (route.expectedTags) {
        const body: ContractAssetPage = await response.json() as ContractAssetPage;
        expect(body.items.find(({ assetId }) => assetId === 'asset')?.tags).toEqual(route.expectedTags);
      }
      if (route.expectedAlbum) expect(await response.json()).toEqual(route.expectedAlbum);
      if (route.expectedAlbums) expect(await response.json()).toEqual({ items: route.expectedAlbums, nextCursor: null });
      if (route.expectedMembers) expect(await response.json()).toEqual({ items: route.expectedMembers, nextCursor: null });
    }
  });
});
