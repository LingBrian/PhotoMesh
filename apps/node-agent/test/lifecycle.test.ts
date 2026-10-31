import { createServer } from 'node:http';
import { describe, expect, it, vi } from 'vitest';
import { createShutdownHandler } from '../src/lifecycle.js';

describe('node-agent shutdown lifecycle', () => {
  it('stops request/listener resources before workers and closes SQLite last, idempotently', async () => {
    const events: string[] = [];
    let closeServer!: () => void;
    let finishScan!: () => void;
    const scanDrain = new Promise<void>((resolve) => { finishScan = resolve; });
    const server = {
      close: (callback: (error?: Error) => void) => {
        events.push('http:close');
        closeServer = () => { events.push('http:closed'); callback(); };
      }
    };
    const shutdown = createShutdownHandler({
      server,
      externalScan: { stop: () => { events.push('scan:stop'); return scanDrain.then(() => { events.push('scan:stopped'); }); } },
      lanNode: { stop: async () => { events.push('p2p:stop'); } },
      mediaVersionService: { stop: async () => { events.push('media:stop'); } },
      uploadService: { stop: async () => { events.push('uploads:stop'); } },
      closeDatabase: () => { events.push('db:close'); }
    });

    const first = shutdown();
    const second = shutdown();
    expect(second).toBe(first);
    expect(events).toContain('http:close');
    expect(events).toContain('scan:stop');
    expect(events).toContain('p2p:stop');
    expect(events).not.toContain('media:stop');
    expect(events).not.toContain('uploads:stop');
    expect(events).not.toContain('db:close');

    closeServer();
    await Promise.resolve();
    expect(events).not.toContain('media:stop');
    expect(events).not.toContain('db:close');
    finishScan();
    await first;
    expect(events.indexOf('http:closed')).toBeLessThan(events.indexOf('media:stop'));
    expect(events.indexOf('media:stop')).toBeLessThan(events.indexOf('uploads:stop'));
    expect(events.indexOf('uploads:stop')).toBeLessThan(events.indexOf('db:close'));
    expect(events.filter((event) => event === 'db:close')).toHaveLength(1);
  });

  it('releases an actual HTTP listening socket before closing the database', async () => {
    const server = createServer();
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const closeDatabase = vi.fn();

    await createShutdownHandler({ server, closeDatabase })();

    expect(server.listening).toBe(false);
    expect(closeDatabase).toHaveBeenCalledOnce();
  });

  it('treats an already-closed HTTP listener as stopped', async () => {
    const closeDatabase = vi.fn();
    const server = {
      close: (callback: (error?: Error) => void) => callback(Object.assign(new Error('not running'), { code: 'ERR_SERVER_NOT_RUNNING' }))
    };

    await createShutdownHandler({ server, closeDatabase })();

    expect(closeDatabase).toHaveBeenCalledOnce();
  });

  it('continues cleanup after an HTTP close error and reports only a generic error', async () => {
    const closeDatabase = vi.fn();
    const server = {
      close: (callback: (error?: Error) => void) => callback(Object.assign(new Error('socket detail'), { code: 'EIO' }))
    };

    await expect(createShutdownHandler({ server, closeDatabase })()).rejects
      .toThrow('node-agent shutdown could not stop all resources safely');
    expect(closeDatabase).toHaveBeenCalledOnce();
  });

  it('continues cleanup after a resource failure and reports only a generic error', async () => {
    const closeDatabase = vi.fn();
    const server = { close: (callback: (error?: Error) => void) => callback() };
    const shutdown = createShutdownHandler({
      server,
      externalScan: { stop: () => { throw new Error('D:\\private\\photos'); } },
      mediaVersionService: { stop: async () => { throw new Error('decoder details'); } },
      closeDatabase
    });

    await expect(shutdown()).rejects.toThrow('node-agent shutdown could not stop all resources safely');
    expect(closeDatabase).toHaveBeenCalledOnce();
    await expect(shutdown()).rejects.toThrow('node-agent shutdown could not stop all resources safely');
  });
});
