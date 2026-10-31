export type AdmissionFault = 'full-disk' | 'timeout' | 'partial-write' | 'queue-full' | 'source-changed';
export type AdmissionFaultDecision = {
  httpStatus: 409 | 429 | 507 | 504;
  retryable: boolean;
  publishSuccess: false;
  cleanupPartialOutput: boolean;
};

/** Maps injected/observed task faults to safe API behavior; it never publishes success. */
export function admissionFaultDecision(fault: AdmissionFault): AdmissionFaultDecision {
  switch (fault) {
    case 'full-disk':
      return { httpStatus: 507, retryable: true, publishSuccess: false, cleanupPartialOutput: true };
    case 'timeout':
      return { httpStatus: 504, retryable: true, publishSuccess: false, cleanupPartialOutput: true };
    case 'partial-write':
      return { httpStatus: 507, retryable: true, publishSuccess: false, cleanupPartialOutput: true };
    case 'queue-full':
      return { httpStatus: 429, retryable: true, publishSuccess: false, cleanupPartialOutput: false };
    case 'source-changed':
      return { httpStatus: 409, retryable: false, publishSuccess: false, cleanupPartialOutput: true };
  }
}
