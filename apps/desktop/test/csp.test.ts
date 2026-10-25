import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const config = JSON.parse(readFileSync(new URL('../src-tauri/tauri.conf.json', import.meta.url), 'utf8')) as {
  app: { security: { csp: string } };
};

function directive(name: string): string {
  const match = config.app.security.csp.split(';').map((value) => value.trim()).find((value) => value.startsWith(`${name} `));
  if (!match) throw new Error(`Missing CSP directive: ${name}`);
  return match;
}

describe('packaged desktop content security policy', () => {
  it('allows only loopback Node API connections on configurable ports', () => {
    const connect = directive('connect-src');
    expect(connect).toContain("'self'");
    expect(connect).toContain('http://127.0.0.1:*');
    expect(connect).toContain('http://localhost:*');
    expect(connect).toContain('http://[::1]:*');
    expect(connect).not.toMatch(/(?:^|\s)https?:\/\/\*(?::|\s|$)/);
    expect(connect).not.toMatch(/(?:^|\s)https?:\s*(?:;|$)/);
  });

  it('allows object URLs for generated previews without allowing arbitrary images', () => {
    const images = directive('img-src');
    expect(images).toContain('blob:');
    expect(images).toContain('data:');
    expect(images).not.toMatch(/(?:^|\s)https?:\/\/\*(?::|\s|$)/);
  });
});
