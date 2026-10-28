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
  components: { schemas: Record<string, ApiErrorSchema> };
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
  { template: '/v1/assets', method: 'get', path: '/v1/assets?libraryId=lib', status: 200, authorization: 'Bearer contract-admin', expectedTags: [] }
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
    listAssets: (libraryId: string) => ({
      items: [{ assetId: 'asset', libraryId, tags: [...(visibleAssetTags.get(`${libraryId}:asset`) ?? [])].sort() }], nextCursor: null
    }),
    getOriginal: async () => undefined
  } as unknown as GalleryServerControl,
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
        ...(route.body ? { 'content-type': 'application/json' } : {})
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
    }
  });
});
