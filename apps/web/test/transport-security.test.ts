import { describe, expect, it } from 'vitest';
import { isInsecureApiEndpointError, normalizeApiBase } from '../src/transport-security';

describe('normalizeApiBase', () => {
  it('allows loopback HTTP for local development', () => {
    expect(normalizeApiBase('http://127.0.0.1:8443/')).toBe('http://127.0.0.1:8443');
    expect(normalizeApiBase('http://localhost:8443')).toBe('http://localhost:8443');
    expect(normalizeApiBase('http://[::1]:8443/')).toBe('http://[::1]:8443');
  });

  it('allows HTTPS endpoints and preserves a reverse-proxy base path', () => {
    expect(normalizeApiBase('https://node.example:8443/api/')).toBe('https://node.example:8443/api');
  });

  it('identifies the localized endpoint-security error', () => {
    let cause: unknown;
    try { normalizeApiBase('http://192.168.1.20:8443'); } catch (error) { cause = error; }
    expect(isInsecureApiEndpointError(cause)).toBe(true);
    expect(isInsecureApiEndpointError(new Error('other'))).toBe(false);
    expect(isInsecureApiEndpointError('INSECURE_API_ENDPOINT')).toBe(false);
  });

  it.each([
    'http://192.168.1.20:8443',
    'http://[fd00::1]:8443',
    'http://photos.example',
    'ftp://localhost:8443',
    'file:///etc/passwd',
    'http://user:password@localhost:8443',
    'https://node.example:8443?token=leaked',
    'https://node.example:8443#fragment',
    'not a URL',
  ])('rejects an insecure or invalid endpoint: %s', (endpoint) => {
    expect(() => normalizeApiBase(endpoint)).toThrow();
  });
});
