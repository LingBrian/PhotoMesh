export interface HealthResponse {
  status: 'degraded';
  protocolMin: number;
  protocolMax: number;
}

export function getHealth(): HealthResponse {
  return { status: 'degraded', protocolMin: 0, protocolMax: 0 };
}
