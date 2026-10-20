import { createServer } from 'node:http';
import { getHealth } from './health.js';

export function createNodeAgentServer() {
  return createServer((request, response) => {
    if (request.method === 'GET' && request.url === '/v1/health') {
      response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify(getHealth()));
      return;
    }
    response.writeHead(404, { 'content-type': 'application/json; charset=utf-8' });
    response.end(JSON.stringify({ error: 'not_found' }));
  });
}
