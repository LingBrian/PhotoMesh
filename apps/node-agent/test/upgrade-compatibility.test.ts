import { describe, expect, it } from 'vitest';
import { checkUpgrade } from '../src/upgrade-compatibility.js';

describe('upgrade compatibility gate', () => {
  it('allows a forward upgrade only after backup verification', () => {
    expect(checkUpgrade({ currentVersion: '1.2.0', targetVersion: '1.3.0', currentSchema: 4, targetSchema: 5, backupVerified: false })).toEqual({ allowed: false, reason: 'backup_required' });
    expect(checkUpgrade({ currentVersion: '1.2.0', targetVersion: '1.3.0', currentSchema: 4, targetSchema: 5, backupVerified: true })).toEqual({ allowed: true, reason: 'ready' });
  });
  it('rejects malformed versions and blocks a downgrade even when schema matches', () => {
    expect(checkUpgrade({ currentVersion: 'dev', targetVersion: '1.0.0', currentSchema: 1, targetSchema: 1, backupVerified: true })).toEqual({ allowed: false, reason: 'invalid_version' });
    expect(checkUpgrade({ currentVersion: '1.3.0', targetVersion: '1.2.0', currentSchema: 5, targetSchema: 5, backupVerified: true })).toEqual({ allowed: false, reason: 'downgrade_blocked' });
  });
  it('blocks incompatible and same-version downgrades', () => {
    expect(checkUpgrade({ currentVersion: '1.3.0', targetVersion: '1.2.0', currentSchema: 5, targetSchema: 4, backupVerified: true })).toEqual({ allowed: false, reason: 'incompatible_downgrade' });
    expect(checkUpgrade({ currentVersion: '1.3.0', targetVersion: '1.3.0', currentSchema: 5, targetSchema: 5, backupVerified: true })).toEqual({ allowed: false, reason: 'downgrade_blocked' });
  });
});
