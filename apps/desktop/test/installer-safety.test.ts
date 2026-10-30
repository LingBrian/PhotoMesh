import { describe, expect, it } from 'vitest';
import { evaluateInstallerScenario } from '../src/installer-safety.js';

describe('Windows installer safety policy', () => {
  it('preserves user data on upgrade and uninstall', () => {
    expect(evaluateInstallerScenario({ scenario: 'upgrade', dataDirectoryExists: true, portAvailable: true })).toMatchObject({ allowed: true, preserveUserData: true, mutateFirewall: false });
    expect(evaluateInstallerScenario({ scenario: 'uninstall', dataDirectoryExists: true, portAvailable: true })).toMatchObject({ allowed: true, preserveUserData: true, mutateFirewall: false });
  });
  it('fails closed on a conflicting port without opening firewall rules', () => {
    expect(evaluateInstallerScenario({ scenario: 'port-conflict', dataDirectoryExists: false, portAvailable: false })).toEqual({ allowed: false, preserveUserData: true, mutateFirewall: false, reason: 'port-in-use' });
    expect(evaluateInstallerScenario({ scenario: 'clean-install', dataDirectoryExists: false, portAvailable: false }).allowed).toBe(false);
  });
  it('allows a clean install as a dry-run decision only', () => {
    expect(evaluateInstallerScenario({ scenario: 'clean-install', dataDirectoryExists: false, portAvailable: true })).toEqual({ allowed: true, preserveUserData: true, mutateFirewall: false, reason: 'ready' });
  });
});
