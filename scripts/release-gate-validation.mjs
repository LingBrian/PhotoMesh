const REQUIRED_ASSETS = 100_000;
const REQUIRED_QUERIES = 1_000;
const MAX_P95_MS = 1_000;

export function performanceReportPasses(report) {
  const assets = report?.dataset?.assets;
  const queries = report?.dataset?.queries;
  const p95Ms = report?.queryApi?.p95Ms;
  return assets === REQUIRED_ASSETS && queries === REQUIRED_QUERIES &&
    typeof p95Ms === 'number' && Number.isFinite(p95Ms) && p95Ms >= 0 && p95Ms < MAX_P95_MS;
}
