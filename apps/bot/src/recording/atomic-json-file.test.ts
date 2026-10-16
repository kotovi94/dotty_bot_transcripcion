import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { writeJsonAtomically } from "./atomic-json-file.ts";

describe("writeJsonAtomically", () => {
  it("replaces an existing manifest on Windows", async (test) => {
    const testDirectory = await fs.mkdtemp(join(tmpdir(), "dotty-atomic-test-"));
    test.after(() => fs.rm(testDirectory, { recursive: true, force: true }));
    const path = join(testDirectory, "manifest-overwrite.json");

    await writeJsonAtomically(path, { status: "recording", chunks: [] });
    await writeJsonAtomically(path, { status: "paused", chunks: ["one"] });
    await writeJsonAtomically(path, { status: "recording", chunks: ["one", "two"] });

    assert.deepEqual(JSON.parse(await fs.readFile(path, "utf8")), {
      status: "recording",
      chunks: ["one", "two"],
    });
    const leftovers = (await fs.readdir(testDirectory)).filter(
      (name) => name.includes("manifest-overwrite.json.") && /\.(tmp|bak)$/.test(name),
    );
    assert.deepEqual(leftovers, []);
  });
});
