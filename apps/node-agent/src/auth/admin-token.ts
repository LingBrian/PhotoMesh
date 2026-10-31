import { timingSafeEqual } from 'node:crypto';

export function createAdminTokenAuthorizer(configuredToken: string | undefined): (providedToken: string | undefined) => boolean {
  return (providedToken) => {
    if (!configuredToken || !providedToken) return false;
    const expected = Buffer.from(configuredToken, 'utf8');
    const provided = Buffer.from(providedToken, 'utf8');
    return expected.byteLength === provided.byteLength && timingSafeEqual(expected, provided);
  };
}
