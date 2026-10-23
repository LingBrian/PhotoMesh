<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import './gallery.css';
import { createPairingApprovalDecision, reconcilePendingLibrarySelections, type PendingPeer } from './pairing-approval';

type Library = { libraryId: string; title: string };
type Asset = {
  assetId: string; libraryId: string; originNodeId: string; kind: string; sha256: string;
  availability: 'online' | 'cached' | 'offline' | 'missing'; filename: string; capturedAt: string | null;
  sourcePath: string | null; sourceKind: string; byteSize: number; version: string;
};
type Page = { items: Asset[]; nextCursor: string | null };
type Tombstone = { assetId: string; libraryId: string; eventId: string };
type Album = { id: string; name: string; tag: string };
const { t, locale } = useI18n();
const endpoint = ref('http://127.0.0.1:8443');
const token = ref('');
const connected = ref(false);
const busy = ref(false);
const error = ref('');
const libraries = ref<Library[]>([]);
const libraryId = ref('');
const assets = ref<Asset[]>([]);
const cursor = ref<string | null>(null);
const search = ref('');
const section = ref<'timeline' | 'recycle' | 'settings'>('timeline');
const tombstones = ref<Tombstone[]>([]);
const peers = ref<Array<{ peerId: string; label: string; trustState: string }>>([]);
const pendingPeers = ref<PendingPeer[]>([]);
const selectedLibraryIds = ref<Record<string, string[]>>({});
const busyApprovalPeers = ref<string[]>([]);
const invitation = ref<{ qrDataUrl: string; invite: unknown } | null>(null);
const scannedInvite = ref('');
const theme = ref<'light' | 'dark'>(window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
const scrollElement = ref<HTMLElement>();
const scrollTop = ref(0);
const tags = ref<Record<string, string[]>>({});
const albums = ref<Album[]>([]);
const activeAlbum = ref('');
const selectedAsset = ref<Asset | null>(null);
const tagInput = ref('');
const thumbnailUrls = ref<Record<string, string>>({});
let imageObserver: IntersectionObserver | undefined;
let healthTimer: ReturnType<typeof setInterval> | undefined;
let pageGeneration = 0;
const rowHeight = 164;
const pageSize = 100;

const filteredAssets = computed(() => {
  const needle = search.value.trim().toLocaleLowerCase();
  return assets.value.filter((asset) => {
    if (needle && !`${asset.filename} ${asset.sourcePath ?? ''} ${asset.originNodeId}`.toLocaleLowerCase().includes(needle)) return false;
    if (activeAlbum.value) {
      const album = albums.value.find((item) => item.id === activeAlbum.value);
      if (!album || !(tags.value[asset.assetId] ?? []).includes(album.tag)) return false;
    }
    return true;
  });
});
const visibleStart = computed(() => Math.max(0, Math.floor(scrollTop.value / rowHeight) - 3));
const visibleEnd = computed(() => Math.min(filteredAssets.value.length, visibleStart.value + 24));
const visibleAssets = computed(() => filteredAssets.value.slice(visibleStart.value, visibleEnd.value));
const topSpacer = computed(() => visibleStart.value * rowHeight);
const bottomSpacer = computed(() => Math.max(0, (filteredAssets.value.length - visibleEnd.value) * rowHeight));
const apiBase = computed(() => endpoint.value.trim().replace(/\/+$/, ''));

function headers() { return { authorization: `Bearer ${token.value.trim()}` }; }
async function request<T>(path: string, init: NonNullable<Parameters<typeof fetch>[1]> = {}): Promise<T> {
  const response = await fetch(`${apiBase.value}${path}`, { ...init, headers: { ...headers(), ...init.headers } });
  if (!response.ok) throw new Error(response.status === 409 ? t('gallery.sourceOffline') : `${response.status}`);
  return response.status === 204 ? undefined as T : await response.json() as T;
}
async function connect(): Promise<void> {
  error.value = ''; busy.value = true; connected.value = false;
  try {
    const health = await fetch(`${apiBase.value}/v1/health`);
    if (!health.ok) throw new Error(t('gallery.connectionFailed'));
    const result = await request<{ items: Library[] }>('/v1/libraries');
    libraries.value = result.items;
    libraryId.value = libraries.value[0]?.libraryId ?? '';
    connected.value = true;
    await loadPage(true);
    await loadPeerList();
    if (healthTimer) clearInterval(healthTimer);
    healthTimer = setInterval(() => { void checkHealth(); }, 30000);
  } catch (cause) { error.value = errorText(cause); }
  finally { busy.value = false; }
}
async function checkHealth(): Promise<void> {
  try { connected.value = (await fetch(`${apiBase.value}/v1/health`)).ok; }
  catch { connected.value = false; }
}
async function loadPage(reset = false): Promise<void> {
  if (!connected.value || !libraryId.value || busy.value && !reset) return;
  if (reset) { pageGeneration += 1; assets.value = []; cursor.value = null; scrollTop.value = 0; }
  if (cursor.value === '') return;
  const generation = pageGeneration;
  busy.value = true; error.value = '';
  try {
    const query = new URLSearchParams({ libraryId: libraryId.value, limit: String(pageSize) });
    if (cursor.value) query.set('cursor', cursor.value);
    if (search.value.trim()) query.set('q', search.value.trim());
    const page = await request<Page>(`/v1/assets?${query.toString()}`);
    if (generation !== pageGeneration) return;
    assets.value = reset ? page.items : [...assets.value, ...page.items];
    cursor.value = page.nextCursor ?? '';
  } catch (cause) { if (generation === pageGeneration) error.value = errorText(cause); }
  finally { if (generation === pageGeneration) busy.value = false; }
}
let searchTimer: ReturnType<typeof setTimeout> | undefined;
watch(search, () => { if (searchTimer) clearTimeout(searchTimer); searchTimer = setTimeout(() => void loadPage(true), 250); });
watch(libraryId, () => { if (connected.value) void loadPage(true); });
watch(theme, (value) => { document.documentElement.dataset.theme = value; }, { immediate: true });
function onScroll(): void {
  scrollTop.value = scrollElement.value?.scrollTop ?? 0;
  if (visibleEnd.value >= filteredAssets.value.length - 8 && cursor.value && !busy.value) void loadPage();
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
watch(visibleAssets, observeImages);
async function ensureThumbnail(assetId: string): Promise<void> {
  if (thumbnailUrls.value[assetId]) return;
  const asset = assets.value.find((item) => item.assetId === assetId);
  if (!asset || !['online', 'cached'].includes(asset.availability)) return;
  const cacheKey = `${apiBase.value}:${asset.originNodeId}:${asset.assetId}:${asset.version}`;
  try {
    const cached = await idbGet<Blob>('thumbnails', cacheKey);
    const thumbnail = cached ?? await (async () => {
      const response = await fetch(`${apiBase.value}/v1/assets/${encodeURIComponent(asset.assetId)}/original`, { headers: headers() });
      if (!response.ok) return undefined;
      const original = await response.blob();
      const bitmap = await createImageBitmap(original);
      const scale = Math.min(360 / bitmap.width, 220 / bitmap.height, 1);
      const canvas = document.createElement('canvas'); canvas.width = Math.max(1, Math.round(bitmap.width * scale)); canvas.height = Math.max(1, Math.round(bitmap.height * scale));
      canvas.getContext('2d')?.drawImage(bitmap, 0, 0); bitmap.close();
      const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/webp', 0.78));
      if (blob) await idbPut('thumbnails', { key: cacheKey, value: blob });
      return blob ?? undefined;
    })();
    if (thumbnail) thumbnailUrls.value[assetId] = URL.createObjectURL(thumbnail);
  } catch { /* An unavailable thumbnail never changes source status or the original. */ }
}
async function downloadOriginal(asset: Asset): Promise<void> {
  try {
    const response = await fetch(`${apiBase.value}/v1/assets/${encodeURIComponent(asset.assetId)}/original`, { headers: headers() });
    if (!response.ok) throw new Error(response.status === 409 ? t('gallery.sourceOffline') : `${response.status}`);
    const blob = await response.blob(); const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a'); anchor.href = url; anchor.download = asset.filename; anchor.click(); URL.revokeObjectURL(url);
  } catch (cause) { error.value = errorText(cause); }
}
async function clearLocalCache(): Promise<void> {
  if (!window.confirm(t('gallery.clearCacheConfirm', { node: endpoint.value.trim() || t('gallery.currentNode') }))) return;
  await idbClear('thumbnails');
  for (const url of Object.values(thumbnailUrls.value)) URL.revokeObjectURL(url);
  thumbnailUrls.value = {};
  error.value = '';
}
async function loadRecycleBin(): Promise<void> {
  if (!libraryId.value) return;
  try { tombstones.value = (await request<{ items: Tombstone[] }>(`/v1/recycle-bin?libraryId=${encodeURIComponent(libraryId.value)}`)).items; }
  catch (cause) { error.value = errorText(cause); }
}
async function loadPeerList(): Promise<void> {
  try {
    const result = await request<{ peers: typeof peers.value; pending?: PendingPeer[] }>('/v1/pairing/peers');
    const pending = result.pending ?? [];
    peers.value = result.peers;
    pendingPeers.value = pending;
    const available = new Set(libraries.value.map((library) => library.libraryId));
    selectedLibraryIds.value = reconcilePendingLibrarySelections(
      pending.map((peer) => peer.peerId), selectedLibraryIds.value, available
    );
  } catch (cause) {
    error.value = errorText(cause);
  }
}
async function decidePendingPeer(peer: PendingPeer, approved: boolean): Promise<void> {
  if (busyApprovalPeers.value.includes(peer.peerId)) return;
  busyApprovalPeers.value = [...busyApprovalPeers.value, peer.peerId];
  error.value = '';
  try {
    await request(`/v1/pairing/peers/${encodeURIComponent(peer.peerId)}/approval`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(createPairingApprovalDecision(approved, selectedLibraryIds.value[peer.peerId] ?? []))
    });
    await loadPeerList();
  } catch (cause) {
    error.value = errorText(cause);
  } finally {
    busyApprovalPeers.value = busyApprovalPeers.value.filter((peerId) => peerId !== peer.peerId);
  }
}
async function createInvitation(): Promise<void> {
  try {
    const response = await request<{ qrDataUrl: string; protocol: string; version: number; hostPeerId: string; addresses: string[]; inviteId: string; secret: string; expiresAt: string }>('/v1/pairing/invitations', { method: 'POST' });
    const { qrDataUrl, ...invite } = response; invitation.value = { qrDataUrl, invite };
  }
  catch (cause) { error.value = errorText(cause); }
}
async function pairFromInvite(): Promise<void> {
  try {
    const invite = JSON.parse(scannedInvite.value) as unknown;
    await request('/v1/pairing/join', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ invite, label: t('gallery.defaultNodeLabel') }) });
    scannedInvite.value = ''; await loadPeerList();
  } catch (cause) { error.value = errorText(cause); }
}
async function revokePeer(peerId: string): Promise<void> {
  if (!window.confirm(t('gallery.revokeConfirm'))) return;
  try { await request(`/v1/pairing/peers/${encodeURIComponent(peerId)}`, { method: 'DELETE' }); await loadPeerList(); }
  catch (cause) { error.value = errorText(cause); }
}
async function loadLocalMetadata(): Promise<void> {
  try {
    tags.value = await idbGet<Record<string, string[]>>('tags', 'all') ?? {};
    albums.value = await idbGet<Album[]>('albums', 'all') ?? [];
  } catch { tags.value = {}; albums.value = []; }
}
async function saveTagAndAlbum(): Promise<void> {
  const tag = tagInput.value.trim(); const asset = selectedAsset.value;
  if (!tag || !asset) return;
  tags.value[asset.assetId] = [...new Set([...(tags.value[asset.assetId] ?? []), tag])];
  await idbPut('tags', { key: 'all', value: tags.value });
  if (!albums.value.some((album) => album.tag === tag)) {
    const album = { id: crypto.randomUUID(), name: tag, tag }; albums.value.push(album);
    await idbPut('albums', { key: 'all', value: albums.value });
  }
  tagInput.value = ''; selectedAsset.value = null;
}
function errorText(cause: unknown): string { return cause instanceof Error ? cause.message : t('gallery.unknownError'); }
function formatDate(value: string | null): string { return value ? new Intl.DateTimeFormat(locale.value, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value)) : t('gallery.unknownDate'); }
function formatSize(bytes: number): string { return new Intl.NumberFormat(locale.value, { style: 'unit', unit: 'byte', unitDisplay: 'narrow', notation: bytes > 1_000_000 ? 'compact' : 'standard', maximumFractionDigits: 1 }).format(bytes); }
function changeSection(value: typeof section.value): void { section.value = value; if (value === 'recycle') void loadRecycleBin(); }
onMounted(() => { void loadLocalMetadata(); document.documentElement.dataset.theme = theme.value; });
onBeforeUnmount(() => {
  if (healthTimer) clearInterval(healthTimer); if (searchTimer) clearTimeout(searchTimer);
  imageObserver?.disconnect(); for (const url of Object.values(thumbnailUrls.value)) URL.revokeObjectURL(url);
});

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('photomesh-gallery-cache', 1);
    request.onupgradeneeded = () => { for (const store of ['thumbnails', 'tags', 'albums']) if (!request.result.objectStoreNames.contains(store)) request.result.createObjectStore(store, { keyPath: 'key' }); };
    request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
  });
}
async function idbGet<T>(store: string, key: string): Promise<T | undefined> {
  const db = await openDb(); return new Promise((resolve, reject) => { const req = db.transaction(store).objectStore(store).get(key); req.onsuccess = () => resolve(req.result?.value as T | undefined); req.onerror = () => reject(req.error); });
}
async function idbPut(store: string, record: { key: string; value: unknown }): Promise<void> {
  const db = await openDb(); return new Promise((resolve, reject) => { const tx = db.transaction(store, 'readwrite'); tx.objectStore(store).put(record); tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error); });
}
async function idbClear(store: string): Promise<void> {
  const db = await openDb(); return new Promise((resolve, reject) => { const tx = db.transaction(store, 'readwrite'); tx.objectStore(store).clear(); tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error); });
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
      <label class="searchbox"><span class="sr-only">{{ t('gallery.search') }}</span><span aria-hidden="true">⌕</span><input
        v-model="search"
        type="search"
        :placeholder="t('gallery.searchPlaceholder')"
        :aria-label="t('gallery.search')"
      ></label>
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
          v-if="!connected"
          class="connect-card"
        >
          <div class="welcome-icon">◈</div><p class="eyebrow">{{ t('gallery.localFirst') }}</p><h1>{{ t('gallery.connectTitle') }}</h1><p class="muted">{{ t('gallery.connectDescription') }}</p>
          <form
            class="connect-form"
            @submit.prevent="connect"
          >
            <label>{{ t('gallery.nodeAddress') }}<input
              v-model="endpoint"
              type="url"
              required
              autocomplete="url"
              placeholder="http://127.0.0.1:8443"
            ></label>
            <label>{{ t('gallery.adminToken') }}<input
              v-model="token"
              type="password"
              required
              autocomplete="off"
              :placeholder="t('gallery.tokenPlaceholder')"
            ></label>
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
              >
                <option
                  v-for="library in libraries"
                  :key="library.libraryId"
                  :value="library.libraryId"
                >
                  {{ library.title }}
                </option>
              </select><span class="count-chip">{{ filteredAssets.length.toLocaleString(locale) }} {{ t('gallery.items') }}</span>
            </div>
          </div>
          <div
            v-if="error"
            class="notice error-notice"
            role="alert"
          >
            {{ error }}
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
            ref="scrollElement"
            class="timeline-scroll"
            role="region"
            :aria-label="t('gallery.timeline')"
            tabindex="0"
            @scroll="onScroll"
          >
            <div
              v-if="!filteredAssets.length && !busy"
              class="empty-state"
            >
              <span>◇</span><h2>{{ search ? t('gallery.noSearchResults') : t('gallery.emptyLibrary') }}</h2><p>{{ t('gallery.emptyHint') }}</p>
            </div>
            <div
              :style="{ height: `${topSpacer}px` }"
              aria-hidden="true"
            />
            <article
              v-for="asset in visibleAssets"
              :key="asset.assetId"
              class="asset-row"
              :data-asset-id="asset.assetId"
              tabindex="0"
              @focus="selectedAsset = asset"
            >
              <div class="asset-preview">
                <img
                  v-if="thumbnailUrls[asset.assetId]"
                  :src="thumbnailUrls[asset.assetId]"
                  alt=""
                ><span
                  v-else
                  class="preview-placeholder"
                >{{ asset.kind === 'video' ? '▶' : '◇' }}</span><span
                  v-if="asset.kind === 'video'"
                  class="media-badge"
                >▶</span>
              </div>
              <div class="asset-info">
                <div class="asset-titleline">
                  <h2 :title="asset.filename">{{ asset.filename }}</h2><span
                    class="availability"
                    :class="asset.availability"
                  >{{ t(`gallery.availability.${asset.availability}`) }}</span>
                </div><p class="asset-date">{{ formatDate(asset.capturedAt) }} <span>·</span> {{ formatSize(asset.byteSize) }}</p><p class="source-line"><span>⌂ {{ asset.originNodeId }}</span><span v-if="asset.sourcePath">· {{ asset.sourcePath }}</span></p><div class="tag-list">
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
                <button
                  class="icon-button"
                  :aria-label="t('gallery.addTag')"
                  :title="t('gallery.addTag')"
                  @click="selectedAsset = asset; tagInput = ''"
                >
                  ＋
                </button><button
                  class="download-button"
                  :disabled="!['online', 'cached'].includes(asset.availability)"
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
          </div>
        </template>
        <section
          v-else-if="section === 'recycle'"
          class="page-section"
        >
          <p class="eyebrow">{{ t('gallery.recycleLabel') }}</p><h1>{{ t('gallery.recycleBin') }}</h1><p class="muted">{{ t('gallery.recycleDescription') }}</p>
          <div class="safety-callout"><strong>↺ {{ t('gallery.recycleSafetyTitle') }}</strong><p>{{ t('gallery.recycleSafetyText') }}</p></div>
          <div
            v-if="!tombstones.length"
            class="empty-state"
          >
            <span>◇</span><h2>{{ t('gallery.recycleEmpty') }}</h2>
          </div>
          <div
            v-for="item in tombstones"
            :key="item.eventId"
            class="tombstone-row"
          >
            <div><strong>{{ item.assetId }}</strong><small>{{ item.libraryId }} · {{ item.eventId }}</small></div><span class="tombstone-state">{{ t('gallery.removedFromIndex') }}</span>
          </div>
        </section>
        <section
          v-else
          class="page-section settings-page"
        >
          <p class="eyebrow">{{ t('gallery.settingsLabel') }}</p><h1>{{ t('gallery.nodeSettings') }}</h1><p class="muted">{{ t('gallery.settingsDescription') }}</p>
          <div
            v-if="error"
            class="notice error-notice"
            role="alert"
          >
            {{ error }}
          </div>
          <div class="settings-card">
            <div class="settings-card-heading">
              <div><h2>{{ t('gallery.nodeConnection') }}</h2><p>{{ t('gallery.nodeConnectionDescription') }}</p></div><span
                class="connection-pill"
                :class="connected ? 'online' : 'offline'"
              ><i />{{ connected ? t('gallery.online') : t('gallery.offline') }}</span>
            </div>
            <label>{{ t('gallery.nodeAddress') }}<input
              v-model="endpoint"
              type="url"
            ></label><label>{{ t('gallery.adminToken') }}<input
              v-model="token"
              type="password"
              autocomplete="off"
            ></label><button
              class="primary-button small-primary"
              @click="connect"
            >
              {{ t('gallery.saveAndConnect') }}
            </button>
          </div>
          <div class="settings-card">
            <div class="settings-card-heading"><div><h2>{{ t('gallery.pairing') }}</h2><p>{{ t('gallery.pairingDescription') }}</p></div><span class="pairing-mark">⌘</span></div>
            <div class="pairing-actions">
              <button
                class="secondary-button"
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
              :disabled="!scannedInvite"
              @click="pairFromInvite"
            >
              {{ t('gallery.joinNode') }}
            </button>
            <div class="pending-approval-heading">
              <h3>{{ t('gallery.pendingApprovals') }}</h3>
              <button
                class="text-button"
                @click="loadPeerList"
              >
                {{ t('gallery.refreshApprovals') }}
              </button>
            </div>
            <p class="muted approval-security-note">
              {{ t('gallery.approvalSecurityNote') }}
            </p>
            <div
              v-if="!pendingPeers.length"
              class="muted"
            >
              {{ t('gallery.noPendingApprovals') }}
            </div>
            <article
              v-for="pending in pendingPeers"
              :key="pending.peerId"
              class="pending-peer-row"
            >
              <div class="pending-peer-details">
                <strong>{{ pending.proposedLabel }}</strong>
                <small>{{ t('gallery.peerIdLabel') }} <code>{{ pending.peerId }}</code></small>
                <small>{{ t('gallery.peerPublicKey') }} <code>{{ pending.publicKey }}</code></small>
                <small>{{ t('gallery.requestedAt') }} {{ formatDate(pending.requestedAt) }}</small>
              </div>
              <fieldset class="approval-grants">
                <legend>{{ t('gallery.grantLibraries') }}</legend>
                <label
                  v-for="library in libraries"
                  :key="library.libraryId"
                >
                  <input
                    v-model="selectedLibraryIds[pending.peerId]"
                    type="checkbox"
                    :value="library.libraryId"
                  >
                  <span>{{ library.title }}</span>
                </label>
                <p
                  v-if="!libraries.length"
                  class="muted"
                >
                  {{ t('gallery.noLibrariesAvailable') }}
                </p>
              </fieldset>
              <div class="pending-peer-actions">
                <button
                  class="secondary-button"
                  :disabled="busyApprovalPeers.includes(pending.peerId)"
                  @click="decidePendingPeer(pending, false)"
                >
                  {{ t('gallery.declineDevice') }}
                </button>
                <button
                  class="primary-button small-primary"
                  :disabled="busyApprovalPeers.includes(pending.peerId)"
                  @click="decidePendingPeer(pending, true)"
                >
                  {{ t('gallery.approveDevice') }}
                </button>
              </div>
            </article>
            <h3>{{ t('gallery.trustedNodes') }}</h3><div
              v-if="!peers.length"
              class="muted"
            >
              {{ t('gallery.noTrustedNodes') }}
            </div><div
              v-for="peer in peers"
              :key="peer.peerId"
              class="peer-row"
            >
              <div><strong>{{ peer.label }}</strong><small>{{ peer.peerId }} · {{ t(`gallery.trust.${peer.trustState}`) }}</small></div><button
                v-if="peer.trustState === 'trusted'"
                class="text-button danger-text"
                @click="revokePeer(peer.peerId)"
              >
                {{ t('gallery.revoke') }}
              </button>
            </div>
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
          @keydown.enter.prevent="saveTagAndAlbum"
        ></label><p class="muted">{{ t('gallery.tagPrivacy') }}</p><div class="dialog-actions">
          <button
            class="secondary-button"
            @click="selectedAsset = null"
          >
            {{ t('gallery.cancel') }}
          </button><button
            class="primary-button small-primary"
            :disabled="!tagInput.trim()"
            @click="saveTagAndAlbum"
          >
            {{ t('gallery.saveTag') }}
          </button>
        </div>
      </section>
    </div>
  </div>
</template>
