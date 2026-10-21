import { Entry } from '@napi-rs/keyring';

export interface SecretStore {
  get(secretName: string): string | undefined;
  set(secretName: string, value: string): void;
}

interface KeyringEntry {
  getPassword(): string | null;
  setPassword(value: string): void;
}

/** Uses Windows Credential Manager or Linux Secret Service. Linux does not fall back to kernel memory. */
export class SystemSecretStore implements SecretStore {
  private readonly service = 'PhotoMesh.NodeAgent';

  constructor(private readonly createEntry: (service: string, secretName: string) => KeyringEntry =
    (service, secretName) => new Entry(service, secretName, { linux: { store: 'secret-service' } })) {}

  get(secretName: string): string | undefined {
    try {
      return this.entry(secretName).getPassword() ?? undefined;
    } catch {
      throw new Error('platform secure storage is unavailable');
    }
  }

  set(secretName: string, value: string): void {
    try {
      this.entry(secretName).setPassword(value);
    } catch {
      throw new Error('platform secure storage is unavailable');
    }
  }

  private entry(secretName: string): KeyringEntry {
    return this.createEntry(this.service, secretName);
  }
}
