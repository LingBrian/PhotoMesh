export type TagOperation =
  | { kind: 'add'; eventId: string; tag: string }
  | { kind: 'remove'; eventId: string; tag: string; observedAddEventIds: string[] };

export type TagOperationPayload =
  | { assetId: string; tag: string }
  | { assetId: string; tag: string; observedAddEventIds: string[] };

export const maxObservedTagAdds = 64;
const tagAddType = 'asset.tag.added';
const tagRemoveType = 'asset.tag.removed';
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Projects active, observed-remove tag operations without using wall-clock order. */
export function projectTagSet(operations: readonly TagOperation[]): string[] {
  const adds = new Map<string, string>();
  const removedAdds = new Set<string>();

  for (const operation of operations) {
    if (operation.kind !== 'add') continue;
    const existingTag = adds.get(operation.eventId);
    if (existingTag !== undefined && existingTag !== operation.tag) throw new Error('tag add event ID conflict');
    adds.set(operation.eventId, operation.tag);
  }

  for (const operation of operations) {
    if (operation.kind !== 'remove') continue;
    for (const addEventId of operation.observedAddEventIds) removedAdds.add(addKey(operation.tag, addEventId));
  }

  const activeTags = new Set<string>();
  for (const [eventId, tag] of adds) {
    if (!removedAdds.has(addKey(tag, eventId))) activeTags.add(tag);
  }
  return [...activeTags].sort((left, right) => Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8')));
}

/** Validates and returns the canonical payload for a signed tag operation. */
export function validateTagOperationPayload(eventType: string, payload: unknown): TagOperationPayload {
  if (!isRecord(payload)) throw new Error('invalid tag operation payload');
  const expectedKeys = eventType === tagAddType ? ['assetId', 'tag']
    : eventType === tagRemoveType ? ['assetId', 'tag', 'observedAddEventIds'] : undefined;
  if (!expectedKeys || Object.keys(payload).sort().join('\0') !== [...expectedKeys].sort().join('\0')) {
    throw new Error('invalid tag operation payload');
  }
  if (!isSafeId(payload.assetId, 128) || typeof payload.tag !== 'string' || !isCanonicalTag(payload.tag)) {
    throw new Error('invalid tag operation payload');
  }
  if (eventType === tagAddType) return { assetId: payload.assetId, tag: payload.tag };

  const observedAddEventIds = payload.observedAddEventIds;
  if (!Array.isArray(observedAddEventIds) || observedAddEventIds.length === 0 ||
      observedAddEventIds.length > maxObservedTagAdds ||
      observedAddEventIds.some((eventId) => typeof eventId !== 'string' || !uuidPattern.test(eventId)) ||
      new Set(observedAddEventIds).size !== observedAddEventIds.length ||
      observedAddEventIds.some((eventId, index) => index > 0 && observedAddEventIds[index - 1]! > eventId)) {
    throw new Error('invalid observed tag add IDs');
  }
  return { assetId: payload.assetId, tag: payload.tag, observedAddEventIds: [...observedAddEventIds] as string[] };
}

function isCanonicalTag(value: string): boolean {
  return value.length > 0 && value === value.trim() && !value.includes('\0') && Buffer.byteLength(value, 'utf8') <= 128;
}

function isSafeId(value: unknown, maxLength: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maxLength &&
    !Array.from(value).some((character) => character.charCodeAt(0) < 0x20);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function addKey(tag: string, eventId: string): string {
  return `${tag}\0${eventId}`;
}
