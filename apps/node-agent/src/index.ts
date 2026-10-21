import { mkdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import Database from 'better-sqlite3';
import { SqliteRepository } from './db/repository.js';
import { createNodeAgentServer } from './server.js';
import { NodeUploadFileSystem } from './uploads/file-system.js';
import { UploadService } from './uploads/service.js';

const port = Number(process.env.PORT ?? 8443);
const dataDirectory = resolve(process.env.PHOTOMESH_DATA_DIR ?? './data');
await mkdir(dataDirectory, { recursive: true });
const databasePath = join(dataDirectory, 'photomesh.sqlite');
const database = new Database(databasePath);
const repository = new SqliteRepository(database, {
  backupBeforeMigration: async () => {
    await database.backup(`${databasePath}.backup-${new Date().toISOString().replaceAll(':', '-')}`);
  }
});
await repository.migrate();
const uploadService = new UploadService({
  repository,
  fileSystem: new NodeUploadFileSystem(join(dataDirectory, 'managed')),
  nodeId: process.env.PHOTOMESH_NODE_ID ?? 'local-node'
});
const server = createNodeAgentServer({ uploadService });
server.listen(port, '127.0.0.1', () => process.stdout.write(`PhotoMesh node-agent listening on 127.0.0.1:${port}\n`));
