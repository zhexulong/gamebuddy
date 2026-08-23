import type { LiveSourceAttester } from "../companion-live-source-attestation.js";
import { CompanionLoop } from "../companion-loop.js";
import { createGameOperationalGateEvidenceProjection } from "../game-operational-gate-evidence.js";
import type { HostGameLifecycleSnapshot } from "../game-status/game-status.js";
import {
  CompanionHostService,
  createGamePresentationAdmissionProvider,
  GameTurnLineageTracker,
} from "../host-service.js";
import type { GameIntegrationModule, IntegrationActionPolicy, IntegrationStateView } from "../integration-module.js";
import type { IntegrationConnection } from "../integration-types.js";
import { createGameCompanionRuntime, type RuntimeSession } from "../runtime.js";
import {
  consumeGameVoicePresentationAttachment,
  type GameVoicePresentationAttachment,
} from "../voice-gateway-client.js";
import {
  type GameRuntimeMaterializer,
  type MaterializedGameRuntime,
  materializeExactEnter,
} from "./continuity-semantic-game-runtime-materializer.internal.js";

export type {
  GameRuntimeMaterializer,
  MaterializedGameRuntime,
} from "./continuity-semantic-game-runtime-materializer.internal.js";

/**
 * Creates the fixed production S4c materializer. This is construction-zone-only:
 * the eventual composer invokes it inside the live S4b one-shot callback after
 * durable prepare. No facade/model/Mod-wire configuration reaches this factory.
 */
export type HostGameRuntimeMaterializerOptions = Readonly<{
  gameOperationalGateNonceSha256?: string;
  /**
   * Opaque capability minted only by the healthy local Voice Gateway client.
   * The materializer alone supplies the receipt-backed session id and Host
   * interruption admission; absent means no presentation tools.
   */
  gameVoicePresentation?: GameVoicePresentationAttachment;
  /** Preview-only parent IPC attestation; absent for every ordinary production launch. */
  liveSourceAttester?: LiveSourceAttester;
}>;

export function createHostGameRuntimeMaterializer(
  options: HostGameRuntimeMaterializerOptions = {},
): GameRuntimeMaterializer {
  return Object.freeze({
    async materializeEnter(reservation, permit): Promise<MaterializedGameRuntime> {
      return materializeExactEnter(reservation, permit, async (execution) => {
        const constructed = await createMaterializedGameRuntime(
          execution.principal,
          execution.world,
          execution.runtimeRoot,
          execution.connection,
          permit.gameSessionId,
          options.gameOperationalGateNonceSha256,
          options.gameVoicePresentation,
        );
        const runtime = constructed.runtime;
        const loop = new CompanionLoop(runtime.session, undefined, options.liveSourceAttester);
        const lifecycle = new IntegrationLifecycleSnapshot(execution.connection.module, execution.connection);
        const operationalGateEvidence =
          options.gameOperationalGateNonceSha256 === undefined
            ? undefined
            : createGameOperationalGateEvidenceProjection(
                execution.connection.module,
                execution.connection,
                execution.launch.events,
              );
        const host = new CompanionHostService(
          loop,
          execution.launch.events,
          (reasonCode) => {
            lifecycle.markConnectionUnavailable();
            // Loss containment must retain cancellation rejection: seal adapter
            // authority first, then contain every remaining async teardown path.
            execution.launch.revoke(reasonCode);
            void (async () => {
              try {
                await runtime.interruptIntegrationExecutions?.(`integration_${reasonCode}`);
              } catch {
                // The revoked runtime cannot reopen. The rejected cancellation
                // has been observed and contained rather than discarded.
              }
              try {
                runtime.gameplaySubagent?.cancel(`integration_${reasonCode}`);
              } catch {
                // Cancellation is best-effort only after authority revocation.
              }
            })();
          },
          runtime.interruption,
          async (epoch, reasonCode) => {
            if (runtime.cancelIntegrationEpoch === undefined) throw new Error("stop_ledger_cancellation_unavailable");
            await runtime.cancelIntegrationEpoch(epoch, reasonCode);
          },
          async (reasonCode) => {
            if (runtime.gameplaySubagent === undefined) return;
            await runtime.gameplaySubagent.cancel(reasonCode);
          },
          constructed.turnTracker,
          runtime.bindIntegrationReceipt,
          options.liveSourceAttester,
        );
        loop.attachTurnObserver(host);
        if (options.gameVoicePresentation !== undefined)
          host.attachVoiceStopper(consumeGameVoicePresentationAttachment(options.gameVoicePresentation).stopVoice);
        let ingressActivated = false;
        const activateIngress = (): void => {
          if (ingressActivated) return;
          ingressActivated = true;
          // These launch-owned facts are intentionally withheld until the
          // semantic enter receipt commits. Their first Pi turn therefore
          // cannot speak before both durable admission and STOP authority.
          host.acceptInitialFacts(execution.launch.initialFacts);
        };
        return Object.freeze({
          session: runtime.session,
          piSessionId: runtime.piSessionId,
          ...(runtime.gameplaySubagent === undefined ? {} : { gameplaySubagent: runtime.gameplaySubagent }),
          ...(runtime.clearGameOperationalGateMarker === undefined
            ? {}
            : { clearGameOperationalGateMarker: runtime.clearGameOperationalGateMarker }),
          ...(operationalGateEvidence === undefined ? {} : { operationalGateEvidence }),
          connected: Object.freeze({
            host,
            lifecycleSnapshot: () => lifecycle.snapshot(),
            ...(operationalGateEvidence === undefined
              ? {}
              : { nextOperationalGateEvidence: operationalGateEvidence.next }),
            markClosing: () => lifecycle.markClosing(),
            activateIngress,
          }),
        });
      });
    },
  });
}

/**
 * Private, read-only reduction of the live integration connection for the Host
 * game-status projection. It owns no lifecycle authority and reads no Chat or
 * origin data.
 */
class IntegrationLifecycleSnapshot {
  #connectionAvailable = true;
  #closing = false;

  public constructor(
    private readonly module: GameIntegrationModule,
    private readonly connection: IntegrationConnection,
    private readonly policy?: IntegrationActionPolicy,
  ) {}

  public markConnectionUnavailable(): void {
    this.#connectionAvailable = false;
  }

  public markClosing(): void {
    this.#closing = true;
  }

  public snapshot(): HostGameLifecycleSnapshot {
    const surface = this.#closing ? "returning" : "active";
    if (!this.#connectionAvailable) return unavailable(surface, "absent");
    let state: IntegrationStateView;
    try {
      state = this.module.readState(this.connection);
    } catch {
      return unavailable(surface, "mismatch");
    }
    if (!isStateView(state)) return unavailable(surface, "mismatch");
    if (!state.connected || state.sessionId === null || state.snapshotRevision === null)
      return unavailable(surface, "absent");
    if (this.#closing) return unavailable(surface, "current");

    let count: number;
    try {
      count = this.module.actionCatalog.visibleActions(
        state.registrations ?? [],
        state.capabilities,
        this.policy,
      ).length;
    } catch {
      return unavailable("active", "mismatch");
    }
    if (!Number.isSafeInteger(count) || count < 0 || count > 512) return unavailable("active", "mismatch");
    return Object.freeze({
      availability: "available",
      surface: "active",
      freshness: "current",
      availableCapabilities: Object.freeze({ category: count === 0 ? "none" : "available", count }),
      activeExecution: state.activeExecution === null ? "none" : "active",
      latestAuthoritativeReceipt:
        state.latestReceipt === null
          ? "none"
          : state.latestReceipt.state === "succeeded"
            ? "succeeded"
            : "not_succeeded",
    });
  }
}

function unavailable(
  surface: HostGameLifecycleSnapshot["surface"],
  freshness: HostGameLifecycleSnapshot["freshness"],
): HostGameLifecycleSnapshot {
  return Object.freeze({
    availability: "unavailable",
    surface,
    freshness,
    availableCapabilities: Object.freeze({ category: "none", count: 0 }),
    activeExecution: "none",
    latestAuthoritativeReceipt: "none",
  });
}

function isStateView(value: unknown): value is IntegrationStateView {
  return (
    isRecord(value) &&
    typeof value.connected === "boolean" &&
    (value.sessionId === null || isOpaque(value.sessionId)) &&
    Array.isArray(value.capabilities) &&
    value.capabilities.length <= 512 &&
    value.capabilities.every(isOpaque) &&
    (value.snapshotRevision === null ||
      (typeof value.snapshotRevision === "number" &&
        Number.isSafeInteger(value.snapshotRevision) &&
        value.snapshotRevision >= 0)) &&
    (value.activeExecution === null || isRecord(value.activeExecution)) &&
    (value.latestReceipt === null || isRecord(value.latestReceipt))
  );
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function isOpaque(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value);
}

type MaterializedGameRuntimeInput = Readonly<{
  principal: Readonly<{ continuityId: string; companionId: string; playerId: string }>;
  world: Readonly<{ saveId: string; worldId: string }>;
  runtimeRoot: string;
  connection: IntegrationConnection;
  gameSessionId: string;
}>;

/**
 * The only named Game runtime constructor lives in the construction-zone
 * materializer. It has no public export: an actual runtime becomes durable
 * Game authority only after this module validates an S4b execution and S4c
 * permit, then the later composer terminalizes an exact receipt.
 */
async function createMaterializedGameRuntime(
  principal: MaterializedGameRuntimeInput["principal"],
  world: MaterializedGameRuntimeInput["world"],
  runtimeRoot: string,
  connection: IntegrationConnection,
  gameSessionId: string,
  gameOperationalGateNonceSha256?: string,
  gameVoicePresentation?: GameVoicePresentationAttachment,
): Promise<Readonly<{ runtime: RuntimeSession; turnTracker: GameTurnLineageTracker }>> {
  const identity = Object.freeze({
    continuityId: principal.continuityId,
    companionId: principal.companionId,
    playerId: principal.playerId,
    saveId: world.saveId,
    worldId: world.worldId,
  });
  const turnTracker = new GameTurnLineageTracker();
  const runtime = await createGameCompanionRuntime(
    identity,
    runtimeRoot,
    connection,
    gameSessionId,
    gameOperationalGateNonceSha256 === undefined
      ? undefined
      : Object.freeze({ nonceSha256: gameOperationalGateNonceSha256 }),
    (handle) => {
      if (gameVoicePresentation === undefined) return undefined;
      const presentation = consumeGameVoicePresentationAttachment(gameVoicePresentation);
      return Object.freeze({
        surface: "game" as const,
        profile: Object.freeze({
          locale: "zh-CN",
          text: false,
          speech: Object.freeze({ voiceProfile: presentation.voiceProfile }),
        }),
        sessionId: gameSessionId,
        speechPort: presentation.speechPort,
        voiceAudioAdmission: presentation.voiceAudioAdmission,
        admissionProvider: createGamePresentationAdmissionProvider(turnTracker, handle.interruption),
      });
    },
  );
  return Object.freeze({ runtime, turnTracker });
}
