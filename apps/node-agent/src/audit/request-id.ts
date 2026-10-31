import { randomUUID } from 'node:crypto';

export const requestIdPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}(?![\s\S])/;

export function resolveRequestId(rawHeaders: readonly string[], fallback: () => string = randomUUID): string {
  let headerCount = 0;
  let candidate: string | undefined;
  for (let index = 0; index + 1 < rawHeaders.length; index += 2) {
    if (rawHeaders[index]?.toLowerCase() === 'x-request-id') {
      headerCount += 1;
      candidate = rawHeaders[index + 1];
    }
  }
  if (headerCount === 1 && candidate !== undefined && requestIdPattern.test(candidate)) return candidate;
  return fallback();
}
