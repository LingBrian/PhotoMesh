import { createNodeAgentServer } from './server.js';

const port = Number(process.env.PORT ?? 8443);
const server = createNodeAgentServer();
server.listen(port, '127.0.0.1', () => {
  process.stdout.write(`PhotoMesh node-agent placeholder listening on 127.0.0.1:${port}\n`);
});
