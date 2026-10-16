import { SessionFileCoordinator } from "./session-file-coordinator.ts";

// Acquire campaign locks before session locks. Multi-session operations must
// acquire session IDs in sorted order and call a lock-assuming helper rather
// than re-entering public deletion; session-only operations must not acquire a
// campaign lock afterward.
export class CampaignFileCoordinator extends SessionFileCoordinator {
  constructor(root: string) {
    super(root, "campaign");
  }
}