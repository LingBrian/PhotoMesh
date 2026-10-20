<script setup lang="ts">
import { useI18n } from 'vue-i18n';

const { t } = useI18n();
</script>

<template>
  <main>
    <p class="eyebrow">{{ t('home.eyebrow') }}</p>
    <h1>{{ t('home.title') }}</h1>
    <p>
      {{ t('home.description') }}
    </p>
  </main>
</template>
