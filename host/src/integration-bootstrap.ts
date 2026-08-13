import { randomUUID } from "node:crypto";

import { endContinuitySession, selectContinuitySession, type SurfaceSession } from "./continuity.js";
import { withContinuitySurfaceTransitionLock } from "./continuity-transition-lock.js";
import type { ContinuitySurfaceCoordinator } from "./continuity-surface-coordinator/continuity-surface-coordinator.js";
import { CompanionLoop } from "./companion-loop.js";
import { CompanionHostService } from "./host-service.js";
import { assertReceiptBackedLaunch, type IntegrationLauncher, type IntegrationLaunchHandle } from "./integration-launcher.js";
import { type IntegrationActionPolicy } from "./integration-module.js";
import { type PresentationProfile, type PresentationRuntime, type CompanionTextPort, type HostPresentationAdmissionProvider, type HostPresentationBinding } from "./presentation.js";
import { createCompanionRuntime, identityKey, resolveRuntimePaths, type CompanionModelConfig, type GameCompanionIdentity, type RuntimeSession } from "./runtime.js";
import { type VoiceSpeechPort } from "./voice.js";
import { type WorldBookBinding } from "./worldbook.js";
import { acquireGameSurfaceLease, type GameSurfaceLease } from "./game-surface-lease.js";
import { GameSurfaceLifecycleProducer } from "./game-surface-lifecycle/game-surface-lifecycle.js";
import type { HostGameLifecycleSnapshot } from "./game-status/game-status.js";

export type IntegrationCompanionConnection = Readonly<{
  identity: GameCompanionIdentity; launcher: IntegrationLauncher; launcherConfig: unknown; runtimeRoot?: string; modelConfig?: CompanionModelConfig; actionPolicy?: IntegrationActionPolicy; gameplaySubagent?: boolean; presentationProfile?: PresentationProfile; textPort?: CompanionTextPort; speechPort?: VoiceSpeechPort; presentationAdmissionProvider?: HostPresentationAdmissionProvider; continuityCoordinator?: ContinuitySurfaceCoordinator; surfaceSessionId?: string; worldBook?: WorldBookBinding;
}>;
export type ConnectedIntegrationCompanion = Readonly<{
  launch: IntegrationLaunchHandle; runtime: RuntimeSession; loop: CompanionLoop; host: CompanionHostService; surfaceSession?: SurfaceSession; close: () => Promise<void>; lifecycleSnapshot: () => HostGameLifecycleSnapshot;
}>;
/** Receipt-backed Game bootstrap. Game rows and leases have no Chat dependency. */
export async function connectIntegrationCompanion(connection: IntegrationCompanionConnection): Promise<ConnectedIntegrationCompanion> {
  if (connection.identity.continuityId !== undefined && connection.surfaceSessionId !== undefined) throw new Error("game_surface_session_id_caller_owned");
  const paths = resolveRuntimePaths(connection.identity, connection.runtimeRoot);
  const launch = await connection.launcher.launch({ identity: connection.identity, config: connection.launcherConfig });
  let lease: GameSurfaceLease | undefined; let surfaceSession: SurfaceSession | undefined; let entered = false;
  try {
    assertReceiptBackedLaunch(connection.launcher, launch, connection.identity);
    const world = launch.connection.module.worldScope(launch.connection);
    if (connection.identity.continuityId !== undefined && world === null) throw new Error("integration_world_scope_required");
    if (connection.identity.continuityId !== undefined) {
      surfaceSession = (await withTransition(connection, paths.runtimeCwd, async () => {
        const currentWorld = launch.connection.module.worldScope(launch.connection);
        if (!sameWorld(world, currentWorld)) throw new Error("integration_world_scope_drift");
        const sessionId = randomUUID();
        lease = await acquireGameSurfaceLease(paths, sessionId, { identity: connection.identity as GameCompanionIdentity & { continuityId: string }, world: currentWorld! });
        const selected = await selectContinuitySession(paths, connection.identity, { surface: "game", sessionId, world: currentWorld! });
        entered = true; return selected.session;
      }));
    }
    let presentationActive = true;
    const admissionProvider = connection.presentationAdmissionProvider === undefined ? undefined : guardIntegrationPresentationAdmission(connection.presentationAdmissionProvider, () => presentationActive);
    const presentation = connection.presentationProfile === undefined ? undefined : { profile: connection.presentationProfile, sessionId: identityKey(connection.identity), admissionProvider, textPort: connection.textPort, speechPort: connection.speechPort } satisfies PresentationRuntime;
    const runtime = await createCompanionRuntime(connection.identity, connection.runtimeRoot, launch.connection, connection.modelConfig, connection.actionPolicy, presentation, connection.gameplaySubagent === true, undefined, surfaceSession?.sessionId ?? connection.surfaceSessionId, connection.worldBook, "game");
    const loop = new CompanionLoop(runtime.session); const lifecycle = new GameSurfaceLifecycleProducer(launch.connection.module, launch.connection, connection.actionPolicy);
    const host = new CompanionHostService(loop, launch.events, (reasonCode) => { lifecycle.markConnectionUnavailable(); presentationActive = false; runtime.interruptIntegrationExecutions?.(`integration_${reasonCode}`); launch.revoke(reasonCode); runtime.gameplaySubagent?.cancel(`integration_${reasonCode}`); });
    host.acceptInitialFacts(launch.initialFacts);
    let closed = false;
    const close = async (): Promise<void> => {
      if (closed) return; closed = true; presentationActive = false; lifecycle.markConnectionUnavailable(); runtime.interruptIntegrationExecutions?.("integration_closed");
      const errors: unknown[] = []; const attempt = async (operation: () => void | Promise<void>): Promise<void> => { try { await operation(); } catch (error) { errors.push(error); } };
      await attempt(() => host.close()); await attempt(() => runtime.gameplaySubagent?.dispose()); await attempt(() => runtime.session.dispose()); await attempt(() => launch.close());
      if (surfaceSession !== undefined) await attempt(async () => { await withTransition(connection, paths.runtimeCwd, () => endContinuitySession(paths, connection.identity, surfaceSession!.sessionId)); });
      if (lease !== undefined) await attempt(() => lease!.release());
      if (errors.length > 0) throw new AggregateError(errors, "integration_close_failed");
    };
    return Object.freeze({ launch, runtime, loop, host, ...(surfaceSession === undefined ? {} : { surfaceSession }), close, lifecycleSnapshot: () => lifecycle.snapshot() });
  } catch (error) { try { launch.close(); } finally { if (!entered) await lease?.release(); } throw error; }
}
function sameWorld(left: { integrationId: string; saveId: string; worldId: string } | null, right: { integrationId: string; saveId: string; worldId: string } | null): boolean { return left?.integrationId === right?.integrationId && left?.saveId === right?.saveId && left?.worldId === right?.worldId; }
function guardIntegrationPresentationAdmission(provider: HostPresentationAdmissionProvider, active: () => boolean): HostPresentationAdmissionProvider { return Object.freeze({ capture() { if (!active()) throw new Error("stale_presentation_admission"); const captured = provider.capture(); const hostBinding = Object.freeze({}); return Object.freeze({ sourceEventId: captured.sourceEventId, admission: Object.freeze({ hostBinding, assertHostCurrent(binding: HostPresentationBinding) { if (binding !== hostBinding || !active()) throw new Error("stale_presentation_admission"); captured.admission.assertHostCurrent(captured.admission.hostBinding); } }) }); } }); }
async function withTransition<T>(connection: IntegrationCompanionConnection, runtimeCwd: string, work: () => Promise<T>): Promise<T> { const continuityId = connection.identity.continuityId; if (continuityId === undefined) throw new Error("continuity_id_required"); return connection.continuityCoordinator === undefined ? withContinuitySurfaceTransitionLock(runtimeCwd, continuityId, work) : connection.continuityCoordinator.withTransition(continuityId, work); }
export function disconnectIntegrationCompanion(connected: ConnectedIntegrationCompanion): void { void connected.close(); }
