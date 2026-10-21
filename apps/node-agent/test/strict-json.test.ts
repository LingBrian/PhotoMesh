import { describe, expect, it } from 'vitest';
import { parseJsonWithoutDuplicateKeys } from '../src/auth/strict-json.js';

describe('strict JSON protocol frames', () => {
  it('parses nested JSON and keeps escaped key contents distinct', () => {
    expect(parseJsonWithoutDuplicateKeys(String.raw`{"event":{"key":"value","escaped":"\"}"}}`))
      .toEqual({ event: { key: 'value', escaped: '"}' } });
  });

  it('accepts empty containers and rejects unterminated or invalid strings', () => {
    expect(parseJsonWithoutDuplicateKeys('{"empty":{},"list":[]}')).toEqual({ empty: {}, list: [] });
    expect(() => parseJsonWithoutDuplicateKeys('{"value":"unterminated}')).toThrow('unterminated');
    expect(() => parseJsonWithoutDuplicateKeys('{"value":"bad\\q"}')).toThrow();
    expect(() => parseJsonWithoutDuplicateKeys('{"value":"line\nfeed"}')).toThrow('invalid JSON string');
  });

  it('rejects duplicate keys at every object depth and malformed JSON', () => {
    expect(() => parseJsonWithoutDuplicateKeys('{"libraryId":"public","libraryId":"private"}')).toThrow('duplicate');
    expect(() => parseJsonWithoutDuplicateKeys('{"event":{"id":1,"id":2}}')).toThrow('duplicate');
    expect(() => parseJsonWithoutDuplicateKeys('{"event": [1,]}')).toThrow();
  });
});
