export interface HealthResponse {
  status: 'degraded';
  protocolMin: number;
  protocolMax: number;
  capabilities: string[];
}

export function getHealth(capabilities: readonly string[] = []): HealthResponse {
  return { status: 'degraded', protocolMin: 0, protocolMax: 0, capabilities: [...capabilities] };
}
