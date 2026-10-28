const maxAlbumTitleUtf8Bytes = 256;
const maxCursorBytes = 2048;

export type AlbumCursorScope =
  | { collection: 'albums'; libraryId: string }
  | { collection: 'members'; libraryId: string; albumId: string }
  | { collection: 'deleted'; libraryId: string; scope: 'all' | 'local' | 'global' };

export class InvalidAlbumCursorError extends Error {
  constructor() {
    super('invalid album cursor');
    this.name = 'InvalidAlbumCursorError';
  }
}

export function normalizeAlbumTitle(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const title = value.trim();
  const bytes = Buffer.byteLength(title, 'utf8');
  return bytes >= 1 && bytes <= maxAlbumTitleUtf8Bytes ? title : undefined;
}

export function encodeAlbumCursor(scope: AlbumCursorScope, lastId: string): string {
  if (!isValidScope(scope) || !isValidIdentifier(lastId)) throw new InvalidAlbumCursorError();
  const cursor = {
    version: 1,
    collection: scope.collection,
    libraryId: scope.libraryId,
    ...(scope.collection === 'members' ? { albumId: scope.albumId } : {}),
    ...(scope.collection === 'deleted' ? { scope: scope.scope } : {}),
    lastId
  };
  const token = Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
  if (token.length > maxCursorBytes) throw new InvalidAlbumCursorError();
  return token;
}

export function decodeAlbumCursor(token: string, expectedScope: AlbumCursorScope): string {
  if (token.length < 1 || token.length > maxCursorBytes || !/^[A-Za-z0-9_-]+$/.test(token) || !isValidScope(expectedScope)) {
    throw new InvalidAlbumCursorError();
  }
  try {
    const decoded = Buffer.from(token, 'base64url').toString('utf8');
    if (Buffer.from(decoded, 'utf8').toString('base64url') !== token) throw new InvalidAlbumCursorError();
    const value: unknown = JSON.parse(decoded);
    if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new InvalidAlbumCursorError();
    const candidate = value as Record<string, unknown>;
    const expectedKeys = expectedScope.collection === 'members'
      ? ['version', 'collection', 'libraryId', 'albumId', 'lastId']
      : expectedScope.collection === 'deleted'
        ? ['version', 'collection', 'libraryId', 'scope', 'lastId']
        : ['version', 'collection', 'libraryId', 'lastId'];
    if (Object.keys(candidate).length !== expectedKeys.length || expectedKeys.some((key) => !Object.hasOwn(candidate, key))) {
      throw new InvalidAlbumCursorError();
    }
    if (candidate.version !== 1 || candidate.collection !== expectedScope.collection ||
      candidate.libraryId !== expectedScope.libraryId ||
      (expectedScope.collection === 'members' && candidate.albumId !== expectedScope.albumId) ||
      (expectedScope.collection === 'deleted' && candidate.scope !== expectedScope.scope) ||
      typeof candidate.lastId !== 'string' || !isValidIdentifier(candidate.lastId)) {
      throw new InvalidAlbumCursorError();
    }
    return candidate.lastId;
  } catch (error) {
    if (error instanceof InvalidAlbumCursorError) throw error;
    throw new InvalidAlbumCursorError();
  }
}

function isValidScope(scope: AlbumCursorScope): boolean {
  return isValidIdentifier(scope.libraryId) &&
    (scope.collection === 'albums' || scope.collection === 'members' && isValidIdentifier(scope.albumId) ||
     scope.collection === 'deleted' && ['all', 'local', 'global'].includes(scope.scope));
}

function isValidIdentifier(value: string): boolean {
  return value.length > 0 && value.length <= 128 && !/[\\/\0]/.test(value);
}
