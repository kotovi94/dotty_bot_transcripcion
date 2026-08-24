import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { buildCharacterModal } from "./dotty-panel.ts";
import { createPanelTutorialMessage, tutorialPageCount } from "./dotty-tutorial.ts";

describe("character modal", () => {
  it("omits an empty character value when adding a new assignment", () => {
    const modal = buildCharacterModal({
      campaignId: "campaign-1",
      userId: "user-1",
      playerName: "Jugador",
    }).toJSON();
    const components = modal.components as Array<{ components: Array<{ value?: string }> }>;
    const characterInput = components[0]?.components[0];
    const playerInput = components[1]?.components[0];

    assert.equal("value" in (characterInput ?? {}), false);
    assert.equal(playerInput !== undefined && "value" in playerInput ? playerInput.value : undefined, "Jugador");
  });

  it("prefills both values when editing an existing assignment", () => {
    const modal = buildCharacterModal({
      campaignId: "campaign-1",
      userId: "user-1",
      characterName: "V",
      playerName: "Jugador",
    }).toJSON();
    const components = modal.components as Array<{ components: Array<{ value?: string }> }>;

    assert.equal(components[0]?.components[0]?.value, "V");
    assert.equal(components[1]?.components[0]?.value, "Jugador");
  });
});

describe("guided Dotty panel tutorial", () => {
  it("covers the complete flow and stays inside the interactive panel", () => {
    assert.equal(tutorialPageCount, 8);
    const rendered = Array.from({ length: tutorialPageCount }, (_, page) =>
      createPanelTutorialMessage(page),
    );
    const serialized = JSON.stringify(rendered.map((message) => ({
      embeds: message.embeds.map((embed) => embed.toJSON()),
      components: message.components.map((row) => row.toJSON()),
    })));
    assert.match(serialized, /Configura|campa/i);
    assert.match(serialized, /Personajes/);
    assert.match(serialized, /Diagn/);
    assert.match(serialized, /Inicia la grabaci/);
    assert.match(serialized, /Reprocesar audio/);
    assert.doesNotMatch(serialized, /dotty_admin/);

    const firstControls = rendered[0]!.components[0]!.toJSON().components as Array<{
      custom_id?: string;
    }>;
    assert.equal(firstControls[1]?.custom_id, "dotty:ui:home");
    assert.equal(firstControls[2]?.custom_id, "dotty:ui:tutorial:1");
  });

  it("clamps invalid pages instead of producing an unusable panel", () => {
    const message = createPanelTutorialMessage(999);
    const footer = message.embeds[0]!.toJSON().footer?.text;
    assert.match(footer ?? "", new RegExp(`Paso ${tutorialPageCount} de ${tutorialPageCount}`));
  });
});
