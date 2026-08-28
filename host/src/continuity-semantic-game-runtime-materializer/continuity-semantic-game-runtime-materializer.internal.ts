import {
  consumeReservedGameRuntimeMaterialization,
  type GameRuntimeBindingExecution,
  type ReservedGameRuntimeMaterialization,
  releaseReservedGameRuntimeMaterialization,
} from "../continuity-semantic-game-runtime-binding/continuity-semantic-game-runtime-binding.internal.js";
import type {
  ProductionGamePermit,
  ProductionGameTerminalReceipt,
} from "../continuity-semantic-store/continuity-semantic-production-store.js";
import type {
  GameOperationalGateEvidence,
  GameOperationalGateEvidenceProjection,
} from "../game-operational-gate-evidence.js";
import type { HostGameLifecycleSnapshot } from "../game-status/game-status.js";
import type { CompanionHostService } from "../host-service.js";

/**
 * The connected Host surface retained by the exact Game runtime. It deliberately
 * excludes binding, permit, coordinator, and runtime-session authority.
 */
export type ConnectedGameRuntime = Readonly<{
  host: CompanionHostService;
  lifecycleSnapshot(): HostGameLifecycleSnapshot;
  /** Present only when the source-owned operational gate was explicitly armed. */
  nextOperationalGateEvidence?: () => Promise<Omit<GameOperationalGateEvidence, "nonceSha256" | "piSessionId">>;
  markClosing(): void;
  /** Internal-only commit gate for launch-owned ingress after durable enter. */
  activateIngress(): void;
  /** Internal-only behavior seam; it exposes no worker, runtime, result, or action authority. */
  dispatchPromptDefinedTask(task: string): Promise<void>;
}>;

type ConnectedGameRuntimeConstruction = Omit<ConnectedGameRuntime, "dispatchPromptDefinedTask">;

export type RuntimeDisposal = Readonly<{
  session: Readonly<{ dispose(): void }>;
  /** Host-observed Pi identity; production connected ingress requires it. */
  piSessionId?: string;
  gameplaySubagent?: Readonly<{
    dispose(): void;
    /** Test workers may omit this; the connected dispatch seam fails closed. */
    run?: (task: string) => Promise<unknown>;
  }>;
  clearGameOperationalGateMarker?: () => void;
  operationalGateEvidence?: GameOperationalGateEvidenceProjection;
  /** Test-only factories may omit this; production admission rejects it. */
  connected?: ConnectedGameRuntimeConstruction;
}>;

export type MaterializedGameRuntime = Readonly<{
  receipt: ProductionGameTerminalReceipt;
  /** Present only for the production connected-ingress materializer. */
  piSessionId?: string;
  connected?: ConnectedGameRuntime;
  /**
   * The private S4d close-effect half. A caller must first durably prepare an
   * exact close permit; only then can this live runtime dispose and mint its
   * matching Host lifecycle receipt. It never commits a store transition.
   */
  teardownClose(permit: ProductionGamePermit): Promise<ProductionGameTerminalReceipt>;
  /** Disposes runtime resources only; composer closes the originating S4b binding last. */
  close(): Promise<void>;
}>;

export type GameRuntimeMaterializer = Readonly<{
  /** Construction-zone-only: consumes one callback-admitted S4b reservation. */
  materializeEnter(
    reservation: ReservedGameRuntimeMaterialization,
    permit: ProductionGamePermit,
  ): Promise<MaterializedGameRuntime>;
}>;

/**
 * Runs one materialization under a lease that outlives the callback only while
 * work already admitted is draining. A detached continuation cannot acquire a
 * lease after callback completion or close admission.
 */
export async function materializeExactEnter(
  reservation: ReservedGameRuntimeMaterialization,
  permit: ProductionGamePermit,
  factory: (execution: GameRuntimeBindingExecution) => Promise<RuntimeDisposal>,
): Promise<MaterializedGameRuntime> {
  const execution = consumeReservedGameRuntimeMaterialization(reservation);
  let runtime: RuntimeDisposal | undefined;
  let finalized = false;
  try {
    assertExecution(execution);
    assertExactEnterPermit(execution, permit);
    runtime = await factory(execution);
    assertRuntimeDisposal(runtime);
    assertExactEnterPermit(execution, permit);
    const result = finalizeMaterializedGameRuntime(permit, runtime);
    finalized = true;
    return result;
  } finally {
    if (!finalized && runtime !== undefined) {
      try {
        await closeMaterializedRuntime(runtime);
      } catch {
        /* preserve primary admission/factory failure */
      }
    }
    releaseReservedGameRuntimeMaterialization(reservation);
  }
}

/** Mints Host lifecycle evidence only after final liveness and deadline admission. */
export function finalizeMaterializedGameRuntime(
  enterPermit: ProductionGamePermit,
  runtime: RuntimeDisposal,
): MaterializedGameRuntime {
  assertRuntimeDisposal(runtime);
  const receipt = mintGameRuntimeReceipt(enterPermit, "runtime_bootstrapped");
  const connected =
    runtime.connected === undefined
      ? undefined
      : Object.freeze({
          host: runtime.connected.host,
          lifecycleSnapshot: runtime.connected.lifecycleSnapshot,
          ...(runtime.connected.nextOperationalGateEvidence === undefined
            ? {}
            : {
                nextOperationalGateEvidence:
                  runtime.connected.nextOperationalGateEvidence,
              }),
          markClosing: runtime.connected.markClosing,
          activateIngress: runtime.connected.activateIngress,
          dispatchPromptDefinedTask: createPromptDefinedTaskDispatcher(
            runtime.gameplaySubagent,
          ),
        });
  let state: "live" | "tearing_down" | "closed" = "live";
  let closePromise: Promise<void> | undefined;
  const dispose = (): Promise<void> => {
    if (state === "closed") return closePromise ?? Promise.resolve();
    if (state === "tearing_down")
      return closePromise ?? Promise.reject(new Error("game_runtime_materialization_teardown_in_progress"));
    state = "closed";
    closePromise = closeMaterializedRuntime(runtime);
    return closePromise;
  };
  return Object.freeze({
    receipt,
    ...(runtime.piSessionId === undefined ? {} : { piSessionId: runtime.piSessionId }),
    ...(connected === undefined ? {} : { connected }),
    async teardownClose(closePermit) {
      if (state !== "live") throw new Error("game_runtime_materialization_unavailable");
      assertExactClosePermit(enterPermit, closePermit);
      runtime.connected?.markClosing();
      state = "tearing_down";
      closePromise = closeMaterializedRuntime(runtime);
      try {
        await closePromise;
        const terminal = mintGameRuntimeReceipt(closePermit, "runtime_torn_down");
        state = "closed";
        return terminal;
      } catch (error) {
        // The facade retains this exact runtime and close permit for a
        // same-owner retry. Do not falsely retire the object after a failed
        // teardown: the underlying runtime may still be live.
        state = "live";
        closePromise = undefined;
        throw error;
      }
    },
    close: dispose,
  });
}

/** Mints closed-record Host lifecycle evidence only after exact permit admission. */
export function mintRuntimeBootstrappedReceipt(permit: ProductionGamePermit): ProductionGameTerminalReceipt {
  return mintGameRuntimeReceipt(permit, "runtime_bootstrapped");
}

function createPromptDefinedTaskDispatcher(
  worker: RuntimeDisposal["gameplaySubagent"],
): (task: string) => Promise<void> {
  return async (task: string): Promise<void> => {
    if (!isCanonicalPromptDefinedTask(task))
      throw new Error("invalid_gameplay_task");
    if (worker === undefined || typeof worker.run !== "function")
      throw new Error("gameplay_task_dispatch_unavailable");
    await worker.run(task);
  };
}

function isCanonicalPromptDefinedTask(value: unknown): value is string {
  if (typeof value !== "string") return false;
  let scalarValues = 0;
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit === 0) return false;
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      index += 1;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      return false;
    }
    scalarValues += 1;
    if (scalarValues > 2_000) return false;
  }
  return scalarValues >= 1;
}

function mintGameRuntimeReceipt(
  permit: ProductionGamePermit,
  kind: ProductionGameTerminalReceipt["kind"],
): ProductionGameTerminalReceipt {
  const occurredAtMs = Date.now();
  if (occurredAtMs > permit.deadlineAtMs) throw new Error("game_runtime_materialization_deadline_expired");
  return Object.freeze({
    kind,
    operationId: permit.operationId,
    requestId: permit.requestId,
    gameSessionId: permit.gameSessionId,
    bindingDigest: permit.bindingDigest,
    world: Object.freeze({
      integrationId: permit.world.integrationId,
      saveId: permit.world.saveId,
      worldId: permit.world.worldId,
    }),
    owner: Object.freeze({
      ownerToken: permit.owner.ownerToken,
      runtimeInstanceId: permit.owner.runtimeInstanceId,
      ownerPid: permit.owner.ownerPid,
      ownerProcessStartIdentity: permit.owner.ownerProcessStartIdentity,
    }),
    fenceToken: permit.fenceToken,
    occurredAtMs,
  });
}

/** Reverse acquisition order. The composer subsequently closes the S4b binding. */
export async function closeMaterializedRuntime(runtime: RuntimeDisposal): Promise<void> {
  const errors: unknown[] = [];
  const attempt = (operation: () => void): void => {
    try {
      operation();
    } catch (error) {
      errors.push(error);
    }
  };
  attempt(() => runtime.connected?.host.close());
  attempt(() => runtime.gameplaySubagent?.dispose());
  attempt(() => runtime.operationalGateEvidence?.close());
  attempt(() => runtime.clearGameOperationalGateMarker?.());
  attempt(() => runtime.session.dispose());
  if (errors.length > 0) throw new AggregateError(errors, "game_runtime_materialization_close_failed");
}

export function assertRuntimeDisposal(value: unknown): asserts value is RuntimeDisposal {
  if (
    !value ||
    typeof value !== "object" ||
    !isObject((value as RuntimeDisposal).session) ||
    typeof (value as RuntimeDisposal).session.dispose !== "function" ||
    ((value as RuntimeDisposal).connected !== undefined &&
      (!isObject((value as RuntimeDisposal).connected) ||
        !((value as RuntimeDisposal).connected!.host instanceof Object) ||
        typeof (value as RuntimeDisposal).connected!.host.close !== "function" ||
        typeof (value as RuntimeDisposal).connected!.lifecycleSnapshot !== "function" ||
        typeof (value as RuntimeDisposal).connected!.markClosing !== "function")) ||
    ((value as RuntimeDisposal).gameplaySubagent !== undefined &&
      (!isObject((value as RuntimeDisposal).gameplaySubagent) ||
        typeof (value as RuntimeDisposal).gameplaySubagent!.dispose !== "function" ||
        ((value as RuntimeDisposal).gameplaySubagent!.run !== undefined &&
          typeof (value as RuntimeDisposal).gameplaySubagent!.run !== "function"))) ||
    ((value as RuntimeDisposal).clearGameOperationalGateMarker !== undefined &&
      typeof (value as RuntimeDisposal).clearGameOperationalGateMarker !== "function") ||
    ((value as RuntimeDisposal).operationalGateEvidence !== undefined &&
      (typeof (value as RuntimeDisposal).operationalGateEvidence !== "object" ||
        typeof (value as RuntimeDisposal).operationalGateEvidence!.next !== "function" ||
        typeof (value as RuntimeDisposal).operationalGateEvidence!.close !== "function"))
  ) {
    throw new Error("invalid_game_runtime_materialization_result");
  }
}

function assertExecution(value: unknown): asserts value is GameRuntimeBindingExecution {
  if (
    !isPlainDataObject(value) ||
    !isPlainDataObject(value.principal) ||
    !isPlainDataObject(value.world) ||
    !isPlainDataObject(value.bindingFacts) ||
    !isPlainDataObject(value.bindingFacts.owner) ||
    typeof value.runtimeRoot !== "string" ||
    value.runtimeRoot.length === 0 ||
    !identifier(value.principal.continuityId) ||
    !identifier(value.principal.companionId) ||
    !identifier(value.principal.playerId) ||
    !identifier(value.world.integrationId) ||
    !identifier(value.world.saveId) ||
    !identifier(value.world.worldId) ||
    !sha256(value.bindingFacts.bindingDigest) ||
    !identifier(value.bindingFacts.runtimeInstanceId) ||
    !validOwner(value.bindingFacts.owner) ||
    value.bindingFacts.owner.runtimeInstanceId !== value.bindingFacts.runtimeInstanceId
  ) {
    throw new Error("invalid_game_runtime_binding_execution");
  }
}

function assertExactEnterPermit(execution: GameRuntimeBindingExecution, permit: ProductionGamePermit): void {
  if (
    !exactPermitShape(permit) ||
    permit.kind !== "enter" ||
    !samePrincipal(permit.principal, execution.principal) ||
    !sameWorld(permit.world, execution.world) ||
    permit.bindingDigest !== execution.bindingFacts.bindingDigest ||
    !sameOwner(permit.owner, execution.bindingFacts.owner)
  ) {
    throw new Error("game_runtime_materialization_permit_rejected");
  }
}

/** S4d close must consume the same live runtime capability, never just a similar request. */
function assertExactClosePermit(enterPermit: ProductionGamePermit, closePermit: ProductionGamePermit): void {
  if (
    !exactPermitShape(closePermit) ||
    closePermit.kind !== "close" ||
    closePermit.principal.continuityId !== enterPermit.principal.continuityId ||
    closePermit.principal.companionId !== enterPermit.principal.companionId ||
    closePermit.principal.playerId !== enterPermit.principal.playerId ||
    closePermit.gameSessionId !== enterPermit.gameSessionId ||
    !sameWorld(closePermit.world, enterPermit.world) ||
    closePermit.bindingDigest !== enterPermit.bindingDigest ||
    !sameOwner(closePermit.owner, enterPermit.owner)
  ) {
    throw new Error("game_runtime_materialization_close_permit_rejected");
  }
}

function exactPermitShape(permit: ProductionGamePermit): boolean {
  return (
    exactRecord(permit, [
      "principal",
      "operationId",
      "requestId",
      "kind",
      "gameSessionId",
      "world",
      "bindingDigest",
      "owner",
      "deadlineAtMs",
      "expected",
      "payloadDigest",
      "fenceToken",
      "prepared",
    ]) &&
    identifier(permit.operationId) &&
    identifier(permit.requestId) &&
    identifier(permit.gameSessionId) &&
    identifier(permit.fenceToken) &&
    isSafeNonNegativeInteger(permit.deadlineAtMs) &&
    Date.now() <= permit.deadlineAtMs &&
    isGameVector(permit.expected) &&
    isGameVector(permit.prepared) &&
    sha256(permit.payloadDigest)
  );
}

function samePrincipal(left: unknown, right: unknown): boolean {
  return (
    exactRecord(left, ["continuityId", "companionId", "playerId"]) &&
    exactRecord(right, ["continuityId", "companionId", "playerId"]) &&
    left.continuityId === right.continuityId &&
    left.companionId === right.companionId &&
    left.playerId === right.playerId
  );
}
function sameWorld(left: unknown, right: unknown): boolean {
  return (
    exactRecord(left, ["integrationId", "saveId", "worldId"]) &&
    exactRecord(right, ["integrationId", "saveId", "worldId"]) &&
    left.integrationId === right.integrationId &&
    left.saveId === right.saveId &&
    left.worldId === right.worldId
  );
}
function sameOwner(left: unknown, right: unknown): boolean {
  return (
    validOwner(left) &&
    validOwner(right) &&
    left.ownerToken === right.ownerToken &&
    left.runtimeInstanceId === right.runtimeInstanceId &&
    left.ownerPid === right.ownerPid &&
    left.ownerProcessStartIdentity === right.ownerProcessStartIdentity
  );
}
function validOwner(value: unknown): value is Record<string, any> {
  return (
    exactRecord(value, ["ownerToken", "runtimeInstanceId", "ownerPid", "ownerProcessStartIdentity"]) &&
    identifier(value.ownerToken) &&
    identifier(value.runtimeInstanceId) &&
    typeof value.ownerPid === "number" &&
    Number.isSafeInteger(value.ownerPid) &&
    value.ownerPid > 0 &&
    identifier(value.ownerProcessStartIdentity)
  );
}
function isGameVector(value: unknown): boolean {
  return (
    exactRecord(value, ["partitionRevision", "gameRevision", "leaseRevision", "fenceEpoch"]) &&
    isSafeNonNegativeInteger(value.partitionRevision) &&
    isSafeNonNegativeInteger(value.gameRevision) &&
    isSafeNonNegativeInteger(value.leaseRevision) &&
    isSafeNonNegativeInteger(value.fenceEpoch)
  );
}
function exactRecord(value: unknown, keys: readonly string[]): value is Record<string, any> {
  if (!isPlainDataObject(value) || !Object.isFrozen(value)) return false;
  const names = Object.getOwnPropertyNames(value);
  return names.length === keys.length && keys.every((key) => names.includes(key));
}
function isPlainDataObject(value: unknown): value is Record<string, any> {
  return (
    isObject(value) &&
    Object.getPrototypeOf(value) === Object.prototype &&
    Object.getOwnPropertySymbols(value).length === 0
  );
}
function isObject(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null;
}
function identifier(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value);
}
function sha256(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}
function isSafeNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
