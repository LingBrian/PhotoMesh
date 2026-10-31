<script setup lang="ts">
import { useI18n } from 'vue-i18n';

export type BackupStatus = 'idle' | 'preparing' | 'running' | 'cancelling' | 'success' | 'failed' | 'cancelled';
export interface BackupStatusSnapshot { status: BackupStatus; bytesDone: number; bytesTotal: number; elapsedSeconds: number; result?: string | null; error?: string | null; }

defineProps<{ snapshot: BackupStatusSnapshot; canStart: boolean; canCancel: boolean }>();
const emit = defineEmits<{ start: []; cancel: [] }>();
const { t } = useI18n();
function formatBytes(value: number): string { if (value < 1024) return `${value} B`; if (value < 1024 ** 2) return `${(value / 1024).toFixed(1)} KB`; return `${(value / 1024 ** 2).toFixed(1)} MB`; }
function statusLabel(status: BackupStatus): string { return t(`gallery.backupStatus.${status}`); }
</script>

<template>
  <section class="settings-card backup-status-card" aria-labelledby="backup-status-title">
    <div class="settings-card-heading">
      <div><h2 id="backup-status-title">{{ t('gallery.backupTitle') }}</h2><p>{{ t('gallery.backupDescription') }}</p></div>
      <span class="connection-pill" :class="snapshot.status === 'success' ? 'online' : 'offline'">{{ statusLabel(snapshot.status) }}</span>
    </div>
    <div class="backup-status-grid" role="status" aria-live="polite">
      <span>{{ t('gallery.backupBytes') }}</span><strong>{{ formatBytes(snapshot.bytesDone) }} / {{ formatBytes(snapshot.bytesTotal) }}</strong>
      <span>{{ t('gallery.backupElapsed') }}</span><strong>{{ snapshot.elapsedSeconds }}s</strong>
      <span v-if="snapshot.result">{{ t('gallery.backupResult') }}</span><strong v-if="snapshot.result">{{ snapshot.result }}</strong>
      <span v-if="snapshot.error" class="error-text">{{ snapshot.error }}</span>
    </div>
    <p class="muted">{{ t('gallery.backupNoOverwrite') }}</p>
    <div class="pairing-actions">
      <button type="button" class="primary-button small-primary" :disabled="!canStart" @click="emit('start')">{{ t('gallery.backupStart') }}</button>
      <button type="button" class="secondary-button" :disabled="!canCancel" @click="emit('cancel')">{{ t('gallery.backupCancel') }}</button>
    </div>
  </section>
</template>
