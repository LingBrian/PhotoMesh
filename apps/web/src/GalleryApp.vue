<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { GalleryPreviewError, loadAssetPreview, type GalleryPreviewErrorCode } from './gallery-preview.js';
import { maxGalleryThumbnailBytes, readGalleryThumbnail } from './gallery-thumbnail.js';
import { createMediaVersion, GalleryVersionError, getMediaVersion, isTerminalVersionStatus, loadMediaVersions, loadVersionContent, normalizeCrop, type VersionCollection } from './gallery-versions.js';
import { assetTagPath, maxLegacyTagsPerAsset, mergeAssetTags, normalizeAssetTag } from './asset-tags.js';
import { maxBulkSelection, updateAssetSelection } from './gallery-bulk.js';
import {
  captureDateGroupKey as getCaptureDateGroupKey, captureDateTimeValue as getCaptureDateTimeValue,
  formatCaptureDate as displayCaptureDate, formatCaptureDateGroup as displayCaptureDateGroup,
  formatCaptureTime as displayCaptureTime
} from './capture-date-display.js';
import { isAuthorizationFailure, isRequestAborted, revokeObjectUrls, SessionRequestScope } from './session-security.js';
import './gallery.css';

type Library = { libraryId: string; title: string };
type Asset = {
  assetId: string; libraryId: string; originNodeId: string; kind: string; sha256: string;
  availability: 'online' | 'cached' | 'offline' | 'missing'; filename: string; capturedAt: string | null;
  captureLocalTime?: string | null; captureOffsetMinutes?: number | null;
  captureSource?: 'exif_offset' | 'exif_floating' | 'legacy_unknown' | 'unknown';
  captureConfidence?: 'high' | 'medium' | 'unknown';
  sourcePath: string | null; sourceKind: string; byteSize: number; version: string; tags?: string[]; favorite?: boolean;
};
type Page = { items: Asset[]; nextCursor: string | null };
type DuplicateCandidateAsset = { assetId: string; originNodeId: string; kind: string; sha256: string; byteSize: number; filename: string; sourcePath: string | null; sourceKind: string; availability: string };
type DuplicateCandidateGroup = { sha256: string; byteSize: number; assets: DuplicateCandidateAsset[]; truncated: boolean };
type Tombstone = { assetId: string; libraryId: string; eventId: string };
type PendingPeerApproval = { peerId: string; publicKey: string; proposedLabel: string; requestedAt: string };
type Album = { id: string; name: string; tag: string };
type BulkActionDraft = { kind: 'tag'; add: boolean } | { kind: 'favorite'; favorite: boolean };
type BulkAction = { kind: 'tag'; add: boolean; tag: string } | { kind: 'favorite'; favorite: boolean };
type BulkOperationEntry = { assetId: string; filename: string; status: 'queued' | 'pending' | 'success' | 'failed'; operationId?: string; error?: string };
type BulkOperation = { libraryId: string; action: BulkAction; entries: BulkOperationEntry[] };
type BulkInterruptedSummary = { id: number; kind: 'tag' | 'favorite'; total: number; succeeded: number; failed: number; uncertain: number; notStarted: number };
class NodeApiError extends Error {
  constructor(readonly status: number) { super(String(status)); }
}
function readPreference(key: string): string | null { try { return localStorage.getItem(key); } catch { return null; } }
function writePreference(key: string, value: string): void { try { localStorage.setItem(key, value); } catch { /* Preferences are optional and never block the gallery. */ } }
const { t, locale } = useI18n();
const savedLocale = readPreference('photomesh-ui-locale');
if (savedLocale === 'zh-CN' || savedLocale === 'en') locale.value = savedLocale;
const endpoint = ref('http://127.0.0.1:8443');
const endpointInput = ref(endpoint.value);
const token = ref('');
const tokenInput = ref('');
const remoteEndpointAcknowledged = ref(false);
const connected = ref(false);
const hasSession = ref(false);
const lastHealthCheck = ref<Date | null>(null);
const cacheAvailable = ref(true);
const isCachedPreview = ref(false);
const isDesktopRuntime = '__TAURI_INTERNALS__' in window;
const busy = ref(false);
const error = ref('');
const libraries = ref<Library[]>([]);
const libraryId = ref('');
const assets = ref<Asset[]>([]);
const cursor = ref<string | null>(null);
const search = ref('');
const searchInput = ref<HTMLInputElement>();
const gallerySearchEnabled = ref(false);
const duplicateCandidatesEnabled = ref(false);
const duplicateGroups = ref<DuplicateCandidateGroup[]>([]);
const duplicateBusy = ref(false);
const duplicateError = ref('');
const ignoredDuplicateHashes = ref<Set<string>>(new Set());
const searchStatus = ref<'idle' | 'debouncing' | 'loading' | 'results' | 'empty' | 'invalid' | 'unsupported' | 'error'>('idle');
const section = ref<'timeline' | 'duplicates' | 'recycle' | 'settings'>('timeline');
const tombstones = ref<Tombstone[]>([]);
const tombstonesBusy = ref(false);
const tombstoneError = ref('');
const tombstoneStatus = ref('');
const restoringTombstones = ref<Record<string, boolean>>({});
const peers = ref<Array<{ peerId: string; label: string; trustState: string }>>([]);
const pendingPeers = ref<PendingPeerApproval[]>([]);
const grantLibraryByPeer = ref<Record<string, string>>({});
const tagWritersByLibrary = ref<Record<string, string[]>>({});
const tagSyncStatusByPeer = ref<Record<string, { pending: number; lastError: string | null }>>({});
const peersBusy = ref(false);
const peersError = ref('');
const tagWriteNotice = ref('');
const invitation = ref<{ qrDataUrl: string; invite: unknown } | null>(null);
const scannedInvite = ref('');
const savedTheme = readPreference('photomesh-ui-theme');
const theme = ref<'light' | 'dark'>(savedTheme === 'light' || savedTheme === 'dark' ? savedTheme : window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
const scrollElement = ref<HTMLElement>();
const scrollTop = ref(0);
const tags = ref<Record<string, string[]>>({});
const serverTags = ref<Record<string, string[]>>({});
const legacyTags = ref<Record<string, string[]>>({});
const importedLegacyTagAssets = ref<Record<string, boolean>>({});
const legacyTagImportState = ref<'idle' | 'importing' | 'complete' | 'failed'>('idle');
const legacyTagImportFailures = ref(0);
const localMetadataUnavailable = ref(false);
const legacyTagImportInFlight = new Set<string>();
const legacyTagImportFailedKeys = new Set<string>();
const albums = ref<Album[]>([]);
const activeAlbum = ref('');
const selectedAsset = ref<Asset | null>(null);
const selectedAssetIds = ref<Set<string>>(new Set());
const selectionError = ref('');
const bulkActionDraft = ref<BulkActionDraft | null>(null);
const bulkDialogOpen = ref(false);
const bulkTagInput = ref('');
const bulkError = ref('');
const bulkOperation = ref<BulkOperation | null>(null);
const bulkBusy = ref(false);
const bulkInterrupted = ref<BulkInterruptedSummary[]>([]);
const tagDialogError = ref('');
const tagWriteBusy = ref(false);
const previewAsset = ref<Asset | null>(null);
const previewUrl = ref('');
const previewBusy = ref(false);
const previewErrorCode = ref<GalleryPreviewErrorCode | null>(null);
const mediaVersionsEnabled = ref(false);
const thumbnailsEnabled = ref(false);
const assetTagsEnabled = ref(false);
const assetFavoritesEnabled = ref(false);
const tagSyncEnabled = ref(false);
const versions = ref<VersionCollection | null>(null);
const versionsBusy = ref(false);
const versionError = ref('');
const crop = ref({ x: 0, y: 0, width: 1, height: 1 });
const sourceVersionId = ref('');
let versionGeneration = 0;
let versionPreviewRequestId = 0;
const pendingIdempotencyKeys = new Map<string, string>();
const rotation = ref<0 | 90 | 180 | 270>(0);
const versionPreviewUrl = ref('');
const activeVersionId = ref('');
const tagInput = ref('');
const thumbnailUrls = ref<Record<string, string>>({});
const maxThumbnailMemoryBytes = 8 * 1024 * 1024;
const maxThumbnailMemoryEntries = 128;
const thumbnailUrlCache = new Map<string, { url: string; byteSize: number }>();
const thumbnailRequests = new Map<string, AbortController>();
let thumbnailMemoryBytes = 0;
let previewGeneration = 0;
let previewAbort: AbortController | undefined;
let previewInvoker: HTMLElement | null = null;
let imageObserver: IntersectionObserver | undefined;
let healthTimer: ReturnType<typeof setInterval> | undefined;
let pageGeneration = 0;
let cacheGeneration = 0;
let metadataGeneration = 0;
let suppressLibraryReload = false;
let sessionRevision = 0;
let bulkInterruptedSequence = 0;
let connectionGeneration = 0;
let healthGeneration = 0;
let healthAbort: AbortController | undefined;
let connectAbort: AbortController | undefined;
let requestedLibraryAfterReconnect: string | undefined;
let endpointSwitchNeedsFreshToken = false;
const sessionRequests = new SessionRequestScope();
const rowHeight = 164;
const pageSize = 100;
const systemTimeZone = (() => {
  try {
    const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
    new Intl.DateTimeFormat('en-US', { timeZone });
    return timeZone;
  } catch { return 'UTC'; }
})();
const fullDateFormatter = computed(() => new Intl.DateTimeFormat(locale.value, { dateStyle: 'medium', timeStyle: 'short', timeZone: systemTimeZone }));

const searchTerm = computed(() => search.value.trim());
const filteredAssets = computed(() => {
  return assets.value.filter((asset) => {
    if (activeAlbum.value) {
      const album = albums.value.find((item) => item.id === activeAlbum.value);
      if (!album || !(tags.value[asset.assetId] ?? []).includes(album.tag)) return false;
    }
    return true;
  });
});
const searchFeedback = computed(() => {
  if (!hasSession.value || !connected.value) return '';
  if (searchStatus.value === 'unsupported' || !gallerySearchEnabled.value) return t('gallery.searchUnsupported');
  switch (searchStatus.value) {
    case 'debouncing': return t('gallery.searchWaiting');
    case 'loading': return t('gallery.searchLoading');
    case 'invalid': return t('gallery.searchMinLength');
    case 'results': return t('gallery.searchResultsLoaded');
    default: return '';
  }
});
const selectedLibraryTitle = computed(() => libraries.value.find((library) => library.libraryId === libraryId.value)?.title ?? t('gallery.timeline'));
const bulkActionsAvailable = computed(() => assetTagsEnabled.value || assetFavoritesEnabled.value);
const selectedAssets = computed(() => Array.from(selectedAssetIds.value)
  .map((assetId) => assets.value.find((asset) => asset.assetId === assetId))
  .filter((asset): asset is Asset => Boolean(asset && asset.libraryId === libraryId.value)));
const selectedTagOptions = computed(() => mergeAssetTags(...selectedAssets.value.map((asset) => tags.value[asset.assetId] ?? [])));
const activeBulkAction = computed(() => bulkOperation.value?.action ?? bulkActionDraft.value);
const bulkActionCount = computed(() => bulkOperation.value?.entries.length ?? selectedAssetIds.value.size);
const bulkSucceededCount = computed(() => bulkOperation.value?.entries.filter((entry) => entry.status === 'success').length ?? 0);
const bulkFailedCount = computed(() => bulkOperation.value?.entries.filter((entry) => entry.status === 'failed').length ?? 0);
const bulkCompletedCount = computed(() => bulkSucceededCount.value + bulkFailedCount.value);
const bulkDialogTitle = computed(() => {
  const action = activeBulkAction.value;
  if (!action) return t('gallery.bulkActions');
  if (action.kind === 'tag') return t(action.add ? 'gallery.bulkDialogAddTagTitle' : 'gallery.bulkDialogRemoveTagTitle', { count: bulkActionCount.value });
  return t(action.favorite ? 'gallery.bulkDialogFavoriteTitle' : 'gallery.bulkDialogUnfavoriteTitle', { count: bulkActionCount.value });
});
const bulkConfirmLabel = computed(() => {
  const action = bulkActionDraft.value;
  if (!action) return '';
  if (action.kind === 'tag') return t(action.add ? 'gallery.bulkConfirmTagAdd' : 'gallery.bulkConfirmTagRemove', { count: selectedAssetIds.value.size });
  return t(action.favorite ? 'gallery.bulkConfirmFavorite' : 'gallery.bulkConfirmUnfavorite', { count: selectedAssetIds.value.size });
});
const bulkCanConfirm = computed(() => {
  const action = bulkActionDraft.value;
  if (!action || bulkOperation.value || bulkBusy.value || !hasSession.value || !connected.value || selectedAssets.value.length !== selectedAssetIds.value.size || !selectedAssets.value.length || selectedAssets.value.length > maxBulkSelection) return false;
  if (action.kind === 'favorite') return assetFavoritesEnabled.value;
  if (!assetTagsEnabled.value) return false;
  const tag = normalizeAssetTag(bulkTagInput.value);
  if (!tag || !action.add && !selectedTagOptions.value.includes(tag)) return false;
  return action.add || !selectedAssets.value.some((asset) => !importedLegacyTagAssets.value[asset.assetId] && (legacyTags.value[asset.assetId] ?? []).includes(tag));
});
const bulkStatusText = computed(() => {
  const total = bulkOperation.value?.entries.length ?? 0;
  return bulkBusy.value
    ? t('gallery.bulkProgress', { completed: bulkCompletedCount.value, total })
    : t('gallery.bulkCompletedSummary', { succeeded: bulkSucceededCount.value, failed: bulkFailedCount.value });
});
function bulkInterruptionText(summary: BulkInterruptedSummary): string {
  const key = summary.kind === 'tag' ? 'gallery.bulkInterruptedTag' : 'gallery.bulkInterruptedFavorite';
  return t(key, { total: summary.total, succeeded: summary.succeeded, failed: summary.failed, uncertain: summary.uncertain, notStarted: summary.notStarted });
}
const visibleStart = computed(() => Math.max(0, Math.floor(scrollTop.value / rowHeight) - 3));
const visibleEnd = computed(() => Math.min(filteredAssets.value.length, visibleStart.value + 24));
const visibleAssets = computed(() => filteredAssets.value.slice(visibleStart.value, visibleEnd.value));
const hasLegacyTagData = computed(() => Object.values(legacyTags.value).some((assetTags) => assetTags.length > 0));
const topSpacer = computed(() => visibleStart.value * rowHeight);
const bottomSpacer = computed(() => Math.max(0, (filteredAssets.value.length - visibleEnd.value) * rowHeight));
const apiBase = computed(() => endpoint.value.trim().replace(/\/+$/, ''));
const desktopRemoteEndpoint = computed(() => {
  if (!isDesktopRuntime) return '';
  try {
    const normalized = normalizeEndpoint(endpointInput.value);
    return new URL(normalized).protocol === 'https:' && !isLoopbackEndpoint(normalized) ? normalized : '';
  } catch { return ''; }
});
watch(endpointInput, (value, previous) => {
  remoteEndpointAcknowledged.value = false;
  const normalizeForComparison = (candidate: string): string => {
    try { return normalizeEndpoint(candidate); } catch { return candidate.trim(); }
  };
  if (normalizeForComparison(value) === normalizeForComparison(previous)) return;
  if (!hasSession.value && !token.value.trim() && !tokenInput.value.trim()) return;
  endpointSwitchNeedsFreshToken = true;
  requestedLibraryAfterReconnect = undefined;
  search.value = '';
  clearAuthorizedSession(true);
  section.value = 'settings';
  error.value = t('gallery.nodeSessionChanged');
});
watch(tokenInput, (value) => {
  if (value.trim()) endpointSwitchNeedsFreshToken = false;
});

function normalizeEndpoint(value: string): string {
  const parsed = new URL(value.trim());
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash || parsed.pathname !== '/') {
    throw new Error(t('gallery.invalidNodeAddress'));
  }
  return parsed.origin;
}
function isLoopbackEndpoint(value: string): boolean {
  try {
    const hostname = new URL(value).hostname.toLowerCase();
    return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]' || hostname === '::1';
  } catch { return false; }
}
function captureBulkInterruption(): void {
  const operation = bulkOperation.value;
  if (!operation) return;
  const succeeded = operation.entries.filter((entry) => entry.status === 'success').length;
  const failed = operation.entries.filter((entry) => entry.status === 'failed').length;
  const uncertain = operation.entries.filter((entry) => entry.status === 'pending').length;
  const notStarted = operation.entries.filter((entry) => entry.status === 'queued').length;
  if (failed + uncertain + notStarted === 0) return;
  bulkInterrupted.value = [...bulkInterrupted.value, {
    id: ++bulkInterruptedSequence,
    kind: operation.action.kind,
    total: operation.entries.length,
    succeeded,
    failed,
    uncertain,
    notStarted,
  }].slice(-5);
}
function dismissBulkInterruption(id: number): void {
  bulkInterrupted.value = bulkInterrupted.value.filter((summary) => summary.id !== id);
}
function clearAuthorizedSession(clearCredentials = false): void {
  captureBulkInterruption();
  sessionRevision += 1;
  sessionRequests.invalidate();
  connectionGeneration += 1;
  connectAbort?.abort(); connectAbort = undefined;
  healthGeneration += 1;
  healthAbort?.abort(); healthAbort = undefined;
  pageGeneration += 1; metadataGeneration += 1;
  if (searchTimer) { clearTimeout(searchTimer); searchTimer = undefined; }
  searchRevision += 1;
  busy.value = false; tombstonesBusy.value = false; peersBusy.value = false;
  if (healthTimer) { clearInterval(healthTimer); healthTimer = undefined; }
  hasSession.value = false; connected.value = false; lastHealthCheck.value = null; gallerySearchEnabled.value = false; assetFavoritesEnabled.value = false;
  search.value = ''; searchStatus.value = 'idle';
  libraries.value = []; libraryId.value = ''; assets.value = []; cursor.value = null;
  tombstones.value = []; tombstoneError.value = ''; tombstoneStatus.value = ''; restoringTombstones.value = {};
  peers.value = []; pendingPeers.value = []; peersError.value = ''; tagWriteNotice.value = ''; grantLibraryByPeer.value = {}; tagWritersByLibrary.value = {}; tagSyncStatusByPeer.value = {}; invitation.value = null; scannedInvite.value = '';
  tags.value = {}; serverTags.value = {}; legacyTags.value = {}; importedLegacyTagAssets.value = {};
  legacyTagImportState.value = 'idle'; legacyTagImportFailures.value = 0; localMetadataUnavailable.value = false; legacyTagImportInFlight.clear(); legacyTagImportFailedKeys.clear();
  albums.value = []; activeAlbum.value = ''; selectedAsset.value = null;
  selectedAssetIds.value = new Set(); selectionError.value = ''; bulkActionDraft.value = null; bulkDialogOpen.value = false;
  bulkTagInput.value = ''; bulkError.value = ''; bulkOperation.value = null; bulkBusy.value = false;
  tagInput.value = ''; tagDialogError.value = ''; tagWriteBusy.value = false; pendingIdempotencyKeys.clear();
  mediaVersionsEnabled.value = false; thumbnailsEnabled.value = false; assetTagsEnabled.value = false; tagSyncEnabled.value = false;
  closePreview(); clearThumbnailUrls();
  if (clearCredentials) { token.value = ''; tokenInput.value = ''; }
}
function invalidateAuthorizationSession(): void {
  if (libraryId.value) requestedLibraryAfterReconnect = libraryId.value;
  clearAuthorizedSession(true);
  section.value = 'settings';
  error.value = t('gallery.authorizationRequired');
}
function headers() { return { authorization: `Bearer ${token.value.trim()}` }; }
async function discardResponseBody(response: Response): Promise<void> {
  try { await response.body?.cancel(); } catch { /* Do not retain rejected response streams. */ }
}
async function request<T>(path: string, init: NonNullable<Parameters<typeof fetch>[1]> = {}): Promise<T> {
  const revision = sessionRevision;
  const lease = sessionRequests.begin(init.signal);
  try {
    const response = await fetch(`${apiBase.value}${path}`, {
      ...init,
      headers: { ...headers(), ...init.headers },
      signal: lease.signal,
    });
    if (!response.ok) {
      if (!lease.isCurrent() || revision !== sessionRevision) {
        await discardResponseBody(response);
        throw new DOMException('Session invalidated', 'AbortError');
      }
      if (isAuthorizationFailure(response.status)) invalidateAuthorizationSession();
      await discardResponseBody(response);
      throw new NodeApiError(response.status);
    }
    const result = response.status === 204 ? undefined as T : await response.json() as T;
    if (!lease.isCurrent() || revision !== sessionRevision) throw new DOMException('Session invalidated', 'AbortError');
    return result;
  } finally { lease.release(); }
}
async function connect(preserveSession = false): Promise<void> {
  let requestedEndpoint: string;
  try { requestedEndpoint = normalizeEndpoint(endpointInput.value); }
  catch (cause) { error.value = errorText(cause); return; }
  if (new URL(requestedEndpoint).protocol === 'http:' && !isLoopbackEndpoint(requestedEndpoint)) {
    error.value = t('gallery.insecureRemoteNode'); return;
  }
  if (isDesktopRuntime && !isLoopbackEndpoint(requestedEndpoint) && !remoteEndpointAcknowledged.value) {
    error.value = t('gallery.remoteNodeTrustRequired'); return;
  }
  if (endpointSwitchNeedsFreshToken) {
    error.value = t('gallery.nodeSessionChanged'); section.value = 'settings'; return;
  }
  if (!tokenInput.value.trim()) { error.value = t('gallery.tokenRequired'); return; }
  const requestedToken = tokenInput.value.trim();
  const sameSession = hasSession.value && requestedEndpoint === endpoint.value && requestedToken === token.value;
  const previousLibraryId = libraryId.value;
  const preferredLibraryId = requestedLibraryAfterReconnect ?? (requestedEndpoint === endpoint.value ? previousLibraryId : undefined);
  if (!preserveSession || !sameSession) clearAuthorizedSession();
  connectAbort?.abort();
  const generation = ++connectionGeneration;
  const controller = new AbortController();
  connectAbort = controller;
  endpoint.value = requestedEndpoint; token.value = requestedToken;
  error.value = ''; busy.value = true; connected.value = false;
  try {
    const health = await fetch(`${apiBase.value}/v1/health`, { signal: controller.signal });
    if (generation !== connectionGeneration) return;
    lastHealthCheck.value = new Date();
    if (!health.ok) throw new Error(t('gallery.connectionFailed'));
    const healthResult = await health.json() as { capabilities?: unknown };
    if (generation !== connectionGeneration) return;
    const capabilities = Array.isArray(healthResult.capabilities) ? healthResult.capabilities.filter((value): value is string => typeof value === 'string') : [];
    gallerySearchEnabled.value = capabilities.includes('gallerySearch');
    duplicateCandidatesEnabled.value = capabilities.includes('duplicateCandidates');
       mediaVersionsEnabled.value = capabilities.includes('mediaVersions');
    thumbnailsEnabled.value = capabilities.includes('thumbnails');
    assetTagsEnabled.value = capabilities.includes('assetTags');
    assetFavoritesEnabled.value = capabilities.includes('assetFavorites');
    tagSyncEnabled.value = capabilities.includes('tagSync');
    const result = await request<{ items: Library[] }>('/v1/libraries', { signal: controller.signal });
    if (generation !== connectionGeneration) return;
    libraries.value = result.items;
    suppressLibraryReload = true;
    libraryId.value = result.items.find((item) => item.libraryId === preferredLibraryId)?.libraryId ?? result.items[0]?.libraryId ?? '';
    requestedLibraryAfterReconnect = undefined;
    suppressLibraryReload = false;
    connected.value = true; hasSession.value = true;
    await loadLocalMetadata();
    if (libraryId.value) await loadPage(true, sameSession);
    if (!hasSession.value || generation !== connectionGeneration) return;
    await loadPeerList();
    if (!hasSession.value || generation !== connectionGeneration) return;
    if (healthTimer) clearInterval(healthTimer);
    healthTimer = setInterval(() => { void checkHealth(); }, 30000);
  } catch (cause) {
    if (generation === connectionGeneration && !isRequestAborted(cause)) error.value = errorText(cause);
  } finally {
    if (generation === connectionGeneration) busy.value = false;
    if (connectAbort === controller) connectAbort = undefined;
  }
}
function disconnectSession(): void {
  requestedLibraryAfterReconnect = undefined;
  endpointSwitchNeedsFreshToken = false;
  clearAuthorizedSession(true);
  endpointInput.value = endpoint.value;
  remoteEndpointAcknowledged.value = false;
  error.value = '';
  section.value = 'timeline';
}
async function checkHealth(): Promise<void> {
  const wasConnected = connected.value;
  const expectedEndpoint = apiBase.value;
  const generation = ++healthGeneration;
  healthAbort?.abort();
  const controller = new AbortController();
  healthAbort = controller;
  lastHealthCheck.value = new Date();
  try {
    const response = await fetch(`${expectedEndpoint}/v1/health`, { signal: controller.signal });
    if (generation !== healthGeneration || expectedEndpoint !== apiBase.value) return;
    if (isAuthorizationFailure(response.status) && hasSession.value) { invalidateAuthorizationSession(); return; }
    connected.value = response.ok;
    if (!response.ok) { gallerySearchEnabled.value = false; assetFavoritesEnabled.value = false; }
    if (response.ok) {
      const healthResult = await response.json() as { capabilities?: unknown };
      if (generation !== healthGeneration || expectedEndpoint !== apiBase.value) return;
      const capabilities = Array.isArray(healthResult.capabilities) ? healthResult.capabilities.filter((value): value is string => typeof value === 'string') : [];
      gallerySearchEnabled.value = capabilities.includes('gallerySearch');
      duplicateCandidatesEnabled.value = capabilities.includes('duplicateCandidates');
       mediaVersionsEnabled.value = capabilities.includes('mediaVersions');
      thumbnailsEnabled.value = capabilities.includes('thumbnails');
      assetTagsEnabled.value = capabilities.includes('assetTags');
      assetFavoritesEnabled.value = capabilities.includes('assetFavorites');
      tagSyncEnabled.value = capabilities.includes('tagSync');
    }
    if (response.ok && !wasConnected && hasSession.value) {
      await loadPage(true, true);
      await loadPeerList();
      if (section.value === 'recycle') await loadRecycleBin();
       if (section.value === 'duplicates') await loadDuplicateCandidates();
    }
  } catch (cause) {
    if (generation === healthGeneration && !isRequestAborted(cause)) {
      connected.value = false; gallerySearchEnabled.value = false; mediaVersionsEnabled.value = false; thumbnailsEnabled.value = false; assetTagsEnabled.value = false; assetFavoritesEnabled.value = false; tagSyncEnabled.value = false;
    }
  } finally { if (healthAbort === controller) healthAbort = undefined; }
}
async function loadPage(reset = false, preserveOnFailure = false): Promise<boolean> {
  const requestedSearch = searchTerm.value;
  if (requestedSearch && (!gallerySearchEnabled.value || Array.from(requestedSearch).length < 3)) return false;
  if (!connected.value || !hasSession.value || !libraryId.value || busy.value && !reset) return false;
  const previousAssets = assets.value;
  const previousCursor = cursor.value;
  if (reset) { pageGeneration += 1; assets.value = []; cursor.value = null; scrollTop.value = 0; }
  if (cursor.value === '') return true;
  const generation = pageGeneration;
  busy.value = true; error.value = '';
  try {
    const query = new URLSearchParams({ libraryId: libraryId.value, limit: String(pageSize) });
    if (cursor.value) query.set('cursor', cursor.value);
    if (requestedSearch) query.set('q', requestedSearch);
    const page = await request<Page>(`/v1/assets?${query.toString()}`);
    if (generation !== pageGeneration) return false;
    const pageTags = Object.fromEntries(page.items.map((asset) => [asset.assetId, Array.isArray(asset.tags) ? asset.tags : []]));
    serverTags.value = reset ? pageTags : { ...serverTags.value, ...pageTags };
    assets.value = reset ? page.items : [...assets.value, ...page.items];
    refreshTagView(page.items.map((asset) => asset.assetId));
    cursor.value = page.nextCursor ?? '';
    void importLegacyTagsForAssets(page.items);
    return true;
  } catch (cause) {
    if (generation === pageGeneration) {
      if (cause instanceof NodeApiError && cause.status === 410 && !reset && previousCursor) {
        assets.value = []; cursor.value = null; serverTags.value = {};
        return await loadPage(true);
      }
      if (cause instanceof TypeError) connected.value = false;
      if (preserveOnFailure && hasSession.value) { assets.value = previousAssets; cursor.value = previousCursor; }
      error.value = errorText(cause);
    }
    return false;
  } finally { if (generation === pageGeneration) busy.value = false; }
}
let searchTimer: ReturnType<typeof setTimeout> | undefined;
let searchRevision = 0;
async function executeSearch(revision: number): Promise<void> {
  const query = searchTerm.value;
  if (revision !== searchRevision) return;
  if (!connected.value || !hasSession.value || !libraryId.value) { searchStatus.value = 'idle'; return; }
  if (query && !gallerySearchEnabled.value) { searchStatus.value = 'unsupported'; return; }
  if (query && Array.from(query).length < 3) { searchStatus.value = 'invalid'; return; }
  searchStatus.value = 'loading';
  const loaded = await loadPage(true);
  if (revision !== searchRevision) return;
  if (!loaded) { searchStatus.value = query && error.value ? 'error' : 'idle'; return; }
  searchStatus.value = query ? assets.value.length ? 'results' : 'empty' : 'idle';
}
function scheduleSearch(): void {
  if (searchTimer) { clearTimeout(searchTimer); searchTimer = undefined; }
  selectedAssetIds.value = new Set(); selectionError.value = '';
  const revision = ++searchRevision;
  pageGeneration += 1;
  busy.value = false; assets.value = []; cursor.value = null; scrollTop.value = 0; error.value = '';
  const query = searchTerm.value;
  if (query && !gallerySearchEnabled.value) {
    searchStatus.value = hasSession.value && connected.value ? 'unsupported' : 'idle';
    return;
  }
  if (query && Array.from(query).length < 3) { searchStatus.value = 'invalid'; return; }
  if (!query) {
    searchStatus.value = connected.value && hasSession.value ? 'loading' : 'idle';
    void executeSearch(revision);
    return;
  }
  searchStatus.value = 'debouncing';
  searchTimer = setTimeout(() => { searchTimer = undefined; void executeSearch(revision); }, 250);
}
function submitSearch(): void {
  if (searchTimer) { clearTimeout(searchTimer); searchTimer = undefined; }
  void executeSearch(++searchRevision);
}
function clearSearch(): void {
  search.value = '';
  searchInput.value?.focus();
}
watch(search, scheduleSearch, { flush: 'sync' });
watch(activeAlbum, () => { selectedAssetIds.value = new Set(); selectionError.value = ''; });
watch(libraryId, (value, previous) => {
  if (!suppressLibraryReload && hasSession.value && previous && value && value !== previous) {
    requestedLibraryAfterReconnect = value;
    clearAuthorizedSession(true);
    section.value = 'settings';
    error.value = t('gallery.librarySessionChanged');
    return;
  }
  closePreview();
  clearThumbnailUrls();
  activeAlbum.value = '';
  tags.value = {}; serverTags.value = {}; legacyTags.value = {}; importedLegacyTagAssets.value = {}; albums.value = [];
  legacyTagImportState.value = 'idle'; legacyTagImportFailures.value = 0; legacyTagImportFailedKeys.clear();
  if (!suppressLibraryReload) { pageGeneration += 1; busy.value = false; assets.value = []; cursor.value = null; scrollTop.value = 0; }
  if (!suppressLibraryReload && value) void loadLocalMetadata().then(() => { if (libraryId.value === value) void importLegacyTagsForAssets(assets.value); });
  if (connected.value && !suppressLibraryReload) void loadPage(true);
}, { flush: 'sync' });
watch(theme, (value) => { document.documentElement.dataset.theme = value; writePreference('photomesh-ui-theme', value); }, { immediate: true });
watch(locale, (value) => {
  const normalized = value === 'zh-CN' ? 'zh-CN' : 'en';
  document.documentElement.lang = normalized;
  writePreference('photomesh-ui-locale', normalized);
}, { immediate: true });
function onScroll(): void {
  scrollTop.value = scrollElement.value?.scrollTop ?? 0;
  if (!activeAlbum.value && visibleEnd.value >= filteredAssets.value.length - 8 && cursor.value && !busy.value) void loadPage();
}
function observeImages(): void {
  void nextTick(() => {
    imageObserver?.disconnect();
    imageObserver = new IntersectionObserver((entries) => {
      for (const entry of entries) if (entry.isIntersecting) {
        const id = (entry.target as HTMLElement).dataset.assetId;
        if (id) { imageObserver?.unobserve(entry.target); void ensureThumbnail(id); }
      }
    }, { root: scrollElement.value ?? null, rootMargin: '350px' });
    document.querySelectorAll<HTMLElement>('[data-asset-id]').forEach((element) => imageObserver?.observe(element));
  });
}
async function loadVisibleThumbnails(): Promise<void> {
  for (const asset of visibleAssets.value) {
    if (asset.kind === 'photo') await ensureThumbnail(asset.assetId);
  }
}
watch(visibleAssets, () => { observeImages(); void loadVisibleThumbnails(); });
function thumbnailCacheKey(asset: Asset): string {
  return JSON.stringify([apiBase.value, asset.libraryId, asset.originNodeId, asset.assetId, asset.version]);
}
function localMetadataKey(): string {
  return JSON.stringify([apiBase.value, libraryId.value]);
}
function refreshTagView(assetIds: readonly string[]): void {
  const next = { ...tags.value };
  for (const assetId of assetIds) {
    const pendingLegacy = importedLegacyTagAssets.value[assetId] ? [] : legacyTags.value[assetId] ?? [];
    next[assetId] = mergeAssetTags(serverTags.value[assetId] ?? [], pendingLegacy);
  }
  tags.value = next;
}
function legacyTagImportKey(metadataKey: string, assetId: string): string {
  return JSON.stringify([metadataKey, assetId]);
}
async function importLegacyTagsForAssets(items: readonly Asset[]): Promise<void> {
  if (!hasSession.value || !connected.value || !items.length) return;
  const currentLibraryId = libraryId.value;
  const candidates = items.filter((asset) => asset.libraryId === currentLibraryId && (legacyTags.value[asset.assetId] ?? []).length > 0);
  if (!candidates.length) return;
  const key = localMetadataKey();
  if (!assetTagsEnabled.value) {
    for (const asset of candidates) legacyTagImportFailedKeys.add(`${key}:${asset.assetId}`);
    legacyTagImportState.value = 'failed';
    legacyTagImportFailures.value = legacyTagImportFailedKeys.size;
    return;
  }

  const revision = sessionRevision;
  const isCurrent = (): boolean => revision === sessionRevision && key === localMetadataKey() && hasSession.value && currentLibraryId === libraryId.value;
  const work = candidates.filter((asset) => !legacyTagImportInFlight.has(`${key}:${asset.assetId}`));
  if (!work.length) return;
  legacyTagImportState.value = 'importing';
  let nextIndex = 0;
  const worker = async (): Promise<void> => {
    while (nextIndex < work.length) {
      const asset = work[nextIndex++];
      if (!asset) continue;
      const inFlightKey = `${key}:${asset.assetId}`;
      legacyTagImportInFlight.add(inFlightKey);
      const markerKey = legacyTagImportKey(key, asset.assetId);
      try {
        if (!isCurrent()) continue;
        const marker = await idbGet<{ importedTags?: string[] }>('tag-imports', markerKey);
        if (!isCurrent()) continue;
        const rawTags = legacyTags.value[asset.assetId] ?? [];
        const normalized = rawTags.map((rawTag) => normalizeAssetTag(rawTag));
        if (normalized.some((tag) => !tag)) throw new NodeApiError(400);
        const tagsToImport = mergeAssetTags(normalized as string[]);
        if (tagsToImport.length > maxLegacyTagsPerAsset) throw new NodeApiError(400);
        const previouslyImported = Array.isArray(marker?.importedTags)
          ? marker.importedTags.filter((tag): tag is string => typeof tag === 'string')
          : [];
        const pendingTags = tagsToImport.filter((tag) => !previouslyImported.includes(tag));
        if (!pendingTags.length) {
          legacyTagImportFailedKeys.delete(inFlightKey);
          importedLegacyTagAssets.value = { ...importedLegacyTagAssets.value, [asset.assetId]: true };
          refreshTagView([asset.assetId]);
          continue;
        }
        for (const tag of pendingTags) {
          if (!isCurrent()) throw new DOMException('Session invalidated', 'AbortError');
          await request<void>(assetTagPath(asset.libraryId, asset.assetId, tag), { method: 'PUT' });
          if (!isCurrent()) throw new DOMException('Session invalidated', 'AbortError');
        }
        if (!isCurrent()) continue;
        await idbMergeImportedTagMarker(markerKey, pendingTags);
        if (!isCurrent()) continue;
        legacyTagImportFailedKeys.delete(inFlightKey);
        importedLegacyTagAssets.value = { ...importedLegacyTagAssets.value, [asset.assetId]: true };
        serverTags.value = { ...serverTags.value, [asset.assetId]: mergeAssetTags(serverTags.value[asset.assetId] ?? asset.tags ?? [], pendingTags) };
        refreshTagView([asset.assetId]);
      } catch (cause) {
        if (revision === sessionRevision && key === localMetadataKey() && !isRequestAborted(cause)) legacyTagImportFailedKeys.add(inFlightKey);
      } finally {
        legacyTagImportInFlight.delete(inFlightKey);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(2, work.length) }, () => worker()));
  if (revision === sessionRevision && key === localMetadataKey()) {
    legacyTagImportFailures.value = legacyTagImportFailedKeys.size;
    legacyTagImportState.value = legacyTagImportFailures.value ? 'failed' : 'complete';
  }
}
async function retryLegacyTagImport(): Promise<void> {
  legacyTagImportState.value = 'idle';
  legacyTagImportFailures.value = 0;
  await importLegacyTagsForAssets(assets.value);
}
function clearThumbnailUrls(): void {
  cacheGeneration += 1;
  for (const controller of thumbnailRequests.values()) controller.abort();
  thumbnailRequests.clear();
  revokeObjectUrls([...thumbnailUrlCache.values()].map((entry) => entry.url), (url) => URL.revokeObjectURL(url));
  thumbnailUrlCache.clear();
  thumbnailMemoryBytes = 0;
  thumbnailUrls.value = {};
}

function touchThumbnailUrl(assetId: string): void {
  const entry = thumbnailUrlCache.get(assetId);
  if (!entry) return;
  thumbnailUrlCache.delete(assetId);
  thumbnailUrlCache.set(assetId, entry);
}

function removeThumbnailUrl(assetId: string): void {
  const entry = thumbnailUrlCache.get(assetId);
  if (!entry) return;
  thumbnailUrlCache.delete(assetId);
  thumbnailMemoryBytes -= entry.byteSize;
  revokeObjectUrls([entry.url], (url) => URL.revokeObjectURL(url));
  const nextUrls = { ...thumbnailUrls.value };
  delete nextUrls[assetId];
  thumbnailUrls.value = nextUrls;
}

function setThumbnailUrl(assetId: string, blob: Blob): void {
  if (blob.size < 1 || blob.size > maxThumbnailMemoryBytes) return;
  const previous = thumbnailUrlCache.get(assetId);
  if (previous) {
    revokeObjectUrls([previous.url], (url) => URL.revokeObjectURL(url));
    thumbnailMemoryBytes -= previous.byteSize;
    thumbnailUrlCache.delete(assetId);
  }
  const url = URL.createObjectURL(blob);
  thumbnailUrlCache.set(assetId, { url, byteSize: blob.size });
  thumbnailMemoryBytes += blob.size;
  thumbnailUrls.value = { ...thumbnailUrls.value, [assetId]: url };
  while (thumbnailUrlCache.size > maxThumbnailMemoryEntries || thumbnailMemoryBytes > maxThumbnailMemoryBytes) {
    const oldest = thumbnailUrlCache.entries().next().value as [string, { url: string; byteSize: number }] | undefined;
    if (!oldest) break;
    thumbnailUrlCache.delete(oldest[0]);
    thumbnailMemoryBytes -= oldest[1].byteSize;
    revokeObjectUrls([oldest[1].url], (url) => URL.revokeObjectURL(url));
    const nextUrls = { ...thumbnailUrls.value };
    delete nextUrls[oldest[0]];
    thumbnailUrls.value = nextUrls;
  }
}

async function ensureThumbnail(assetId: string): Promise<void> {
  if (thumbnailUrls.value[assetId]) { touchThumbnailUrl(assetId); return; }
  if (thumbnailRequests.has(assetId)) return;
  const asset = assets.value.find((item) => item.assetId === assetId);
  if (!asset || asset.kind !== 'photo') return;
  const generation = cacheGeneration;
  const key = thumbnailCacheKey(asset);
  const controller = new AbortController();
  const lease = sessionRequests.begin(controller.signal);
  thumbnailRequests.set(assetId, controller);
  try {
    let cached: Blob | undefined;
    try { cached = await idbGet<Blob>('thumbnails', key); } catch { /* A cache miss does not trigger original bytes. */ }
    if (!lease.isCurrent()) return;
    if (cached && cached.size > 0 && cached.size <= maxThumbnailMemoryBytes &&
        generation === cacheGeneration && assets.value.some((item) => thumbnailCacheKey(item) === key)) {
      setThumbnailUrl(assetId, cached);
      return;
    }
    if (!thumbnailsEnabled.value || !connected.value || !token.value.trim()) return;
    const path = `/v1/libraries/${encodeURIComponent(asset.libraryId)}/assets/${encodeURIComponent(asset.assetId)}/thumbnail?profile=timeline-192`;
    const response = await fetch(`${apiBase.value}${path}`, {
      headers: headers(), cache: 'no-store', signal: lease.signal
    });
    if (isAuthorizationFailure(response.status)) {
      if (generation === cacheGeneration && lease.isCurrent()) invalidateAuthorizationSession();
      return;
    }
    if (response.status === 404) {
      if (generation === cacheGeneration) removeThumbnailUrl(assetId);
      return;
    }
    if (!response.ok) return;
    if ((response.headers.get('content-type') ?? '').split(';', 1)[0]?.trim().toLowerCase() !== 'image/webp') {
      try { await response.body?.cancel(); } catch { /* Reject unexpected media types without reading them. */ }
      return;
    }
    const contentLength = Number(response.headers.get('content-length'));
    if (Number.isFinite(contentLength) && contentLength > maxGalleryThumbnailBytes) {
      try { await response.body?.cancel(); } catch { /* The byte limit remains authoritative. */ }
      return;
    }
    const blob = await readGalleryThumbnail(response);
    if (!blob || blob.size < 1 || blob.size > maxGalleryThumbnailBytes || generation !== cacheGeneration ||
        !assets.value.some((item) => thumbnailCacheKey(item) === key)) return;
    setThumbnailUrl(assetId, blob);
  } catch {
    // The grid keeps its placeholder on transport/decoder errors; no original read is attempted.
  } finally {
    lease.release();
    if (thumbnailRequests.get(assetId) === controller) thumbnailRequests.delete(assetId);
  }
}

function clearVersionPreview(): void { versionPreviewRequestId += 1; if (versionPreviewUrl.value) revokeObjectUrls([versionPreviewUrl.value], (url) => URL.revokeObjectURL(url)); versionPreviewUrl.value = ''; activeVersionId.value = ''; }
function closePreview(restoreFocus = false): void {
  const invoker = restoreFocus ? previewInvoker : null;
  previewInvoker = null;
  clearVersionPreview();
  versionGeneration += 1;
  versions.value = null; versionsBusy.value = false; versionError.value = ''; crop.value = { x: 0, y: 0, width: 1, height: 1 }; sourceVersionId.value = ''; rotation.value = 0;
  previewGeneration += 1;
  previewAbort?.abort();
  previewAbort = undefined;
  if (previewUrl.value) revokeObjectUrls([previewUrl.value], (url) => URL.revokeObjectURL(url));
  previewUrl.value = '';
  previewAsset.value = null;
  previewBusy.value = false;
  previewErrorCode.value = null;
  isCachedPreview.value = false;
  if (restoreFocus && invoker?.isConnected) void nextTick(() => invoker.focus());
}

async function resizeImage(source: Blob, maxWidth: number, maxHeight: number): Promise<Blob> {
  const bitmap = await createImageBitmap(source);
  try {
    const scale = Math.min(maxWidth / bitmap.width, maxHeight / bitmap.height, 1);
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const context = canvas.getContext('2d');
    if (!context) throw new Error('canvas_unavailable');
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const output = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/webp', 0.82));
    if (!output) throw new Error('image_encode_failed');
    return output;
  } finally { bitmap.close(); }
}

async function openPreview(asset: Asset): Promise<void> {
  const invoker = previewAsset.value ? previewInvoker : document.activeElement instanceof HTMLElement ? document.activeElement : null;
  closePreview();
  previewInvoker = invoker;
  const generation = ++previewGeneration;
  const controller = new AbortController();
  previewAbort = controller;
  previewAsset.value = asset;
  isCachedPreview.value = false;
  if (connected.value && mediaVersionsEnabled.value) void loadVersions();
  previewBusy.value = true;
  await nextTick();
  if (generation !== previewGeneration) return;
  document.querySelector<HTMLElement>('.preview-dialog')?.focus();
  try {
    if (!connected.value || !['online', 'cached'].includes(asset.availability)) {
      let cached: Blob | undefined;
      try { cached = await idbGet<Blob>('thumbnails', thumbnailCacheKey(asset)); } catch { /* Use current-session memory cache if available. */ }
      if (!cached) {
        const cachedUrl = thumbnailUrls.value[asset.assetId];
        if (cachedUrl) {
          touchThumbnailUrl(asset.assetId);
          try {
            const cachedResponse = await fetch(cachedUrl);
            if (cachedResponse.ok) cached = await cachedResponse.blob();
          } catch { /* The object URL may have been evicted during navigation. */ }
        }
      }
      if (!cached) throw new GalleryPreviewError('source-offline');
      if (generation !== previewGeneration) return;
      previewUrl.value = URL.createObjectURL(cached);
      isCachedPreview.value = true;
      return;
    }
    const original = await loadAssetPreview({
      apiBase: apiBase.value, token: token.value, asset, signal: controller.signal,
      fetcher: async (input, init) => {
        const response = await fetch(input, init);
        if (isAuthorizationFailure(response.status) && generation === previewGeneration) invalidateAuthorizationSession();
        return response;
      },
    });
    if (generation !== previewGeneration) return;
    const view = await resizeImage(original, 1600, 1200);
    if (generation !== previewGeneration) return;
    const thumbnail = await resizeImage(view, 360, 220);
    if (generation !== previewGeneration) return;
    try {
      await idbPut('thumbnails', { key: thumbnailCacheKey(asset), value: thumbnail });
      cacheAvailable.value = true;
    } catch { cacheAvailable.value = false; }
    if (generation !== previewGeneration) return;
    setThumbnailUrl(asset.assetId, thumbnail);
    previewUrl.value = URL.createObjectURL(view);
  } catch (cause) {
    if (generation === previewGeneration && !controller.signal.aborted) {
      if (cause instanceof GalleryPreviewError && cause.code === 'unauthorized') {
        invalidateAuthorizationSession();
        return;
      }
      previewErrorCode.value = cause instanceof GalleryPreviewError ? cause.code : 'unsupported-media';
    }
  } finally {
    if (generation === previewGeneration) previewBusy.value = false;
  }
}

const previewIndex = computed(() => previewAsset.value ? filteredAssets.value.findIndex((item) => item.assetId === previewAsset.value?.assetId) : -1);
function findPreviewNeighbor(direction: -1 | 1): number {
  const currentIndex = previewAsset.value ? filteredAssets.value.findIndex((item) => item.assetId === previewAsset.value?.assetId) : -1;
  for (let index = currentIndex + direction; index >= 0 && index < filteredAssets.value.length; index += direction) {
    const asset = filteredAssets.value[index];
    if (asset && asset.kind === 'photo' && ['online', 'cached'].includes(asset.availability)) return index;
  }
  return -1;
}
const previousPreviewIndex = computed(() => findPreviewNeighbor(-1));
const nextPreviewIndex = computed(() => findPreviewNeighbor(1));
function navigatePreview(direction: -1 | 1): void {
  if (previewBusy.value) return;
  const targetIndex = direction < 0 ? previousPreviewIndex.value : nextPreviewIndex.value;
  const target = targetIndex >= 0 ? filteredAssets.value[targetIndex] : undefined;
  if (target) void openPreview(target);
}
function onPreviewKeydown(event: KeyboardEvent): void {
  if (!previewAsset.value || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
  const target = event.target;
  if (target instanceof HTMLElement && (target.isContentEditable || target.closest('input, textarea, select, [role="textbox"]'))) return;
  if (event.key === 'ArrowLeft') { event.preventDefault(); navigatePreview(-1); }
  else if (event.key === 'ArrowRight') { event.preventDefault(); navigatePreview(1); }
}
function onSearchShortcut(event: KeyboardEvent): void {
  if (event.altKey || event.shiftKey || section.value !== 'timeline' || !connected.value || !gallerySearchEnabled.value || previewAsset.value) return;
  const target = event.target;
  if (target instanceof HTMLElement && (target.isContentEditable || target.closest('input, textarea, select, [role="textbox"]'))) return;
  const focusSearch = (event.key === '/' && !event.ctrlKey && !event.metaKey) ||
    (event.key.toLowerCase() === 'k' && (event.ctrlKey || event.metaKey));
  if (!focusSearch) return;
  event.preventDefault();
  searchInput.value?.focus();
}
function previewErrorMessage(code: GalleryPreviewErrorCode): string {
  switch (code) {
    case 'source-offline': return t('gallery.sourceOffline');
    case 'preview-too-large': return t('gallery.previewTooLarge');
    case 'unsupported-media': return t('gallery.previewUnsupported');
    case 'unauthorized':
    case 'asset-unavailable': return t('gallery.previewUnavailable');
    case 'request-failed': return t('gallery.previewFailed');
  }
}

function handleVersionAuthorizationFailure(cause: unknown, lease: ReturnType<SessionRequestScope['begin']>): boolean {
  if (!(cause instanceof GalleryVersionError) || !isAuthorizationFailure(cause.status) || !lease.isCurrent()) return false;
  invalidateAuthorizationSession();
  return true;
}
async function loadVersions(): Promise<void> {
  const asset = previewAsset.value; if (!asset || !mediaVersionsEnabled.value) return;
  const generation = versionGeneration;
  const lease = sessionRequests.begin();
  versionsBusy.value = true; versionError.value = '';
  try {
    const result = await loadMediaVersions(apiBase.value, token.value, libraryId.value, asset.assetId, fetch, lease.signal);
    if (lease.isCurrent() && generation === versionGeneration && previewAsset.value === asset) versions.value = result;
  } catch (cause) {
    if (handleVersionAuthorizationFailure(cause, lease)) return;
    if (generation === versionGeneration && !isRequestAborted(cause)) versionError.value = t('gallery.versionsFailed');
  } finally {
    lease.release();
    if (generation === versionGeneration) versionsBusy.value = false;
  }
}
function handleVersionSourceChange(): void {
  if (sourceVersionId.value) {
    void previewVersion(sourceVersionId.value);
    return;
  }
  clearVersionPreview();
}

async function createVersion(): Promise<void> {
  const asset = previewAsset.value; const collection = versions.value; const original = collection?.original;
  if (!asset || !original || !mediaVersionsEnabled.value) return;
  const generation = versionGeneration;
  const selectedSource = sourceVersionId.value ? collection.items.find((item) => item.versionId === sourceVersionId.value && item.status.toLowerCase() === 'ready') : undefined;
  const sourceSha256 = selectedSource?.outputSha256 ?? original.sha256;
  if (!sourceSha256 || (sourceVersionId.value && !selectedSource)) return;
  const coordinates = normalizeCrop(crop.value, rotation.value);
  if (!coordinates) {
    versionError.value = t('gallery.invalidCrop'); return;
  }
  const requestFingerprint = JSON.stringify([libraryId.value, asset.assetId, selectedSource?.versionId ?? null, sourceSha256, coordinates, rotation.value]);
  const idempotencyKey = pendingIdempotencyKeys.get(requestFingerprint) ?? crypto.randomUUID();
  pendingIdempotencyKeys.set(requestFingerprint, idempotencyKey);
  const lease = sessionRequests.begin();
  versionsBusy.value = true; versionError.value = '';
  try {
    const accepted = await createMediaVersion(apiBase.value, token.value, libraryId.value, asset.assetId, { sourceVersionId: selectedSource?.versionId ?? null, sourceSha256, transform: { crop: coordinates, rotation: rotation.value }, idempotencyKey }, fetch, lease.signal);
    let current = await getMediaVersion(apiBase.value, token.value, libraryId.value, asset.assetId, accepted.versionId, fetch, lease.signal);
    for (let attempt = 0; !isTerminalVersionStatus(current.status) && attempt < 120; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 700));
      if (!lease.isCurrent() || generation !== versionGeneration || previewAsset.value !== asset) return;
      current = await getMediaVersion(apiBase.value, token.value, libraryId.value, asset.assetId, accepted.versionId, fetch, lease.signal);
    }
    if (!lease.isCurrent() || generation !== versionGeneration || previewAsset.value !== asset) return;
    versions.value = { ...collection, items: [current, ...collection.items.filter((item) => item.versionId !== current.versionId)] };
    if (['ready', 'failed'].includes(current.status.toLowerCase())) pendingIdempotencyKeys.delete(requestFingerprint);
    if (!isTerminalVersionStatus(current.status) || current.status.toLowerCase() !== 'ready') throw new Error('version-processing-failed');
    await previewVersion(current.versionId);
  } catch (cause) {
    if (handleVersionAuthorizationFailure(cause, lease)) return;
    if (generation === versionGeneration && !isRequestAborted(cause)) versionError.value = t('gallery.versionCreateFailed');
  } finally {
    lease.release();
    if (generation === versionGeneration) versionsBusy.value = false;
  }
}
async function previewVersion(versionId: string): Promise<void> {
  const asset = previewAsset.value; if (!asset) return;
  const generation = versionGeneration;
  clearVersionPreview();
  const requestId = ++versionPreviewRequestId;
  const lease = sessionRequests.begin();
  try {
    const blob = await loadVersionContent(apiBase.value, token.value, libraryId.value, asset.assetId, versionId, fetch, lease.signal);
    if (!lease.isCurrent() || generation !== versionGeneration || requestId !== versionPreviewRequestId || previewAsset.value !== asset) return;
    const displayPreview = await resizeImage(blob, 1600, 1200);
    if (!lease.isCurrent() || generation !== versionGeneration || requestId !== versionPreviewRequestId || previewAsset.value !== asset) return;
    activeVersionId.value = versionId; versionPreviewUrl.value = URL.createObjectURL(displayPreview);
  } catch (cause) {
    if (handleVersionAuthorizationFailure(cause, lease)) return;
    if (generation === versionGeneration && requestId === versionPreviewRequestId && previewAsset.value === asset && !isRequestAborted(cause)) {
      clearVersionPreview(); versionError.value = t('gallery.versionContentFailed');
    }
  } finally { lease.release(); }
}

async function downloadOriginal(asset: Asset): Promise<void> {
  if (!connected.value || !hasSession.value) return;
  const revision = sessionRevision;
  const lease = sessionRequests.begin();
  let objectUrl = '';
  try {
    const response = await fetch(`${apiBase.value}/v1/assets/${encodeURIComponent(asset.assetId)}/original`, {
      headers: headers(), cache: 'no-store', signal: lease.signal
    });
    if (!response.ok) {
      if (!lease.isCurrent() || revision !== sessionRevision) {
        await discardResponseBody(response);
        throw new DOMException('Session invalidated', 'AbortError');
      }
      if (isAuthorizationFailure(response.status)) invalidateAuthorizationSession();
      await discardResponseBody(response);
      throw new NodeApiError(response.status);
    }
    const blob = await response.blob();
    if (!lease.isCurrent() || revision !== sessionRevision) return;
    objectUrl = URL.createObjectURL(blob);
    const anchor = document.createElement('a'); anchor.href = objectUrl; anchor.download = asset.filename; anchor.click();
  } catch (cause) {
    if (!isRequestAborted(cause)) error.value = cause instanceof NodeApiError && cause.status === 409 ? t('gallery.sourceOffline') : errorText(cause);
  } finally {
    if (objectUrl) revokeObjectUrls([objectUrl], (url) => URL.revokeObjectURL(url));
    lease.release();
  }
}
async function clearLocalCache(): Promise<void> {
  if (!window.confirm(t('gallery.clearCacheConfirm'))) return;
  closePreview();
  try {
    await idbClear('thumbnails');
    clearThumbnailUrls(); cacheAvailable.value = true; error.value = '';
    if (connected.value && thumbnailsEnabled.value) await loadVisibleThumbnails();
  } catch { cacheAvailable.value = false; error.value = t('gallery.cacheClearFailed'); }
}
async function loadDuplicateCandidates(): Promise<void> {
  if (!libraryId.value || !hasSession.value || !connected.value || !duplicateCandidatesEnabled.value) return;
  const revision = sessionRevision;
  const requestedLibraryId = libraryId.value;
  duplicateBusy.value = true; duplicateError.value = '';
  try {
    const result = await request<{ groups: DuplicateCandidateGroup[] }>(`/v1/assets/duplicate-candidates?libraryId=${encodeURIComponent(requestedLibraryId)}`);
    if (revision === sessionRevision && hasSession.value && libraryId.value === requestedLibraryId) duplicateGroups.value = result.groups;
  } catch (cause) { if (revision === sessionRevision) duplicateError.value = errorText(cause); }
  finally { if (revision === sessionRevision) duplicateBusy.value = false; }
}
function ignoreDuplicateGroup(hash: string): void {
  ignoredDuplicateHashes.value = new Set([...ignoredDuplicateHashes.value, hash]);
}
async function loadRecycleBin(): Promise<void> {
  if (!libraryId.value || !hasSession.value || !connected.value) return;
  const revision = sessionRevision;
  const requestedLibraryId = libraryId.value;
  tombstonesBusy.value = true; tombstoneError.value = ''; tombstoneStatus.value = '';
  try {
    const result = await request<{ items: Tombstone[] }>(`/v1/recycle-bin?libraryId=${encodeURIComponent(requestedLibraryId)}`);
    if (revision === sessionRevision && hasSession.value && libraryId.value === requestedLibraryId) tombstones.value = result.items;
  } catch (cause) { if (revision === sessionRevision) tombstoneError.value = errorText(cause); }
  finally { if (revision === sessionRevision) tombstonesBusy.value = false; }
}
async function restoreTombstone(item: Tombstone): Promise<void> {
  if (!connected.value || !hasSession.value) return;
  if (!window.confirm(t('gallery.restoreConfirm'))) return;
  const revision = sessionRevision;
  restoringTombstones.value = { ...restoringTombstones.value, [item.eventId]: true };
  tombstoneError.value = '';
  try {
    await request('/v1/recycle-bin/restore', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ libraryId: item.libraryId, eventId: item.eventId })
    });
    if (revision !== sessionRevision || !hasSession.value) return;
    await loadRecycleBin();
    if (revision === sessionRevision) tombstoneStatus.value = t('gallery.restoreSucceeded');
  } catch (cause) {
    if (revision === sessionRevision) tombstoneError.value = cause instanceof NodeApiError ? errorText(cause) : t('gallery.restoreFailed');
  } finally {
    if (revision === sessionRevision) restoringTombstones.value = { ...restoringTombstones.value, [item.eventId]: false };
  }
}
async function loadPeerList(): Promise<void> {
  if (!hasSession.value || !connected.value) return;
  const revision = sessionRevision;
  peersBusy.value = true; peersError.value = '';
  try {
    const result = await request<{ peers: typeof peers.value; pending: PendingPeerApproval[] }>('/v1/pairing/peers');
    if (revision !== sessionRevision || !hasSession.value) return;
    peers.value = result.peers; pendingPeers.value = result.pending;
    for (const peer of peers.value) if (!grantLibraryByPeer.value[peer.peerId]) {
      grantLibraryByPeer.value[peer.peerId] = libraryId.value || libraries.value[0]?.libraryId || '';
    }
    if (tagSyncEnabled.value) await Promise.all(peers.value.map((peer) => refreshPeerTagStatus(peer.peerId)));
  } catch (cause) { if (revision === sessionRevision) peersError.value = errorText(cause); }
  finally { if (revision === sessionRevision) peersBusy.value = false; }
}
async function refreshPeerTagStatus(peerId: string): Promise<void> {
  if (!hasSession.value || !connected.value || !tagSyncEnabled.value) return;
  const revision = sessionRevision;
  const library = grantLibraryByPeer.value[peerId];
  try {
    const status = await request<{ pending: number; lastError: string | null }>(`/v1/pairing/peers/${encodeURIComponent(peerId)}/tag-sync-status`);
    if (revision === sessionRevision) tagSyncStatusByPeer.value = { ...tagSyncStatusByPeer.value, [peerId]: status };
  } catch { /* PM-042 endpoints are optional on older nodes. */ }
  if (!library) return;
  try {
    const result = await request<{ writers: string[] }>(`/v1/pairing/libraries/${encodeURIComponent(library)}/tag-writers`);
    if (revision === sessionRevision) tagWritersByLibrary.value = { ...tagWritersByLibrary.value, [library]: result.writers };
  } catch { /* PM-042 endpoints are optional on older nodes. */ }
}
function onPeerLibraryChange(peerId: string): void {
  tagWriteNotice.value = '';
  void refreshPeerTagStatus(peerId);
}
function peerTagWriteEnabled(peerId: string): boolean {
  const selectedLibrary = grantLibraryByPeer.value[peerId];
  return selectedLibrary ? tagWritersByLibrary.value[selectedLibrary]?.includes(peerId) ?? false : false;
}
async function togglePeerTagWrite(peerId: string): Promise<void> {
  const selectedLibrary = grantLibraryByPeer.value[peerId];
  if (!selectedLibrary) { peersError.value = t('gallery.selectLibraryToGrant'); return; }
  const method = peerTagWriteEnabled(peerId) ? 'DELETE' : 'PUT';
  const revision = sessionRevision;
  try {
    const result = await request<{ replicatedEventsRemain?: boolean }>(`/v1/pairing/peers/${encodeURIComponent(peerId)}/libraries/${encodeURIComponent(selectedLibrary)}/tag-write`, { method });
    if (revision === sessionRevision) {
      tagWriteNotice.value = method === 'DELETE' && result.replicatedEventsRemain ? t('gallery.tagWriteRevocationWarning') : '';
      await refreshPeerTagStatus(peerId);
    }
  } catch (cause) { if (revision === sessionRevision) peersError.value = errorText(cause); }
}
function tagSyncErrorLabel(errorCode: string | null): string {
  if (errorCode === 'peer_missing_asset_tags_v1') return t('gallery.tagSyncNMinusOne');
  if (errorCode === 'tag_write_denied') return t('gallery.tagSyncWriteDenied');
  if (errorCode === 'remote_conflict') return t('gallery.tagSyncConflict');
  return errorCode ?? '';
}
async function decidePeer(peer: PendingPeerApproval, approved: boolean): Promise<void> {
  const prompt = approved ? t('gallery.approvePeerConfirm') : t('gallery.rejectPeerConfirm');
  if (!window.confirm(`${prompt}\n\n${peer.peerId}`)) return;
  const revision = sessionRevision;
  try {
    await request(`/v1/pairing/peers/${encodeURIComponent(peer.peerId)}/approval`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ approved, ...(approved ? { label: peer.proposedLabel, libraryIds: [] } : {}) })
    });
    if (revision === sessionRevision) await loadPeerList();
  } catch (cause) { if (revision === sessionRevision) peersError.value = errorText(cause); }
}
async function grantPeerLibrary(peerId: string): Promise<void> {
  const selectedLibrary = grantLibraryByPeer.value[peerId];
  if (!selectedLibrary) { peersError.value = t('gallery.selectLibraryToGrant'); return; }
  const revision = sessionRevision;
  try {
    await request(`/v1/pairing/peers/${encodeURIComponent(peerId)}/libraries/${encodeURIComponent(selectedLibrary)}`, { method: 'PUT' });
    if (revision === sessionRevision) peersError.value = '';
  } catch (cause) { if (revision === sessionRevision) peersError.value = errorText(cause); }
}
async function createInvitation(): Promise<void> {
  const revision = sessionRevision;
  try {
    const response = await request<{ qrDataUrl: string; protocol: string; version: number; hostPeerId: string; addresses: string[]; inviteId: string; secret: string; expiresAt: string }>('/v1/pairing/invitations', { method: 'POST' });
    if (revision !== sessionRevision || !hasSession.value) return;
    const { qrDataUrl, ...invite } = response; invitation.value = { qrDataUrl, invite };
  }
  catch (cause) { if (revision === sessionRevision) error.value = errorText(cause); }
}
async function pairFromInvite(): Promise<void> {
  const revision = sessionRevision;
  try {
    const invite = JSON.parse(scannedInvite.value) as unknown;
    await request('/v1/pairing/join', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ invite, label: t('gallery.defaultNodeLabel') }) });
    if (revision !== sessionRevision || !hasSession.value) return;
    scannedInvite.value = ''; await loadPeerList();
  } catch (cause) { if (revision === sessionRevision) error.value = errorText(cause); }
}
async function revokePeer(peerId: string): Promise<void> {
  if (!window.confirm(t('gallery.revokeConfirm'))) return;
  const revision = sessionRevision;
  try {
    await request(`/v1/pairing/peers/${encodeURIComponent(peerId)}`, { method: 'DELETE' });
    if (revision === sessionRevision) await loadPeerList();
  } catch (cause) { if (revision === sessionRevision) error.value = errorText(cause); }
}
async function loadLocalMetadata(): Promise<void> {
  const generation = ++metadataGeneration;
  localMetadataUnavailable.value = false;
  if (!hasSession.value || !libraryId.value) { legacyTags.value = {}; tags.value = {}; albums.value = []; return; }
  const key = localMetadataKey();
  try {
    const [storedTags, storedAlbums] = await Promise.all([
      idbGet<Record<string, string[]>>('tags', key), idbGet<Album[]>('albums', key)
    ]);
    if (generation !== metadataGeneration || key !== localMetadataKey()) return;
    legacyTags.value = storedTags ?? {};
    importedLegacyTagAssets.value = {};
    albums.value = storedAlbums ?? [];
    refreshTagView(assets.value.map((asset) => asset.assetId));
  } catch {
    if (generation === metadataGeneration) {
      localMetadataUnavailable.value = true;
      legacyTags.value = {}; importedLegacyTagAssets.value = {}; albums.value = [];
    }
  }
}
async function saveTagAndAlbum(): Promise<void> {
  const tag = normalizeAssetTag(tagInput.value); const asset = selectedAsset.value;
  if (!tag || !asset || !libraryId.value || !hasSession.value || !connected.value) {
    tagDialogError.value = !tag ? t('gallery.invalidTag') : t('gallery.tagNodeOffline');
    return;
  }
  if (!assetTagsEnabled.value || asset.libraryId !== libraryId.value) {
    tagDialogError.value = t('gallery.tagApiUnavailable');
    return;
  }
  const key = localMetadataKey();
  const revision = sessionRevision;
  const nextAlbums = albums.value.some((album) => album.tag === tag)
    ? albums.value
    : [...albums.value, { id: crypto.randomUUID(), name: tag, tag }];
  tagDialogError.value = '';
  tagWriteBusy.value = true;
  try {
    await request<void>(assetTagPath(asset.libraryId, asset.assetId, tag), { method: 'PUT' });
    if (revision !== sessionRevision || !hasSession.value || key !== localMetadataKey()) return;
    serverTags.value = { ...serverTags.value, [asset.assetId]: mergeAssetTags(serverTags.value[asset.assetId] ?? asset.tags ?? [], [tag]) };
    refreshTagView([asset.assetId]);
    if (nextAlbums !== albums.value) {
      try {
        await idbPut('albums', { key, value: nextAlbums });
        if (revision !== sessionRevision || !hasSession.value || key !== localMetadataKey()) return;
        albums.value = nextAlbums;
      } catch {
        tagDialogError.value = t('gallery.tagSavedAlbumNotSaved');
        return;
      }
    }
    tagInput.value = ''; selectedAsset.value = null;
  } catch (cause) {
    if (revision === sessionRevision && hasSession.value) tagDialogError.value = tagMutationErrorText(cause);
  } finally {
    if (revision === sessionRevision) tagWriteBusy.value = false;
  }
}
function onAssetSelectionChange(assetId: string, event: Event): void {
  const input = event.target;
  if (!(input instanceof HTMLInputElement) || bulkBusy.value || bulkDialogOpen.value || bulkFailedCount.value > 0) return;
  const update = updateAssetSelection(selectedAssetIds.value, assetId, input.checked);
  selectedAssetIds.value = update.selected;
  selectionError.value = update.limitReached ? t('gallery.bulkSelectionLimitReached', { limit: maxBulkSelection }) : '';
}
function clearAssetSelection(): void {
  if (bulkBusy.value || bulkDialogOpen.value || bulkFailedCount.value > 0) return;
  selectedAssetIds.value = new Set();
  selectionError.value = '';
}
function openBulkTagAction(add: boolean): void {
  if (!hasSession.value || !connected.value || !assetTagsEnabled.value || bulkBusy.value || bulkOperation.value) return;
  bulkActionDraft.value = { kind: 'tag', add };
  bulkTagInput.value = add ? '' : selectedTagOptions.value[0] ?? '';
  bulkError.value = '';
  bulkDialogOpen.value = true;
}
function openBulkFavoriteAction(favorite: boolean): void {
  if (!hasSession.value || !connected.value || !assetFavoritesEnabled.value || bulkBusy.value || bulkOperation.value) return;
  bulkActionDraft.value = { kind: 'favorite', favorite };
  bulkError.value = '';
  bulkDialogOpen.value = true;
}
function closeBulkDialog(): void {
  if (bulkBusy.value) return;
  bulkDialogOpen.value = false;
  bulkError.value = '';
  if (bulkFailedCount.value === 0) {
    bulkOperation.value = null;
    bulkActionDraft.value = null;
    bulkTagInput.value = '';
  }
}
function reviewBulkOperation(): void {
  if (!bulkOperation.value) return;
  bulkActionDraft.value = null;
  bulkDialogOpen.value = true;
  bulkTagInput.value = bulkOperation.value.action.kind === 'tag' ? bulkOperation.value.action.tag : '';
}
async function confirmBulkOperation(): Promise<void> {
  const draft = bulkActionDraft.value;
  if (!draft || bulkOperation.value || bulkBusy.value) return;
  const selected = selectedAssets.value;
  if (!hasSession.value || !connected.value || !libraryId.value || selected.length !== selectedAssetIds.value.size || !selected.length || selected.length > maxBulkSelection) {
    bulkError.value = t('gallery.bulkScopeUnavailable');
    return;
  }
  let action: BulkAction;
  if (draft.kind === 'favorite') {
    if (!assetFavoritesEnabled.value) { bulkError.value = t('gallery.bulkCapabilityUnavailable'); return; }
    action = { kind: 'favorite', favorite: draft.favorite };
  } else {
    if (!assetTagsEnabled.value) { bulkError.value = t('gallery.bulkCapabilityUnavailable'); return; }
    const tag = normalizeAssetTag(bulkTagInput.value);
    if (!tag) { bulkError.value = t('gallery.bulkTagInvalid'); return; }
    if (!draft.add && !selectedTagOptions.value.includes(tag)) { bulkError.value = t('gallery.bulkTagUnavailable'); return; }
    if (!draft.add && selected.some((asset) => !importedLegacyTagAssets.value[asset.assetId] && (legacyTags.value[asset.assetId] ?? []).includes(tag))) {
      bulkError.value = t('gallery.bulkTagImportPending');
      return;
    }
    action = { kind: 'tag', add: draft.add, tag };
  }
  try {
    const entries = selected.map((asset) => ({
      assetId: asset.assetId,
      filename: asset.filename,
      status: 'queued' as const,
      ...(action.kind === 'favorite' ? { operationId: crypto.randomUUID() } : {}),
    }));
    bulkOperation.value = { libraryId: libraryId.value, action, entries };
    bulkActionDraft.value = null;
    bulkError.value = '';
    await runBulkOperation(false);
  } catch {
    bulkError.value = t('gallery.bulkOperationUnavailable');
  }
}
async function runBulkOperation(retryOnly: boolean): Promise<void> {
  const operation = bulkOperation.value;
  if (!operation || bulkBusy.value || !hasSession.value || !connected.value || libraryId.value !== operation.libraryId) {
    if (operation) bulkError.value = t('gallery.bulkScopeUnavailable');
    return;
  }
  const revision = sessionRevision;
  const entries = operation.entries.filter((entry) => !retryOnly || entry.status === 'failed');
  bulkBusy.value = true;
  bulkError.value = '';
  try {
    for (const entry of entries) {
      if (revision !== sessionRevision || !hasSession.value) break;
      if (!connected.value || libraryId.value !== operation.libraryId) {
        const failure = connected.value ? t('gallery.bulkScopeUnavailable') : t('gallery.connectionFailed');
        for (const pending of operation.entries) {
          if (pending.status === 'pending' || pending.status === 'queued') { pending.status = 'failed'; pending.error = failure; }
        }
        break;
      }
      entry.status = 'pending';
      delete entry.error;
      const action = operation.action;
      try {
        if (action.kind === 'favorite') {
          const favorite = action.favorite;
          const operationId = entry.operationId;
          if (!operationId) throw new Error(t('gallery.bulkOperationUnavailable'));
          const result = await request<{ favorite: boolean }>(
            `/v1/libraries/${encodeURIComponent(operation.libraryId)}/assets/${encodeURIComponent(entry.assetId)}/favorite`,
            {
              method: 'PUT',
              headers: { 'content-type': 'application/json', 'idempotency-key': operationId },
              body: JSON.stringify({ favorite }),
            },
          );
          if (revision !== sessionRevision || !hasSession.value) return;
          assets.value = assets.value.map((asset) => asset.assetId === entry.assetId ? { ...asset, favorite: result.favorite } : asset);
        } else {
          const { tag, add } = action;
          await request<void>(assetTagPath(operation.libraryId, entry.assetId, tag), { method: add ? 'PUT' : 'DELETE' });
          if (revision !== sessionRevision || !hasSession.value) return;
          const current = serverTags.value[entry.assetId] ?? assets.value.find((asset) => asset.assetId === entry.assetId)?.tags ?? [];
          const next = add ? mergeAssetTags(current, [tag]) : current.filter((value) => value !== tag);
          serverTags.value = { ...serverTags.value, [entry.assetId]: next };
          refreshTagView([entry.assetId]);
        }
        entry.status = 'success';
      } catch (cause) {
        if (revision !== sessionRevision || !hasSession.value) return;
        entry.status = 'failed';
        entry.error = action.kind === 'tag' ? tagMutationErrorText(cause) : errorText(cause);
      }
    }
  } finally {
    if (revision === sessionRevision) bulkBusy.value = false;
  }
  if (revision === sessionRevision && hasSession.value && bulkFailedCount.value === 0) {
    selectedAssetIds.value = new Set();
    selectionError.value = '';
  }
}
function retryFailedBulkItems(): void {
  if (!bulkOperation.value || bulkFailedCount.value === 0 || bulkBusy.value) return;
  bulkDialogOpen.value = true;
  void runBulkOperation(true);
}
function bulkEntryStatus(entry: BulkOperationEntry): string {
  if (entry.status === 'success') return t('gallery.bulkItemUpdated');
  if (entry.status === 'failed') return t('gallery.bulkItemFailed');
  return t('gallery.bulkItemPending');
}
function tagMutationErrorText(cause: unknown): string {
  if (cause instanceof NodeApiError) {
    if (cause.status === 400) return t('gallery.tagRejected');
    if (cause.status === 404) return t('gallery.tagAssetUnavailable');
    if (cause.status === 503) return t('gallery.tagServiceUnavailable');
  }
  return errorText(cause);
}
function errorText(cause: unknown): string {
  if (isRequestAborted(cause)) return '';
  if (cause instanceof NodeApiError) {
    if (cause.status === 401 || cause.status === 403) return t('gallery.authorizationRequired');
    if (cause.status === 409) return t('gallery.requestConflict');
    return t('gallery.requestFailedWithStatus', { status: cause.status });
  }
  if (cause instanceof TypeError) return t('gallery.connectionFailed');
  if (cause instanceof Error) return cause.message;
  return t('gallery.unknownError');
}
function parsedDate(value: string | null): Date | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}
function formatDate(value: string | null): string {
  const date = parsedDate(value);
  return date ? fullDateFormatter.value.format(date) : t('gallery.unknownDate');
}
function formatCaptureDate(asset: Asset): string {
  return displayCaptureDate(asset, locale.value, systemTimeZone, t('gallery.unknownDate'), t('gallery.captureTimezoneUnknown'));
}
function formatCaptureDateGroup(asset: Asset): string {
  return displayCaptureDateGroup(asset, locale.value, systemTimeZone, t('gallery.unknownDate'), t('gallery.captureTimezoneUnknown'));
}
function formatCaptureTime(asset: Asset): string {
  return displayCaptureTime(asset, locale.value, systemTimeZone, t('gallery.unknownDate'), t('gallery.captureTimezoneUnknown'));
}
function captureConfidenceText(asset: Asset): string {
  if (!asset.capturedAt && !asset.captureLocalTime) return '';
  if (asset.captureConfidence === 'high') {
    if (typeof asset.captureOffsetMinutes !== 'number') return t('gallery.captureConfidence.unknown');
    const absoluteMinutes = Math.abs(asset.captureOffsetMinutes);
    const offset = `UTC${asset.captureOffsetMinutes < 0 ? '-' : '+'}${String(Math.floor(absoluteMinutes / 60)).padStart(2, '0')}:${String(absoluteMinutes % 60).padStart(2, '0')}`;
    return t('gallery.captureConfidence.high', { offset });
  }
  return t(`gallery.captureConfidence.${asset.captureConfidence ?? 'unknown'}`);
}
function isDateGroupStart(asset: Asset, visibleIndex: number): boolean {
  const absoluteIndex = visibleStart.value + visibleIndex;
  if (absoluteIndex === 0) return true;
  const previous = filteredAssets.value[absoluteIndex - 1];
  return getCaptureDateGroupKey(previous, systemTimeZone) !== getCaptureDateGroupKey(asset, systemTimeZone);
}
function versionStatusText(status: string): string {
  switch (status.toLowerCase()) {
    case 'staging': return t('gallery.versionStatus.staging');
    case 'ready': return t('gallery.versionStatus.ready');
    case 'failed': return t('gallery.versionStatus.failed');
    default: return t('gallery.unknownStatus');
  }
}
function formatSize(bytes: number): string { return new Intl.NumberFormat(locale.value, { style: 'unit', unit: 'byte', unitDisplay: 'narrow', notation: bytes > 1_000_000 ? 'compact' : 'standard', maximumFractionDigits: 1 }).format(bytes); }
function changeSection(value: typeof section.value): void {
  if (value !== 'timeline') { selectedAssetIds.value = new Set(); selectionError.value = ''; }
  section.value = value;
  if (value === 'recycle') void loadRecycleBin();
   if (value === 'duplicates') void loadDuplicateCandidates();
}
onMounted(() => {
  void loadLocalMetadata(); document.documentElement.dataset.theme = theme.value;
  document.addEventListener('keydown', onPreviewKeydown);
  document.addEventListener('keydown', onSearchShortcut);
});
onBeforeUnmount(() => {
  document.removeEventListener('keydown', onPreviewKeydown);
  document.removeEventListener('keydown', onSearchShortcut);
  requestedLibraryAfterReconnect = undefined;
  clearAuthorizedSession(true);
  imageObserver?.disconnect();
});

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('photomesh-gallery-cache', 2);
    let settled = false;
    request.onupgradeneeded = () => {
      for (const store of ['thumbnails', 'tags', 'albums', 'tag-imports']) {
        if (!request.result.objectStoreNames.contains(store)) request.result.createObjectStore(store, { keyPath: 'key' });
      }
    };
    request.onblocked = () => {
      if (!settled) { settled = true; reject(new Error('IndexedDB upgrade is blocked by another PhotoMesh tab')); }
    };
    request.onsuccess = () => {
      if (settled) { request.result.close(); return; }
      settled = true;
      request.result.onversionchange = () => request.result.close();
      resolve(request.result);
    };
    request.onerror = () => {
      if (!settled) { settled = true; reject(request.error); }
    };
  });
}
async function idbGet<T>(store: string, key: string): Promise<T | undefined> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const req = db.transaction(store).objectStore(store).get(key);
    req.onsuccess = () => { const value = req.result?.value as T | undefined; db.close(); resolve(value); };
    req.onerror = () => { db.close(); reject(req.error); };
  });
}
async function idbPut(store: string, record: { key: string; value: unknown }): Promise<void> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readwrite');
    tx.objectStore(store).put(record);
    tx.oncomplete = () => { db.close(); resolve(); };
    tx.onerror = () => { db.close(); reject(tx.error); };
    tx.onabort = () => { db.close(); reject(tx.error); };
  });
}
async function idbMergeImportedTagMarker(key: string, tagsToMerge: readonly string[]): Promise<void> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('tag-imports', 'readwrite');
    const store = tx.objectStore('tag-imports');
    let importedTags: string[] = [];
    let rejected = false;
    const rejectOnce = (cause: DOMException | null): void => {
      if (!rejected) { rejected = true; reject(cause ?? new Error('Could not update legacy tag import marker')); }
    };
    const get = store.get(key);
    get.onsuccess = () => {
      const current = get.result?.value as { importedTags?: unknown } | undefined;
      const existing = Array.isArray(current?.importedTags) ? current.importedTags.filter((tag): tag is string => typeof tag === 'string') : [];
      importedTags = mergeAssetTags(existing, tagsToMerge);
      store.put({ key, value: { importedTags } });
    };
    get.onerror = () => { db.close(); rejectOnce(get.error); };
    tx.oncomplete = () => { db.close(); if (!rejected) resolve(); };
    tx.onerror = () => { db.close(); rejectOnce(tx.error); };
    tx.onabort = () => { db.close(); rejectOnce(tx.error); };
  });
}
async function idbClear(store: string): Promise<void> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readwrite');
    tx.objectStore(store).clear();
    tx.oncomplete = () => { db.close(); resolve(); };
    tx.onerror = () => { db.close(); reject(tx.error); };
    tx.onabort = () => { db.close(); reject(tx.error); };
  });
}
</script>

<template>
  <div class="gallery-shell">
    <header class="topbar">
      <a
        class="brand"
        href="#timeline"
        @click.prevent="changeSection('timeline')"
      ><span class="brand-mark">P</span> PhotoMesh</a>
      <div
        class="searchbox"
        role="search"
      >
        <label
          class="sr-only"
          for="gallery-search-input"
        >{{ t('gallery.search') }}</label><span aria-hidden="true">⌕</span><input
          id="gallery-search-input"
          ref="searchInput"
          v-model="search"
          type="search"
          maxlength="256"
          autocomplete="off"
          :placeholder="t('gallery.searchPlaceholder')"
          :aria-label="t('gallery.search')"
          aria-keyshortcuts="/ Control+K Meta+K"
          :aria-describedby="searchFeedback ? 'search-feedback' : undefined"
          :disabled="!connected || !hasSession || !gallerySearchEnabled || bulkBusy || bulkDialogOpen"
          @keydown.enter.prevent="submitSearch"
          @keydown.esc.prevent.stop="clearSearch"
        ><button
          v-if="search"
          type="button"
          class="search-clear-button"
          :aria-label="t('gallery.clearSearch')"
          :disabled="bulkBusy || bulkDialogOpen"
          @click.stop="clearSearch"
        >
          ×
        </button>
      </div>
      <div class="top-actions">
        <span
          class="connection-pill"
          :class="connected ? 'online' : 'offline'"
        ><i />{{ connected ? t('gallery.online') : t('gallery.offline') }}</span>
        <label
          class="sr-only"
          for="locale-choice"
        >{{ t('gallery.language') }}</label>
        <select
          id="locale-choice"
          v-model="locale"
          class="compact-select"
        >
          <option value="zh-CN">中文</option><option value="en">English</option>
        </select>
        <label
          class="sr-only"
          for="theme-choice"
        >{{ t('gallery.theme') }}</label>
        <select
          id="theme-choice"
          v-model="theme"
          class="compact-select"
        >
          <option value="light">{{ t('gallery.light') }}</option><option value="dark">{{ t('gallery.dark') }}</option>
        </select>
      </div>
    </header>
    <div class="workspace">
      <aside
        class="sidebar"
        :aria-label="t('gallery.navigation')"
      >
        <button
          class="nav-item"
          :class="{ active: section === 'timeline' }"
          @click="changeSection('timeline')"
        >
          <span>▦</span>{{ t('gallery.timeline') }}
        </button>
        <div class="side-label">{{ t('gallery.virtualAlbums') }}</div>
        <button
          v-for="album in albums"
          :key="album.id"
          class="nav-item album-nav"
          :class="{ active: activeAlbum === album.id }"
          @click="activeAlbum = activeAlbum === album.id ? '' : album.id; changeSection('timeline')"
        >
          <span>◷</span>{{ album.name }}
        </button>
        <button
          v-if="duplicateCandidatesEnabled"
          class="nav-item"
          :class="{ active: section === 'duplicates' }"
          @click="changeSection('duplicates')"
        >
          <span>⧉</span>{{ t('gallery.duplicateCandidates') }}
        </button>
        <button
          class="nav-item"
          :class="{ active: section === 'recycle' }"
          @click="changeSection('recycle')"
        >
          <span>↺</span>{{ t('gallery.recycleBin') }}
        </button>
        <div class="sidebar-spacer" />
        <button
          class="nav-item"
          :class="{ active: section === 'settings' }"
          @click="changeSection('settings')"
        >
          <span>⚙</span>{{ t('gallery.nodeSettings') }}
        </button>
        <div class="sidebar-node">
          <span
            class="node-dot"
            :class="connected ? 'online' : 'offline'"
          /><div><strong>{{ t('gallery.currentNode') }}</strong><small>{{ endpoint }}</small></div>
        </div>
      </aside>

      <main class="content">
        <div
          v-for="summary in bulkInterrupted"
          :key="summary.id"
          class="notice error-notice bulk-interrupted-notice"
          role="alert"
        >
          <span>{{ bulkInterruptionText(summary) }}</span><button
            type="button"
            class="secondary-button"
            :aria-label="t('gallery.dismissBulkInterrupted')"
            @click="dismissBulkInterruption(summary.id)"
          >
            ×
          </button>
        </div>
        <div
          v-if="!hasSession"
          class="connect-card"
        >
          <div class="welcome-icon">◈</div><p class="eyebrow">{{ t('gallery.localFirst') }}</p><h1>{{ t('gallery.connectTitle') }}</h1><p class="muted">{{ isDesktopRuntime ? t('gallery.desktopConnectDescription') : t('gallery.connectDescription') }}</p>
          <div
            v-if="error"
            class="notice error-notice"
            role="alert"
          >
            {{ error }}
          </div>
          <form
            class="connect-form"
            @submit.prevent="connect()"
          >
            <label>{{ t('gallery.nodeAddress') }}<input
              v-model="endpointInput"
              type="url"
              required
              autocomplete="url"
              placeholder="http://127.0.0.1:8443"
            ></label>
            <label>{{ t('gallery.adminToken') }}<input
              v-model="tokenInput"
              type="password"
              required
              autocomplete="off"
              :placeholder="t('gallery.tokenPlaceholder')"
            ></label>
            <label
              v-if="desktopRemoteEndpoint"
              class="remote-node-trust"
            >
              <input
                v-model="remoteEndpointAcknowledged"
                type="checkbox"
              ><span>{{ t('gallery.remoteNodeTrustAcknowledgement', { endpoint: desktopRemoteEndpoint }) }}</span>
            </label>
            <p
              v-if="desktopRemoteEndpoint"
              class="remote-node-warning"
            >
              {{ t('gallery.remoteNodeTrustWarning') }}
            </p>
            <button
              class="primary-button"
              :disabled="busy"
            >
              {{ busy ? t('gallery.connecting') : t('gallery.connect') }}<span aria-hidden="true">→</span>
            </button>
          </form>
          <p class="privacy-note">⌑ {{ t('gallery.credentialNote') }}</p>
        </div>
        <template v-else-if="section === 'timeline'">
          <div class="page-heading">
            <div><p class="eyebrow">{{ t('gallery.libraryLabel') }}</p><h1>{{ libraries.find((item) => item.libraryId === libraryId)?.title ?? t('gallery.timeline') }}</h1><p class="muted">{{ t('gallery.timelineDescription') }}</p></div>
            <div class="heading-controls">
              <label
                class="sr-only"
                for="library-choice"
              >{{ t('gallery.chooseLibrary') }}</label><select
                id="library-choice"
                v-model="libraryId"
                class="field-select"
                :disabled="bulkBusy || bulkDialogOpen"
              >
                <option
                  v-for="library in libraries"
                  :key="library.libraryId"
                  :value="library.libraryId"
                >
                  {{ library.title }}
                </option>
              </select><span class="count-chip">{{ filteredAssets.length.toLocaleString(locale) }} {{ t('gallery.items') }}</span><button
                type="button"
                class="secondary-button"
                :disabled="busy"
                @click="checkHealth"
              >
                {{ t('gallery.refreshNodeStatus') }}
              </button>
            </div>
          </div>
          <div
            v-if="searchFeedback"
            id="search-feedback"
            class="notice search-feedback"
            role="status"
            aria-live="polite"
          >
            {{ searchFeedback }}
          </div>
          <div
            v-if="!connected"
            class="notice offline-notice"
            role="status"
          >
            <span>{{ t('gallery.offlineSessionNotice') }}</span>
            <button
              type="button"
              class="secondary-button"
              :disabled="busy"
              @click="connect(true)"
            >
              {{ t('gallery.retryConnection') }}
            </button>
          </div>
          <div
            v-if="error"
            class="notice error-notice"
            role="alert"
          >
            <span>{{ error }}</span><button
              v-if="searchStatus === 'error' && searchTerm"
              type="button"
              class="secondary-button"
              @click="submitSearch"
            >
              {{ t('gallery.retrySearch') }}
            </button>
          </div>
          <div
            v-if="localMetadataUnavailable"
            class="notice error-notice"
            role="alert"
          >
            {{ t('gallery.localMetadataUnavailable') }}
          </div>
          <div
            v-if="hasLegacyTagData"
            class="notice"
            :class="legacyTagImportState === 'failed' ? 'error-notice' : 'offline-notice'"
            :role="legacyTagImportState === 'failed' ? 'alert' : 'status'"
          >
            <span v-if="legacyTagImportState === 'importing'">{{ t('gallery.legacyTagImporting') }}</span>
            <span v-else-if="legacyTagImportState === 'complete'">{{ t('gallery.legacyTagImportComplete') }}</span>
            <span v-else-if="legacyTagImportState === 'failed' && !assetTagsEnabled">{{ t('gallery.legacyTagImportUnsupported') }}</span>
            <span v-else-if="legacyTagImportState === 'failed'">{{ t('gallery.legacyTagImportFailed', { count: legacyTagImportFailures }) }}</span>
            <span v-else>{{ t('gallery.legacyTagImportPending') }}</span>
            <button
              v-if="legacyTagImportState === 'failed' && assetTagsEnabled && connected"
              type="button"
              class="secondary-button"
              @click="retryLegacyTagImport"
            >
              {{ t('gallery.retryLegacyTagImport') }}
            </button>
          </div>
          <div
            v-if="activeAlbum"
            class="filter-chip"
          >
            {{ albums.find((album) => album.id === activeAlbum)?.name }} <button
              :aria-label="t('gallery.clearFilter')"
              @click="activeAlbum = ''"
            >
              ×
            </button>
          </div>
          <div
            v-if="bulkOperation && bulkFailedCount > 0 && !bulkDialogOpen"
            class="notice error-notice bulk-retry-notice"
            role="alert"
          >
            <span>{{ bulkStatusText }}</span><button
              type="button"
              class="secondary-button"
              @click="reviewBulkOperation"
            >
              {{ t('gallery.bulkReviewResults') }}
            </button><button
              type="button"
              class="secondary-button"
              :disabled="bulkBusy || !connected"
              @click="retryFailedBulkItems"
            >
              {{ t('gallery.bulkRetryFailed') }}
            </button>
          </div>
          <div
            v-if="selectedAssetIds.size && bulkActionsAvailable"
            class="bulk-toolbar"
            role="group"
            :aria-label="t('gallery.bulkActions')"
          >
            <div class="bulk-selection-summary">
              <span
                role="status"
                aria-live="polite"
              >{{ t('gallery.bulkSelectedCount', { count: selectedAssetIds.size, library: selectedLibraryTitle }) }}</span>
              <small>{{ t('gallery.bulkSelectionLimit', { limit: maxBulkSelection }) }}</small>
            </div>
            <button
              v-if="assetTagsEnabled"
              type="button"
              class="secondary-button"
              :disabled="!connected || !hasSession || bulkBusy || !!bulkOperation"
              @click="openBulkTagAction(true)"
            >
              {{ t('gallery.bulkAddTag') }}
            </button>
            <button
              v-if="assetTagsEnabled"
              type="button"
              class="secondary-button"
              :disabled="!connected || !hasSession || bulkBusy || !!bulkOperation || !selectedTagOptions.length"
              @click="openBulkTagAction(false)"
            >
              {{ t('gallery.bulkRemoveTag') }}
            </button>
            <button
              v-if="assetFavoritesEnabled"
              type="button"
              class="secondary-button"
              :disabled="!connected || !hasSession || bulkBusy || !!bulkOperation"
              @click="openBulkFavoriteAction(true)"
            >
              {{ t('gallery.bulkFavoriteOn') }}
            </button>
            <button
              v-if="assetFavoritesEnabled"
              type="button"
              class="secondary-button"
              :disabled="!connected || !hasSession || bulkBusy || !!bulkOperation"
              @click="openBulkFavoriteAction(false)"
            >
              {{ t('gallery.bulkFavoriteOff') }}
            </button>
            <button
              type="button"
              class="secondary-button"
              :disabled="bulkBusy || bulkDialogOpen || !!bulkOperation"
              @click="clearAssetSelection"
            >
              {{ t('gallery.bulkClearSelection') }}
            </button>
          </div>
          <p
            v-if="selectionError"
            class="notice error-notice"
            role="alert"
          >
            {{ selectionError }}
          </p>
          <div
            ref="scrollElement"
            class="timeline-scroll"
            role="region"
            :aria-label="t('gallery.timeline')"
            tabindex="0"
            @scroll="onScroll"
          >
            <div
              v-if="!filteredAssets.length && !busy && !['debouncing', 'loading', 'invalid', 'unsupported', 'error'].includes(searchStatus)"
              class="empty-state"
              role="status"
              aria-live="polite"
            >
              <span>◇</span><h2>{{ activeAlbum ? t('gallery.noTaggedItemsLoaded') : searchTerm ? t('gallery.noSearchResults') : t('gallery.emptyLibrary') }}</h2><p>{{ activeAlbum && cursor ? t('gallery.localAlbumPageHint') : searchTerm ? t('gallery.noSearchResultsHint') : t('gallery.emptyHint') }}</p>
            </div>
            <div
              :style="{ height: `${topSpacer}px` }"
              aria-hidden="true"
            />
            <article
              v-for="(asset, visibleIndex) in visibleAssets"
              :key="asset.assetId"
              class="asset-row"
              :data-asset-id="asset.assetId"
              tabindex="0"
            >
              <div class="asset-preview">
                <button
                  type="button"
                  class="asset-preview-trigger"
                  :aria-label="t('gallery.previewAsset', { filename: asset.filename })"
                  :disabled="asset.kind !== 'photo' || (!['online', 'cached'].includes(asset.availability) && !thumbnailUrls[asset.assetId]) || (!connected && !thumbnailUrls[asset.assetId])"
                  @click="openPreview(asset)"
                >
                  <img
                    v-if="thumbnailUrls[asset.assetId]"
                    :src="thumbnailUrls[asset.assetId]"
                    alt=""
                  ><span
                    v-else
                    class="preview-placeholder"
                    aria-hidden="true"
                  >{{ asset.kind === 'video' ? '▶' : '◇' }}</span><span class="preview-trigger-label">{{ t('gallery.preview') }}</span>
                </button><span
                  v-if="asset.kind === 'video'"
                  class="media-badge"
                  aria-hidden="true"
                >▶</span>
              </div>
              <div class="asset-info">
                <div class="asset-titleline">
                  <h2 :title="asset.filename">{{ asset.filename }}</h2><span
                    class="availability"
                    :class="asset.availability"
                  >{{ t(`gallery.availability.${asset.availability}`) }}</span><span
                    v-if="assetFavoritesEnabled && asset.favorite"
                    class="favorite-badge"
                  ><span aria-hidden="true">★</span><span>{{ t('gallery.sharedFavorite') }}</span></span>
                </div>
                <p class="asset-date">
                  <time
                    :class="{ 'timeline-day-heading': isDateGroupStart(asset, visibleIndex) }"
                    :datetime="getCaptureDateTimeValue(asset)"
                    :aria-label="formatCaptureDate(asset)"
                    :title="captureConfidenceText(asset)"
                  >{{ isDateGroupStart(asset, visibleIndex) ? formatCaptureDateGroup(asset) : formatCaptureTime(asset) }}</time>
                  <span
                    v-if="captureConfidenceText(asset)"
                    class="capture-confidence"
                  >{{ captureConfidenceText(asset) }}</span>
                  <span>·</span> {{ formatSize(asset.byteSize) }}
                </p>
                <p class="source-line"><span>⌂ {{ asset.originNodeId }}</span><span v-if="asset.sourcePath">· {{ asset.sourcePath }}</span></p><div class="tag-list">
                  <span
                    v-for="tag in tags[asset.assetId] ?? []"
                    :key="tag"
                    class="tag"
                  >{{ tag }}</span><span
                    v-if="!tags[asset.assetId]?.length"
                    class="no-tags"
                  >{{ t('gallery.noTags') }}</span>
                </div>
              </div>
              <div class="asset-actions">
                <label
                  v-if="bulkActionsAvailable"
                  class="asset-selection"
                >
                  <input
                    type="checkbox"
                    :aria-label="t('gallery.bulkSelectAsset', { filename: asset.filename })"
                    :checked="selectedAssetIds.has(asset.assetId)"
                    :disabled="!hasSession || !connected || bulkBusy || bulkDialogOpen || bulkFailedCount > 0"
                    @change="onAssetSelectionChange(asset.assetId, $event)"
                  >
                </label>
                <button
                  class="icon-button"
                  :aria-label="t('gallery.addTag')"
                  :title="t('gallery.addTag')"
                  :disabled="!hasSession || !connected || !assetTagsEnabled"
                  @click="selectedAsset = asset; tagInput = ''; tagDialogError = ''"
                >
                  ＋
                </button><button
                  class="download-button"
                  :disabled="!connected || !['online', 'cached'].includes(asset.availability)"
                  @click="downloadOriginal(asset)"
                >
                  {{ t('gallery.downloadOriginal') }} <span aria-hidden="true">↓</span>
                </button>
              </div>
            </article>
            <div
              :style="{ height: `${bottomSpacer}px` }"
              aria-hidden="true"
            />
            <div
              v-if="busy"
              class="loading-row"
              role="status"
            >
              {{ t('gallery.loading') }}
            </div>
            <div
              v-else-if="cursor === '' && assets.length"
              class="end-row"
            >
              {{ t('gallery.endOfTimeline') }}
            </div>
            <div
              v-if="activeAlbum && cursor && cursor !== '' && !busy"
              class="end-row"
            >
              <p>{{ t('gallery.localAlbumPageHint') }}</p>
              <button
                type="button"
                class="secondary-button"
                @click="loadPage()"
              >
                {{ t('gallery.loadMoreForAlbum') }}
              </button>
            </div>
          </div>
        </template>
        <section
          v-else-if="section === 'duplicates'"
          class="page-section"
        >
          <div class="page-heading">
            <div><p class="eyebrow">{{ t('gallery.libraryLabel') }}</p><h1>{{ t('gallery.duplicateCandidates') }}</h1><p class="muted">{{ t('gallery.duplicateCandidatesDescription') }}</p></div><button
              type="button"
              class="secondary-button"
              :disabled="duplicateBusy"
              @click="loadDuplicateCandidates"
            >
              {{ t('gallery.refreshNodeStatus') }}
            </button>
          </div>
          <div
            v-if="duplicateError"
            class="notice error-notice"
            role="alert"
          >
            {{ duplicateError }}
          </div>
          <div
            v-if="duplicateBusy"
            class="notice"
            role="status"
          >
            {{ t('gallery.loading') }}
          </div>
          <div
            v-else-if="!duplicateGroups.filter((group) => !ignoredDuplicateHashes.has(group.sha256)).length"
            class="empty-state"
          >
            <h2>{{ t('gallery.noDuplicateCandidates') }}</h2><p>{{ t('gallery.noDuplicateCandidatesDescription') }}</p>
          </div>
          <article
            v-for="group in duplicateGroups.filter((item) => !ignoredDuplicateHashes.has(item.sha256))"
            :key="group.sha256"
            class="duplicate-card"
          >
            <div class="duplicate-card-heading">
              <div><h2>{{ t('gallery.candidateGroup') }} · {{ formatSize(group.byteSize) }}</h2><code>{{ group.sha256 }}</code></div><button
                type="button"
                class="secondary-button"
                @click="ignoreDuplicateGroup(group.sha256)"
              >
                {{ t('gallery.ignoreCandidate') }}
              </button>
            </div>
            <p class="muted">{{ t('gallery.candidateWarning') }}<span v-if="group.truncated"> {{ t('gallery.candidateTruncated') }}</span></p>
            <div class="duplicate-assets">
              <div
                v-for="asset in group.assets"
                :key="asset.assetId"
                class="duplicate-asset"
              >
                <strong>{{ asset.filename }}</strong><span>{{ asset.sourcePath ?? t('gallery.pathUnavailable') }}</span><span>{{ asset.originNodeId }} · {{ asset.availability }} · {{ formatSize(asset.byteSize) }}</span>
              </div>
            </div>
          </article>
        </section>
        <section
          v-else-if="section === 'recycle'"
          class="page-section"
        >
          <p class="eyebrow">{{ t('gallery.recycleLabel') }}</p><h1>{{ t('gallery.recycleBin') }}</h1><p class="muted">{{ t('gallery.recycleDescription') }}</p>
          <p class="muted">{{ t('gallery.currentLibrary') }}: {{ libraries.find((item) => item.libraryId === libraryId)?.title ?? libraryId }}</p>
          <div
            v-if="!connected"
            class="notice offline-notice"
            role="status"
          >
            <span>{{ t('gallery.offlineSessionNotice') }}</span>
            <button
              type="button"
              class="secondary-button"
              :disabled="busy"
              @click="connect(true)"
            >
              {{ t('gallery.retryConnection') }}
            </button>
          </div>
          <div class="safety-callout"><strong>↺ {{ t('gallery.recycleSafetyTitle') }}</strong><p>{{ t('gallery.recycleSafetyText') }}</p></div>
          <div class="recycle-controls">
            <span
              v-if="lastHealthCheck"
              class="muted"
            >{{ t('gallery.lastHealthCheck', { time: formatDate(lastHealthCheck.toISOString()) }) }}</span><button
              type="button"
              class="secondary-button"
              :disabled="!connected || tombstonesBusy"
              @click="loadRecycleBin"
            >
              {{ t('gallery.refreshRecycleBin') }}
            </button>
          </div>
          <div
            v-if="tombstonesBusy"
            class="loading-row"
            role="status"
          >
            {{ t('gallery.recycleLoading') }}
          </div>
          <div
            v-if="tombstoneError"
            class="notice error-notice"
            role="alert"
          >
            {{ tombstoneError }}
          </div>
          <div
            v-if="tombstoneStatus"
            class="notice success-notice"
            role="status"
          >
            {{ tombstoneStatus }}
          </div>
          <div
            v-if="!tombstonesBusy && !tombstoneError && !tombstones.length"
            class="empty-state"
          >
            <span>◇</span><h2>{{ t('gallery.recycleEmpty') }}</h2>
          </div>
          <div
            v-for="item in tombstones"
            :key="item.eventId"
            class="tombstone-row"
          >
            <div><strong>{{ item.assetId }}</strong><small>{{ item.libraryId }} · {{ item.eventId }}</small></div><span class="tombstone-state">{{ t('gallery.removedFromIndex') }}</span><button
              type="button"
              class="secondary-button"
              :disabled="!connected || restoringTombstones[item.eventId]"
              @click="restoreTombstone(item)"
            >
              {{ restoringTombstones[item.eventId] ? t('gallery.restoringItem') : t('gallery.restoreItem') }}
            </button>
          </div>
        </section>
        <section
          v-else
          class="page-section settings-page"
        >
          <p class="eyebrow">{{ t('gallery.settingsLabel') }}</p><h1>{{ t('gallery.nodeSettings') }}</h1><p class="muted">{{ t('gallery.settingsDescription') }}</p>
          <div
            v-if="!connected"
            class="notice offline-notice"
            role="status"
          >
            <span>{{ t('gallery.offlineSessionNotice') }}</span>
            <button
              type="button"
              class="secondary-button"
              :disabled="busy"
              @click="connect(true)"
            >
              {{ t('gallery.retryConnection') }}
            </button>
          </div>
          <div
            v-if="error"
            class="notice error-notice"
            role="alert"
          >
            {{ error }}
          </div>
          <div class="settings-card">
            <div class="settings-card-heading">
              <div>
                <h2>{{ t('gallery.nodeConnection') }}</h2><p>{{ t('gallery.nodeConnectionDescription') }}</p><p
                  v-if="lastHealthCheck"
                  class="muted"
                >
                  {{ t('gallery.lastHealthCheck', { time: formatDate(lastHealthCheck.toISOString()) }) }}
                </p>
              </div><div class="node-status-actions">
                <span
                  class="connection-pill"
                  :class="connected ? 'online' : 'offline'"
                ><i />{{ connected ? t('gallery.online') : t('gallery.offline') }}</span><button
                  type="button"
                  class="secondary-button"
                  :disabled="busy"
                  @click="checkHealth"
                >
                  {{ t('gallery.refreshNodeStatus') }}
                </button>
              </div>
            </div>
            <label>{{ t('gallery.nodeAddress') }}<input
              v-model="endpointInput"
              type="url"
            ></label><label>{{ t('gallery.adminToken') }}<input
              v-model="tokenInput"
              type="password"
              autocomplete="off"
            ></label>
            <label
              v-if="desktopRemoteEndpoint"
              class="remote-node-trust"
            >
              <input
                v-model="remoteEndpointAcknowledged"
                type="checkbox"
              >
              <span>{{ t('gallery.remoteNodeTrustAcknowledgement', { endpoint: desktopRemoteEndpoint }) }}</span>
            </label>
            <p
              v-if="desktopRemoteEndpoint"
              class="remote-node-warning"
            >
              {{ t('gallery.remoteNodeTrustWarning') }}
            </p>
            <button
              class="primary-button small-primary"
              :disabled="busy"
              @click="connect()"
            >
              {{ t('gallery.saveAndConnect') }}
            </button>
            <button
              type="button"
              class="secondary-button"
              :disabled="busy || bulkBusy"
              @click="disconnectSession"
            >
              {{ t('gallery.disconnectSession') }}
            </button>
          </div>
          <div class="settings-card">
            <div class="settings-card-heading"><div><h2>{{ t('gallery.pairing') }}</h2><p>{{ t('gallery.pairingDescription') }}</p></div><span class="pairing-mark">⌘</span></div>
            <div class="pairing-actions">
              <button
                class="secondary-button"
                :disabled="!connected || busy"
                @click="createInvitation"
              >
                {{ t('gallery.createInvite') }}
              </button><span>{{ t('gallery.inviteTtl') }}</span>
            </div>
            <div
              v-if="invitation"
              class="invite-box"
            >
              <img
                :src="invitation.qrDataUrl"
                :alt="t('gallery.inviteQr')"
              ><code>{{ JSON.stringify(invitation.invite) }}</code><p>{{ t('gallery.inviteShortLived') }}</p>
            </div>
            <label>{{ t('gallery.scanInvite') }}<textarea
              v-model="scannedInvite"
              rows="3"
              :placeholder="t('gallery.scanInvitePlaceholder')"
            /></label><button
              class="secondary-button"
              :disabled="!connected || !scannedInvite || busy"
              @click="pairFromInvite"
            >
              {{ t('gallery.joinNode') }}
            </button>
            <div class="peer-list-heading">
              <h3>{{ t('gallery.trustedNodes') }}</h3><button
                type="button"
                class="secondary-button"
                :disabled="!connected || peersBusy"
                @click="loadPeerList"
              >
                {{ t('gallery.refreshPeers') }}
              </button>
            </div>
            <div
              v-if="peersError"
              class="notice error-notice"
              role="alert"
            >
              {{ peersError }}
            </div>
            <p
              v-if="tagWriteNotice"
              class="muted"
              role="status"
            >
              {{ tagWriteNotice }}
            </p>
            <p
              v-if="hasSession && connected && !tagSyncEnabled"
              class="muted"
              role="status"
            >
              {{ t('gallery.tagSyncUnavailable') }}
            </p>
            <div
              v-if="peersBusy"
              class="loading-row"
              role="status"
            >
              {{ t('gallery.loading') }}
            </div>
            <div
              v-if="!peers.length && !pendingPeers.length && !peersBusy"
              class="muted"
            >
              {{ t('gallery.noTrustedNodes') }}
            </div>
            <div
              v-for="peer in peers"
              :key="peer.peerId"
              class="peer-row"
            >
              <div><strong>{{ peer.label }}</strong><small>{{ peer.peerId }} · {{ t(`gallery.trust.${peer.trustState}`) }}</small></div>
              <div
                v-if="peer.trustState === 'trusted'"
                class="peer-actions"
              >
                <label
                  class="sr-only"
                  :for="`grant-library-${peer.peerId}`"
                >{{ t('gallery.grantReadAccess') }}</label>
                <select
                  :id="`grant-library-${peer.peerId}`"
                  v-model="grantLibraryByPeer[peer.peerId]"
                  class="field-select"
                  :disabled="!connected || !libraries.length"
                  @change="onPeerLibraryChange(peer.peerId)"
                >
                  <option
                    v-for="library in libraries"
                    :key="library.libraryId"
                    :value="library.libraryId"
                  >
                    {{ library.title }}
                  </option>
                </select>
                <button
                  type="button"
                  class="secondary-button"
                  :disabled="!connected || !libraries.length"
                  @click="grantPeerLibrary(peer.peerId)"
                >
                  {{ t('gallery.grantLibrary') }}
                </button>
                <button
                  v-if="tagSyncEnabled"
                  type="button"
                  class="secondary-button"
                  :disabled="!connected || !libraries.length"
                  @click="togglePeerTagWrite(peer.peerId)"
                >
                  {{ t(peerTagWriteEnabled(peer.peerId) ? 'gallery.revokeTagWrite' : 'gallery.grantTagWrite') }}
                </button>
                <small
                  v-if="tagSyncEnabled && tagSyncStatusByPeer[peer.peerId]"
                  class="peer-sync-status"
                >
                  {{ t('gallery.tagSyncPending', { count: tagSyncStatusByPeer[peer.peerId]?.pending ?? 0 }) }}
                  <span v-if="tagSyncStatusByPeer[peer.peerId]?.lastError">· {{ tagSyncErrorLabel(tagSyncStatusByPeer[peer.peerId]?.lastError ?? null) }}</span>
                </small>
                <button
                  type="button"
                  class="text-button danger-text"
                  :disabled="!connected"
                  @click="revokePeer(peer.peerId)"
                >
                  {{ t('gallery.revoke') }}
                </button>
              </div>
            </div>
            <template v-if="pendingPeers.length">
              <h3>{{ t('gallery.pendingApprovals') }}</h3>
              <div
                v-for="pending in pendingPeers"
                :key="pending.peerId"
                class="peer-row pending-peer-row"
              >
                <div><strong>{{ pending.proposedLabel }}</strong><small>{{ t('gallery.peerFingerprint', { peerId: pending.peerId }) }} · {{ formatDate(pending.requestedAt) }}</small></div>
                <div class="peer-actions">
                  <button
                    type="button"
                    class="secondary-button"
                    :disabled="!connected"
                    @click="decidePeer(pending, true)"
                  >
                    {{ t('gallery.approvePeer') }}
                  </button><button
                    type="button"
                    class="text-button danger-text"
                    :disabled="!connected"
                    @click="decidePeer(pending, false)"
                  >
                    {{ t('gallery.rejectPeer') }}
                  </button>
                </div>
              </div>
            </template>
          </div>
          <div class="settings-card cleanup-card">
            <div><h2>{{ t('gallery.localCacheTitle') }}</h2><p>{{ t('gallery.localCacheDescription') }}</p></div><button
              class="secondary-button"
              @click="clearLocalCache"
            >
              {{ t('gallery.clearCache') }}
            </button>
          </div>
        </section>
      </main>
    </div>
    <div
      v-if="previewAsset"
      class="modal-backdrop preview-backdrop"
      @click.self="closePreview(true)"
      @keydown.esc="closePreview(true)"
    >
      <section
        class="preview-dialog"
        role="dialog"
        aria-modal="true"
        tabindex="-1"
        :aria-label="t('gallery.previewAsset', { filename: previewAsset.filename })"
      >
        <section
          class="preview-main"
          :aria-label="t('gallery.preview')"
        >
          <nav
            class="preview-navigation"
            :aria-label="t('gallery.previewNavigation')"
          >
            <button
              type="button"
              class="secondary-button"
              :aria-label="t('gallery.previousPhoto')"
              :disabled="previousPreviewIndex < 0 || previewBusy"
              @click="navigatePreview(-1)"
            >
              ← {{ t('gallery.previousPhoto') }}
            </button>
            <span aria-live="polite">{{ previewIndex + 1 }} / {{ filteredAssets.length }}</span>
            <button
              type="button"
              class="secondary-button"
              :aria-label="t('gallery.nextPhoto')"
              :disabled="nextPreviewIndex < 0 || previewBusy"
              @click="navigatePreview(1)"
            >
              {{ t('gallery.nextPhoto') }} →
            </button>
          </nav>
          <div
            class="preview-stage"
            :aria-busy="previewBusy"
          >
            <p
              v-if="previewBusy"
              role="status"
            >
              {{ t('gallery.previewLoading') }}
            </p>
            <p
              v-else-if="previewErrorCode"
              class="notice error-notice"
              role="alert"
            >
              {{ previewErrorMessage(previewErrorCode) }}
            </p>
            <div
              v-else-if="previewUrl"
              class="preview-content"
            >
              <p
                v-if="isCachedPreview"
                class="muted cached-preview-note"
                role="status"
              >
                {{ t('gallery.cachedPreviewNote') }}
              </p>
              <p
                v-if="!cacheAvailable"
                class="muted cached-preview-note"
                role="status"
              >
                {{ t('gallery.cacheUnavailable') }}
              </p>
              <img
                class="preview-image"
                :src="previewUrl"
                :alt="previewAsset.filename"
              >
            </div>
          </div>
        </section>
        <aside
          class="preview-sidebar"
          :aria-label="t('gallery.previewDetails')"
        >
          <header class="preview-sidebar-header">
            <button
              class="dialog-close"
              :aria-label="t('gallery.close')"
              autofocus
              @click="closePreview(true)"
            >
              ×
            </button>
            <h2>{{ previewAsset.filename }}</h2>
          </header>
          <dl class="preview-metadata">
            <div>
              <dt>{{ t('gallery.captureTime') }}</dt>
              <dd>{{ formatCaptureDate(previewAsset) }}</dd>
            </div>
            <div>
              <dt>{{ t('gallery.originNode') }}</dt>
              <dd>{{ previewAsset.originNodeId }}</dd>
            </div>
            <div>
              <dt>{{ t('gallery.fileSize') }}</dt>
              <dd>{{ formatSize(previewAsset.byteSize) }}</dd>
            </div>
            <div>
              <dt>{{ t('gallery.availabilityLabel') }}</dt>
              <dd>
                <span
                  class="availability"
                  :class="previewAsset.availability"
                >
                  {{ t(`gallery.availability.${previewAsset.availability}`) }}
                </span>
              </dd>
            </div>
          </dl>
          <section
            class="version-editor"
            :aria-label="t('gallery.editorTitle')"
          >
            <h3>{{ t('gallery.editorTitle') }}</h3>
            <p
              v-if="!mediaVersionsEnabled"
              class="muted"
            >
              {{ t('gallery.editorUnavailable') }}
            </p>
            <template v-else>
              <div
                v-if="versionsBusy && !versions"
                role="status"
              >
                {{ t('gallery.versionsLoading') }}
              </div>
              <div
                v-else-if="versions?.original"
                class="editor-controls"
              >
                <p class="muted">
                  {{ t('gallery.originalReadOnly') }} · {{ versions.original.filename }}
                </p>
                <label>
                  {{ t('gallery.versionSource') }}
                  <select
                    v-model="sourceVersionId"
                    @change="handleVersionSourceChange"
                  >
                    <option value="">{{ t('gallery.originalSource') }}</option>
                    <option
                      v-for="item in versions.items.filter((item) => item.status.toLowerCase() === 'ready' && item.outputSha256)"
                      :key="item.versionId"
                      :value="item.versionId"
                    >
                      {{ t('gallery.derivedSource', { id: item.versionId }) }}
                    </option>
                  </select>
                </label>
                <div
                  class="crop-controls"
                  role="group"
                  :aria-label="t('gallery.cropControls')"
                >
                  <label>
                    {{ t('gallery.cropX') }}
                    <input
                      v-model.number="crop.x"
                      type="number"
                      min="0"
                      max="1"
                      step="0.01"
                    >
                  </label>
                  <label>
                    {{ t('gallery.cropY') }}
                    <input
                      v-model.number="crop.y"
                      type="number"
                      min="0"
                      max="1"
                      step="0.01"
                    >
                  </label>
                  <label>
                    {{ t('gallery.cropWidth') }}
                    <input
                      v-model.number="crop.width"
                      type="number"
                      min="0.01"
                      max="1"
                      step="0.01"
                    >
                  </label>
                  <label>
                    {{ t('gallery.cropHeight') }}
                    <input
                      v-model.number="crop.height"
                      type="number"
                      min="0.01"
                      max="1"
                      step="0.01"
                    >
                  </label>
                </div>
                <label>
                  {{ t('gallery.rotation') }}
                  <select v-model.number="rotation">
                    <option :value="0">0°</option>
                    <option :value="90">90°</option>
                    <option :value="180">180°</option>
                    <option :value="270">270°</option>
                  </select>
                </label>
                <button
                  class="primary-button small-primary"
                  :disabled="versionsBusy || !crop.width || !crop.height"
                  @click="createVersion"
                >
                  {{ versionsBusy ? t('gallery.versionSaving') : t('gallery.saveVersion') }}
                </button>
                <p
                  v-if="versionError"
                  class="notice error-notice"
                  role="alert"
                >
                  {{ versionError }}
                </p>
                <ul class="version-list">
                  <li
                    v-for="item in versions.items"
                    :key="item.versionId"
                  >
                    <span>{{ item.versionId.slice(0, 8) }} · {{ versionStatusText(item.status) }} · {{ formatDate(item.createdAt) }}</span>
                    <button
                      v-if="item.status.toLowerCase() === 'ready'"
                      class="secondary-button"
                      @click="previewVersion(item.versionId)"
                    >
                      {{ t('gallery.previewVersion') }}
                    </button>
                  </li>
                </ul>
                <div
                  v-if="activeVersionId && versionPreviewUrl"
                  class="version-output"
                >
                  <p>{{ t('gallery.derivedPreview') }}</p>
                  <img
                    :src="versionPreviewUrl"
                    :alt="t('gallery.versionPreviewAlt')"
                  >
                </div>
              </div>
              <button
                v-else
                class="secondary-button"
                :disabled="versionsBusy"
                @click="loadVersions"
              >
                {{ t('gallery.loadVersions') }}
              </button>
            </template>
          </section>
        </aside>
      </section>
    </div>
    <div
      v-if="selectedAsset"
      class="modal-backdrop"
      @click.self="selectedAsset = null"
      @keydown.esc="selectedAsset = null"
    >
      <section
        class="tag-dialog"
        role="dialog"
        aria-modal="true"
        :aria-label="t('gallery.addTag')"
      >
        <button
          class="dialog-close"
          :aria-label="t('gallery.close')"
          @click="selectedAsset = null"
        >
          ×
        </button><p class="eyebrow">{{ t('gallery.virtualAlbum') }}</p><h2>{{ selectedAsset.filename }}</h2><label>{{ t('gallery.tagName') }}<input
          v-model="tagInput"
          autofocus
          :placeholder="t('gallery.tagPlaceholder')"
          :disabled="tagWriteBusy || !assetTagsEnabled || !connected"
          @input="tagDialogError = ''"
          @keydown.enter.prevent="saveTagAndAlbum"
        ></label><p class="muted">{{ t('gallery.tagPrivacy') }}</p><p
          v-if="tagDialogError"
          class="notice error-notice"
          role="alert"
        >
          {{ tagDialogError }}
        </p><div class="dialog-actions">
          <button
            class="secondary-button"
            @click="selectedAsset = null"
          >
            {{ t('gallery.cancel') }}
          </button><button
            class="primary-button small-primary"
            :disabled="!tagInput.trim() || tagWriteBusy || !assetTagsEnabled || !connected"
            @click="saveTagAndAlbum"
          >
            {{ tagWriteBusy ? t('gallery.savingTag') : t('gallery.saveTag') }}
          </button>
        </div>
      </section>
    </div>
    <div
      v-if="bulkDialogOpen"
      class="modal-backdrop"
      @click.self="closeBulkDialog"
      @keydown.esc.prevent="closeBulkDialog"
    >
      <section
        class="tag-dialog bulk-dialog"
        role="dialog"
        aria-modal="true"
        :aria-label="bulkDialogTitle"
      >
        <button
          class="dialog-close"
          type="button"
          :aria-label="t('gallery.close')"
          :disabled="bulkBusy"
          @click="closeBulkDialog"
        >
          ×
        </button>
        <p class="eyebrow">{{ t('gallery.bulkActions') }}</p>
        <h2>{{ bulkDialogTitle }}</h2>
        <p class="muted">{{ t('gallery.bulkScopeNotice', { count: bulkActionCount, library: selectedLibraryTitle }) }}</p>
        <p
          v-if="activeBulkAction?.kind === 'favorite'"
          class="bulk-shared-notice"
        >
          {{ t('gallery.bulkFavoriteShared') }}
        </p>
        <label v-if="activeBulkAction?.kind === 'tag' && activeBulkAction.add">{{ t('gallery.tagName') }}<input
          v-model="bulkTagInput"
          autofocus
          :placeholder="t('gallery.tagPlaceholder')"
          :disabled="bulkBusy || !!bulkOperation"
          @input="bulkError = ''"
          @keydown.enter.prevent="confirmBulkOperation"
        ></label>
        <label v-else-if="activeBulkAction?.kind === 'tag'">{{ t('gallery.bulkTagToRemove') }}<select
          v-model="bulkTagInput"
          autofocus
          :disabled="bulkBusy || !!bulkOperation"
        ><option
          v-for="tag in selectedTagOptions"
          :key="tag"
          :value="tag"
        >{{ tag }}</option></select></label>
        <p
          v-if="bulkError"
          class="notice error-notice"
          role="alert"
        >
          {{ bulkError }}
        </p>
        <template v-if="bulkOperation">
          <p
            class="notice"
            :class="bulkFailedCount ? 'error-notice' : 'offline-notice'"
            role="status"
            aria-live="polite"
          >
            {{ bulkStatusText }}
          </p>
          <ul class="bulk-result-list">
            <li
              v-for="entry in bulkOperation.entries"
              :key="entry.assetId"
              :class="`bulk-result-${entry.status}`"
            >
              <span>{{ entry.filename }}</span><span>{{ bulkEntryStatus(entry) }}</span><small v-if="entry.error">{{ entry.error }}</small>
            </li>
          </ul>
          <button
            v-if="bulkFailedCount"
            type="button"
            class="secondary-button"
            :disabled="bulkBusy || !connected"
            @click="retryFailedBulkItems"
          >
            {{ t('gallery.bulkRetryFailed') }}
          </button>
        </template>
        <div class="dialog-actions">
          <button
            type="button"
            class="secondary-button"
            :disabled="bulkBusy"
            @click="closeBulkDialog"
          >
            {{ bulkOperation ? t('gallery.close') : t('gallery.cancel') }}
          </button>
          <button
            v-if="!bulkOperation"
            type="button"
            class="primary-button small-primary"
            :disabled="!bulkCanConfirm"
            @click="confirmBulkOperation"
          >
            {{ bulkConfirmLabel }}
          </button>
        </div>
      </section>
    </div>
  </div>
</template>
