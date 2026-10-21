import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { getHealth } from './health.js';
import { UploadError, UploadService, type CreateUploadRequest } from './uploads/service.js';

export interface UploadAuthorizationRequest {
  token: string | undefined;
  action: 'create' | 'read' | 'write' | 'complete';
  libraryId?: string;
  sessionId?: string;
}

export interface UploadPrincipal {
  principalId: string;
}

export type UploadAuthorizer = (request: UploadAuthorizationRequest) => Promise<UploadPrincipal | undefined> | UploadPrincipal | undefined;

export interface NodeAgentServerOptions {
  uploadService?: UploadService;
  authorizeUpload?: UploadAuthorizer;
  maxRequestBytes?: number;
}

export function createNodeAgentServer(options: NodeAgentServerOptions = {}) {
  return createServer((request, response) => {
    const requestId = headerValue(request, 'x-request-id') ?? randomUUID();
    response.setHeader('x-request-id', requestId);
    void handleRequest(request, response, options, requestId).catch((error: unknown) => {
      const apiError = error instanceof UploadError ? error : new UploadError('STORAGE_IO', 'Request handling failed');
      sendJson(response, statusFor(apiError), { error: apiError.code.toLowerCase(), requestId });
    });
  });
}

async function handleRequest(request: IncomingMessage, response: ServerResponse, options: NodeAgentServerOptions, requestId: string): Promise<void> {
  const url = new URL(request.url ?? '/', `http://${headerValue(request, 'host') ?? 'localhost'}`);
  if (request.method === 'GET' && url.pathname === '/v1/health') {
    sendJson(response, 200, getHealth());
    return;
  }

  const service = options.uploadService;
  if (!service) {
    sendJson(response, 404, { error: 'not_found', requestId });
    return;
  }

  if (request.method === 'POST' && url.pathname === '/v1/uploads') {
    const input = await readJsonBody(request, options.maxRequestBytes ?? 64 * 1024);
    if (!isCreateUploadRequest(input)) {
      sendJson(response, 400, { error: 'invalid_request', requestId });
      return;
    }
    const principal = await authorize(options, {
      token: bearerToken(request), action: 'create', libraryId: input.libraryId
    });
    if (!principal) {
      sendJson(response, 403, { error: 'forbidden', requestId });
      return;
    }
    const idempotencyKey = headerValue(request, 'idempotency-key');
    if (!idempotencyKey) {
      sendJson(response, 400, { error: 'invalid_request', requestId });
      return;
    }
    const created = await service.createSession(idempotencyKey, input, principal.principalId);
    sendJson(response, 201, created);
    return;
  }

  const sessionPath = url.pathname.match(/^\/v1\/uploads\/([^/]+)$/);
  if (request.method === 'GET' && sessionPath?.[1]) {
    const sessionId = decodeURIComponent(sessionPath[1]);
    const principal = await authorize(options, { token: bearerToken(request), action: 'read', sessionId });
    if (!principal) {
      sendJson(response, 403, { error: 'forbidden', requestId });
      return;
    }
    sendJson(response, 200, service.getSession(sessionId));
    return;
  }

  const chunkPath = url.pathname.match(/^\/v1\/uploads\/([^/]+)\/chunks\/(\d+)$/);
  if (request.method === 'PUT' && chunkPath?.[1] && chunkPath[2]) {
    const sessionId = decodeURIComponent(chunkPath[1]);
    const principal = await authorize(options, { token: bearerToken(request), action: 'write', sessionId });
    if (!principal) {
      sendJson(response, 403, { error: 'forbidden', requestId });
      return;
    }
    const offset = Number(headerValue(request, 'upload-offset'));
    const checksum = headerValue(request, 'upload-chunk-sha256') ?? '';
    if (!Number.isSafeInteger(offset) || offset < 0) {
      sendJson(response, 400, { error: 'invalid_request', requestId });
      return;
    }
    const bytes = await readBytes(request, options.maxRequestBytes ?? 8 * 1024 * 1024);
    const session = await service.putChunk(sessionId, Number(chunkPath[2]), offset, bytes, checksum);
    sendJson(response, 200, session);
    return;
  }

  const completePath = url.pathname.match(/^\/v1\/uploads\/([^/]+)\/complete$/);
  if (request.method === 'POST' && completePath?.[1]) {
    const sessionId = decodeURIComponent(completePath[1]);
    const principal = await authorize(options, { token: bearerToken(request), action: 'complete', sessionId });
    if (!principal) {
      sendJson(response, 403, { error: 'forbidden', requestId });
      return;
    }
    const result = await service.complete(sessionId);
    sendJson(response, 200, result);
    return;
  }

  sendJson(response, 404, { error: 'not_found', requestId });
}

async function authorize(options: NodeAgentServerOptions, request: UploadAuthorizationRequest): Promise<UploadPrincipal | undefined> {
  return options.authorizeUpload?.(request);
}

async function readJsonBody(request: IncomingMessage, limit: number): Promise<unknown> {
  const bytes = await readBytes(request, limit);
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  } catch {
    return undefined;
  }
}

async function readBytes(request: IncomingMessage, limit: number): Promise<Uint8Array> {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const value of request) {
    const chunk = value as Buffer;
    length += chunk.byteLength;
    if (length > limit) throw new UploadError('TOO_LARGE', 'Request body exceeds configured limit');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, length);
}

function isCreateUploadRequest(value: unknown): value is CreateUploadRequest {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<CreateUploadRequest>;
  return typeof candidate.libraryId === 'string'
    && typeof candidate.filename === 'string'
    && (candidate.originalPath === undefined || typeof candidate.originalPath === 'string')
    && (candidate.sourceKind === 'upload' || candidate.sourceKind === 'import')
    && (candidate.sourceNodeId === undefined || typeof candidate.sourceNodeId === 'string')
    && (candidate.kind === undefined || candidate.kind === 'photo' || candidate.kind === 'video' || candidate.kind === 'live_photo')
    && typeof candidate.totalBytes === 'number'
    && typeof candidate.sha256 === 'string';
}

function bearerToken(request: IncomingMessage): string | undefined {
  const authorization = headerValue(request, 'authorization');
  const match = authorization?.match(/^Bearer\s+(.+)$/i);
  return match?.[1];
}

function headerValue(request: IncomingMessage, name: string): string | undefined {
  const value = request.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  if (response.headersSent) return;
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(body));
}

function statusFor(error: UploadError): number {
  switch (error.code) {
    case 'NOT_FOUND': return 404;
    case 'SESSION_EXPIRED': return 410;
    case 'TOO_LARGE': return 413;
    case 'CHECKSUM_MISMATCH': return 422;
    case 'CAPACITY_EXHAUSTED': return 507;
    case 'IDEMPOTENCY_CONFLICT':
    case 'OFFSET_CONFLICT':
    case 'CHUNK_CONFLICT':
    case 'SESSION_FAILED':
    case 'INCOMPLETE_UPLOAD': return 409;
    case 'INVALID_REQUEST': return 400;
    case 'STORAGE_IO': return 500;
  }
}
