import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { normalizeCampaignName } from "./campaign-repository.ts";

describe("campaign names", () => {
  it("normalizes spacing, case and compatible unicode", () => {
    assert.equal(normalizeCampaignName("  La Maldicion DE Strahd  "), "la maldicion de strahd");
  });

  it("rejects an empty name", () => {
    assert.throws(() => normalizeCampaignName("   "), TypeError);
  });
});

