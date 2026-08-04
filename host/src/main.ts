import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { connectLocalCompanion, disconnectLocalCompanion } from "./local-bootstrap.js";
import { DEFAULT_COMPANION_MODEL_CONFIG } from "./runtime.js";
import { LocalVoiceGatewayClient } from "./voice-gateway-client.js";
import { loadKnowledgeBundle } from "./knowledge.js";
import { resolveKnowledgeBundlePath, validateLocalHostConfig } from "./local-host-config.js";
import type { PresentationProfile } from "./presentation.js";

/**
 * Explicit local Host bootstrap. It never searches the repository for config,
 * never reads credentials from source files, and refuses to start without an
 * identity-bound Mod bridge configuration supplied by the local operator.
 */

const configPath = process.argv[2] ?? process.env.GAMEBUDDY_HOST_CONFIG;
if (configPath === undefined) throw new Error("host_config_path_required");
const config = validateLocalHostConfig(JSON.parse(await readFile(resolve(configPath), "utf8")) as unknown);
const knowledge = config.knowledgeBundlePath === undefined ? undefined : await loadKnowledgeBundle(resolveKnowledgeBundlePath(resolve(configPath), config.knowledgeBundlePath), config.gameVersion);
const voice = config.voiceGateway === undefined ? undefined : await LocalVoiceGatewayClient.connect(config.voiceGateway);
const voiceCapabilities = voice === undefined ? undefined : await voice.health();
const presentationProfile: PresentationProfile | undefined = config.presentation === undefined ? undefined : {
  locale: "zh-CN",
  text: false,
  speech: config.presentation.speech === undefined || voiceCapabilities === undefined
    ? null
    : { voiceProfile: config.presentation.speech.voiceProfile, perUtteranceDirection: voiceCapabilities.perUtteranceDirection },
};
if (config.presentation?.speech !== undefined && (voice === undefined || voiceCapabilities === undefined)) {
  voice?.close();
  throw new Error("speech_presentation_unavailable");
}
const connected = await connectLocalCompanion({
  identity: { playerId: config.playerId, saveId: config.saveId, worldId: config.worldId, companionId: config.companionId },
  pipeName: config.pipeName,
  bridgeToken: config.bridgeToken,
  // Product Host defaults to the approved dialogue model. The lower-level
  // bootstrap API still permits an omitted model for deterministic replay.
  modelConfig: config.model === undefined ? DEFAULT_COMPANION_MODEL_CONFIG : { provider: "cpa-oai", modelId: config.model, thinkingLevel: config.thinkingLevel ?? "high" },
  knowledge,
  gameVersion: config.gameVersion,
  actionPolicy: config.actionPolicy,
  gameplaySubagent: config.gameplaySubagent,
  presentationProfile,
  speechPort: voice ?? undefined,
});
// connectLocalCompanion already admitted the mandatory initial Mod snapshot
// through the ordinary Host turn path before returning. Only explicit
// presentation tools can reach a player-facing surface.
const detachVoice = voice === undefined ? undefined : connected.host.attachFinalVoiceSource(voice);
const voicePoll = voice === undefined ? undefined : setInterval(() => {
  void voice.pollEvents().catch(() => undefined);
}, 200);
process.stdout.write("GameBuddy Host connected to an identity-bound local Stardew bridge. Press Ctrl+C to stop.\n");
await new Promise<void>((resolveStop) => {
  const stop = () => resolveStop();
  process.once("SIGINT", stop); process.once("SIGTERM", stop);
});
if (voicePoll !== undefined) clearInterval(voicePoll);
detachVoice?.();
voice?.close();
disconnectLocalCompanion(connected);
