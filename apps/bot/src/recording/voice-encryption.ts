import { setTimeout } from "node:timers/promises";
import { VoiceConnectionStatus, type VoiceConnection } from "@discordjs/voice";

export function voiceEncryptionStatus(connection: VoiceConnection) {
  const state = connection.state;
  if (state.status !== VoiceConnectionStatus.Ready) return { connectionStatus: state.status };
  const network = state.networking?.state;
  const dave = network && "dave" in network ? network.dave : undefined;
  return {
    connectionStatus: state.status,
    daveProtocol: dave?.protocolVersion ?? 0,
    daveReady: dave?.session?.ready ?? false,
  };
}

// Transport Ready does not guarantee that the MLS welcome has been processed.
// voice 0.19.2 passes encrypted frames through when its DAVE session isn't ready.
export async function waitForVoiceEncryption(connection: VoiceConnection): Promise<void> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const status = voiceEncryptionStatus(connection);
    if (status.connectionStatus !== VoiceConnectionStatus.Ready) {
      throw new Error("Voice connection lost while waiting for encryption");
    }
    if (status.daveProtocol === 0 || status.daveReady) return;
    if (Date.now() >= deadline) throw new Error("DAVE_ENCRYPTION_NOT_READY: voice encryption did not become ready in 10 seconds");
    await setTimeout(100);
  }
}
