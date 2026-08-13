import { AsyncLocalStorage } from "node:async_hooks";

import { loadHostDeploymentManifest } from "../deployment-manifest.js";
import {
  bindIntegrationIdentity,
  type ConfigurableIntegrationLauncher,
  type PreparedIntegrationLaunch,
} from "../integration-catalog.js";
import { assertReceiptBackedLaunch, type IntegrationLaunchHandle } from "../integration-launcher.js";
import type { IntegrationWorldScope } from "../integration-module.js";
import type { CompanionIdentity } from "../runtime.js";
import {
  assertRuntimeOwnerIdentity,
  mintBindingToken,
  mintGameRuntimeBindingFacts,
  readRuntimeOwnerIdentityRecord,
  drainBindingMaterializations,
  revokeBindingToken,
  stopAcceptingBindingMaterialization,
  type OpaqueGameRuntimeBindingToken,
  type OpaqueRuntimeOwnerIdentity,
} from "./continuity-semantic-game-runtime-binding.internal.js";
import { createWindowsRuntimeOwnerIdentityPort } from "./continuity-semantic-game-runtime-binding.windows-owner-identity.js";

export type {
  OpaqueGameRuntimeBindingToken,
  OpaqueRuntimeOwnerIdentity,
} from "./continuity-semantic-game-runtime-binding.internal.js";
export { createWindowsRuntimeOwnerIdentityPort } from "./continuity-semantic-game-runtime-binding.windows-owner-identity.js";
export type { WindowsRuntimeOwnerIdentityPort } from "./continuity-semantic-game-runtime-binding.windows-owner-identity.js";

/** All authority inputs are construction-owned; no caller may inject an owner proof. */
export type GameRuntimeBindingInput = Readonly<{
  manifestPath: string;
  /** Selected adapter must derive its own validated save/world scope before launch. */
  launcher: ConfigurableIntegrationLauncher;
  /** Operator-owned config, consumed only by the selected adapter's prepare step. */
  launcherConfig: unknown;
  /** Operator-owned directory passed only to the selected adapter's prepare step. */
  configDirectory: string;
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
  const manifest = await loadHostDeploymentManifest(input.manifestPath);
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
  let launch: IntegrationLaunchHandle;
  try {
    launch = await input.launcher.launch(Object.freeze({ identity, config: prepared.launchConfig }));
  } catch (error) {
    throw error;
  }

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
      preparedScope,
    );
    const ownerIdentity = await createWindowsRuntimeOwnerIdentityPort().createCurrentProcessOwnerIdentity();
    assertRuntimeOwnerIdentity(ownerIdentity);
    if (readRuntimeOwnerIdentityRecord(ownerIdentity).processId !== process.pid)
      throw new Error("windows_runtime_owner_identity_mismatch");
    const bindingFacts = mintGameRuntimeBindingFacts({ principal: manifestIdentity, world, ownerIdentity });
    const execution = Object.freeze({
      principal: manifestIdentity,
      runtimeRoot: manifest.runtimeRoot,
      connection: launch.connection,
      world,
      launch,
      ownerIdentity,
      bindingFacts,
    });
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

function assertInput(value: unknown): asserts value is GameRuntimeBindingInput {
  if (
    !isRecord(value) ||
    typeof value.manifestPath !== "string" ||
    value.manifestPath.length === 0 ||
    !isRecord(value.launcher) ||
    typeof value.launcher.launch !== "function" ||
    typeof value.launcher.prepare !== "function" ||
    typeof value.configDirectory !== "string" ||
    value.configDirectory.length === 0 ||
    value.configDirectory.includes("\0") ||
    Object.keys(value).length !== 4 ||
    !Object.prototype.hasOwnProperty.call(value, "manifestPath") ||
    !Object.prototype.hasOwnProperty.call(value, "launcher") ||
    !Object.prototype.hasOwnProperty.call(value, "launcherConfig") ||
    !Object.prototype.hasOwnProperty.call(value, "configDirectory")
  ) {
    throw new Error("invalid_game_runtime_binding_input");
  }
}
function assertPreparedLaunch(value: unknown): asserts value is PreparedIntegrationLaunch {
  if (
    !isRecord(value) ||
    !Object.prototype.hasOwnProperty.call(value, "launchConfig") ||
    !isRecord(value.identityScope) ||
    !identifier(value.identityScope.saveId) ||
    !identifier(value.identityScope.worldId)
  ) {
    throw new Error("invalid_integration_selection");
  }
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
