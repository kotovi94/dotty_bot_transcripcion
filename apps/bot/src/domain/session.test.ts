import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  applySessionEvent,
  createSession,
  InvalidSessionTransitionError,
} from "./session.ts";

describe("session lifecycle", () => {
  it("moves through a complete recording lifecycle", () => {
    const startedAt = new Date("2026-08-01T20:00:00.000Z");
    const endedAt = new Date("2026-08-01T23:30:00.000Z");
    let session = createSession({
      id: "session-18",
      campaignId: "campaign-dotty",
      sequenceNumber: 18,
    });

    session = applySessionEvent(session, { type: "start", occurredAt: startedAt });
    session = applySessionEvent(session, { type: "pause" });
    session = applySessionEvent(session, { type: "resume" });
    session = applySessionEvent(session, { type: "finish", occurredAt: endedAt });
    session = applySessionEvent(session, { type: "complete" });

    assert.equal(session.status, "completed");
    assert.equal(session.startedAt, startedAt);
    assert.equal(session.endedAt, endedAt);
  });

  it("rejects transitions that would corrupt the lifecycle", () => {
    const session = createSession({
      id: "session-1",
      campaignId: "campaign-dotty",
      sequenceNumber: 1,
    });

    assert.throws(
      () => applySessionEvent(session, { type: "pause" }),
      InvalidSessionTransitionError,
    );
  });

  it("rejects invalid sequence numbers", () => {
    assert.throws(
      () =>
        createSession({
          id: "session-0",
          campaignId: "campaign-dotty",
          sequenceNumber: 0,
        }),
      RangeError,
    );
  });
});

