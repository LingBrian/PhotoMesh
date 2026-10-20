import { describe, expect, it } from 'vitest';
import zhCN from '@photomesh/i18n/locales/zh-CN.json';
import en from '@photomesh/i18n/locales/en.json';

describe('desktop scaffold', () => {
  it('provides desktop copy in Chinese and English', () => {
    expect(zhCN.home.desktopTitle).toBeTruthy();
    expect(en.home.desktopTitle).toBeTruthy();
  });
});
