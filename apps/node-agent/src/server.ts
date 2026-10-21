import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { isIP } from 'node:net';
import QRCode from 'qrcode';
import { getHealth } from './health.js';
import { UploadError, UploadService, type CreateUploadRequest } from './uploads/service.js';
import type { PairingQrPayload, PairingApproval } from './auth/pairing-service.js';
import type { PendingPeerApproval } from './auth/pairing-approval-queue.js';
import type { TrustedPeerRecord } from './db/repository.js';

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
  authorizePairingAdmin?: (token: string | undefined) => boolean;
  authorizeLibraryRead?: (token: string | undefined, libraryId: string) => string | undefined | Promise<string | undefined>;
  pairingControl?: PairingServerControl;
  maxRequestBytes?: number;
}

export interface PairingServerControl {
  createInvite(): PairingQrPayload;
  pairWithInvite(invite: PairingQrPayload, label: string, manualIp?: { host: string; port: number }): Promise<{ hostPeerId: string }>;
  listPeers(): TrustedPeerRecord[];
  listPending(): PendingPeerApproval[];
  decide(peerId: string, approval: PairingApproval): boolean;
  revokePeer(peerId: string): Promise<boolean>;
  grantLibraryRead(peerId: string, libraryId: string): void;
  readLibraryIndex(peerId: string, libraryId: string): unknown[] | undefined;
  listDiscoveredPeers(): Array<{ peerId: string; addresses: string[] }>;
  dialManualIp(host: string, port: number, peerId: string): Promise<{ peerId: string; addresses: string[] }>;
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

  if (request.method === 'GET' && url.pathname === '/v1/assets') {
    const libraryId = url.searchParams.get('libraryId');
    const peerId = libraryId ? await options.authorizeLibraryRead?.(bearerToken(request), libraryId) : undefined;
    const items = peerId && libraryId ? options.pairingControl?.readLibraryIndex(peerId, libraryId) : undefined;
    if (!items) { sendJson(response, 403, { error: 'forbidden', requestId }); return; }
    const rawLimit = Number(url.searchParams.get('limit') ?? 50);
    const cursor = url.searchParams.get('cursor');
    const rawOffset = cursor === null ? 0 : Number(cursor);
    if (!Number.isInteger(rawLimit) || rawLimit < 1 || rawLimit > 200 || !Number.isSafeInteger(rawOffset) || rawOffset < 0) {
      sendJson(response, 400, { error: 'invalid_request', requestId }); return;
    }
    const page = items.slice(rawOffset, rawOffset + rawLimit);
    sendJson(response, 200, { items: page, nextCursor: rawOffset + rawLimit < items.length ? String(rawOffset + rawLimit) : null });
    return;
  }

  if (await handlePairingRequest(request, response, options, requestId, url.pathname)) return;

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

async function handlePairingRequest(
  request: IncomingMessage, response: ServerResponse, options: NodeAgentServerOptions, requestId: string, pathname: string
): Promise<boolean> {
  const control = options.pairingControl;
  if (!control || !pathname.startsWith('/v1/pairing/')) return false;
  if (!options.authorizePairingAdmin?.(bearerToken(request))) {
    sendJson(response, 403, { error: 'forbidden', requestId });
    return true;
  }
  if (request.method === 'POST' && pathname === '/v1/pairing/invitations') {
    const invite = control.createInvite();
    const qrDataUrl = await QRCode.toDataURL(JSON.stringify(invite), { errorCorrectionLevel: 'M', margin: 2, width: 400 });
    sendJson(response, 201, { ...invite, qrDataUrl });
    return true;
  }
  if (request.method === 'POST' && pathname === '/v1/pairing/join') {
    const body = await readJsonBody(request, 16 * 1024);
    if (!isPairingJoin(body)) { sendJson(response, 400, { error: 'invalid_request', requestId }); return true; }
    try {
      const result = await control.pairWithInvite(body.invite, body.label, body.manualIp);
      sendJson(response, 200, result);
    } catch {
      sendJson(response, 403, { error: 'pairing_rejected', requestId });
    }
    return true;
  }
  if (request.method === 'GET' && pathname === '/v1/pairing/peers') {
    sendJson(response, 200, { peers: control.listPeers(), pending: control.listPending() });
    return true;
  }
  if (request.method === 'GET' && pathname === '/v1/pairing/discovered') {
    sendJson(response, 200, { peers: control.listDiscoveredPeers() });
    return true;
  }
  if (request.method === 'POST' && pathname === '/v1/pairing/manual-discovery') {
    const body = await readJsonBody(request, 8 * 1024);
    if (!isManualAddress(body)) { sendJson(response, 400, { error: 'invalid_request', requestId }); return true; }
    try {
      const discovered = await control.dialManualIp(body.host, body.port, body.peerId);
      sendJson(response, 200, discovered);
    } catch {
      sendJson(response, 502, { error: 'peer_unreachable', requestId });
    }
    return true;
  }
  const approvalPath = pathname.match(/^\/v1\/pairing\/peers\/([^/]+)\/approval$/);
  if (request.method === 'POST' && approvalPath?.[1]) {
    const body = await readJsonBody(request, 16 * 1024);
    if (!isPairingApproval(body)) { sendJson(response, 400, { error: 'invalid_request', requestId }); return true; }
    const approved = control.decide(decodeURIComponent(approvalPath[1]), body);
    sendJson(response, approved ? 200 : 404, approved ? { status: 'decided' } : { error: 'pending_request_not_found', requestId });
    return true;
  }
  const grantPath = pathname.match(/^\/v1\/pairing\/peers\/([^/]+)\/libraries\/([^/]+)$/);
  if (request.method === 'PUT' && grantPath?.[1] && grantPath[2]) {
    try {
      control.grantLibraryRead(decodeURIComponent(grantPath[1]), decodeURIComponent(grantPath[2]));
      response.writeHead(204);
      response.end();
    } catch {
      sendJson(response, 409, { error: 'peer_not_trusted', requestId });
    }
    return true;
  }
  const peerPath = pathname.match(/^\/v1\/pairing\/peers\/([^/]+)$/);
  if (request.method === 'DELETE' && peerPath?.[1]) {
    const revoked = await control.revokePeer(decodeURIComponent(peerPath[1]));
    sendJson(response, revoked ? 200 : 404, revoked ? { status: 'revoked' } : { error: 'peer_not_found', requestId });
    return true;
  }
  sendJson(response, 404, { error: 'not_found', requestId });
  return true;
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

function isPairingApproval(value: unknown): value is PairingApproval {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<PairingApproval>;
  return typeof candidate.approved === 'boolean' &&
    (candidate.label === undefined || typeof candidate.label === 'string' && candidate.label.length <= 80) &&
    (candidate.libraryIds === undefined || Array.isArray(candidate.libraryIds) && candidate.libraryIds.every((id) => typeof id === 'string' && id.length > 0 && id.length <= 128));
}

function isManualAddress(value: unknown): value is { host: string; port: number; peerId: string } {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as { host?: unknown; port?: unknown; peerId?: unknown };
  if (typeof candidate.host !== 'string' || typeof candidate.port !== 'number' || typeof candidate.peerId !== 'string' ||
      candidate.peerId.length < 10 || candidate.peerId.length > 128 || !Number.isInteger(candidate.port) || candidate.port < 1 || candidate.port > 65535) return false;
  const address = candidate.host.toLowerCase().split('%')[0] ?? '';
  const family = isIP(address);
  if (family === 4) {
    const octets = address.split('.').map(Number);
    if (octets.length !== 4 || octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
    return octets[0] === 10 || octets[0] === 127 ||
      octets[0] === 172 && octets[1]! >= 16 && octets[1]! <= 31 || octets[0] === 192 && octets[1] === 168;
  }
  return family === 6 && (address === '::1' || /^(fc|fd)/i.test(address));
}

function isPairingJoin(value: unknown): value is { invite: PairingQrPayload; label: string; manualIp?: { host: string; port: number } } {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as { invite?: unknown; label?: unknown; manualIp?: unknown };
  if (typeof candidate.label !== 'string' || candidate.label.length > 80 || typeof candidate.invite !== 'object' || candidate.invite === null) return false;
  if (candidate.manualIp === undefined) return true;
  if (typeof candidate.manualIp !== 'object' || candidate.manualIp === null) return false;
  const manual = candidate.manualIp as { host?: unknown; port?: unknown };
  return typeof manual.host === 'string' && typeof manual.port === 'number' && Number.isInteger(manual.port) && manual.port > 0 && manual.port <= 65535;
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
