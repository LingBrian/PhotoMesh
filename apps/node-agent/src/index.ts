import { mkdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import Database from 'better-sqlite3';
import { SqliteRepository } from './db/repository.js';
import { createNodeAgentServer } from './server.js';
import { NodeUploadFileSystem } from './uploads/file-system.js';
import { UploadService } from './uploads/service.js';
import { ExternalScanService, type AuthorizedExternalRoot } from './media/external-scan.js';
import { NodeExternalFileSystem, NodeExternalWatcher } from './media/node-external-adapters.js';

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

const rootsJson = process.env.PHOTOMESH_EXTERNAL_ROOTS;
let externalScan: ExternalScanService | undefined;
if (rootsJson) {
  const roots = JSON.parse(rootsJson) as AuthorizedExternalRoot[];
  if (!Array.isArray(roots) || roots.some((root) => !root || typeof root.rootId !== 'string' || typeof root.libraryId !== 'string' ||
    typeof root.path !== 'string' || !['posix', 'win32'].includes(root.pathStyle))) {
    throw new Error('PHOTOMESH_EXTERNAL_ROOTS must be an array of explicitly authorized root objects');
  }
  externalScan = new ExternalScanService({
    nodeId: process.env.PHOTOMESH_NODE_ID ?? 'local-node', roots,
    fileSystem: new NodeExternalFileSystem(), repository, watcher: new NodeExternalWatcher()
  });
  void externalScan.start().then((results) => {
    const indexed = results.reduce((total, result) => total + result.indexed, 0);
    process.stdout.write(`External directory scan initialized (${results.length} roots, ${indexed} indexed paths)\n`);
  }).catch(() => process.stderr.write('External directory scan initialization failed; configured roots remain read-only\n'));
}

const shutdown = (): void => {
  externalScan?.stop();
  server.close(() => database.close());
};
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
