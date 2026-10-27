export interface ShutdownHttpServer {
  close(callback: (error?: Error) => void): void;
}

export interface ShutdownStoppable {
  stop(): void | Promise<void>;
}

export interface NodeAgentShutdownOptions {
  server: ShutdownHttpServer;
  externalScan?: ShutdownStoppable;
  lanNode?: ShutdownStoppable;
  mediaVersionService?: ShutdownStoppable;
  uploadService?: ShutdownStoppable;
  closeDatabase: () => void;
}

export function createShutdownHandler(options: NodeAgentShutdownOptions): () => Promise<void> {
  let shutdownPromise: Promise<void> | undefined;
  return () => {
    shutdownPromise ??= shutdown(options);
    return shutdownPromise;
  };
}

async function shutdown(options: NodeAgentShutdownOptions): Promise<void> {
  let failed = false;
  const attempt = async (action: () => void | Promise<void>): Promise<void> => {
    try {
      await action();
    } catch {
      failed = true;
    }
  };
  const earlyStops: Promise<void>[] = [attempt(() => closeServer(options.server))];
  if (options.externalScan) earlyStops.push(attempt(() => options.externalScan!.stop()));
  if (options.lanNode) earlyStops.push(attempt(() => options.lanNode!.stop()));
  await Promise.all(earlyStops);
  if (options.mediaVersionService) await attempt(() => options.mediaVersionService!.stop());
  if (options.uploadService) await attempt(() => options.uploadService!.stop());
  await attempt(options.closeDatabase);
  if (failed) throw new Error('node-agent shutdown could not stop all resources safely');
}

function closeServer(server: ShutdownHttpServer): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (!error || (error as NodeJS.ErrnoException).code === 'ERR_SERVER_NOT_RUNNING') resolve();
      else reject(error);
    });
  });
}
