import { describe, expect, it, vi } from 'vitest';
import { getDiagnostics, getHealth, type DiagnosticCapability } from '../src/health.js';

describe('getHealth', () => {
  it('returns the negotiated protocol range and explicit capabilities', () => {
    expect(getHealth()).toEqual({ status: 'degraded', protocolMin: 0, protocolMax: 0, capabilities: [] });
    expect(getHealth(['mediaVersions'])).toEqual({
      status: 'degraded', protocolMin: 0, protocolMax: 0, capabilities: ['mediaVersions']
    });
  });
});

describe('getDiagnostics', () => {
  it('reports API, database, storage, and identity components separately', async () => {
    const checkDatabase = vi.fn(async () => undefined);
    const checkStorage = vi.fn(async () => undefined);
    const result = await getDiagnostics({
      checkDatabase,
      checkStorage,
      apiCapabilities: () => ['rest', 'mediaVersions'],
      storageCapabilities: () => ['managedFiles'],
      identityCapabilities: () => ['nodeIdentity', 'eventSigning']
    });

    expect(result).toEqual({
      status: 'ok',
      readiness: 'ready',
      components: {
        api: { status: 'ok', capabilities: ['rest', 'mediaVersions'] },
        database: { status: 'ok', capabilities: ['sqlite'] },
        storage: { status: 'ok', capabilities: ['managedFiles'] },
        identity: { status: 'ok', capabilities: ['nodeIdentity', 'eventSigning'] }
      }
    });
    expect(checkDatabase).toHaveBeenCalledOnce();
    expect(checkStorage).toHaveBeenCalledOnce();
  });

  it('fails readiness for database/storage failures and degrades when identity is unavailable', async () => {
    const sensitiveDiagnostic = 'C:\\\\Users\\\\private\\\\photos';
    const result = await getDiagnostics({
      checkDatabase: () => { throw new Error(sensitiveDiagnostic); },
      checkStorage: () => undefined,
      apiCapabilities: () => ['rest'],
      storageCapabilities: () => ['managedFiles'],
      identityCapabilities: () => []
    });

    expect(result).toEqual({
      status: 'unavailable',
      readiness: 'not_ready',
      components: {
        api: { status: 'ok', capabilities: ['rest'] },
        database: { status: 'unavailable', capabilities: ['sqlite'] },
        storage: { status: 'ok', capabilities: ['managedFiles'] },
        identity: { status: 'unavailable', capabilities: [] }
      }
    });
    expect(JSON.stringify(result)).not.toContain(sensitiveDiagnostic);

    const degraded = await getDiagnostics({
      checkDatabase: () => undefined,
      checkStorage: () => undefined,
      apiCapabilities: () => ['rest'],
      storageCapabilities: () => ['managedFiles'],
      identityCapabilities: () => []
    });
    expect(degraded).toMatchObject({ status: 'degraded', readiness: 'ready' });

    const partialIdentity = await getDiagnostics({
      checkDatabase: () => undefined,
      checkStorage: () => undefined,
      apiCapabilities: () => ['rest'],
      storageCapabilities: () => ['managedFiles'],
      identityCapabilities: () => ['nodeIdentity']
    });
    expect(partialIdentity).toMatchObject({
      status: 'degraded',
      readiness: 'ready',
      components: { identity: { status: 'degraded', capabilities: ['nodeIdentity'] } }
    });

    const storageUnavailable = await getDiagnostics({
      checkDatabase: () => undefined,
      checkStorage: () => { throw new Error(sensitiveDiagnostic); },
      apiCapabilities: () => ['rest'],
      storageCapabilities: () => ['managedFiles'],
      identityCapabilities: () => ['nodeIdentity', 'eventSigning']
    });
    expect(storageUnavailable).toMatchObject({
      status: 'unavailable',
      readiness: 'not_ready',
      components: { storage: { status: 'unavailable', capabilities: ['managedFiles'] } }
    });
    expect(JSON.stringify(storageUnavailable)).not.toContain(sensitiveDiagnostic);

    const unsafeCapabilities = await getDiagnostics({
      checkDatabase: () => undefined,
      checkStorage: () => undefined,
      apiCapabilities: () => ['rest', sensitiveDiagnostic] as unknown as DiagnosticCapability[],
      storageCapabilities: () => ['managedFiles'],
      identityCapabilities: () => ['nodeIdentity', 'eventSigning']
    });
    expect(unsafeCapabilities.components.api.capabilities).toEqual(['rest']);
    expect(JSON.stringify(unsafeCapabilities)).not.toContain(sensitiveDiagnostic);
  });
});
