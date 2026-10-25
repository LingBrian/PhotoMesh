import { describe, expect, it } from 'vitest';
import zhCN from '@photomesh/i18n/locales/zh-CN.json';
import en from '@photomesh/i18n/locales/en.json';

function messagePaths(value: unknown, prefix = ''): string[] {
  if (typeof value !== 'object' || value === null) return [prefix];
  return Object.entries(value).flatMap(([key, child]) => messagePaths(child, prefix ? `${prefix}.${key}` : key)).sort();
}

describe('web scaffold', () => {
  it('provides Chinese and English home copy', () => {
    expect(zhCN.home.title).toBe('PhotoMesh');
    expect(en.home.title).toBe('PhotoMesh');
    expect(zhCN.home.description).not.toBe(en.home.description);
  });

  it('keeps gallery translation keys in sync for Chinese and English', () => {
    expect(messagePaths(zhCN.gallery)).toEqual(messagePaths(en.gallery));
  });
});
