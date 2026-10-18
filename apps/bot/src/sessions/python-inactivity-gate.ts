// Provisional fail-closed gate. Python DELETE currently removes job rows but
// cannot prove that current or pre-protocol workers stopped using WAV files.
export const PYTHON_INACTIVITY_PENDING_CODE = "PYTHON_INACTIVITY_PROTOCOL_PENDING";

export function hasVerifiedPythonInactivity(_sessionId: string): boolean {
  return false;
}
