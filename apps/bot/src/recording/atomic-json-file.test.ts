import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";

import { writeJsonAtomically } from "./atomic-json-file.ts";

const databaseUrl = process.env.TEST_DATABASE_URL;
if (databaseUrl === undefined) {
  throw new Error("TEST_DATABASE_URL must be set by the test runner.");
}
const testDirectory = dirname(databaseUrl.slice("file:".length));

describe("writeJsonAtomically", () => {
  it("replaces an existing manifest on Windows", async () => {
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
