const insecureEndpointError = 'INSECURE_API_ENDPOINT';

/**
 * Normalize a node API base URL and prevent bearer credentials from being sent
 * over plaintext HTTP to a non-loopback host.
 */
export function normalizeApiBase(endpoint: string): string {
  let url: URL;
  try {
    url = new URL(endpoint.trim());
  } catch {
    throw new Error(insecureEndpointError);
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(insecureEndpointError);
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error(insecureEndpointError);
  }

  const host = url.hostname.toLowerCase();
  const isLoopback = host === 'localhost' || host === '[::1]' || /^127(?:\.\d{1,3}){3}$/.test(host);
  if (url.protocol === 'http:' && !isLoopback) {
    throw new Error(insecureEndpointError);
  }

  return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
}

export function isInsecureApiEndpointError(cause: unknown): boolean {
  return cause instanceof Error && cause.message === insecureEndpointError;
}
