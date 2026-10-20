<script setup lang="ts">
import { useI18n } from 'vue-i18n';

const { t } = useI18n();
</script>

<template>
  <main>
    <p class="eyebrow">{{ t('home.title') }} Desktop</p>
    <h1>{{ t('home.desktopTitle') }}</h1>
    <p>
      {{ t('home.desktopDescription') }}
    </p>
  </main>
</template>
