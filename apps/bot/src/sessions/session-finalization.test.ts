import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { VoiceCaptureManager } from "../recording/voice-capture-manager.ts";
import type { PersistedSession } from "./session-repository.ts";
import { finalizeSessionSafely } from "./session-finalization.ts";
import type { SessionService } from "./session-service.ts";

const completed = { id: "session-1", status: "completed" } as unknown as PersistedSession;
const finalizing = { id: "session-1", status: "finalizing" } as unknown as PersistedSession;

describe("safe session finalization", () => {
  it("finishes capture before completing the database lifecycle", async () => {
    const calls: string[] = [];
    const sessions = {
      finish: async () => { calls.push("db-finalizing"); return finalizing; },
      complete: async () => { calls.push("db-completed"); return completed; },
    } as unknown as SessionService;
    const recordings = {
      finish: async () => { calls.push("capture-completed"); },
    } as Pick<VoiceCaptureManager, "finish">;

    assert.equal(await finalizeSessionSafely(sessions, recordings, "guild", "campaign"), completed);
    assert.deepEqual(calls, ["db-finalizing", "capture-completed", "db-completed"]);
  });

  it("marks the session failed when audio finalization fails", async () => {
    let failed = false;
    const sessions = {
      finish: async () => finalizing,
      fail: async () => { failed = true; return completed; },
    } as unknown as SessionService;
    const recordings = {
      finish: async () => { throw new Error("decoder stuck"); },
    } as Pick<VoiceCaptureManager, "finish">;

    await assert.rejects(
      finalizeSessionSafely(sessions, recordings, "guild", "campaign"),
      /decoder stuck/u,
    );
    assert.equal(failed, true);
  });

  it("recovers a transient final database transition", async () => {
    let recovered = false;
    const sessions = {
      finish: async () => finalizing,
      complete: async () => { throw new Error("database busy"); },
      recoverInterrupted: async () => { recovered = true; return 1; },
      findById: async () => completed,
    } as unknown as SessionService;
    const recordings = { finish: async () => undefined } as Pick<VoiceCaptureManager, "finish">;

    assert.equal(await finalizeSessionSafely(sessions, recordings, "guild", "campaign"), completed);
    assert.equal(recovered, true);
  });
});
