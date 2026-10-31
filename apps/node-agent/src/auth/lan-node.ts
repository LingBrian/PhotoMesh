import { isIP } from 'node:net';
import { createLibp2p, type Libp2p } from 'libp2p';
import { tcp } from '@libp2p/tcp';
import { mdns } from '@libp2p/mdns';
import { noise } from '@chainsafe/libp2p-noise';
import { yamux } from '@chainsafe/libp2p-yamux';
import { publicKeyFromProtobuf, publicKeyToProtobuf } from '@libp2p/crypto/keys';
import { peerIdFromPublicKey, peerIdFromString } from '@libp2p/peer-id';
import { multiaddr } from '@multiformats/multiaddr';
import { parseJsonWithoutDuplicateKeys } from './strict-json.js';
import type { LocalIdentity } from './local-identity.js';
import { PAIRING_PROTOCOL_VERSION, PairingRejectedError, PairingService, type PairingQrPayload } from './pairing-service.js';
import { isSyncExchangeRequest, SYNC_PROTOCOL, SyncService, type SyncExchangeRequest, type SyncExchangeResponse, type SyncTransport } from '../sync/sync-service.js';
import { isTagSyncExchangeRequest, TAG_SYNC_CAPABILITY, TAG_SYNC_PROTOCOL, TagSyncService, type TagSyncExchangeRequest, type TagSyncExchangeResponse, type TagSyncTransport } from '../sync/tag-sync-service.js';
import { ALBUM_SYNC_CAPABILITY, ALBUM_SYNC_PROTOCOL, AlbumSyncService, isAlbumSyncExchangeRequest, type AlbumSyncExchangeRequest, type AlbumSyncExchangeResponse, type AlbumSyncTransport } from '../sync/album-sync-service.js';
import { FAVORITE_SYNC_CAPABILITY, FAVORITE_SYNC_PROTOCOL, FavoriteSyncService, isFavoriteSyncExchangeRequest, type FavoriteSyncExchangeRequest, type FavoriteSyncExchangeResponse, type FavoriteSyncTransport } from '../sync/favorite-sync-service.js';
import { RATING_SYNC_CAPABILITY, RATING_SYNC_PROTOCOL, RatingSyncService, isRatingSyncExchangeRequest, type RatingSyncExchangeRequest, type RatingSyncExchangeResponse, type RatingSyncTransport } from '../sync/rating-sync-service.js';

const PAIR_PROTOCOL = '/photomesh/pairing/1.0.0';
const INDEX_PROTOCOL = '/photomesh/library-index/1.0.0';
const MAX_FRAME_BYTES = 32 * 1024;
const MAX_SYNC_FRAME_BYTES = 18 * 1024 * 1024;
const MAX_TAG_SYNC_FRAME_BYTES = 18 * 1024 * 1024;
const MAX_ALBUM_SYNC_FRAME_BYTES = 16 * 1024 * 1024;
const MAX_FAVORITE_SYNC_FRAME_BYTES = 16 * 1024 * 1024;
const MAX_RATING_SYNC_FRAME_BYTES = 16 * 1024 * 1024;

export interface DiscoveredPeer { peerId: string; addresses: string[] }

export interface LanNodeOptions {
  identity: LocalIdentity;
  pairing: PairingService;
  /** Explicit private LAN interface addresses only; wildcard/public binds are rejected. */
  listenAddresses: readonly string[];
  listenPort?: number;
  syncService?: SyncService;
  tagSyncService?: TagSyncService;
  albumSyncService?: AlbumSyncService;
  favoriteSyncService?: FavoriteSyncService;
  ratingSyncService?: RatingSyncService;
}

export class LanPairingNode implements SyncTransport, TagSyncTransport, AlbumSyncTransport, FavoriteSyncTransport, RatingSyncTransport {
  private readonly discovered = new Map<string, Set<string>>();
  private readonly syncTasks = new Map<string, Promise<{ rounds: number; received: number; sent: number }>>();
  private syncTimer: ReturnType<typeof setInterval> | undefined;
  private stopping = false;
  private stopPromise: Promise<void> | undefined;

  private constructor(
    private readonly node: Libp2p,
    private readonly pairing: PairingService,
    private readonly publicKey: Uint8Array,
    private readonly syncService?: SyncService,
    private readonly tagSyncService?: TagSyncService,
    private readonly albumSyncService?: AlbumSyncService,
    private readonly favoriteSyncService?: FavoriteSyncService,
    private readonly ratingSyncService?: RatingSyncService
  ) {}

  static async start(options: LanNodeOptions): Promise<LanPairingNode> {
    if ((options.tagSyncService || options.albumSyncService || options.favoriteSyncService || options.ratingSyncService) && !options.syncService) throw new Error('extension sync requires event sync capability negotiation');
    const advertisesTagSync = options.syncService?.hello().capabilities.includes(TAG_SYNC_CAPABILITY) ?? false;
    if (advertisesTagSync !== Boolean(options.tagSyncService)) throw new Error('tag sync capability must match its transport handler');
    const advertisesAlbumSync = options.syncService?.hello().capabilities.includes(ALBUM_SYNC_CAPABILITY) ?? false;
    if (advertisesAlbumSync !== Boolean(options.albumSyncService)) throw new Error('album sync capability must match its transport handler');
    const advertisesFavoriteSync = options.syncService?.hello().capabilities.includes(FAVORITE_SYNC_CAPABILITY) ?? false;
    if (advertisesFavoriteSync !== Boolean(options.favoriteSyncService)) throw new Error('favorite sync capability must match its transport handler');
    const advertisesRatingSync = options.syncService?.hello().capabilities.includes(RATING_SYNC_CAPABILITY) ?? false;
    if (advertisesRatingSync !== Boolean(options.ratingSyncService)) throw new Error('rating sync capability must match its transport handler');
    const privateAddresses = [...new Set(options.listenAddresses)].map(normalizePrivateLanAddress);
    if (privateAddresses.length === 0) throw new Error('explicit private LAN listen addresses are required');
    const node = await createLibp2p({
      privateKey: options.identity.privateKey,
      addresses: { listen: privateAddresses.map((address) => `${address}/tcp/${options.listenPort ?? 0}`) },
      transports: [tcp()], connectionEncrypters: [noise()], streamMuxers: [yamux()], peerDiscovery: [mdns()]
    });
    const lan = new LanPairingNode(node, options.pairing, options.identity.publicKey, options.syncService, options.tagSyncService, options.albumSyncService, options.favoriteSyncService, options.ratingSyncService);
    node.addEventListener('peer:discovery', (event) => {
      const detail = event.detail as { id: { toString(): string }; multiaddrs?: Array<{ toString(): string }> };
      const peerId = detail.id.toString();
      const addresses = lan.discovered.get(peerId) ?? new Set<string>();
      for (const address of detail.multiaddrs ?? []) addresses.add(address.toString());
      lan.discovered.set(peerId, addresses);
      if (options.pairing.listPeers().some((peer) => peer.peerId === peerId && peer.trustState === 'trusted')) {
        void lan.syncWithPeer(peerId).catch(() => undefined);
      }
    });
    node.handle(PAIR_PROTOCOL, async (stream, connection) => {
      try {
        const message = await readFrame(stream);
        if (message.kind !== 'pair' || message.version !== PAIRING_PROTOCOL_VERSION ||
            typeof message.inviteId !== 'string' || typeof message.secret !== 'string' ||
            typeof message.label !== 'string' || typeof message.publicKey !== 'string') throw new PairingRejectedError();
        const publicKeyBytes = Buffer.from(message.publicKey, 'base64');
        const publicKey = publicKeyFromProtobuf(publicKeyBytes);
        const authenticatedPeerId = connection.remotePeer.toString();
        if (peerIdFromPublicKey(publicKey).toString() !== authenticatedPeerId || authenticatedPeerId === options.identity.peerId) {
          throw new PairingRejectedError();
        }
        const result = await options.pairing.acceptInvite({
          inviteId: message.inviteId, secret: message.secret, proposedLabel: message.label,
          authenticatedRemote: { peerId: authenticatedPeerId, publicKey: publicKeyBytes }
        });
        if (options.syncService) void lan.syncWithPeer(authenticatedPeerId).catch(() => undefined);
        await writeFrame(stream, { ok: true, peerId: result.peerId, grantedLibraryIds: result.grantedLibraryIds });
      } catch {
        await writeFrame(stream, { ok: false, error: 'pairing_rejected' }).catch(() => undefined);
      }
    });
    node.handle(INDEX_PROTOCOL, async (stream, connection) => {
      try {
        const message = await readFrame(stream);
        const libraryId = typeof message.libraryId === 'string' ? message.libraryId : '';
        const offset = Number.isSafeInteger(message.offset) && Number(message.offset) >= 0 ? Number(message.offset) : 0;
        const limit = Number.isSafeInteger(message.limit) ? Math.min(200, Math.max(1, Number(message.limit))) : 50;
        const assets = options.pairing.readLibraryIndex(connection.remotePeer.toString(), libraryId);
        if (!assets) { await writeFrame(stream, { ok: false, error: 'forbidden' }); return; }
        await writeFrame(stream, { ok: true, items: assets.slice(offset, offset + limit), nextOffset: offset + limit < assets.length ? offset + limit : null });
      } catch {
        await writeFrame(stream, { ok: false, error: 'invalid_request' }).catch(() => undefined);
      }
    });
    if (options.syncService) node.handle(SYNC_PROTOCOL, async (stream, connection) => {
      try {
        const message = await readFrame(stream, MAX_SYNC_FRAME_BYTES);
        if (!isSyncExchangeRequest(message)) throw new Error('invalid sync request');
        const response = await options.syncService!.handleExchange(connection.remotePeer.toString(), message);
        await writeFrame(stream, { ...response }, MAX_SYNC_FRAME_BYTES);
      } catch {
        await writeFrame(stream, { ok: false, error: 'sync_rejected' }, MAX_SYNC_FRAME_BYTES).catch(() => undefined);
      }
    });
    if (options.tagSyncService) node.handle(TAG_SYNC_PROTOCOL, async (stream, connection) => {
      try {
        const message = await readFrame(stream, MAX_TAG_SYNC_FRAME_BYTES);
        if (!isTagSyncExchangeRequest(message)) throw new Error('invalid tag sync request');
        const response = await options.tagSyncService!.handleExchange(connection.remotePeer.toString(), message);
        await writeFrame(stream, { ...response }, MAX_TAG_SYNC_FRAME_BYTES);
      } catch {
        await writeFrame(stream, { ok: false, error: 'tag_sync_rejected' }, MAX_TAG_SYNC_FRAME_BYTES).catch(() => undefined);
      }
    });
    if (options.albumSyncService) node.handle(ALBUM_SYNC_PROTOCOL, async (stream, connection) => {
      try {
        const message = await readFrame(stream, MAX_ALBUM_SYNC_FRAME_BYTES);
        if (!isAlbumSyncExchangeRequest(message)) throw new Error('invalid album sync request');
        const response = await options.albumSyncService!.handleExchange(connection.remotePeer.toString(), message);
        await writeFrame(stream, { ...response }, MAX_ALBUM_SYNC_FRAME_BYTES);
      } catch {
        await writeFrame(stream, { ok: false, error: 'album_sync_rejected' }, MAX_ALBUM_SYNC_FRAME_BYTES).catch(() => undefined);
      }
    });
    if (options.favoriteSyncService) node.handle(FAVORITE_SYNC_PROTOCOL, async (stream, connection) => {
      try {
        const message = await readFrame(stream, MAX_FAVORITE_SYNC_FRAME_BYTES);
        if (!isFavoriteSyncExchangeRequest(message)) throw new Error('invalid favorite sync request');
        const response = await options.favoriteSyncService!.handleExchange(connection.remotePeer.toString(), message);
        await writeFrame(stream, { ...response }, MAX_FAVORITE_SYNC_FRAME_BYTES);
      } catch {
        await writeFrame(stream, { ok: false, error: 'favorite_sync_rejected' }, MAX_FAVORITE_SYNC_FRAME_BYTES).catch(() => undefined);
      }
    });
    if (options.ratingSyncService) node.handle(RATING_SYNC_PROTOCOL, async (stream, connection) => {
      try {
        const message = await readFrame(stream, MAX_RATING_SYNC_FRAME_BYTES);
        if (!isRatingSyncExchangeRequest(message)) throw new Error('invalid rating sync request');
        const response = await options.ratingSyncService!.handleExchange(connection.remotePeer.toString(), message);
        await writeFrame(stream, { ...response }, MAX_RATING_SYNC_FRAME_BYTES);
      } catch {
        await writeFrame(stream, { ok: false, error: 'rating_sync_rejected' }, MAX_RATING_SYNC_FRAME_BYTES).catch(() => undefined);
      }
    });
    await node.start();
    if (options.syncService) {
      lan.syncTimer = setInterval(() => {
        for (const peer of options.pairing.listPeers()) if (peer.trustState === 'trusted') void lan.syncWithPeer(peer.peerId).catch(() => undefined);
      }, 10_000);
      lan.syncTimer.unref?.();
    }
    return lan;
  }

  createInvite(): PairingQrPayload {
    const addresses = this.node.getMultiaddrs().map((address) => {
      const value = address.toString();
      return value.includes('/p2p/') ? value : `${value}/p2p/${this.node.peerId.toString()}`;
    });
    return this.pairing.createInvite(addresses);
  }

  listDiscoveredPeers(): DiscoveredPeer[] {
    return [...this.discovered].map(([peerId, addresses]) => ({ peerId, addresses: [...addresses] }));
  }

  async pairWithInvite(invite: PairingQrPayload, label: string, manualIp?: { host: string; port: number }): Promise<{ hostPeerId: string }> {
    if (!isPairingInvite(invite) || Date.parse(invite.expiresAt) <= Date.now()) {
      throw new PairingRejectedError('invite is invalid or expired');
    }
    const targets = manualIp
      ? [formatManualAddress(manualIp.host, manualIp.port, invite.hostPeerId)]
      : invite.addresses;
    if (targets.length === 0) throw new Error('no LAN address is available; use mDNS or provide a manual IP');
    let lastError: unknown;
    for (const target of targets) {
      try {
        const address = multiaddr(target);
        if (getPeerId(address.toString()) !== invite.hostPeerId) throw new PairingRejectedError('QR address identity does not match');
        const stream = await this.node.dialProtocol(address, PAIR_PROTOCOL);
        await writeFrame(stream, {
          kind: 'pair', version: PAIRING_PROTOCOL_VERSION, inviteId: invite.inviteId, secret: invite.secret,
          label, publicKey: Buffer.from(this.publicKey).toString('base64')
        });
        const response = await readFrame(stream);
        if (response.ok !== true || response.peerId !== this.node.peerId.toString()) throw new PairingRejectedError();
        const authenticatedHost = this.node.getConnections().find((connection) => connection.remotePeer.toString() === invite.hostPeerId)?.remotePeer;
        if (!authenticatedHost?.publicKey || peerIdFromPublicKey(authenticatedHost.publicKey).toString() !== invite.hostPeerId) {
          throw new PairingRejectedError('host identity could not be verified');
        }
        this.pairing.trustScannedHost(invite.hostPeerId, publicKeyToProtobuf(authenticatedHost.publicKey), 'Paired PhotoMesh node');
        if (this.syncService) void this.syncWithPeer(invite.hostPeerId).catch(() => undefined);
        return { hostPeerId: invite.hostPeerId };
      } catch (error) { lastError = error; }
    }
    throw lastError instanceof Error ? lastError : new Error('unable to connect to the invited node');
  }

  async getLibraryIndex(peerId: string, libraryId: string, limit = 50, offset = 0): Promise<unknown[]> {
    const stream = await this.node.dialProtocol(peerIdFromString(peerId), INDEX_PROTOCOL);
    await writeFrame(stream, { libraryId, limit, offset });
    const response = await readFrame(stream);
    if (response.ok !== true || !Array.isArray(response.items)) throw new PairingRejectedError('library access denied');
    return response.items;
  }

  async exchange(peerId: string, request: SyncExchangeRequest): Promise<SyncExchangeResponse> {
    const stream = await this.node.dialProtocol(peerIdFromString(peerId), SYNC_PROTOCOL);
    await writeFrame(stream, { ...request }, MAX_SYNC_FRAME_BYTES);
    const response = await readFrame(stream, MAX_SYNC_FRAME_BYTES);
    if (response.ok === false || typeof response.hello !== 'object' || response.hello === null) throw new Error('peer rejected sync exchange');
    return response as unknown as SyncExchangeResponse;
  }

  async exchangeTags(peerId: string, request: TagSyncExchangeRequest): Promise<TagSyncExchangeResponse> {
    const stream = await this.node.dialProtocol(peerIdFromString(peerId), TAG_SYNC_PROTOCOL);
    await writeFrame(stream, { ...request }, MAX_TAG_SYNC_FRAME_BYTES);
    const response = await readFrame(stream, MAX_TAG_SYNC_FRAME_BYTES);
    if (response.ok === false || typeof response.hello !== 'object' || response.hello === null) throw new Error('peer rejected tag sync exchange');
    return response as unknown as TagSyncExchangeResponse;
  }

  async exchangeAlbums(peerId: string, request: AlbumSyncExchangeRequest): Promise<AlbumSyncExchangeResponse> {
    const stream = await this.node.dialProtocol(peerIdFromString(peerId), ALBUM_SYNC_PROTOCOL);
    await writeFrame(stream, { ...request }, MAX_ALBUM_SYNC_FRAME_BYTES);
    const response = await readFrame(stream, MAX_ALBUM_SYNC_FRAME_BYTES);
    if (response.ok === false || typeof response.hello !== 'object' || response.hello === null) throw new Error('peer rejected album sync exchange');
    return response as unknown as AlbumSyncExchangeResponse;
  }

  async exchangeFavorites(peerId: string, request: FavoriteSyncExchangeRequest): Promise<FavoriteSyncExchangeResponse> {
    const stream = await this.node.dialProtocol(peerIdFromString(peerId), FAVORITE_SYNC_PROTOCOL);
    await writeFrame(stream, { ...request }, MAX_FAVORITE_SYNC_FRAME_BYTES);
    const response = await readFrame(stream, MAX_FAVORITE_SYNC_FRAME_BYTES);
    if (response.ok === false || typeof response.hello !== 'object' || response.hello === null) throw new Error('peer rejected favorite sync exchange');
    return response as unknown as FavoriteSyncExchangeResponse;
  }

  async exchangeRatings(peerId: string, request: RatingSyncExchangeRequest): Promise<RatingSyncExchangeResponse> {
    const stream = await this.node.dialProtocol(peerIdFromString(peerId), RATING_SYNC_PROTOCOL);
    await writeFrame(stream, { ...request }, MAX_RATING_SYNC_FRAME_BYTES);
    const response = await readFrame(stream, MAX_RATING_SYNC_FRAME_BYTES);
    if (response.ok === false || typeof response.hello !== 'object' || response.hello === null) throw new Error('peer rejected rating sync exchange');
    return response as unknown as RatingSyncExchangeResponse;
  }

  async syncWithPeer(peerId: string): Promise<{ rounds: number; received: number; sent: number }> {
    if (this.stopping) throw new Error('LAN node is stopping');
    if (!this.syncService) throw new Error('event sync is not configured');
    const running = this.syncTasks.get(peerId);
    if (running) return running;
    const task = (async () => {
      const result = await this.syncService!.syncWithPeer(peerId, this);
      if (this.tagSyncService) {
        if (this.syncService!.peerSupportsCapability(peerId, TAG_SYNC_CAPABILITY)) {
          await this.tagSyncService.syncWithPeer(peerId, this);
        } else {
          this.tagSyncService.markPeerUnsupported(peerId);
        }
      }
      if (this.albumSyncService) {
        if (this.syncService!.peerSupportsCapability(peerId, ALBUM_SYNC_CAPABILITY)) {
          await this.albumSyncService.syncWithPeer(peerId, this);
        } else {
          this.albumSyncService.markPeerUnsupported(peerId);
        }
      }
      if (this.favoriteSyncService) {
        if (this.syncService!.peerSupportsCapability(peerId, FAVORITE_SYNC_CAPABILITY)) {
          await this.favoriteSyncService.syncWithPeer(peerId, this);
        } else {
          this.favoriteSyncService.markPeerUnsupported(peerId);
        }
      }
      if (this.ratingSyncService) {
        if (this.syncService!.peerSupportsCapability(peerId, RATING_SYNC_CAPABILITY)) {
          await this.ratingSyncService.syncWithPeer(peerId, this);
        } else {
          this.ratingSyncService.markPeerUnsupported(peerId);
        }
      }
      return result;
    })().finally(() => this.syncTasks.delete(peerId));
    this.syncTasks.set(peerId, task);
    return task;
  }

  async dialManualIp(host: string, port: number, peerId: string): Promise<DiscoveredPeer> {
    const address = multiaddr(formatManualAddress(host, port, peerId));
    const stream = await this.node.dialProtocol(address, PAIR_PROTOCOL);
    await stream.close();
    return { peerId, addresses: [address.toString()] };
  }

  async revokePeer(peerId: string): Promise<boolean> {
    const revoked = await this.pairing.revokePeer(peerId);
    if (revoked) await this.node.hangUp(peerIdFromString(peerId)).catch(() => undefined);
    return revoked;
  }

  stop(): Promise<void> {
    this.stopPromise ??= this.stopInternal();
    return this.stopPromise;
  }

  private async stopInternal(): Promise<void> {
    this.stopping = true;
    if (this.syncTimer) clearInterval(this.syncTimer);
    this.syncTimer = undefined;
    try {
      await this.node.stop();
    } finally {
      await Promise.allSettled([...this.syncTasks.values()]);
    }
  }
}

interface JsonFrame { [key: string]: unknown }

interface FrameChunk { byteLength: number; subarray(start?: number, end?: number): Uint8Array }
interface WritableFrameStream { send(data: Uint8Array): boolean; close(): Promise<void> }

async function readFrame(source: AsyncIterable<FrameChunk>, maximum = MAX_FRAME_BYTES): Promise<JsonFrame> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of source) {
    size += chunk.byteLength;
    if (size > maximum) throw new Error('frame too large');
    const buffer = Buffer.from(chunk.subarray());
    const newline = buffer.indexOf(10);
    if (newline >= 0) {
      chunks.push(buffer.subarray(0, newline));
      const parsed = parseJsonWithoutDuplicateKeys(Buffer.concat(chunks).toString('utf8'));
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('invalid frame');
      return parsed as JsonFrame;
    }
    chunks.push(buffer);
  }
  throw new Error('incomplete frame');
}

async function writeFrame(stream: WritableFrameStream, value: JsonFrame, maximum = MAX_FRAME_BYTES): Promise<void> {
  const frame = Buffer.from(`${JSON.stringify(value)}\n`, 'utf8');
  if (frame.byteLength > maximum) throw new Error('frame too large');
  stream.send(frame);
  await stream.close();
}

function normalizePrivateLanAddress(address: string): string {
  const family = isIP(address);
  const normalized = address.toLowerCase().split('%')[0] ?? '';
  const isPrivate = family === 4
    ? isPrivateIpv4(normalized) || normalized.startsWith('127.')
    : family === 6 && (normalized === '::1' || /^(fc|fd)/.test(normalized));
  if (!isPrivate) throw new Error('LAN listener must be an explicit private or loopback address');
  return `/${family === 6 ? 'ip6' : 'ip4'}/${normalized}`;
}

function isPrivateIpv4(address: string): boolean {
  const octets = address.split('.').map(Number);
  if (octets.length !== 4 || octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  return octets[0] === 10 || (octets[0] === 172 && octets[1]! >= 16 && octets[1]! <= 31) ||
    (octets[0] === 192 && octets[1] === 168);
}

function formatManualAddress(host: string, port: number, peerId: string): string {
  const family = isIP(host.split('%')[0] ?? '');
  const normalized = host.toLowerCase().split('%')[0] ?? '';
  const privateAddress = family === 4 ? isPrivateIpv4(normalized) || normalized.startsWith('127.') :
    family === 6 && (normalized === '::1' || /^(fc|fd)/i.test(normalized));
  if (family === 0 || !privateAddress) {
    throw new Error('manual peer address must be an explicit private LAN IP');
  }
  if (!Number.isInteger(port) || port < 1 || port > 65535 || peerId.length > 128) throw new Error('invalid manual peer address');
  return `/${family === 6 ? 'ip6' : 'ip4'}/${host}/tcp/${port}/p2p/${peerId}`;
}

function isPairingInvite(value: unknown): value is PairingQrPayload {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const invite = value as Partial<PairingQrPayload>;
  if (invite.protocol !== 'photomesh-pairing' || invite.version !== PAIRING_PROTOCOL_VERSION ||
      typeof invite.hostPeerId !== 'string' || typeof invite.inviteId !== 'string' || typeof invite.secret !== 'string' || typeof invite.expiresAt !== 'string' ||
      !/^[A-Za-z0-9]{10,128}$/.test(invite.hostPeerId) || !Array.isArray(invite.addresses) || invite.addresses.length > 32 ||
      !/^[0-9a-f-]{36}$/i.test(invite.inviteId) || !/^[A-Za-z0-9_-]{43}$/.test(invite.secret) ||
      !Number.isFinite(Date.parse(invite.expiresAt))) return false;
  return invite.addresses.every((address) => typeof address === 'string' && address.length <= 512 && isPrivateLanMultiaddr(address, invite.hostPeerId!));
}

function getPeerId(address: string): string | undefined {
  return multiaddr(address).getComponents().find((component) => component.name === 'p2p')?.value;
}

function isPrivateLanMultiaddr(address: string, peerId: string): boolean {
  try {
    const components = multiaddr(address).getComponents();
    const peer = components.find((component) => component.name === 'p2p')?.value;
    const ip4 = components.find((component) => component.name === 'ip4')?.value;
    const ip6 = components.find((component) => component.name === 'ip6')?.value;
    if (peer !== peerId || components.find((component) => component.name === 'tcp') === undefined) return false;
    if (ip4) return isPrivateIpv4(ip4) || ip4.startsWith('127.');
    if (ip6) return ip6 === '::1' || /^(fc|fd)/i.test(ip6);
    return false;
  } catch {
    return false;
  }
}
