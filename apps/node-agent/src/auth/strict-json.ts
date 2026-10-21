/** Parse a protocol frame while rejecting duplicate object keys before JSON.parse can collapse them. */
export function parseJsonWithoutDuplicateKeys(text: string): unknown {
  let cursor = 0;
  const whitespace = (): void => { while (/\s/.test(text[cursor] ?? '') && cursor < text.length) cursor += 1; };
  const stringToken = (): string => {
    if (text[cursor] !== '"') throw new Error('invalid JSON string');
    const start = cursor++;
    while (cursor < text.length) {
      const character = text[cursor++];
      if (character === '"') return text.slice(start, cursor);
      if (character === '\\') cursor += 1;
      else if (character !== undefined && character.charCodeAt(0) < 0x20) throw new Error('invalid JSON string');
    }
    throw new Error('unterminated JSON string');
  };
  const value = (): void => {
    whitespace();
    const current = text[cursor];
    if (current === '"') { stringToken(); return; }
    if (current === '{') {
      cursor += 1;
      whitespace();
      const keys = new Set<string>();
      if (text[cursor] === '}') { cursor += 1; return; }
      while (cursor < text.length) {
        whitespace();
        const key = JSON.parse(stringToken()) as string;
        if (keys.has(key)) throw new Error('duplicate JSON object key');
        keys.add(key);
        whitespace();
        if (text[cursor++] !== ':') throw new Error('invalid JSON object');
        value();
        whitespace();
        const separator = text[cursor++];
        if (separator === '}') return;
        if (separator !== ',') throw new Error('invalid JSON object');
      }
      throw new Error('unterminated JSON object');
    }
    if (current === '[') {
      cursor += 1;
      whitespace();
      if (text[cursor] === ']') { cursor += 1; return; }
      while (cursor < text.length) {
        value();
        whitespace();
        const separator = text[cursor++];
        if (separator === ']') return;
        if (separator !== ',') throw new Error('invalid JSON array');
      }
      throw new Error('unterminated JSON array');
    }
    const remaining = text.slice(cursor);
    const primitive = /^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(remaining)?.[0];
    if (!primitive) throw new Error('invalid JSON value');
    cursor += primitive.length;
  };
  value();
  whitespace();
  if (cursor !== text.length) throw new Error('trailing JSON data');
  return JSON.parse(text) as unknown;
}
