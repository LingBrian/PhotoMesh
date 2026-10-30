export type InstallerScenario = 'clean-install' | 'upgrade' | 'uninstall' | 'port-conflict';
export type InstallerDecision = { allowed: boolean; preserveUserData: boolean; mutateFirewall: false; reason: 'ready' | 'data-preserved' | 'port-in-use' };

/** Dry-run safety policy for the Windows packaging smoke tests; performs no OS operations. */
export function evaluateInstallerScenario(input: { scenario: InstallerScenario; dataDirectoryExists: boolean; portAvailable: boolean }): InstallerDecision {
  if (input.scenario === 'port-conflict' || !input.portAvailable) return { allowed: false, preserveUserData: true, mutateFirewall: false, reason: 'port-in-use' };
  if (input.scenario === 'uninstall') return { allowed: true, preserveUserData: true, mutateFirewall: false, reason: 'data-preserved' };
  if (input.scenario === 'upgrade' && input.dataDirectoryExists) return { allowed: true, preserveUserData: true, mutateFirewall: false, reason: 'data-preserved' };
  return { allowed: true, preserveUserData: true, mutateFirewall: false, reason: 'ready' };
}
