import { Entry } from '@napi-rs/keyring';
import { constants, mkdirSync, openSync, readFileSync, renameSync, closeSync, writeFileSync, fsyncSync, chmodSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

export interface SecretStore {
  get(secretName: string): string | undefined;
  set(secretName: string, value: string): void;
}

interface KeyringEntry {
  getPassword(): string | null;
  setPassword(value: string): void;
}

export const systemSecretStoreService = 'PhotoMesh.NodeAgent';

/** Uses Windows Credential Manager or Linux Secret Service. Linux does not fall back to kernel memory. */
export class SystemSecretStore implements SecretStore {
  constructor(private readonly createEntry: (service: string, secretName: string) => KeyringEntry =
    (service, secretName) => new Entry(service, secretName, { linux: { store: 'secret-service' } })) {}

  get(secretName: string): string | undefined {
    try {
      return this.entry(secretName).getPassword() ?? undefined;
    } catch (error) {
      throw new Error('platform secure storage is unavailable', { cause: error });
    }
  }

  set(secretName: string, value: string): void {
    try {
      const entry = this.entry(secretName);
      entry.setPassword(value);
      if (entry.getPassword() !== value) throw new Error('credential write could not be verified');
    } catch (error) {
      throw new Error('platform secure storage is unavailable', { cause: error });
    }
  }

  private entry(secretName: string): KeyringEntry {
    return this.createEntry(systemSecretStoreService, secretName);
  }
}

/** Persistent permission-restricted secret files for isolated Docker integration fixtures only. */
export class FixtureFileSecretStore implements SecretStore {
  private readonly directory: string;

  constructor(directory: string) {
    this.directory = resolve(directory);
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    chmodSync(this.directory, 0o700);
  }

  get(secretName: string): string | undefined {
    const path = this.pathFor(secretName);
    try {
      const descriptor = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      try { return readFileSync(descriptor, 'utf8'); } finally { closeSync(descriptor); }
    } catch (error) {
      if (isCode(error, 'ENOENT')) return undefined;
      throw new Error('fixture secret store is unavailable', { cause: error });
    }
  }

  set(secretName: string, value: string): void {
    const path = this.pathFor(secretName);
    const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
    try {
      const descriptor = openSync(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
      try { writeFileSync(descriptor, value, 'utf8'); fsyncSync(descriptor); } finally { closeSync(descriptor); }
      renameSync(temporary, path);
      chmodSync(path, 0o600);
    } catch (error) {
      try { rmSync(temporary, { force: true }); } catch { /* Any abandoned file remains mode 0600 inside the fixture secret directory. */ }
      throw new Error('fixture secret store is unavailable', { cause: error });
    }
  }

  private pathFor(secretName: string): string {
    if (!/^[a-z0-9-]{1,80}$/i.test(secretName)) throw new Error('invalid fixture secret name');
    return join(this.directory, `${secretName}.secret`);
  }
}

function isCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code;
}
