import { describe, expect, it } from 'vitest';
import { projectTagSet, validateTagOperationPayload, type TagOperation } from '../src/sync/tag-orset.js';

const add = (eventId: string, tag: string): TagOperation => ({ kind: 'add', eventId, tag });
const remove = (eventId: string, tag: string, observedAddEventIds: string[]): TagOperation => ({
  kind: 'remove', eventId, tag, observedAddEventIds
});

const addA = '11111111-1111-4111-8111-111111111111';
const addB = '22222222-2222-4222-8222-222222222222';
const removeA = '33333333-3333-4333-8333-333333333333';
const addAgain = '44444444-4444-4444-8444-444444444444';


describe('tag observed-remove set', () => {
  it('preserves concurrent adds and removes only the observed add operation', () => {
    expect(projectTagSet([add(addA, 'Summer'), add(addB, 'Summer'), remove(removeA, 'Summer', [addA])]))
      .toEqual(['Summer']);
    expect(projectTagSet([add(addA, 'Summer'), add(addB, 'Summer'), remove(removeA, 'Summer', [addA, addB])]))
      .toEqual([]);
  });

  it('supports remove followed by a new add without reviving removed operations', () => {
    expect(projectTagSet([add(addA, 'Summer'), remove(removeA, 'Summer', [addA]), add(addAgain, 'Summer')]))
      .toEqual(['Summer']);
    expect(projectTagSet([add(addA, 'Summer'), remove(removeA, 'Summer', [addA])]))
      .toEqual([]);
  });

  it('is independent of delivery order and duplicate delivery', () => {
    const operations = [add(addA, 'Summer'), add(addB, 'summer'), remove(removeA, 'Summer', [addA])];
    const expected = ['summer'];
    expect(projectTagSet(operations)).toEqual(expected);
    expect(projectTagSet([...operations].reverse())).toEqual(expected);
    expect(projectTagSet([...operations, ...operations])).toEqual(expected);
  });

  it('keeps tag identity case-sensitive and returns deterministic binary order', () => {
    expect(projectTagSet([add(addA, 'summer'), add(addB, 'Summer'), add(addAgain, '旅行')]))
      .toEqual(['Summer', 'summer', '旅行']);
  });

  it('preserves a converged union larger than the per-writer limit', () => {
    const operations = Array.from({ length: 65 }, (_, index) => add(
      `${String(index + 1).padStart(8, '0')}-1111-4111-8111-111111111111`, `tag-${index}`
    ));
    expect(projectTagSet(operations)).toHaveLength(65);
  });

  it('supports the approved 4096-tag merged-set boundary', () => {
    const operations = Array.from({ length: 4096 }, (_, index) => add(
      `${(index + 1).toString(16).padStart(8, '0')}-1111-4111-8111-111111111111`, `tag-${index}`
    ));
    expect(projectTagSet(operations)).toHaveLength(4096);
  });
});

describe('tag operation payload validation', () => {
  it('accepts valid add and observed-remove payloads without rewriting tag text', () => {
    expect(validateTagOperationPayload('asset.tag.added', { assetId: 'asset-1', tag: 'Summer' }))
      .toEqual({ assetId: 'asset-1', tag: 'Summer' });
    expect(validateTagOperationPayload('asset.tag.removed', { assetId: 'asset-1', tag: 'Summer', observedAddEventIds: [addA] }))
      .toEqual({ assetId: 'asset-1', tag: 'Summer', observedAddEventIds: [addA] });
    expect(validateTagOperationPayload('asset.tag.added', { assetId: 'asset-1', tag: '旅行' })).toMatchObject({ tag: '旅行' });
  });

  it.each([
    ['empty tag', { assetId: 'asset-1', tag: '   ' }],
    ['untrimmed tag', { assetId: 'asset-1', tag: ' Summer ' }],
    ['overlong UTF-8 tag', { assetId: 'asset-1', tag: '界'.repeat(43) }],
    ['embedded NUL', { assetId: 'asset-1', tag: 'Su\0mmer' }],
    ['missing asset id', { tag: 'Summer' }]
  ])('rejects %s add payloads', (_caseName, payload) => {
    expect(() => validateTagOperationPayload('asset.tag.added', payload)).toThrow();
  });

  it.each([
    ['empty observed set', []],
    ['duplicate event ids', [addA, addA]],
    ['invalid event id', ['not-a-uuid']],
    ['more than 64 observed ids', Array.from({ length: 65 }, (_, index) => `${String(index + 1).padStart(8, '0')}-1111-4111-8111-111111111111`)]
  ])('rejects %s remove payloads', (_caseName, observedAddEventIds) => {
    expect(() => validateTagOperationPayload('asset.tag.removed', { assetId: 'asset-1', tag: 'Summer', observedAddEventIds }))
      .toThrow();
  });
});
