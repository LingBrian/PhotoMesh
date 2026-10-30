export interface ResourceMetricsSource {
  disk: () => { totalBytes: number; availableBytes: number } | Promise<{ totalBytes: number; availableBytes: number }>;
  queue: () => { pending: number; running: number; failed: number } | Promise<{ pending: number; running: number; failed: number }>;
  lowSpaceBytes?: number;
}
export interface ResourceMetrics {
  status: 'ok' | 'low_space' | 'unavailable';
  acceptsNewWork: boolean;
  storage: { totalBytes: number; availableBytes: number; usedBytes: number; lowSpace: boolean };
  queue: { pending: number; running: number; failed: number };
}

const nonNegative = (value: number): number => Number.isSafeInteger(value) && value >= 0 ? value : 0;
export async function getResourceMetrics(source: ResourceMetricsSource): Promise<ResourceMetrics> {
  try {
    const [disk, queue] = await Promise.all([source.disk(), source.queue()]);
    const totalBytes = nonNegative(disk.totalBytes);
    const availableBytes = Math.min(totalBytes, nonNegative(disk.availableBytes));
    const lowSpace = availableBytes <= (source.lowSpaceBytes ?? 1_073_741_824);
    return {
      status: lowSpace ? 'low_space' : 'ok', acceptsNewWork: !lowSpace,
      storage: { totalBytes, availableBytes, usedBytes: totalBytes - availableBytes, lowSpace },
      queue: { pending: nonNegative(queue.pending), running: nonNegative(queue.running), failed: nonNegative(queue.failed) }
    };
  } catch {
    return { status: 'unavailable', acceptsNewWork: false, storage: { totalBytes: 0, availableBytes: 0, usedBytes: 0, lowSpace: true }, queue: { pending: 0, running: 0, failed: 0 } };
  }
}
