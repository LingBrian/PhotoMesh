import { createApp } from 'vue';
import App from './App.vue';
import './style.css';
import { createI18n } from 'vue-i18n';
import zhCN from '@photomesh/i18n/locales/zh-CN.json';
import en from '@photomesh/i18n/locales/en.json';

const locale = navigator.language.toLowerCase().startsWith('zh') ? 'zh-CN' : 'en';
createApp(App)
  .use(createI18n({ legacy: false, locale, fallbackLocale: 'en', messages: { 'zh-CN': zhCN, en } }))
  .mount('#app');
