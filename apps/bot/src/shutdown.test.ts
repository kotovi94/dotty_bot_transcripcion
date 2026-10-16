import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { runShutdownActions } from "./shutdown.ts";

describe("best-effort shutdown actions", () => {
  it("attempts Discord, Prisma, and later cleanup despite independent failures", async () => {
    const calls: string[] = [];
    const failures = await runShutdownActions([
      { resource: "captures", run: async () => { calls.push("captures"); } },
      { resource: "discord", run: async () => { calls.push("discord"); throw new Error("Discord close failed"); } },
      { resource: "prisma", run: async () => { calls.push("prisma"); throw new Error("Prisma disconnect failed"); } },
      { resource: "status", run: async () => { calls.push("status"); } },
    ]);
    assert.deepEqual(calls, ["captures", "discord", "prisma", "status"]);
    assert.deepEqual(failures, [
      { resource: "discord", message: "Discord close failed" },
      { resource: "prisma", message: "Prisma disconnect failed" },
    ]);
  });
});
