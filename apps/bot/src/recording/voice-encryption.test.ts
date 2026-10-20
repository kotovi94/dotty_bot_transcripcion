import assert from "node:assert/strict";
import { it } from "node:test";
import { VoiceConnectionStatus, type VoiceConnection } from "@discordjs/voice";
import { waitForVoiceEncryption } from "./voice-encryption.ts";

it("waits for MLS readiness even when the transport is Ready", async () => {
  const session = { ready: false };
  const connection = { state: { status: VoiceConnectionStatus.Ready,
    networking: { state: { dave: { protocolVersion: 1, session } } } } } as unknown as VoiceConnection;
  let completed = false;
  const pending = waitForVoiceEncryption(connection).then(() => { completed = true; });
  await Promise.resolve();
  assert.equal(completed, false);
  session.ready = true;
  await pending;
  assert.equal(completed, true);
});

it("rejects a disconnected transport", async () => {
  const connection = { state: { status: VoiceConnectionStatus.Disconnected } } as VoiceConnection;
  await assert.rejects(waitForVoiceEncryption(connection), /connection lost/);
});
