import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { afterEach, describe, it } from "node:test";

import { AdaptiveVocabularyStore } from "./adaptive-vocabulary.ts";

const directories: string[] = [];
const testDataRoot = resolve("../../data");

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("adaptive campaign vocabulary", () => {
  it("learns a repeated high-confidence fantasy name for the next session", async () => {
    const directory = await mkdtemp(join(testDataRoot, "dotty-vocabulary-"));
    directories.push(directory);
    const store = new AdaptiveVocabularyStore(directory);
    const activated = await store.observe("campaign-1", "session-1", [{
      words: [
        { text: " Viajamos", probability: 0.98 },
        { text: " Barovia", probability: 0.94 },
        { text: " Barovia", probability: 0.92 },
        { text: " Barovia", probability: 0.91 },
        { text: " Barovia", probability: 0.93 },
        { text: " Barovia", probability: 0.95 },
        { text: " Barovia", probability: 0.96 },
      ],
    }]);

    assert.deepEqual(activated, ["Barovia"]);
    assert.deepEqual(await store.listActive("campaign-1"), ["Barovia"]);
  });

  it("requires two sessions for names seen only once per session", async () => {
    const directory = await mkdtemp(join(testDataRoot, "dotty-vocabulary-"));
    directories.push(directory);
    const store = new AdaptiveVocabularyStore(directory);
    const line = { words: [{ text: " Vimos", probability: 0.98 }, { text: " Strahd", probability: 0.9 }] };

    assert.deepEqual(await store.observe("campaign-1", "session-1", [line]), []);
    assert.deepEqual(await store.observe("campaign-1", "session-2", [line]), ["Strahd"]);
  });

  it("ignores low-confidence, sentence-initial and configured terms", async () => {
    const directory = await mkdtemp(join(testDataRoot, "dotty-vocabulary-"));
    directories.push(directory);
    const store = new AdaptiveVocabularyStore(directory);
    await store.observe("campaign-1", "session-1", [{
      words: [
        { text: " Avernus", probability: 0.99 },
        { text: " Dudoso", probability: 0.4 },
        { text: " Admin", probability: 0.99 },
        { text: " Admin", probability: 0.99 },
        { text: " Admin", probability: 0.99 },
      ],
    }], ["Admin"]);

    assert.deepEqual(await store.listActive("campaign-1"), []);
  });

  it("ignores campaign-name components and close variants of known characters", async () => {
    const directory = await mkdtemp(join(testDataRoot, "dotty-vocabulary-"));
    directories.push(directory);
    const store = new AdaptiveVocabularyStore(directory);
    const repeated = (text: string) => Array.from(
      { length: 6 },
      () => ({ text: ` ${text}`, probability: 0.97 }),
    );
    await store.observe("campaign-1", "session-1", [{
      words: [
        { text: " Vimos", probability: 0.99 },
        ...repeated("Red"),
        ...repeated("Zero"),
        ...repeated("Estela"),
      ],
    }], ["Cyberpunk Red Zero Humanity", "STELLA"]);

    assert.deepEqual(await store.listActive("campaign-1"), []);
  });
});
