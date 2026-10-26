import { createHash, randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { isIP } from 'node:net';
import QRCode from 'qrcode';
import { getHealth } from './health.js';
import { UploadError, UploadService, type CreateUploadRequest } from './uploads/service.js';
import type { PairingQrPayload, PairingApproval } from './auth/pairing-service.js';
import type { PendingPeerApproval } from './auth/pairing-approval-queue.js';
import type { TrustedPeerRecord } from './db/repository.js';
import type { Readable } from 'node:stream';
import type { CreateMediaVersionRequest, MediaVersionOperation, MediaVersionPage, MediaVersionView } from './media/media-version-service.js';
import type { ThumbnailContent } from './media/thumbnail-service.js';
import { maxThumbnailOutputBytes } from './media/image-transformer.js';

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
  authorizeLibraryList?: (token: string | undefined) => boolean | Promise<boolean>;
  gallery?: GalleryServerControl;
  mediaVersions?: MediaVersionServerControl;
  thumbnails?: ThumbnailServerControl;
  pairingControl?: PairingServerControl;
  allowedWebOrigins?: readonly string[];
  maxRequestBytes?: number;
}

export interface GalleryServerControl {
  listLibraries(): Array<{ libraryId: string; title: string }>;
  listAssets(libraryId: string, cursor: string | undefined, limit: number, query?: string): { items: unknown[]; nextCursor: string | null };
  getOriginal(assetId: string): Promise<{ libraryId: string; filename: string; sha256: string; byteSize: number; availability: string; storageRef: string; originalPath: string | null } | undefined>;
  openOriginal(media: { storageRef: string; originalPath: string | null }): Promise<Readable | undefined> | Readable | undefined;
  listTombstones(libraryId?: string): unknown[];
  restoreTombstone(libraryId: string, eventId: string): Promise<{ status: 'restored'; restoreEventId: string } | 'not_found' | 'inactive' | 'conflict' | 'unavailable'>;
}

export interface MediaVersionServerControl {
  listVersions(libraryId: string, assetId: string): MediaVersionPage;
  createVersion(libraryId: string, assetId: string, input: CreateMediaVersionRequest, principalId: string): Promise<MediaVersionOperation>;
  getVersion(libraryId: string, assetId: string, versionId: string): MediaVersionView | undefined;
  readVersionContent(libraryId: string, assetId: string, versionId: string): Promise<{
    bytes: Buffer; mimeType: 'image/jpeg' | 'image/png' | 'image/webp'; sha256: string; byteSize: number;
  }>;
}

export interface ThumbnailServerControl {
  readThumbnail(libraryId: string, assetId: string, profile: string): Promise<ThumbnailContent>;
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
  const allowedWebOrigins = normalizeAllowedWebOrigins(options.allowedWebOrigins ?? []);
  return createServer((request, response) => {
    setCorsHeaders(request, response, allowedWebOrigins);
    const requestId = headerValue(request, 'x-request-id') ?? randomUUID();
    response.setHeader('x-request-id', requestId);
    if (request.method === 'OPTIONS') {
      response.writeHead(204, { 'access-control-max-age': '600' });
      response.end();
      return;
    }
    void handleRequest(request, response, options, requestId).catch((error: unknown) => {
      const apiError = error instanceof UploadError ? error : new UploadError('STORAGE_IO', 'Request handling failed');
      sendJson(response, statusFor(apiError), { error: apiError.code.toLowerCase(), requestId });
    });
  });
}

async function handleRequest(request: IncomingMessage, response: ServerResponse, options: NodeAgentServerOptions, requestId: string): Promise<void> {
  const url = new URL(request.url ?? '/', `http://${headerValue(request, 'host') ?? 'localhost'}`);
  if (request.method === 'GET' && url.pathname === '/v1/health') {
    const capabilities = [
      ...(options.mediaVersions ? ['mediaVersions'] : []),
      ...(options.thumbnails ? ['thumbnails'] : [])
    ];
    sendJson(response, 200, getHealth(capabilities));
    return;
  }

  if (request.method === 'GET' && url.pathname === '/v1/libraries') {
    if (!await options.authorizeLibraryList?.(bearerToken(request))) { sendJson(response, 403, { error: 'forbidden', requestId }); return; }
    sendJson(response, 200, { items: options.gallery?.listLibraries() ?? [] });
    return;
  }

  const thumbnailPath = url.pathname.match(/^\/v1\/libraries\/([^/]+)\/assets\/([^/]+)\/thumbnail$/);
  if (request.method === 'GET' && thumbnailPath?.[1] && thumbnailPath[2]) {
    const libraryId = decodePathSegment(thumbnailPath[1]);
    const assetId = decodePathSegment(thumbnailPath[2]);
    const profileValues = url.searchParams.getAll('profile');
    const hasUnknownQuery = [...url.searchParams.keys()].some((key) => key !== 'profile');
    const profile = profileValues[0] ?? 'timeline-192';
    if (!libraryId || !assetId || hasUnknownQuery || profileValues.length > 1 || profile !== 'timeline-192') {
      sendJson(response, 400, { error: 'invalid_request', requestId }); return;
    }
    const token = bearerToken(request);
    if (!await options.authorizeLibraryRead?.(token, libraryId)) {
      sendJson(response, 404, { error: 'not_found', requestId }); return;
    }
    const control = options.thumbnails;
    if (!control) { sendJson(response, 503, { error: 'capability_unavailable', requestId }); return; }
    try {
      const content = await control.readThumbnail(libraryId, assetId, profile);
      if (!Buffer.isBuffer(content.bytes) || content.mimeType !== 'image/webp' ||
          content.byteSize !== content.bytes.byteLength || content.byteSize < 1 || content.byteSize > maxThumbnailOutputBytes ||
          !/^[0-9a-f]{64}$/.test(content.sha256) || digestBytes(content.bytes) !== content.sha256 ||
          !Number.isSafeInteger(content.width) || !Number.isSafeInteger(content.height) ||
          content.width < 1 || content.height < 1 || content.width > 192 || content.height > 192) {
        sendJson(response, 500, { error: 'thumbnail_invalid', requestId }); return;
      }
      if (!await options.authorizeLibraryRead?.(token, libraryId)) {
        sendJson(response, 404, { error: 'not_found', requestId }); return;
      }
      response.writeHead(200, {
        'content-type': 'image/webp', 'content-length': String(content.byteSize),
        'etag': `"${content.sha256}"`, 'cache-control': 'private, no-store',
        'x-content-type-options': 'nosniff', 'content-disposition': 'inline', 'vary': 'Authorization'
      });
      response.end(content.bytes);
    } catch (error) {
      sendThumbnailError(response, error, requestId);
    }
    return;
  }

  const originalPath = url.pathname.match(/^\/v1\/assets\/([^/]+)\/original$/);
  if (request.method === 'GET' && originalPath?.[1]) {
    const assetId = decodeURIComponent(originalPath[1]);
    const media = await options.gallery?.getOriginal(assetId);
    if (!media) { sendJson(response, 404, { error: 'not_found', requestId }); return; }
    const principal = await options.authorizeLibraryRead?.(bearerToken(request), media.libraryId);
    if (!principal) { sendJson(response, 404, { error: 'not_found', requestId }); return; }
    if (!['online', 'cached'].includes(media.availability)) {
      sendJson(response, 409, { error: 'source_offline', requestId }); return;
    }
    let stream: Readable | undefined;
    try { stream = await options.gallery?.openOriginal(media); }
    catch { sendJson(response, 409, { error: 'source_offline', requestId }); return; }
    if (!stream) { sendJson(response, 409, { error: 'source_offline', requestId }); return; }
    response.writeHead(200, {
      'content-type': 'application/octet-stream', 'content-length': String(media.byteSize),
      'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(media.filename)}`,
      'etag': `"${media.sha256}"`, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff'
    });
    stream.on('error', () => { if (!response.headersSent) sendJson(response, 500, { error: 'media_read_failed', requestId }); else response.destroy(); });
    stream.pipe(response);
    return;
  }

  const versionCollection = url.pathname.match(/^\/v1\/libraries\/([^/]+)\/assets\/([^/]+)\/versions$/);
  const versionResource = url.pathname.match(/^\/v1\/libraries\/([^/]+)\/assets\/([^/]+)\/versions\/([^/]+)$/);
  const versionContent = url.pathname.match(/^\/v1\/libraries\/([^/]+)\/assets\/([^/]+)\/versions\/([^/]+)\/content$/);
  if (versionCollection && (request.method === 'GET' || request.method === 'POST')) {
    const libraryId = decodePathSegment(versionCollection[1]);
    const assetId = decodePathSegment(versionCollection[2]);
    if (!libraryId || !assetId) { sendJson(response, 400, { error: 'invalid_request', requestId }); return; }
    const principalId = await authorizeMediaVersionRequest(request, response, options, libraryId, requestId);
    if (!principalId) return;
    const control = options.mediaVersions;
    if (!control) { sendJson(response, 503, { error: 'capability_unavailable', requestId }); return; }
    if (request.method === 'GET') {
      try { sendJson(response, 200, control.listVersions(libraryId, assetId)); }
      catch (error) { sendMediaVersionError(response, error, requestId); }
      return;
    }
    try {
      const contentType = headerValue(request, 'content-type') ?? '';
      if (!/^application\/json(?:\s*;|$)/i.test(contentType)) {
        sendJson(response, 415, { error: 'unsupported_media_type', requestId });
        return;
      }
      const body = await readJsonBody(request, 64 * 1024);
      if (!isCreateMediaVersionRequest(body)) { sendJson(response, 400, { error: 'invalid_request', requestId }); return; }
      const operation = await control.createVersion(libraryId, assetId, body, principalId);
      sendJson(response, 202, operation);
    } catch (error) {
      if (error instanceof UploadError) sendJson(response, statusFor(error), { error: error.code.toLowerCase(), requestId });
      else sendMediaVersionError(response, error, requestId);
    }
    return;
  }

  const versionRoute = versionContent ?? versionResource;
  if (versionRoute && request.method === 'GET') {
    const libraryId = decodePathSegment(versionRoute[1]);
    const assetId = decodePathSegment(versionRoute[2]);
    const versionId = decodePathSegment(versionRoute[3]);
    if (!libraryId || !assetId || !versionId) { sendJson(response, 400, { error: 'invalid_request', requestId }); return; }
    const principalId = await authorizeMediaVersionRequest(request, response, options, libraryId, requestId);
    if (!principalId) return;
    const control = options.mediaVersions;
    if (!control) { sendJson(response, 503, { error: 'capability_unavailable', requestId }); return; }
    const version = control.getVersion(libraryId, assetId, versionId);
    if (!version) { sendJson(response, 404, { error: 'not_found', requestId }); return; }
    if (!versionContent) { sendJson(response, 200, version); return; }
    if (version.status !== 'ready' || !version.outputSha256 || !version.mimeType || version.byteSize === null) {
      sendJson(response, 409, { error: version.status === 'failed' ? 'version_failed' : 'version_not_ready', requestId });
      return;
    }
    try {
      const content = await control.readVersionContent(libraryId, assetId, versionId);
      response.writeHead(200, {
        'content-type': content.mimeType,
        'content-length': String(content.byteSize),
        'etag': `"${content.sha256}"`,
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
        'content-disposition': 'inline'
      });
      response.end(content.bytes);
    } catch (error) { sendMediaVersionError(response, error, requestId); }
    return;
  }

  if (request.method === 'GET' && url.pathname === '/v1/recycle-bin') {
    const libraryId = url.searchParams.get('libraryId') ?? undefined;
    if (!libraryId || !await options.authorizeLibraryRead?.(bearerToken(request), libraryId)) {
      sendJson(response, 403, { error: 'forbidden', requestId }); return;
    }
    sendJson(response, 200, { items: options.gallery?.listTombstones(libraryId) ?? [] });
    return;
  }

  if (request.method === 'POST' && url.pathname === '/v1/recycle-bin/restore') {
    const token = bearerToken(request);
    if (!await options.authorizePairingAdmin?.(token)) { sendJson(response, 403, { error: 'forbidden', requestId }); return; }
    let input: unknown;
    try { input = await readJsonBody(request, 16 * 1024); }
    catch (error) {
      if (error instanceof UploadError) { sendJson(response, statusFor(error), { error: error.code.toLowerCase(), requestId }); return; }
      throw error;
    }
    if (!isRestoreTombstoneRequest(input)) { sendJson(response, 400, { error: 'invalid_request', requestId }); return; }
    if (!await options.authorizeLibraryRead?.(token, input.libraryId)) { sendJson(response, 403, { error: 'forbidden', requestId }); return; }
    const gallery = options.gallery;
    if (!gallery) { sendJson(response, 503, { error: 'capability_unavailable', requestId }); return; }
    const result = await gallery.restoreTombstone(input.libraryId, input.eventId);
    if (result === 'not_found') { sendJson(response, 404, { error: 'not_found', requestId }); return; }
    if (result === 'inactive') { sendJson(response, 409, { error: 'tombstone_not_active', requestId }); return; }
    if (result === 'conflict') { sendJson(response, 409, { error: 'causal_context_conflict', requestId }); return; }
    if (result === 'unavailable') { sendJson(response, 503, { error: 'capability_unavailable', requestId }); return; }
    sendJson(response, 200, { status: 'restored', tombstoneEventId: input.eventId, restoreEventId: result.restoreEventId });
    return;
  }

  if (request.method === 'GET' && url.pathname === '/v1/assets') {
    const libraryId = url.searchParams.get('libraryId');
    const peerId = libraryId ? await options.authorizeLibraryRead?.(bearerToken(request), libraryId) : undefined;
    const rawLimit = Number(url.searchParams.get('limit') ?? 50);
    const cursor = url.searchParams.get('cursor');
    const rawOffset = cursor === null ? 0 : Number(cursor);
    if (!Number.isInteger(rawLimit) || rawLimit < 1 || rawLimit > 200 ||
      (options.gallery ? cursor !== null && !/^[A-Za-z0-9_-]{1,2048}$/.test(cursor) : !Number.isSafeInteger(rawOffset) || rawOffset < 0)) {
      sendJson(response, 400, { error: 'invalid_request', requestId }); return;
    }
    if (options.gallery) {
      if (!peerId || !libraryId) { sendJson(response, 403, { error: 'forbidden', requestId }); return; }
      try {
        const query = url.searchParams.get('q') ?? '';
        if (query.length > 256) { sendJson(response, 400, { error: 'invalid_request', requestId }); return; }
        const page = options.gallery.listAssets(libraryId, cursor ?? undefined, rawLimit, query);
        sendJson(response, 200, page);
      } catch {
        sendJson(response, 400, { error: 'invalid_request', requestId });
      }
      return;
    }
    const items = peerId && libraryId ? options.pairingControl?.readLibraryIndex(peerId, libraryId) : undefined;
    if (!items) { sendJson(response, 403, { error: 'forbidden', requestId }); return; }
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

async function authorizeMediaVersionRequest(
  request: IncomingMessage,
  response: ServerResponse,
  options: NodeAgentServerOptions,
  libraryId: string,
  requestId: string
): Promise<string | undefined> {
  const token = bearerToken(request);
  if (!await options.authorizePairingAdmin?.(token)) {
    sendJson(response, 403, { error: 'forbidden', requestId });
    return undefined;
  }
  const principalId = await options.authorizeLibraryRead?.(token, libraryId);
  if (!principalId) {
    sendJson(response, 403, { error: 'forbidden', requestId });
    return undefined;
  }
  return principalId;
}

function decodePathSegment(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const decoded = decodeURIComponent(value);
    return decoded.length > 0 && decoded.length <= 128 && !/[\\/\0]/.test(decoded) ? decoded : undefined;
  } catch { return undefined; }
}

function isRestoreTombstoneRequest(value: unknown): value is { libraryId: string; eventId: string } {
  return isPlainRecord(value) && hasExactKeys(value, ['libraryId', 'eventId']) &&
    typeof value.libraryId === 'string' && value.libraryId.length > 0 && value.libraryId.length <= 128 && !/[\\/\0]/.test(value.libraryId) &&
    typeof value.eventId === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89abAB][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value.eventId);
}

function isCreateMediaVersionRequest(value: unknown): value is CreateMediaVersionRequest {
  if (!isPlainRecord(value) || !hasExactKeys(value, ['sourceVersionId', 'sourceSha256', 'transform', 'idempotencyKey'])) return false;
  if (!(value.sourceVersionId === null || typeof value.sourceVersionId === 'string' && value.sourceVersionId.length > 0 && value.sourceVersionId.length <= 128) ||
    typeof value.sourceSha256 !== 'string' || !/^[0-9a-f]{64}$/.test(value.sourceSha256) ||
    typeof value.idempotencyKey !== 'string' || !/^[A-Za-z0-9._~-]{16,128}$/.test(value.idempotencyKey) ||
    !isPlainRecord(value.transform) || !hasExactKeys(value.transform, ['crop', 'rotation'])) return false;
  const { crop, rotation } = value.transform;
  if (!isPlainRecord(crop) || !hasExactKeys(crop, ['x', 'y', 'width', 'height']) ||
    !Number.isSafeInteger(crop.x) || !Number.isSafeInteger(crop.y) || !Number.isSafeInteger(crop.width) || !Number.isSafeInteger(crop.height) ||
    (crop.x as number) < 0 || (crop.y as number) < 0 || (crop.width as number) < 1 || (crop.height as number) < 1 ||
    (crop.x as number) + (crop.width as number) > 1_000_000 || (crop.y as number) + (crop.height as number) > 1_000_000 ||
    ![0, 90, 180, 270].includes(rotation as number)) return false;
  return !(crop.x === 0 && crop.y === 0 && crop.width === 1_000_000 && crop.height === 1_000_000 && rotation === 0);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.length && expected.every((key) => Object.hasOwn(value, key));
}

function sendMediaVersionError(response: ServerResponse, error: unknown, requestId: string): void {
  const candidate = typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined;
  const code = typeof candidate === 'string' && mediaVersionErrorStatuses[candidate]
    ? candidate : 'STORAGE_FAILED';
  sendJson(response, mediaVersionErrorStatuses[code]!, { error: code.toLowerCase(), requestId });
}

function sendThumbnailError(response: ServerResponse, error: unknown, requestId: string): void {
  const candidate = typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined;
  const code = typeof candidate === 'string' && Object.hasOwn(thumbnailErrorStatuses, candidate) ? candidate : 'PROCESSING_FAILED';
  if (code === 'QUEUE_FULL') response.setHeader('retry-after', '1');
  sendJson(response, thumbnailErrorStatuses[code]!, { error: code.toLowerCase(), requestId });
}

const thumbnailErrorStatuses: Record<string, number> = {
  INVALID_REQUEST: 400,
  NOT_FOUND: 404,
  SOURCE_CHANGED: 409,
  SOURCE_OFFLINE: 409,
  TOO_LARGE: 413,
  UNSUPPORTED_MEDIA: 415,
  PROCESSING_FAILED: 500,
  QUEUE_FULL: 429,
  STORAGE_FAILED: 503
};

const mediaVersionErrorStatuses: Record<string, number> = {
  INVALID_REQUEST: 400,
  NOT_FOUND: 404,
  SOURCE_CHANGED: 409,
  SOURCE_OFFLINE: 503,
  IDEMPOTENCY_CONFLICT: 409,
  VERSION_NOT_READY: 409,
  VERSION_FAILED: 409,
  VERSION_UNAVAILABLE: 503,
  TOO_LARGE: 413,
  UNSUPPORTED_MEDIA: 415,
  PROCESSING_FAILED: 500,
  STORAGE_FAILED: 503,
  QUEUE_FULL: 503
};

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

function setCorsHeaders(request: IncomingMessage, response: ServerResponse, allowedWebOrigins: ReadonlySet<string>): void {
  const origin = headerValue(request, 'origin');
  if (!origin || (!isAllowedLocalOrigin(origin) && !allowedWebOrigins.has(origin))) return;
  response.setHeader('access-control-allow-origin', origin);
  response.setHeader('vary', 'Origin');
  response.setHeader('access-control-allow-methods', 'GET, POST, PUT, DELETE, OPTIONS');
  response.setHeader('access-control-allow-headers', 'Authorization, Content-Type, Idempotency-Key, Upload-Offset, Upload-Chunk-SHA256, X-Request-ID');
  response.setHeader('access-control-expose-headers', 'Content-Disposition, ETag, X-Request-ID');
}

function normalizeAllowedWebOrigins(origins: readonly string[]): ReadonlySet<string> {
  const normalized = new Set<string>();
  for (const value of origins) {
    let origin: URL;
    try { origin = new URL(value); }
    catch { throw new Error('PHOTOMESH_WEB_ORIGINS must contain valid HTTP(S) origins'); }
    if (!['http:', 'https:'].includes(origin.protocol) || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash ||
        origin.protocol === 'http:' && !isAllowedLocalOrigin(origin.origin)) {
      throw new Error('PHOTOMESH_WEB_ORIGINS must contain HTTPS origins (or loopback HTTP origins) without credentials or paths');
    }
    normalized.add(origin.origin);
  }
  return normalized;
}

function isAllowedLocalOrigin(value: string): boolean {
  try {
    const origin = new URL(value);
    return origin.protocol === 'tauri:' && origin.hostname === 'localhost' ||
      (origin.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname)) ||
      (origin.protocol === 'https:' && origin.hostname === 'tauri.localhost');
  } catch { return false; }
}

function digestBytes(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
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
