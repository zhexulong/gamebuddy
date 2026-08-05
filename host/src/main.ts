import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { connectIntegrationCompanion, disconnectIntegrationCompanion } from "./integration-bootstrap.js";
import { bindIntegrationIdentity } from "./integration-catalog.js";
import { PRODUCT_INTEGRATION_CATALOG } from "./integration-catalog-product.js";
import { DEFAULT_COMPANION_MODEL_CONFIG } from "./runtime.js";
import { connectHealthyVoiceGateway } from "./voice-bootstrap.js";
import { validateLocalHostConfig } from "./local-host-config.js";
import type { PresentationProfile } from "./presentation.js";

/** Explicit local Host bootstrap; the selected adapter owns transport and game config. */
const configPath = process.argv[2] ?? process.env.GAMEBUDDY_HOST_CONFIG;
if (configPath === undefined) throw new Error("host_config_path_required");
const absoluteConfigPath = resolve(configPath);
const config = validateLocalHostConfig(JSON.parse(await readFile(absoluteConfigPath, "utf8")) as unknown);
const selected = await PRODUCT_INTEGRATION_CATALOG.select(config.integrationId, config.integration, {
  configDirectory: dirname(absoluteConfigPath),
});
const identity = bindIntegrationIdentity({
  playerId: config.playerId,
  companionId: config.companionId,
  ...(config.continuityId === undefined ? {} : { continuityId: config.continuityId }),
}, selected.prepared.identityScope);
const actionPolicy = config.actionPolicy === undefined ? undefined : selected.launcher.module.parsePolicy(config.actionPolicy);
const voice = await connectHealthyVoiceGateway(config.voiceGateway);
const voiceHealthy = voice !== undefined;
const presentationProfile: PresentationProfile | undefined = config.presentation === undefined ? undefined : {
  locale: "zh-CN",
  text: false,
  speech: config.presentation.speech === undefined || !voiceHealthy
    ? null
    : { voiceProfile: config.presentation.speech.voiceProfile },
};
if (config.presentation?.speech !== undefined && voice === undefined) {
  throw new Error("speech_presentation_unavailable");
}
const connected = await connectIntegrationCompanion({
  identity,
  launcher: selected.launcher,
  launcherConfig: selected.prepared.launchConfig,
  modelConfig: config.model === undefined ? DEFAULT_COMPANION_MODEL_CONFIG : { provider: "cpa-oai", modelId: config.model, thinkingLevel: config.thinkingLevel ?? "high" },
  actionPolicy,
  gameplaySubagent: config.gameplaySubagent,
  presentationProfile,
  speechPort: voice ?? undefined,
});
const detachVoice = voice === undefined ? undefined : connected.host.attachFinalVoiceSource(voice);
const voicePoll = voice === undefined ? undefined : setInterval(() => { void voice.pollEvents().catch(() => undefined); }, 200);
process.stdout.write(`GameBuddy Host connected through receipt-backed integration '${config.integrationId}'. Press Ctrl+C to stop.\n`);
await new Promise<void>((resolveStop) => {
  const stop = () => resolveStop();
  process.once("SIGINT", stop); process.once("SIGTERM", stop);
});
if (voicePoll !== undefined) clearInterval(voicePoll);
detachVoice?.();
voice?.close();
disconnectIntegrationCompanion(connected);
