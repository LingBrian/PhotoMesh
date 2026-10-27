import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FixtureFileSecretStore, SystemSecretStore } from '../src/auth/key-store.js';

const directories: string[] = [];
afterEach(() => directories.splice(0).forEach((directory) => rmSync(directory, { recursive: true, force: true })));

describe('fixture and system secret stores', () => {
  it('keeps fixture identity material in a permission-restricted file across store instances', () => {
    const directory = mkdtempSync(join(tmpdir(), 'photomesh-secrets-'));
    directories.push(directory);
    const first = new FixtureFileSecretStore(directory);
    expect(first.get('node-identity-ed25519-v1')).toBeUndefined();
    first.set('node-identity-ed25519-v1', 'private-key-test-only');
    expect(new FixtureFileSecretStore(directory).get('node-identity-ed25519-v1')).toBe('private-key-test-only');
    if (process.platform !== 'win32') expect(statSync(join(directory, 'node-identity-ed25519-v1.secret')).mode & 0o777).toBe(0o600);
    expect(readFileSync(join(directory, 'node-identity-ed25519-v1.secret'), 'utf8')).toBe('private-key-test-only');
    expect(() => first.get('../escape')).toThrow('invalid fixture secret name');
  });

  it('does not silently fall back when the OS secret store is unavailable', () => {
    const store = new SystemSecretStore(() => ({
      getPassword: () => { throw new Error('keychain offline'); },
      setPassword: () => { throw new Error('keychain offline'); }
    }));
    expect(() => store.get('identity')).toThrow('platform secure storage is unavailable');
    expect(() => store.set('identity', 'secret')).toThrow('platform secure storage is unavailable');
  });

  it('fails closed if a stored credential cannot be read back after writing', () => {
    const store = new SystemSecretStore(() => ({
      getPassword: () => null,
      setPassword: () => undefined
    }));
    expect(() => store.set('identity', 'private-key-test-only'))
      .toThrow('platform secure storage is unavailable');
  });

  it('normalizes access-denied failures without exposing native details', () => {
    const store = new SystemSecretStore(() => ({
      getPassword: () => { throw new Error('ERROR_ACCESS_DENIED: sample detail'); },
      setPassword: () => { throw new Error('ERROR_ACCESS_DENIED: sample detail'); }
    }));
    expect(() => store.get('identity')).toThrow('platform secure storage is unavailable');
    expect(() => store.set('identity', 'private-key-test-only')).toThrow('platform secure storage is unavailable');
  });
});
