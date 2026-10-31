import { spawnSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { SystemSecretStore, systemSecretStoreService } from '../../apps/node-agent/dist/auth/key-store.js';

const require = createRequire(new URL('../../apps/node-agent/package.json', import.meta.url));
const { Entry } = require('@napi-rs/keyring');
const [mode, operation] = process.argv.slice(2);
const secretName = process.env.PM037_TEST_SECRET_NAME;
const secretValue = process.env.PM037_TEST_SECRET_VALUE;

function runProbe(probeOperation, env) {
  const result = spawnSync(process.execPath, [fileURLToPath(import.meta.url), 'probe', probeOperation], {
    env,
    stdio: 'ignore'
  });
  if (result.error || result.status !== 0) throw new Error('credential-store probe failed');
}

if (mode === 'probe') {
  try {
    if (!/^pm037-smoke-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(secretName ?? '')) {
      throw new Error('invalid temporary probe name');
    }
    if (!/^[A-Za-z0-9_-]{43}$/.test(secretValue ?? '')) throw new Error('invalid temporary probe value');
    if (operation === 'write') {
      const store = new SystemSecretStore();
      if (store.get(secretName) !== undefined) throw new Error('unexpected test credential collision');
      store.set(secretName, secretValue);
    } else if (operation === 'read') {
      if (new SystemSecretStore().get(secretName) !== secretValue) throw new Error('credential readback mismatch');
    } else if (operation === 'delete') {
      new Entry(systemSecretStoreService, secretName).deletePassword();
    } else {
      throw new Error('unsupported probe operation');
    }
  } catch {
    process.exitCode = 1;
  }
} else {
  if (process.platform !== 'win32') {
    process.stderr.write('This smoke test requires Windows Credential Manager.\n');
    process.exitCode = 2;
  } else {
    const env = {
      ...process.env,
      PM037_TEST_SECRET_NAME: `pm037-smoke-${randomUUID()}`,
      PM037_TEST_SECRET_VALUE: randomBytes(32).toString('base64url')
    };
    try {
      runProbe('write', env);
      runProbe('read', env);
      if (process.argv.includes('--pause-for-unlock')) {
        if (!process.stdin.isTTY) throw new Error('unlock check requires an interactive terminal');
        process.stdout.write('Credential stored. Lock with Win+L, unlock as the same Windows user, then press Enter here.\n');
        await new Promise((resolve) => process.stdin.once('data', resolve));
        runProbe('read', env);
      }
      process.stdout.write('Windows Credential Manager cross-process persistence check passed; no secret values were printed.\n');
    } catch {
      process.stderr.write('Windows Credential Manager smoke test failed or was unavailable; no secret values were printed.\n');
      process.exitCode = 1;
    } finally {
      try { runProbe('delete', env); }
      catch {
        process.stderr.write(`Cleanup failed for ${systemSecretStoreService}/${env.PM037_TEST_SECRET_NAME}; remove that temporary entry from Windows Credential Manager.\n`);
        process.exitCode = 1;
      }
    }
  }
}
