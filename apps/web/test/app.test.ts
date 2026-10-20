import { describe, expect, it } from 'vitest';
import zhCN from '@photomesh/i18n/locales/zh-CN.json';
import en from '@photomesh/i18n/locales/en.json';

describe('web scaffold', () => {
  it('provides Chinese and English home copy', () => {
    expect(zhCN.home.title).toBe('PhotoMesh');
    expect(en.home.title).toBe('PhotoMesh');
    expect(zhCN.home.description).not.toBe(en.home.description);
  });
});
