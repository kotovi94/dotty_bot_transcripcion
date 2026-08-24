export type SessionStatus =
  | "scheduled"
  | "recording"
  | "paused"
  | "finalizing"
  | "completed"
  | "failed";

export interface SessionState {
  readonly id: string;
  readonly campaignId: string;
  readonly sequenceNumber: number;
  readonly status: SessionStatus;
  readonly startedAt: Date | null;
  readonly endedAt: Date | null;
}

export type SessionEvent =
  | { readonly type: "start"; readonly occurredAt: Date }
  | { readonly type: "pause" }
  | { readonly type: "resume" }
  | { readonly type: "finish"; readonly occurredAt: Date }
  | { readonly type: "complete" }
  | { readonly type: "fail"; readonly occurredAt: Date };

export class InvalidSessionTransitionError extends Error {
  constructor(status: SessionStatus, event: SessionEvent["type"]) {
    super(`Cannot apply event '${event}' while session is '${status}'.`);
    this.name = "InvalidSessionTransitionError";
  }
}

export function createSession(input: {
  id: string;
  campaignId: string;
  sequenceNumber: number;
}): SessionState {
  if (input.id.trim() === "" || input.campaignId.trim() === "") {
    throw new TypeError("Session and campaign identifiers are required.");
  }
  if (!Number.isSafeInteger(input.sequenceNumber) || input.sequenceNumber < 1) {
    throw new RangeError("Session sequence number must be a positive integer.");
  }

  return {
    ...input,
    status: "scheduled",
    startedAt: null,
    endedAt: null,
  };
}

export function applySessionEvent(
  session: SessionState,
  event: SessionEvent,
): SessionState {
  switch (event.type) {
    case "start":
      assertStatus(session, event, ["scheduled"]);
      return { ...session, status: "recording", startedAt: event.occurredAt };
    case "pause":
      assertStatus(session, event, ["recording"]);
      return { ...session, status: "paused" };
    case "resume":
      assertStatus(session, event, ["paused"]);
      return { ...session, status: "recording" };
    case "finish":
      assertStatus(session, event, ["recording", "paused"]);
      return { ...session, status: "finalizing", endedAt: event.occurredAt };
    case "complete":
      assertStatus(session, event, ["finalizing"]);
      return { ...session, status: "completed" };
    case "fail":
      assertStatus(session, event, [
        "scheduled",
        "recording",
        "paused",
        "finalizing",
      ]);
      return { ...session, status: "failed", endedAt: event.occurredAt };
  }
}

function assertStatus(
  session: SessionState,
  event: SessionEvent,
  allowed: readonly SessionStatus[],
): void {
  if (!allowed.includes(session.status)) {
    throw new InvalidSessionTransitionError(session.status, event.type);
  }
}

