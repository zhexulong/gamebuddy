import { randomUUID } from "node:crypto";
import { isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createCompanionLiveEvidenceArtifact } from "./companion-live-evidence-artifact.js";
import { createLiveSourceAttester } from "./companion-live-source-attestation.js";
import { CompanionLoop } from "./companion-loop.js";
import {
  createFarmhandCompanionPresentationPort,
  createFarmhandPresentationEpochAdmission,
  createFarmhandSystemNoticePresenter,
  type FarmhandPresentationBridge,
} from "./farmhand-companion-presentation.js";
import {
  CompanionHostService,
  createGamePresentationAdmissionProvider,
  GameTurnLineageTracker,
} from "./host-service.js";
import {
  assertReceiptBackedLaunch,
  type IntegrationLauncher,
  type IntegrationLaunchHandle,
} from "./integration-launcher.js";
import { createGameCompanionRuntime, type GameCompanionIdentity, type RuntimeSession } from "./runtime.js";
import { ModelProfileStore, resolveModelProfileConfig } from "./settings/model-profile-store.js";
import { isExactReceiptRecoveryPort } from "./stardew-execution-recovery-supervisor.js";
import {
  getAuthenticatedStardewPresentationPortForPreview,
  parseStardewLauncherConfig,
  STARDEW_INTEGRATION_LAUNCHER,
} from "./stardew-integration-launcher.js";
import { readStrictJsonFile } from "./strict-json-reader.js";

export const FARMHAND_COMPANION_PREVIEW_SCHEMA_VERSION = 1;

/** Tracks the closed edge and bound scope of a composed preview so explicit relaunch fails closed. */
const previewState = new WeakMap<FarmhandCompanionPreview, { closed: boolean; identity: GameCompanionIdentity }>();
/** One explicit relaunch per predecessor at a time; no retries or backoff. */
const relaunchInFlight = new WeakSet<FarmhandCompanionPreview>();

function isFarmhandPresentationBridge(value: unknown): value is FarmhandPresentationBridge {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const bridge = value as Record<string, unknown>;
  if (
    typeof bridge.presentCompanionText !== "function" ||
    typeof bridge.presentSystemNotice !== "function" ||
    typeof bridge.state !== "object" ||
    bridge.state === null
  )
    return false;
  const state = bridge.state as Record<string, unknown>;
  if (state.snapshot === null) return true;
  if (typeof state.snapshot !== "object" || state.snapshot === null) return false;
  const snapshot = state.snapshot as Record<string, unknown>;
  return typeof snapshot.revision === "number" && Number.isSafeInteger(snapshot.revision) && snapshot.revision >= 0;
}

/** Redacted launcher-visible marker emitted after successful Preview admission. */
export const FARMHAND_COMPANION_PREVIEW_READY_MARKER = "farmhand_companion_preview_ready";

/**
 * Trusted Host-first input only. This preview accepts authenticated bridge
 * identity binding; model selection is the existing Host-owned game profile.
 * It deliberately has no action-policy, semantic-authority, or local-bootstrap
 * input.
 */
export type FarmhandCompanionPreviewConfig = Readonly<{
  schemaVersion: number;
  runtimeRoot: string;
  runtimeInstanceId: string;
  /** Launcher-selected native chat/font locale for this bounded live profile. */
  requiredPresentationLocale: "zh-CN" | "en-US";
  identity: GameCompanionIdentity;
  bridge: Readonly<{
    pipeName: string;
    bridgeToken: string;
  }>;
  evidence?: Readonly<{ path: string; manifestSha256: string }>;
}>;

export type FarmhandCompanionPreview = Readonly<{
  host: CompanionHostService;
  runtime: RuntimeSession;
  /** Stable scope identity retained for explicit successor binding checks. */
  identity: GameCompanionIdentity;
  close(): Promise<void>;
}>;

type FarmhandCompanionPreviewDependencies = Readonly<{
  launcher: IntegrationLauncher;
  presentationPort(launch: IntegrationLaunchHandle): FarmhandPresentationBridge;
  createRuntime(
    identity: GameCompanionIdentity,
    root: string,
    connection: IntegrationLaunchHandle["connection"],
    presentationBridge: FarmhandPresentationBridge,
    sessionId: string,
    turnTracker: GameTurnLineageTracker,
    presentationLocale: string,
  ): Promise<RuntimeSession>;
  createLoop(runtime: RuntimeSession, evidence: ReturnType<typeof createLiveSourceAttester> | undefined): CompanionLoop;
  createHost(
    loop: CompanionLoop,
    launch: IntegrationLaunchHandle,
    runtime: RuntimeSession,
    turnTracker: GameTurnLineageTracker,
    evidence: ReturnType<typeof createLiveSourceAttester> | undefined,
  ): CompanionHostService;
}>;

/** Parse and freeze the explicit preview-only Host contract before bridge I/O. */
export function parseFarmhandCompanionPreviewConfig(value: unknown): FarmhandCompanionPreviewConfig {
  if (
    !isRecord(value) ||
    Object.keys(value).some(
      (key) =>
        ![
          "schemaVersion",
          "runtimeRoot",
          "runtimeInstanceId",
          "requiredPresentationLocale",
          "identity",
          "bridge",
          "evidence",
        ].includes(key),
    )
  )
    throw new Error("invalid_farmhand_companion_preview_config");
  const identity = value.identity;
  const bridge = value.bridge;
  if (
    value.schemaVersion !== FARMHAND_COMPANION_PREVIEW_SCHEMA_VERSION ||
    typeof value.runtimeRoot !== "string" ||
    !isAbsolute(value.runtimeRoot) ||
    value.runtimeRoot.includes("\0") ||
    !isIdentifier(value.runtimeInstanceId) ||
    (value.requiredPresentationLocale !== "zh-CN" && value.requiredPresentationLocale !== "en-US") ||
    !isRecord(identity) ||
    Object.keys(identity).some((key) => !["playerId", "companionId", "continuityId", "saveId", "worldId"].includes(key)) ||
    !isIdentifier(identity.playerId) ||
    !isIdentifier(identity.companionId) ||
    !isIdentifier(identity.continuityId) ||
    !isIdentifier(identity.saveId) ||
    !isIdentifier(identity.worldId) ||
    !isRecord(bridge) ||
    Object.keys(bridge).some((key) => !["pipeName", "bridgeToken"].includes(key))
  )
    throw new Error("invalid_farmhand_companion_preview_config");
  // Reuse the adapter's strict token/pipe validation. The token remains in the
  // launch closure only and is never copied into runtime, evidence, or output.
  parseStardewLauncherConfig({ pipeName: bridge.pipeName, bridgeToken: bridge.bridgeToken });
  if (
    value.evidence !== undefined &&
    (!isRecord(value.evidence) ||
      Object.keys(value.evidence).some((key) => key !== "path" && key !== "manifestSha256") ||
      typeof value.evidence.path !== "string" ||
      !isAbsolute(value.evidence.path) ||
      value.evidence.path.includes("\0") ||
      typeof value.evidence.manifestSha256 !== "string" ||
      !/^[a-f0-9]{64}$/.test(value.evidence.manifestSha256))
  )
    throw new Error("invalid_farmhand_companion_preview_config");
  return Object.freeze({
    schemaVersion: FARMHAND_COMPANION_PREVIEW_SCHEMA_VERSION,
    runtimeRoot: value.runtimeRoot,
    runtimeInstanceId: value.runtimeInstanceId,
    requiredPresentationLocale: value.requiredPresentationLocale,
    identity: Object.freeze({
      playerId: identity.playerId,
      companionId: identity.companionId,
      continuityId: identity.continuityId,
      saveId: identity.saveId,
      worldId: identity.worldId,
    }),
    bridge: Object.freeze({
      pipeName: bridge.pipeName as string,
      bridgeToken: bridge.bridgeToken as string,
    }),
    ...(value.evidence === undefined
      ? {}
      : { evidence: Object.freeze({ path: value.evidence.path, manifestSha256: value.evidence.manifestSha256 }) }),
  });
}

/** Official formal Preview entrypoint. It never uses semantic Game authority. */
export async function startFarmhandCompanionPreview(value: unknown): Promise<FarmhandCompanionPreview> {
  return await startPreview(parseFarmhandCompanionPreviewConfig(value), productionDependencies());
}


async function startPreview(
  config: FarmhandCompanionPreviewConfig,
  dependencies: FarmhandCompanionPreviewDependencies,
): Promise<FarmhandCompanionPreview> {
  // The adapter connects and observes before any runtime/Pi construction.
  const launch = await dependencies.launcher.launch({
    identity: config.identity,
    config: {
      pipeName: config.bridge.pipeName,
      bridgeToken: config.bridge.bridgeToken,
      expectedPresentationLocale: config.requiredPresentationLocale,
    },
  });
  try {
    assertReceiptBackedLaunch(dependencies.launcher, launch, config.identity);
    return await composePreview(config, dependencies, launch);
  } catch (error) {
    launch.revoke("preview_start_failed");
    launch.close();
    throw error;
  }
}

/** Wire one already-asserted launch into a full preview (runtime, loop, Host, initial facts). */
async function composePreview(
  config: FarmhandCompanionPreviewConfig,
  dependencies: FarmhandCompanionPreviewDependencies,
  launch: IntegrationLaunchHandle,
): Promise<FarmhandCompanionPreview> {
  const connectionState = launch.connection.state;
  const presentationLocale =
    typeof connectionState === "object" &&
    connectionState !== null &&
    "snapshot" in connectionState &&
    typeof connectionState.snapshot === "object" &&
    connectionState.snapshot !== null &&
    "presentationLocale" in connectionState.snapshot
      ? connectionState.snapshot.presentationLocale
      : undefined;
  if (typeof presentationLocale !== "string" || !/^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{2,16}){0,3}$/.test(presentationLocale))
    throw new Error("farmhand_preview_presentation_locale_unavailable");
  if (presentationLocale !== config.requiredPresentationLocale)
    throw new Error("farmhand_preview_presentation_locale_mismatch");
  const presentation = dependencies.presentationPort(launch);
  if (!isFarmhandPresentationBridge(presentation))
    throw new Error("farmhand_preview_presentation_bridge_unavailable");
  const turnTracker = new GameTurnLineageTracker();
  const runtime = await dependencies.createRuntime(
    config.identity,
    config.runtimeRoot,
    launch.connection,
    presentation,
    `preview_${randomUUID().replaceAll("-", "")}`,
    turnTracker,
    presentationLocale,
  );
  const evidence = createPreviewLiveSourceAttester(config);
  evidence?.activate(config.runtimeInstanceId);
  const loop = dependencies.createLoop(runtime, evidence);
  const host = dependencies.createHost(loop, launch, runtime, turnTracker, evidence);
  loop.attachTurnObserver(host);
  // Host STOP/presentation fences are installed before launch-owned facts can
  // become a Pi turn. The no-op stopper is intentionally only a closed
  // preview presentation port; it cannot mint a voice/control channel.
  host.attachVoiceStopper(async () => undefined);
  host.attachStopSystemNoticePresenter(createFarmhandSystemNoticePresenter(presentation));
  host.acceptInitialFacts(launch.initialFacts);
  const state = { closed: false, identity: config.identity };
  let closePromise: Promise<void> | undefined;
  const preview = Object.freeze({
    host,
    runtime,
    identity: config.identity,
    close: () => {
      state.closed = true;
      return (closePromise ??= closePreview(host, runtime, launch));
    },
  });
  previewState.set(preview, state);
  return preview;
}

/**
 * Official explicit relaunch/recovery entrypoint. It is never triggered by a
 * disconnect and never retries or backs off: the caller owns lifecycle. The
 * predecessor runtime stays alive here; only its private coordinator is
 * consulted through a fresh authenticated read-only receipt port.
 */
export async function relaunchFarmhandCompanionPreview(
  predecessor: FarmhandCompanionPreview,
  value: unknown,
): Promise<FarmhandCompanionPreview> {
  return await relaunchPreview(parseFarmhandCompanionPreviewConfig(value), predecessor, productionDependencies());
}


async function relaunchPreview(
  config: FarmhandCompanionPreviewConfig,
  predecessor: FarmhandCompanionPreview,
  dependencies: FarmhandCompanionPreviewDependencies,
): Promise<FarmhandCompanionPreview> {
  const predecessorState = previewState.get(predecessor);
  if (predecessorState?.closed === true) throw new Error("farmhand_preview_relaunch_predecessor_closed");
  if (typeof predecessor.runtime.recoverStardewExecutionReceipts !== "function")
    throw new Error("farmhand_preview_relaunch_requires_game_runtime");
  if (!sameGameCompanionIdentity(predecessor.identity, config.identity))
    throw new Error("farmhand_preview_relaunch_identity_mismatch");
  if (relaunchInFlight.has(predecessor)) throw new Error("farmhand_preview_relaunch_in_flight");
  relaunchInFlight.add(predecessor);
  // Exactly one new authenticated receipt-backed Stardew binding.
  const launch = await dependencies.launcher.launch({
    identity: config.identity,
    config: {
      pipeName: config.bridge.pipeName,
      bridgeToken: config.bridge.bridgeToken,
      expectedPresentationLocale: config.requiredPresentationLocale,
    },
  });
  try {
    assertReceiptBackedLaunch(dependencies.launcher, launch, config.identity);
    const recoveryPort = launch.receiptRecovery;
    if (!isExactReceiptRecoveryPort(recoveryPort))
      throw new Error("farmhand_preview_receipt_recovery_capability_unavailable");
    // Exactly one bounded recovery pass over the predecessor's private
    // coordinator, before any successor runtime materialization or ingress
    // activation. Held port is read-only; no action request is ever reissued.
    await predecessor.runtime.recoverStardewExecutionReceipts(recoveryPort);
    return await composePreview(config, dependencies, launch);
  } catch (error) {
    launch.revoke("preview_relaunch_failed");
    launch.close();
    throw error;
  } finally {
    relaunchInFlight.delete(predecessor);
  }
}

function sameGameCompanionIdentity(a: GameCompanionIdentity, b: GameCompanionIdentity): boolean {
  return (
    a.playerId === b.playerId && a.companionId === b.companionId && a.saveId === b.saveId && a.worldId === b.worldId
  );
}

function createPreviewLiveSourceAttester(
  config: FarmhandCompanionPreviewConfig,
): ReturnType<typeof createLiveSourceAttester> | undefined {
  const artifact = createCompanionLiveEvidenceArtifact(config.evidence?.path, config.evidence?.manifestSha256);
  const launchBindingSha256 = process.env.GAMEBUDDY_LIVE_SOURCE_ATTESTATION_LAUNCH_BINDING_SHA256;
  if (launchBindingSha256 === undefined) {
    if (artifact === undefined) return undefined;
    return createLiveSourceAttester({
      launchBindingSha256: config.evidence!.manifestSha256,
      send: (message) => {
        artifact.append(message.evidence);
        return true;
      },
    });
  }
  if (!/^[a-f0-9]{64}$/.test(launchBindingSha256) || typeof process.send !== "function" || process.connected !== true)
    throw new Error("live_source_attestation_unavailable");
  return createLiveSourceAttester({
    launchBindingSha256,
    send: (message) => {
      artifact?.append(message.evidence);
      return process.send!(message);
    },
  });
}

async function closePreview(
  host: CompanionHostService,
  runtime: RuntimeSession,
  launch: IntegrationLaunchHandle,
): Promise<void> {
  const errors: unknown[] = [];
  // Revoke first: no mounted action closure may outlive teardown.
  try {
    launch.revoke("preview_closed");
  } catch (error) {
    errors.push(error);
  }
  try {
    host.close();
  } catch (error) {
    errors.push(error);
  }
  try {
    await runtime.interruptIntegrationExecutions?.("preview_closed");
  } catch (error) {
    errors.push(error);
  }
  try {
    runtime.gameplaySubagent?.cancel("preview_closed");
  } catch (error) {
    errors.push(error);
  }
  try {
    await runtime.clearGameOperationalGateMarker?.();
  } catch (error) {
    errors.push(error);
  }
  try {
    runtime.session.dispose();
  } catch (error) {
    errors.push(error);
  }
  try {
    launch.close();
  } catch (error) {
    errors.push(error);
  }
  if (errors.length > 0) throw new AggregateError(errors, "farmhand_companion_preview_close_failed");
}

function productionDependencies(): FarmhandCompanionPreviewDependencies {
  return Object.freeze({
    launcher: STARDEW_INTEGRATION_LAUNCHER,
    presentationPort: getAuthenticatedStardewPresentationPortForPreview,
    createRuntime: async (
      identity,
      root,
      connection,
      presentationBridge,
      sessionId,
      turnTracker,
      presentationLocale,
    ) => {
      const modelConfig = resolveModelProfileConfig(
        await new ModelProfileStore(resolve(root, "settings", "model-profiles.json")).read("game"),
      );
      if (modelConfig === null) throw new Error("farmhand_preview_model_configuration_unavailable");
      return await createGameCompanionRuntime(
        identity,
        root,
        connection,
        sessionId,
        undefined,
        undefined,
        Object.freeze({
          modelConfig,
          gameplaySubagentEnabled: true,
          // Preview is deliberately ephemeral: it can never enable Magic Context
          // memory or Historian through its JSON/configuration contract.
          disableMagicContextMemory: true,
          hostBindingFactory: (handle) =>
            Object.freeze({
              profile: Object.freeze({ locale: presentationLocale, text: true, speech: null }),
              surface: "game" as const,
              sessionId,
              textPort: createFarmhandCompanionPresentationPort(
                presentationBridge,
                createFarmhandPresentationEpochAdmission(handle.interruption),
              ),
              admissionProvider: createGamePresentationAdmissionProvider(turnTracker, handle.interruption),
            }),
        }),
      );
    },
    createLoop: (runtime, evidence) => new CompanionLoop(runtime.session, undefined, evidence),
    createHost: (loop, launch, runtime, turnTracker, evidence) =>
      new CompanionHostService(
        loop,
        launch.events,
        (reasonCode) => {
          launch.revoke(reasonCode);
          void (async () => {
            try {
              await runtime.interruptIntegrationExecutions?.(`integration_${reasonCode}`);
            } catch {
              /* revoke is already sealed */
            }
          })();
          try {
            runtime.gameplaySubagent?.cancel(`integration_${reasonCode}`);
          } catch {
            /* revoke is already sealed */
          }
        },
        runtime.interruption,
        runtime.cancelIntegrationEpoch,
        async (reasonCode) => await runtime.gameplaySubagent?.cancel(reasonCode),
        turnTracker,
        runtime.bindIntegrationReceipt,
        evidence,
      ),
  });
}
function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function isIdentifier(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value);
}

async function runPreviewCommand(): Promise<void> {
  const [flag, configPath] = process.argv.slice(2);
  if (flag !== "--config" || typeof configPath !== "string" || !isAbsolute(configPath) || process.argv.length !== 4)
    throw new Error("farmhand_companion_preview_usage: --config <absolute-path>");
  const config = parseFarmhandCompanionPreviewConfig(await readStrictJsonFile(resolve(configPath)));
  const preview = await startFarmhandCompanionPreview(config);
  // The launcher captures stdout into its private run root and accepts only
  // this exact redacted marker after receipt-backed admission. It carries no
  // identity, token, receipt, or model data.
  console.log(FARMHAND_COMPANION_PREVIEW_READY_MARKER);
  try {
    await new Promise<void>((resolveStop) => {
      process.once("SIGINT", resolveStop);
      process.once("SIGTERM", resolveStop);
    });
  } finally {
    await preview.close();
  }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await runPreviewCommand();
}
