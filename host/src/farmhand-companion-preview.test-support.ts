import { randomUUID } from "node:crypto";
import { createCompanionLiveEvidenceArtifact } from "./companion-live-evidence-artifact.js";
import { createLiveSourceAttester } from "./companion-live-source-attestation.js";
import { CompanionLoop } from "./companion-loop.js";
import { createFarmhandSystemNoticePresenter, type FarmhandPresentationBridge } from "./farmhand-companion-presentation.js";
import { CompanionHostService, GameTurnLineageTracker } from "./host-service.js";
import { assertReceiptBackedLaunch, type IntegrationLauncher, type IntegrationLaunchHandle } from "./integration-launcher.js";
import type { GameCompanionIdentity, RuntimeSession } from "./runtime.js";
import { isExactReceiptRecoveryPort } from "./stardew-execution-recovery-supervisor.js";
import { type FarmhandCompanionPreview, type FarmhandCompanionPreviewConfig, parseFarmhandCompanionPreviewConfig } from "./farmhand-companion-preview.js";

const previewState = new WeakMap<FarmhandCompanionPreview, { closed: boolean }>();
const relaunchInFlight = new WeakSet<FarmhandCompanionPreview>();

export type FarmhandCompanionPreviewDependencies = Readonly<{
  launcher: IntegrationLauncher;
  presentationPort(launch: IntegrationLaunchHandle): FarmhandPresentationBridge;
  createRuntime(identity: GameCompanionIdentity, root: string, connection: IntegrationLaunchHandle["connection"], presentationBridge: FarmhandPresentationBridge, sessionId: string, turnTracker: GameTurnLineageTracker, presentationLocale: string): Promise<RuntimeSession>;
  createLoop(runtime: RuntimeSession, evidence: ReturnType<typeof createLiveSourceAttester> | undefined): CompanionLoop;
  createHost(loop: CompanionLoop, launch: IntegrationLaunchHandle, runtime: RuntimeSession, turnTracker: GameTurnLineageTracker, evidence: ReturnType<typeof createLiveSourceAttester> | undefined): CompanionHostService;
}>;

export async function startFarmhandCompanionPreviewForTest(value: unknown, dependencies: FarmhandCompanionPreviewDependencies): Promise<FarmhandCompanionPreview> {
  const config = parseFarmhandCompanionPreviewConfig(value);
  const launch = await dependencies.launcher.launch({ identity: config.identity, config: { pipeName: config.bridge.pipeName, bridgeToken: config.bridge.bridgeToken, expectedPresentationLocale: config.requiredPresentationLocale } });
  try {
    assertReceiptBackedLaunch(dependencies.launcher, launch, config.identity);
    return await composePreview(config, dependencies, launch);
  } catch (error) {
    launch.revoke("preview_start_failed"); launch.close(); throw error;
  }
}

export async function relaunchFarmhandCompanionPreviewForTest(predecessor: FarmhandCompanionPreview, value: unknown, dependencies: FarmhandCompanionPreviewDependencies): Promise<FarmhandCompanionPreview> {
  const config = parseFarmhandCompanionPreviewConfig(value);
  if (previewState.get(predecessor)?.closed === true) throw new Error("farmhand_preview_relaunch_predecessor_closed");
  if (typeof predecessor.runtime.recoverStardewExecutionReceipts !== "function") throw new Error("farmhand_preview_relaunch_requires_game_runtime");
  if (!sameIdentity(predecessor.identity, config.identity)) throw new Error("farmhand_preview_relaunch_identity_mismatch");
  if (relaunchInFlight.has(predecessor)) throw new Error("farmhand_preview_relaunch_in_flight");
  relaunchInFlight.add(predecessor);
  const launch = await dependencies.launcher.launch({ identity: config.identity, config: { pipeName: config.bridge.pipeName, bridgeToken: config.bridge.bridgeToken, expectedPresentationLocale: config.requiredPresentationLocale } });
  try {
    assertReceiptBackedLaunch(dependencies.launcher, launch, config.identity);
    if (!isExactReceiptRecoveryPort(launch.receiptRecovery)) throw new Error("farmhand_preview_receipt_recovery_capability_unavailable");
    await predecessor.runtime.recoverStardewExecutionReceipts(launch.receiptRecovery);
    return await composePreview(config, dependencies, launch);
  } catch (error) {
    launch.revoke("preview_relaunch_failed"); launch.close(); throw error;
  } finally { relaunchInFlight.delete(predecessor); }
}

function isPresentationBridge(value: unknown): value is FarmhandPresentationBridge {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const bridge = value as Record<string, unknown>;
  if (typeof bridge.presentCompanionText !== "function" || typeof bridge.presentSystemNotice !== "function" || typeof bridge.state !== "object" || bridge.state === null) return false;
  const snapshot = (bridge.state as Record<string, unknown>).snapshot;
  return snapshot === null || (typeof snapshot === "object" && snapshot !== null && typeof (snapshot as Record<string, unknown>).revision === "number" && Number.isSafeInteger((snapshot as Record<string, unknown>).revision) && ((snapshot as Record<string, unknown>).revision as number) >= 0);
}

async function composePreview(config: FarmhandCompanionPreviewConfig, dependencies: FarmhandCompanionPreviewDependencies, launch: IntegrationLaunchHandle): Promise<FarmhandCompanionPreview> {
  const state = launch.connection.state;
  const locale = typeof state === "object" && state !== null && "snapshot" in state && typeof state.snapshot === "object" && state.snapshot !== null && "presentationLocale" in state.snapshot ? state.snapshot.presentationLocale : undefined;
  if (typeof locale !== "string" || !/^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{2,16}){0,3}$/.test(locale)) throw new Error("farmhand_preview_presentation_locale_unavailable");
  if (locale !== config.requiredPresentationLocale) throw new Error("farmhand_preview_presentation_locale_mismatch");
  const presentation = dependencies.presentationPort(launch);
  if (!isPresentationBridge(presentation)) throw new Error("farmhand_preview_presentation_bridge_unavailable");
  const turnTracker = new GameTurnLineageTracker();
  const runtime = await dependencies.createRuntime(config.identity, config.runtimeRoot, launch.connection, presentation, `preview_${randomUUID().replaceAll("-", "")}`, turnTracker, locale);
  const evidence = createEvidence(config); evidence?.activate(config.runtimeInstanceId);
  const loop = dependencies.createLoop(runtime, evidence); const host = dependencies.createHost(loop, launch, runtime, turnTracker, evidence);
  loop.attachTurnObserver(host); host.attachVoiceStopper(async () => undefined); host.attachStopSystemNoticePresenter(createFarmhandSystemNoticePresenter(presentation)); host.acceptInitialFacts(launch.initialFacts);
  let closePromise: Promise<void> | undefined;
  const preview = Object.freeze({ host, runtime, identity: config.identity, close: () => { previewState.set(preview, { closed: true }); return (closePromise ??= close(host, runtime, launch)); } });
  previewState.set(preview, { closed: false }); return preview;
}
function createEvidence(config: FarmhandCompanionPreviewConfig): ReturnType<typeof createLiveSourceAttester> | undefined {
  const artifact = createCompanionLiveEvidenceArtifact(config.evidence?.path, config.evidence?.manifestSha256); const binding = process.env.GAMEBUDDY_LIVE_SOURCE_ATTESTATION_LAUNCH_BINDING_SHA256;
  if (binding === undefined) return artifact === undefined ? undefined : createLiveSourceAttester({ launchBindingSha256: config.evidence!.manifestSha256, send: (message) => { artifact.append(message.evidence); return true; } });
  if (!/^[a-f0-9]{64}$/.test(binding) || typeof process.send !== "function" || process.connected !== true) throw new Error("live_source_attestation_unavailable");
  return createLiveSourceAttester({ launchBindingSha256: binding, send: (message) => { artifact?.append(message.evidence); return process.send!(message); } });
}
async function close(host: CompanionHostService, runtime: RuntimeSession, launch: IntegrationLaunchHandle): Promise<void> {
  const errors: unknown[] = []; try { launch.revoke("preview_closed"); } catch (e) { errors.push(e); } try { host.close(); } catch (e) { errors.push(e); } try { await runtime.interruptIntegrationExecutions?.("preview_closed"); } catch (e) { errors.push(e); } try { runtime.gameplaySubagent?.cancel("preview_closed"); } catch (e) { errors.push(e); } try { await runtime.clearGameOperationalGateMarker?.(); } catch (e) { errors.push(e); } try { runtime.session.dispose(); } catch (e) { errors.push(e); } try { launch.close(); } catch (e) { errors.push(e); } if (errors.length) throw new AggregateError(errors, "farmhand_companion_preview_close_failed");
}
function sameIdentity(a: GameCompanionIdentity, b: GameCompanionIdentity): boolean { return a.playerId === b.playerId && a.companionId === b.companionId && a.saveId === b.saveId && a.worldId === b.worldId; }
