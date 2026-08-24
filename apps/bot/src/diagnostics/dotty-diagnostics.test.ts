import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { formatBytes } from "./dotty-diagnostics.ts";

describe("diagnostic storage formatting", () => {
  it("uses readable binary units", () => {
    assert.equal(formatBytes(10 * 1_073_741_824), "10.0 GB");
    assert.equal(formatBytes(512 * 1_048_576), "512.0 MB");
    assert.equal(formatBytes(1024), "1 KB");
  });
});
