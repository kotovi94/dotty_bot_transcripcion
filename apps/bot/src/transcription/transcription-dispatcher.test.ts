import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

import type { Logger } from "pino";

import type { CampaignService } from "../campaigns/campaign-service.ts";
import type { AdaptiveVocabularyStore } from "./adaptive-vocabulary.ts";
import { TranscriptionDispatcher } from "./transcription-dispatcher.ts";

const directories: string[] = [];
after(async () => Promise.all(directories.map((directory) => rm(directory, { recursive: true }))));

describe("transcription dispatcher", () => {
  it("continues with later sessions when one directory fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "dotty-dispatch-"));
    directories.push(root);
    for (const name of ["first", "second"]) {
      const directory = join(root, name);
      await mkdir(directory, { recursive: true });
      await writeFile(join(directory, "audio.wav"), "audio");
      await writeFile(join(directory, "manifest.json"), JSON.stringify({
        version: 1,
        sessionId: name,
        campaignId: "campaign-1",
        campaignName: "Campaign",
        status: "completed",
        chunks: [{
          id: "chunk-1",
          speakerUserId: "user-1",
          file: "audio.wav",
          startedOffsetMs: 0,
        }],
      }));
    }

    const dispatcher = new TranscriptionDispatcher(
      root,
      {
        findById: async () => null,
        listMembersByCampaignId: async () => [],
      } as unknown as CampaignService,
      "http://127.0.0.1:8765",
      "secret",
      { listActive: async () => [] } as unknown as AdaptiveVocabularyStore,
      { info() {}, warn() {}, debug() {} } as unknown as Logger,
    );
    const internal = dispatcher as unknown as {
      dispatchDirectory(directory: string): Promise<void>;
    };
    const original = internal.dispatchDirectory.bind(dispatcher);
    let calls = 0;
    let successfulDirectory = "";
    internal.dispatchDirectory = async (directory) => {
      calls += 1;
      if (calls === 1) throw new Error("broken session");
      successfulDirectory = directory;
      await original(directory);
    };

    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response(JSON.stringify({ status: "queued" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
    try {
      await dispatcher.dispatchCompleted();
      assert.equal(calls, 2);
      await access(join(successfulDirectory, ".transcription-enqueued"));
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
