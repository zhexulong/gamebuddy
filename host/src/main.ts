import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { connectIntegrationCompanion } from "./integration-bootstrap.js";
import { bindIntegrationIdentity } from "./integration-catalog.js";
import { PRODUCT_INTEGRATION_CATALOG } from "./integration-catalog-product.js";
import { validateLocalHostConfig } from "./local-host-config.js";
import type { PresentationProfile } from "./presentation.js";
import { createProductionGameContinuity } from "./production-game-continuity.js";
import { DEFAULT_COMPANION_MODEL_CONFIG } from "./runtime.js";
import { connectHealthyVoiceGateway } from "./voice-bootstrap.js";
import { createHostShutdownLifecycle, createVoicePollingSupervisor } from "./voice-polling.js";

/** Explicit local Host bootstrap; the selected adapter owns transport and game config. */
const configPath = process.argv[2] ?? process.env.GAMEBUDDY_HOST_CONFIG;
if (configPath === undefined) throw new Error("host_config_path_required");
const absoluteConfigPath = resolve(configPath);
const config = validateLocalHostConfig(JSON.parse(await readFile(absoluteConfigPath, "utf8")) as unknown);
const selected = await PRODUCT_INTEGRATION_CATALOG.select(config.integrationId, config.integration, {
  configDirectory: dirname(absoluteConfigPath),
});
const identity = bindIntegrationIdentity(
  {
    playerId: config.playerId,
    companionId: config.companionId,
    ...(config.continuityId === undefined ? {} : { continuityId: config.continuityId }),
  },
  selected.prepared.identityScope,
);
const actionPolicy =
  config.actionPolicy === undefined ? undefined : selected.launcher.module.parsePolicy(config.actionPolicy);
const configuredVoiceProfile = config.presentation?.speech?.voiceProfile;
let voice = await connectHealthyVoiceGateway(config.voiceGateway, configuredVoiceProfile);
let voiceClosed = false;
const closeVoiceOnce = (): void => {
  if (voice === undefined || voiceClosed) return;
  voiceClosed = true;
  voice.close();
};
let connected: Awaited<ReturnType<typeof connectIntegrationCompanion>> | undefined;
let detachVoice: (() => Promise<void>) | undefined;
let voicePoll: ReturnType<typeof createVoicePollingSupervisor> | undefined;
try {
  const voiceHealthy = voice !== undefined;
  const presentationProfile: PresentationProfile | undefined =
    config.presentation === undefined
      ? undefined
      : {
          locale: "zh-CN",
          text: false,
          speech:
            config.presentation.speech === undefined || !voiceHealthy
              ? null
              : { voiceProfile: config.presentation.speech.voiceProfile },
        };
  if (config.presentation?.speech !== undefined && voice === undefined) {
    throw new Error("speech_presentation_unavailable");
  }
  const continuity = identity.continuityId === undefined ? undefined : createProductionGameContinuity(identity);
  connected = await connectIntegrationCompanion({
    identity,
    launcher: selected.launcher,
    launcherConfig: selected.prepared.launchConfig,
    modelConfig:
      config.model === undefined
        ? DEFAULT_COMPANION_MODEL_CONFIG
        : { provider: "cpa-oai", modelId: config.model, thinkingLevel: config.thinkingLevel ?? "high" },
    actionPolicy,
    gameplaySubagent: config.gameplaySubagent,
    presentationProfile,
    speechPort: voice ?? undefined,
    ...(continuity === undefined
      ? {}
      : { continuityCoordinator: continuity.coordinator }),
  });
  // Voice event ingress is enabled only by an explicit Host-owned session
  // binding. Never derive it from game, chat, continuity, or integration IDs.
  if (voice !== undefined && config.voiceSessionId !== undefined) {
    // Bind before attaching the source or starting the poller so neither path
    // can issue an unscoped events request or admit unrelated transcripts.
    await voice.bootstrapSession(config.voiceSessionId);
    detachVoice = connected.host.attachFinalVoiceSource(voice, config.voiceSessionId);
    voicePoll = createVoicePollingSupervisor(voice);
    voicePoll.start();
  }
} catch (error) {
  // Voice is acquired before the remaining bootstrap, so retain the original
  // setup failure while closing the only acquired voice resource exactly once.
  if (detachVoice !== undefined) {
    try {
      await detachVoice();
    } catch {
      // The startup error remains authoritative; closeVoiceOnce still seals the
      // transport even if listener cleanup itself fails.
    }
  }
  if (connected !== undefined) {
    try {
      await connected.close();
    } catch {
      // Preserve the startup error while attempting all acquired-resource cleanup.
    }
  }
  voicePoll = undefined;
  closeVoiceOnce();
  throw error;
}
if (connected === undefined) throw new Error("host_connection_missing");
const shutdown = createHostShutdownLifecycle({
  stopPolling: voicePoll === undefined ? undefined : () => voicePoll.close(),
  detachVoice,
  closeVoice: voice === undefined ? undefined : closeVoiceOnce,
  closeConnected: () => connected.close(),
});
process.stdout.write(
  `GameBuddy Host connected through receipt-backed integration '${config.integrationId}'. Press Ctrl+C to stop.\n`,
);
let primaryError: unknown;
let cleanupErrors: unknown[] = [];
try {
  await new Promise<void>((resolveStop) => {
    const stop = () => resolveStop();
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
  const preparationErrors = await shutdown.prepareForReturn();
  if (preparationErrors.length > 0) throw new AggregateError(preparationErrors, "host_shutdown_prepare_failed");
} catch (error) {
  primaryError = error;
} finally {
  // Cleanup is best effort per resource: one failing operation must not skip
  // the remaining close operations or change an existing primary error.
  cleanupErrors.push(...(await shutdown.cleanup()));
}
if (primaryError !== undefined) throw primaryError;
if (cleanupErrors.length > 0) throw new AggregateError(cleanupErrors, "host_cleanup_failed");
