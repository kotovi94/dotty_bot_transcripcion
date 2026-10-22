import type { MaintenanceState } from "../shared/contracts";

export function maintenanceDisplay(state: MaintenanceState): {
  confirmed: boolean;
  empty: boolean;
  stale: boolean;
} {
  const confirmed = state.failureQuery?.status === "current" && state.localScanAvailable !== false;
  return { confirmed, empty: confirmed && state.issues.length === 0,
    stale: state.failureQuery?.status === "stale" };
}
