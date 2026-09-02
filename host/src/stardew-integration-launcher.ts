import { resolve } from "node:path";
import type { ConfigurableIntegrationLauncher, PreparedIntegrationLaunch } from "./integration-catalog.js";
import {
  createStardewIntegrationLaunchHandleFromAuthenticatedBridge,
} from "./stardew-integration-launcher-body-program.internal.js";
import type { IntegrationLaunchHandle } from "./integration-launcher.js";
import { type KnowledgeBundle, loadKnowledgeBundle, parseKnowledgeBundle } from "./knowledge.js";
import { LocalStardewBridgeClient } from "./local-stardew-bridge.js";
import type { Scope } from "./protocol.js";
import { STARDEW_GAME_INTEGRATION_ADAPTER } from "./stardew-game-integration-adapter.js";

export {
  createStardewIntegrationLaunchHandleFromAuthenticatedBridge,
  getAuthenticatedStardewPresentationPortForPreview,
} from "./stardew-integration-launcher-body-program.internal.js";


/** Operator-owned local configuration for the receipt-backed Stardew adapter. */
export type StardewLauncherConfig = Readonly<{
  pipeName: string;
  bridgeToken: string;
  /** Preview-only expected locale from its launcher-owned bounded config. */
  expectedPresentationLocale?: string;
  knowledge?: KnowledgeBundle;
  gameVersion?: string;
}>;

/**
 * The Stardew launcher owns bridge-v1 scope, named-pipe transport, hello, and
 * conversion of validated Mod messages to Host-neutral facts. Host core never
 * imports this type or bridge schema.
 */

export const STARDEW_INTEGRATION_LAUNCHER: ConfigurableIntegrationLauncher = Object.freeze({
  integrationId: "stardew",
  module: STARDEW_GAME_INTEGRATION_ADAPTER,
  async prepare(config, { configDirectory }): Promise<PreparedIntegrationLaunch> {
    const operator = parseStardewOperatorConfig(config);
    const knowledge =
      operator.knowledgeBundlePath === undefined
        ? undefined
        : await loadKnowledgeBundle(resolve(configDirectory, operator.knowledgeBundlePath), operator.gameVersion!);
    return Object.freeze({
      launchConfig: Object.freeze({
        pipeName: operator.pipeName,
        bridgeToken: operator.bridgeToken,
        ...(knowledge === undefined ? {} : { knowledge }),
        ...(operator.gameVersion === undefined ? {} : { gameVersion: operator.gameVersion }),
      }),
      identityScope: Object.freeze({ saveId: operator.saveId, worldId: operator.worldId }),
    });
  },
  async launch({ identity, config }): Promise<IntegrationLaunchHandle> {
    const local = parseStardewLauncherConfig(config);
    if (identity.saveId === undefined || identity.worldId === undefined)
      throw new Error("stardew_identity_scope_required");
    const scope: Scope = {
      integrationId: "stardew",
      saveId: identity.saveId,
      worldId: identity.worldId,
      playerId: identity.playerId,
      companionId: identity.companionId,
    };
    const bridge = await LocalStardewBridgeClient.connect(
      scope,
      local.pipeName,
      local.bridgeToken,
      local.knowledge,
      local.gameVersion,
    );
    return createStardewIntegrationLaunchHandleFromAuthenticatedBridge(bridge, identity, local);
  },
});


export type StardewOperatorConfig = Readonly<{
  pipeName: string;
  bridgeToken: string;
  saveId: string;
  worldId: string;
  knowledgeBundlePath?: string;
  gameVersion?: string;
}>;

/** Strict adapter-owned operator config; Host sees only opaque config. */
export function parseStardewOperatorConfig(value: unknown): StardewOperatorConfig {
  if (
    !isRecord(value) ||
    Object.keys(value).some(
      (key) =>
        key !== "pipeName" &&
        key !== "bridgeToken" &&
        key !== "saveId" &&
        key !== "worldId" &&
        key !== "knowledgeBundlePath" &&
        key !== "gameVersion",
    ) ||
    typeof value.pipeName !== "string" ||
    !/^[A-Za-z0-9_-]{1,128}$/.test(value.pipeName) ||
    typeof value.bridgeToken !== "string" ||
    !/^[A-Za-z0-9_-]{16,256}$/.test(value.bridgeToken) ||
    typeof value.saveId !== "string" ||
    !/^[A-Za-z0-9_-]{1,128}$/.test(value.saveId) ||
    typeof value.worldId !== "string" ||
    !/^[A-Za-z0-9_-]{1,128}$/.test(value.worldId) ||
    (value.knowledgeBundlePath !== undefined &&
      (typeof value.knowledgeBundlePath !== "string" ||
        value.knowledgeBundlePath.length === 0 ||
        value.knowledgeBundlePath.length > 512)) ||
    (value.gameVersion !== undefined &&
      (typeof value.gameVersion !== "string" || !/^[A-Za-z0-9_.-]{1,64}$/.test(value.gameVersion))) ||
    (value.knowledgeBundlePath === undefined) !== (value.gameVersion === undefined)
  ) {
    throw new Error("invalid_stardew_operator_config");
  }
  return Object.freeze({
    pipeName: value.pipeName,
    bridgeToken: value.bridgeToken,
    saveId: value.saveId,
    worldId: value.worldId,
    ...(value.knowledgeBundlePath === undefined ? {} : { knowledgeBundlePath: value.knowledgeBundlePath }),
    ...(value.gameVersion === undefined ? {} : { gameVersion: value.gameVersion }),
  });
}

export function parseStardewLauncherConfig(value: unknown): StardewLauncherConfig {
  if (
    !isRecord(value) ||
    Object.keys(value).some(
      (key) =>
        key !== "pipeName" &&
        key !== "bridgeToken" &&
        key !== "expectedPresentationLocale" &&
        key !== "knowledge" &&
        key !== "gameVersion",
    ) ||
    typeof value.pipeName !== "string" ||
    !/^[A-Za-z0-9_-]{1,128}$/.test(value.pipeName) ||
    typeof value.bridgeToken !== "string" ||
    !/^[A-Za-z0-9_-]{16,256}$/.test(value.bridgeToken) ||
    (value.expectedPresentationLocale !== undefined &&
      (typeof value.expectedPresentationLocale !== "string" ||
        !/^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{2,16}){0,3}$/.test(value.expectedPresentationLocale))) ||
    (value.knowledge !== undefined && value.gameVersion === undefined) ||
    (value.gameVersion !== undefined &&
      (typeof value.gameVersion !== "string" || !/^[A-Za-z0-9_.-]{1,64}$/.test(value.gameVersion)))
  ) {
    throw new Error("invalid_stardew_launcher_config");
  }
  return Object.freeze({
    pipeName: value.pipeName,
    bridgeToken: value.bridgeToken,
    ...(value.expectedPresentationLocale === undefined
      ? {}
      : { expectedPresentationLocale: value.expectedPresentationLocale }),
    ...(value.knowledge === undefined
      ? {}
      : { knowledge: parseKnowledgeBundle(value.knowledge, value.gameVersion as string) }),
    ...(value.gameVersion === undefined ? {} : { gameVersion: value.gameVersion }),
  });
}


function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
