import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { readEnvironment } from "./environment.ts";

describe("Dotty environment", () => {
  it("accepts the required Discord configuration", () => {
    const environment = readEnvironment({
      DISCORD_TOKEN: "test-token",
      DISCORD_CLIENT_ID: "client-1",
      DISCORD_GUILD_ID: "guild-1",
    });

    assert.equal(environment.DATABASE_URL, "file:../../data/dotty.db");
    assert.equal(environment.DOTTY_LOG_LEVEL, "info");
    assert.equal(environment.DOTTY_DIAGNOSTICS_ENABLED, true);
  });

  it("can disable persistent diagnostics explicitly", () => {
    const environment = readEnvironment({
      DISCORD_TOKEN: "test-token",
      DISCORD_CLIENT_ID: "client-1",
      DISCORD_GUILD_ID: "guild-1",
      DOTTY_DIAGNOSTICS_ENABLED: "false",
    });

    assert.equal(environment.DOTTY_DIAGNOSTICS_ENABLED, false);
  });

  it("reports missing keys without printing secret values", () => {
    assert.throws(
      () => readEnvironment({ DISCORD_TOKEN: "do-not-print-this" }),
      (error: unknown) => {
        assert(error instanceof Error);
        assert.match(error.message, /DISCORD_CLIENT_ID/);
        assert.doesNotMatch(error.message, /do-not-print-this/);
        return true;
      },
    );
  });
});

