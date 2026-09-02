import { AsyncLocalStorage } from "node:async_hooks";

import type { HostDeploymentManifest } from "../deployment-manifest.js";
import {
  bindIntegrationIdentity,
  type ConfigurableIntegrationLauncher,
  type PreparedIntegrationLaunch,
} from "../integration-catalog.js";
import { assertReceiptBackedLaunch, type IntegrationLaunchHandle } from "../integration-launcher.js";
import type { IntegrationWorldScope } from "../game-integration-adapter.js";
import type { CompanionIdentity } from "../runtime.js";
import type {
  ExecutionReceipt,
  ExecutionReceiptQuery,
} from "../protocol.js";
import { isExactReceiptRecoveryPort } from "../stardew-execution-recovery-supervisor.js";
import type { StardewLogicalActionRecoveryJournal } from "../stardew-logical-action-recovery-journal.js";
import {
  assertRuntimeOwnerIdentity,
  drainBindingMaterializations,
  mintBindingToken,
  mintGameRuntimeBindingFacts,
  type GameRuntimeBindingExecution,
  type OpaqueGameRuntimeBindingToken,
  readRuntimeOwnerIdentityRecord,
  revokeBindingToken,
  stopAcceptingBindingMaterialization,
} from "./continuity-semantic-game-runtime-binding.internal.js";
import { createWindowsRuntimeOwnerIdentityPort } from "./continuity-semantic-game-runtime-binding.windows-owner-identity.js";

/**
 * Stable identity for a Stardew recovery record. Runtime lifecycle facts are
 * deliberately absent: they belong to a dispatch attempt, not its recovery
 * record directory or continuity scope.
 */
export type StableGameRuntimeBindingIdentity = Readonly<{
  product: "stardew";
  continuityId: string;
  integrationId: "stardew";
  saveId: string;
  worldId: string;
}>;

// Kept in this module so no internal importer can mint receipt-backed provenance.
const receiptBackedExecutionBrand = new WeakSet<object>();

/** Opaque fresh-binding recovery context; its query capability never reaches GameConnection. */
export type StardewRecoveryBindingContext = Readonly<{
  readonly __stardewRecoveryBindingContext: unique symbol;
}>;

export type StardewRecoveryBindingContextRecord = Readonly<{
  journal: StardewLogicalActionRecoveryJournal;
  identity: StableGameRuntimeBindingIdentity;
  scope: StableGameRuntimeBindingIdentity;
  bindingIdentity: StableGameRuntimeBindingIdentity;
  queryExecutionReceipt(query: ExecutionReceiptQuery): Promise<ExecutionReceipt>;
}>;
const recoveryContextBrand = new WeakSet<object>();
const recoveryContextRecords = new WeakMap<object, StardewRecoveryBindingContextRecord>();


export type {
  OpaqueGameRuntimeBindingToken,
  OpaqueRuntimeOwnerIdentity,
} from "./continuity-semantic-game-runtime-binding.internal.js";
export type { WindowsRuntimeOwnerIdentityPort } from "./continuity-semantic-game-runtime-binding.windows-owner-identity.js";
export { createWindowsRuntimeOwnerIdentityPort } from "./continuity-semantic-game-runtime-binding.windows-owner-identity.js";

/** All authority inputs are construction-owned; no caller may inject an owner proof. */
export type GameRuntimeBindingInput = Readonly<{
  /** The construction root's already canonicalized immutable manifest snapshot. */
  manifest: HostDeploymentManifest;
  /** Selected adapter must derive its own validated save/world scope before launch. */
  launcher: ConfigurableIntegrationLauncher;
  /** Operator-owned config, consumed only by the selected adapter's prepare step. */
  launcherConfig: unknown;
  /** Operator-owned directory passed only to the selected adapter's prepare step. */
  configDirectory: string;
}>;

/** Closed-composition input after an authenticated integration launch already exists. */
export type ReceiptBackedGameRuntimeBindingInput = Readonly<{
  manifest: HostDeploymentManifest;
  launcher: ConfigurableIntegrationLauncher;
  launch: IntegrationLaunchHandle;
  expectedWorld: Readonly<{ saveId: string; worldId: string }>;
}>;

/** The construction-zone result. No adapter, world, manifest, or owner escapes. */
export type GameRuntimeBinding = Readonly<{
  executeWithBinding<T>(callback: (token: OpaqueGameRuntimeBindingToken) => Promise<T> | T): Promise<T>;
  close(): Promise<void>;
}>;

const IDENTIFIER = /^[A-Za-z0-9_-]{1,128}$/;

/**
 * Creates one production Game runtime binding. This is intentionally not an
 * entrypoint or a facade: only the audited Game construction zone may call it.
 */
export async function createGameRuntimeBinding(input: GameRuntimeBindingInput): Promise<GameRuntimeBinding> {
  assertInput(input);
  if (process.platform !== "win32") throw new Error("windows_runtime_owner_identity_required");
  const manifest = input.manifest;
  assertManifestSnapshot(manifest);
  const manifestIdentity = Object.freeze({
    continuityId: manifest.principal.continuityId,
    companionId: manifest.principal.companionId,
    playerId: manifest.principal.playerId,
  });
  const prepared = await input.launcher.prepare(
    input.launcherConfig,
    Object.freeze({ configDirectory: input.configDirectory }),
  );
  assertPreparedLaunch(prepared);
  // Snapshot adapter-owned scope before the asynchronous launch; later validation
  // must compare the connected world against these exact prepared values.
  const preparedScope = Object.freeze({
    saveId: prepared.identityScope.saveId,
    worldId: prepared.identityScope.worldId,
  });
  const identity: CompanionIdentity = bindIntegrationIdentity(manifestIdentity, preparedScope);
  const launch = await input.launcher.launch(Object.freeze({ identity, config: prepared.launchConfig }));
  return createGameRuntimeBindingFromReceiptBackedLaunch(
    Object.freeze({ manifest, launcher: input.launcher, launch, expectedWorld: preparedScope }),
  );
}

/**
 * Consumes one already-authenticated, receipt-backed launch inside a closed
 * production composition. The caller must retain the authoritative world scope
 * that produced the launch; this function independently rechecks every fact.
 */
export async function createGameRuntimeBindingFromReceiptBackedLaunch(
  input: ReceiptBackedGameRuntimeBindingInput,
): Promise<GameRuntimeBinding> {
  try {
    assertReceiptBackedInput(input);
    if (process.platform !== "win32") throw new Error("windows_runtime_owner_identity_required");
    assertManifestSnapshot(input.manifest);
  } catch (error) {
    closeRejectedReceiptBackedLaunch(input);
    throw error;
  }
  const manifestIdentity = Object.freeze({
    continuityId: input.manifest.principal.continuityId,
    companionId: input.manifest.principal.companionId,
    playerId: input.manifest.principal.playerId,
  });
  const identity: CompanionIdentity = bindIntegrationIdentity(manifestIdentity, input.expectedWorld);
  const launch = input.launch;

  let launchClosed = false;
  const revokeAndClose = (reasonCode: string): void => {
    if (launchClosed) return;
    launchClosed = true;
    let firstError: unknown;
    const candidate = launch as unknown;
    try {
      if (isRecord(candidate) && isCallable(candidate.revoke)) candidate.revoke(reasonCode);
    } catch (error) {
      firstError = error;
    }
    try {
      if (isRecord(candidate) && isCallable(candidate.close)) candidate.close();
    } catch (error) {
      if (firstError === undefined) firstError = error;
    }
    if (firstError !== undefined) throw firstError;
  };

  try {
    assertReceiptBackedLaunch(input.launcher, launch, identity);
    const world = exactWorldScope(
      launch.connection.module.worldScope(launch.connection),
      input.launcher.integrationId,
      input.expectedWorld,
    );
    const ownerIdentity = await createWindowsRuntimeOwnerIdentityPort().createCurrentProcessOwnerIdentity();
    assertRuntimeOwnerIdentity(ownerIdentity);
    if (readRuntimeOwnerIdentityRecord(ownerIdentity).processId !== process.pid)
      throw new Error("windows_runtime_owner_identity_mismatch");
    const bindingFacts = mintGameRuntimeBindingFacts({ principal: manifestIdentity, world, ownerIdentity });
    const execution = Object.freeze({
      principal: manifestIdentity,
      runtimeRoot: input.manifest.runtimeRoot,
      connection: launch.connection,
      world,
      launch,
      ownerIdentity,
      bindingFacts,
    });
    receiptBackedExecutionBrand.add(execution);
    let closed = false;
    let active = false;
    let executed = false;
    const callbackScope = new AsyncLocalStorage<OpaqueGameRuntimeBindingToken>();
    let closePromise: Promise<void> | undefined;
    let drainResolve: (() => void) | undefined;
    let drainPromise: Promise<void> | undefined;

    const drain = (): Promise<void> => {
      if (!active) return Promise.resolve();
      return (drainPromise ??= new Promise<void>((resolve) => {
        drainResolve = resolve;
      }));
    };
    const close = async (): Promise<void> => {
      if (callbackScope.getStore() === tokenForClose) throw new Error("game_runtime_binding_close_reentrant");
      if (closePromise !== undefined) return closePromise;
      closed = true;
      // Close admission is the linearization point: no callback that is still
      // draining may begin a new external effect after this call starts.
      stopAcceptingBindingMaterialization(tokenForClose);
      closePromise = (async () => {
        await drain();
        await drainBindingMaterializations(tokenForClose);
        revokeBindingToken(tokenForClose);
        revokeAndClose("game_runtime_binding_closed");
      })();
      return closePromise;
    };
    // Assigned before close can be called by a consumer; this remains private.
    const tokenForClose = mintBindingToken(execution);
    const executeWithBinding = async <T>(
      callback: (token: OpaqueGameRuntimeBindingToken) => Promise<T> | T,
    ): Promise<T> => {
      if (closed || active || executed) throw new Error("game_runtime_binding_unavailable");
      if (typeof callback !== "function") throw new Error("invalid_game_runtime_binding_callback");
      active = true;
      executed = true;
      try {
        return await callbackScope.run(tokenForClose, () => callback(tokenForClose));
      } finally {
        stopAcceptingBindingMaterialization(tokenForClose);
        active = false;
        drainResolve?.();
        drainResolve = undefined;
        drainPromise = undefined;
      }
    };
    return Object.freeze({ executeWithBinding, close });
  } catch (error) {
    try {
      revokeAndClose("game_runtime_binding_validation_failed");
    } catch {
      /* preserve validation failure */
    }
    throw error;
  }
}

/**
 * Projects one validated receipt-backed execution into its cross-Host recovery
 * identity. Membership is private to this construction module and cannot be
 * established by token minting or by constructing a lookalike execution.
 */
export function createStableGameRuntimeBindingIdentity(
  execution: GameRuntimeBindingExecution,
): StableGameRuntimeBindingIdentity {
  if (
    !isRecord(execution) ||
    !Object.isFrozen(execution) ||
    !receiptBackedExecutionBrand.has(execution) ||
    execution.world.integrationId !== "stardew"
  ) {
    throw new Error("invalid_stardew_game_runtime_binding_execution");
  }
  return Object.freeze({
    product: "stardew",
    continuityId: execution.principal.continuityId,
    integrationId: "stardew",
    saveId: execution.world.saveId,
    worldId: execution.world.worldId,
  });
}

/** Binds one Host-owned journal to this exact fresh receipt-backed binding. */
export function createStardewRecoveryBindingContext(
  execution: GameRuntimeBindingExecution,
  journal: StardewLogicalActionRecoveryJournal,
): StardewRecoveryBindingContext {
  const receiptRecovery = execution.launch.receiptRecovery;
  if (!receiptBackedExecutionBrand.has(execution) || !isExactReceiptRecoveryPort(receiptRecovery))
    throw new Error("invalid_stardew_recovery_binding_context");
  const identity = createStableGameRuntimeBindingIdentity(execution);
  if (
    !sameStableIdentity(receiptRecovery.scope, identity) ||
    !sameStableIdentity(receiptRecovery.bindingIdentity, identity)
  ) throw new Error("invalid_stardew_recovery_binding_context");
  const context = Object.freeze(Object.create(null)) as StardewRecoveryBindingContext;
  recoveryContextBrand.add(context);
  recoveryContextRecords.set(context, Object.freeze({
    journal,
    identity,
    scope: receiptRecovery.scope,
    bindingIdentity: receiptRecovery.bindingIdentity,
    queryExecutionReceipt: receiptRecovery.queryExecutionReceipt,
  }));
  return context;
}

/** Internal consumer; structural lookalikes fail closed. */
export function readStardewRecoveryBindingContext(value: unknown): StardewRecoveryBindingContextRecord {
  if (!isRecord(value) || !recoveryContextBrand.has(value) || !Object.isFrozen(value))
    throw new Error("invalid_stardew_recovery_binding_context");
  const record = recoveryContextRecords.get(value);
  if (record === undefined) throw new Error("invalid_stardew_recovery_binding_context");
  return record;
}


/** Validates the exact durable identity shape without admitting runtime facts. */
export function assertStableGameRuntimeBindingIdentity(
  value: unknown,
): asserts value is StableGameRuntimeBindingIdentity {
  if (
    !isFrozenPlainDataObject(value, ["product", "continuityId", "integrationId", "saveId", "worldId"]) ||
    value.product !== "stardew" ||
    value.integrationId !== "stardew" ||
    !identifier(value.continuityId) ||
    !identifier(value.saveId) ||
    !identifier(value.worldId)
  ) {
    throw new Error("invalid_stardew_game_runtime_binding_identity");
  }
}

function sameStableIdentity(left: StableGameRuntimeBindingIdentity, right: StableGameRuntimeBindingIdentity): boolean {
  return (
    left.product === right.product &&
    left.continuityId === right.continuityId &&
    left.integrationId === right.integrationId &&
    left.saveId === right.saveId &&
    left.worldId === right.worldId
  );
}

/** Explicit construction-zone spelling retained for call sites that name the production boundary. */
export const createProductionGameRuntimeBinding = createGameRuntimeBinding;

function exactWorldScope(
  value: unknown,
  integrationId: string,
  expected: Readonly<{ saveId: string; worldId: string }>,
): IntegrationWorldScope {
  if (
    !isRecord(value) ||
    !Object.isFrozen(value) ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    Object.getOwnPropertySymbols(value).length !== 0
  ) {
    throw new Error("integration_world_scope_invalid");
  }
  const names = Object.getOwnPropertyNames(value);
  if (names.length !== 3 || !names.every((key) => ["integrationId", "saveId", "worldId"].includes(key))) {
    throw new Error("integration_world_scope_invalid");
  }
  for (const key of ["integrationId", "saveId", "worldId"] as const) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      !descriptor ||
      !("value" in descriptor) ||
      descriptor.enumerable !== true ||
      descriptor.get !== undefined ||
      descriptor.set !== undefined
    ) {
      throw new Error("integration_world_scope_invalid");
    }
  }
  if (
    value.integrationId !== integrationId ||
    value.saveId !== expected.saveId ||
    value.worldId !== expected.worldId ||
    !identifier(value.integrationId) ||
    !identifier(value.saveId) ||
    !identifier(value.worldId)
  ) {
    throw new Error("integration_world_scope_invalid");
  }
  return Object.freeze({ integrationId: value.integrationId, saveId: value.saveId, worldId: value.worldId });
}

function assertReceiptBackedInput(value: unknown): asserts value is ReceiptBackedGameRuntimeBindingInput {
  if (
    !isRecord(value) ||
    !isRecord(value.manifest) ||
    !isRecord(value.launcher) ||
    typeof value.launcher.integrationId !== "string" ||
    typeof value.launcher.launch !== "function" ||
    !isRecord(value.launch) ||
    !isRecord(value.expectedWorld) ||
    !Object.isFrozen(value.expectedWorld) ||
    Object.getPrototypeOf(value.expectedWorld) !== Object.prototype ||
    Object.getOwnPropertySymbols(value.expectedWorld).length !== 0 ||
    Object.keys(value.expectedWorld).length !== 2 ||
    !Object.hasOwn(value.expectedWorld, "saveId") ||
    !Object.hasOwn(value.expectedWorld, "worldId") ||
    !identifier(value.expectedWorld.saveId) ||
    !identifier(value.expectedWorld.worldId) ||
    Object.keys(value).length !== 4 ||
    !Object.hasOwn(value, "manifest") ||
    !Object.hasOwn(value, "launcher") ||
    !Object.hasOwn(value, "launch") ||
    !Object.hasOwn(value, "expectedWorld")
  ) {
    throw new Error("invalid_receipt_backed_game_runtime_binding_input");
  }
}

function closeRejectedReceiptBackedLaunch(value: unknown): void {
  if (!isRecord(value) || !isRecord(value.launch)) return;
  try {
    if (isCallable(value.launch.revoke)) value.launch.revoke("game_runtime_binding_validation_failed");
  } catch {
    /* preserve validation failure */
  }
  try {
    if (isCallable(value.launch.close)) value.launch.close();
  } catch {
    /* preserve validation failure */
  }
}

function assertInput(value: unknown): asserts value is GameRuntimeBindingInput {
  if (
    !isRecord(value) ||
    !isRecord(value.manifest) ||
    !isRecord(value.launcher) ||
    typeof value.launcher.launch !== "function" ||
    typeof value.launcher.prepare !== "function" ||
    typeof value.configDirectory !== "string" ||
    value.configDirectory.length === 0 ||
    value.configDirectory.includes("\0") ||
    Object.keys(value).length !== 4 ||
    !Object.hasOwn(value, "manifest") ||
    !Object.hasOwn(value, "launcher") ||
    !Object.hasOwn(value, "launcherConfig") ||
    !Object.hasOwn(value, "configDirectory")
  ) {
    throw new Error("invalid_game_runtime_binding_input");
  }
}
function assertManifestSnapshot(value: unknown): asserts value is HostDeploymentManifest {
  if (
    !isRecord(value) ||
    !Object.isFrozen(value) ||
    !isRecord(value.principal) ||
    !Object.isFrozen(value.principal) ||
    typeof value.runtimeRoot !== "string" ||
    !identifier(value.bootstrapOperationId) ||
    !Number.isSafeInteger(value.authorityGeneration) ||
    value.authorityGeneration <= 0 ||
    !identifier(value.principal.continuityId) ||
    !identifier(value.principal.companionId) ||
    !identifier(value.principal.playerId)
  ) {
    throw new Error("invalid_game_runtime_binding_input");
  }
}

function assertPreparedLaunch(value: unknown): asserts value is PreparedIntegrationLaunch {
  if (
    !isRecord(value) ||
    !Object.hasOwn(value, "launchConfig") ||
    !isRecord(value.identityScope) ||
    !identifier(value.identityScope.saveId) ||
    !identifier(value.identityScope.worldId)
  ) {
    throw new Error("invalid_integration_selection");
  }
}
function isFrozenPlainDataObject(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (
    !isRecord(value) ||
    !Object.isFrozen(value) ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    Object.getOwnPropertySymbols(value).length !== 0
  )
    return false;
  const names = Object.getOwnPropertyNames(value);
  if (names.length !== keys.length || !keys.every((key) => names.includes(key))) return false;
  return keys.every((key) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return (
      descriptor !== undefined &&
      "value" in descriptor &&
      descriptor.enumerable === true &&
      descriptor.configurable === false &&
      descriptor.writable === false
    );
  });
}
function identifier(value: unknown): value is string {
  return typeof value === "string" && IDENTIFIER.test(value);
}
function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function isCallable(value: unknown): value is (...args: any[]) => unknown {
  return typeof value === "function";
}
