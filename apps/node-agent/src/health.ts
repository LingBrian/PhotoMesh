export interface HealthResponse {
  status: 'degraded';
  protocolMin: number;
  protocolMax: number;
  capabilities: string[];
}

export type DiagnosticStatus = 'ok' | 'degraded' | 'unavailable';
export type DiagnosticComponentStatus = 'ok' | 'degraded' | 'unavailable';
export type DiagnosticReadiness = 'ready' | 'not_ready';
export type DiagnosticCapability =
  | 'rest'
  | 'mediaVersions'
  | 'thumbnails'
  | 'assetTags'
  | 'virtualAlbums'
  | 'assetFavorites'
  | 'favoriteSync'
  | 'assetRatings'
  | 'ratingSync'
  | 'tagSync'
  | 'sqlite'
  | 'managedFiles'
  | 'nodeIdentity'
  | 'eventSigning'
  | 'lanPairing';

export interface HealthComponent {
  status: DiagnosticComponentStatus;
  capabilities: DiagnosticCapability[];
}

export interface HealthDiagnostics {
  status: DiagnosticStatus;
  readiness: DiagnosticReadiness;
  components: {
    api: HealthComponent;
    database: HealthComponent;
    storage: HealthComponent;
    identity: HealthComponent;
  };
}

export interface HealthDiagnosticsSource {
  checkDatabase: () => void | Promise<void>;
  checkStorage: () => void | Promise<void>;
  apiCapabilities: () => readonly DiagnosticCapability[];
  storageCapabilities: () => readonly DiagnosticCapability[];
  identityCapabilities: () => readonly DiagnosticCapability[];
}

const knownCapabilities = new Set<DiagnosticCapability>([
  'rest', 'mediaVersions', 'thumbnails', 'assetTags', 'virtualAlbums', 'assetFavorites', 'favoriteSync', 'assetRatings', 'ratingSync', 'tagSync', 'sqlite', 'managedFiles', 'nodeIdentity', 'eventSigning', 'lanPairing'
]);

export function getHealth(capabilities: readonly string[] = []): HealthResponse {
  return { status: 'degraded', protocolMin: 0, protocolMax: 0, capabilities: [...capabilities] };
}

export async function getDiagnostics(source: HealthDiagnosticsSource): Promise<HealthDiagnostics> {
  const [databaseReady, storageReady] = await Promise.all([
    checkAvailable(source.checkDatabase),
    checkAvailable(source.checkStorage)
  ]);
  const apiCapabilities = normalizeCapabilities(source.apiCapabilities);
  const storageCapabilities = normalizeCapabilities(source.storageCapabilities);
  const identityCapabilities = normalizeCapabilities(source.identityCapabilities);
  const coreReady = databaseReady && storageReady;
  const identityReady = identityCapabilities.includes('nodeIdentity') && identityCapabilities.includes('eventSigning');
  const identityStatus: DiagnosticComponentStatus = identityReady ? 'ok' : identityCapabilities.length ? 'degraded' : 'unavailable';
  const status: DiagnosticStatus = !coreReady ? 'unavailable' : identityReady ? 'ok' : 'degraded';

  return {
    status,
    readiness: coreReady ? 'ready' : 'not_ready',
    components: {
      api: { status: 'ok', capabilities: apiCapabilities },
      database: { status: databaseReady ? 'ok' : 'unavailable', capabilities: ['sqlite'] },
      storage: { status: storageReady ? 'ok' : 'unavailable', capabilities: storageCapabilities },
      identity: { status: identityStatus, capabilities: identityCapabilities }
    }
  };
}

async function checkAvailable(check: () => void | Promise<void>): Promise<boolean> {
  try {
    await check();
    return true;
  } catch {
    return false;
  }
}

function normalizeCapabilities(read: () => readonly DiagnosticCapability[]): DiagnosticCapability[] {
  try {
    const values = read();
    if (!Array.isArray(values)) return [];
    return [...new Set(values.filter((value): value is DiagnosticCapability => knownCapabilities.has(value)))];
  } catch {
    return [];
  }
}
