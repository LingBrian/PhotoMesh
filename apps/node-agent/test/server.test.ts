import { afterEach, describe, expect, it } from 'vitest';
import { createNodeAgentServer } from '../src/server.js';

const servers: ReturnType<typeof createNodeAgentServer>[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  })));
});

async function request(path: string) {
  const server = createNodeAgentServer();
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Expected an ephemeral TCP address');
  return fetch(`http://127.0.0.1:${address.port}${path}`);
}

describe('node-agent health endpoint', () => {
  it('returns the health contract on loopback', async () => {
    const response = await request('/v1/health');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: 'degraded', protocolMin: 0, protocolMax: 0 });
  });

  it('returns a structured 404 for unknown paths', async () => {
    const response = await request('/private');
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'not_found' });
  });
});
