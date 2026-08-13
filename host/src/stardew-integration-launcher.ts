import { resolve } from "node:path";
import { type WorldFact } from "./event-pump.js";
import {
  RECEIPT_BACKED_INTEGRATION_AUTHORITY,
  type IntegrationEventSource,
  type IntegrationLauncher,
  type IntegrationLifecycleEvent,
  type IntegrationLaunchHandle,
  type ExecutionWake,
} from "./integration-launcher.js";
import { loadKnowledgeBundle, parseKnowledgeBundle, type KnowledgeBundle } from "./knowledge.js";
import {
  LocalStardewBridgeClient,
  type LocalStardewBridgeFact,
  type LocalStardewConnectionFact,
} from "./local-stardew-bridge.js";
import { type Scope } from "./protocol.js";
import { type ConfigurableIntegrationLauncher, type PreparedIntegrationLaunch } from "./integration-catalog.js";
import { STARDEW_INTEGRATION_MODULE } from "./stardew-integration-module.js";

/** Operator-owned local configuration for the receipt-backed Stardew adapter. */
export type StardewLauncherConfig = Readonly<{
  pipeName: string;
  bridgeToken: string;
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
  module: STARDEW_INTEGRATION_MODULE,
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
    const executionGate = { executable: true };
    let closed = false;
    const bufferedFacts: WorldFact[] = [];
    const bufferedLifecycle: IntegrationLifecycleEvent[] = [];
    const factListeners = new Set<(fact: WorldFact) => void>();
    const lifecycleListeners = new Set<(event: IntegrationLifecycleEvent) => void>();
    const executionWakeListeners = new Set<(wake: ExecutionWake) => void>();
    const publishWake = (wake: ExecutionWake) => {
      for (const listener of executionWakeListeners) listener(wake);
    };
    const disconnect = (reasonCode: string) => {
      if (closed) return;
      // Freeze dispatch and publish exactly one liveness transition before
      // closing transport. bridge.close() may synchronously report its own
      // connection fact, which is suppressed by the closed guard.
      executionGate.executable = false;
      // Seal before notifying listeners so a listener-triggered close or a
      // synchronous transport callback cannot publish a second transition.
      closed = true;
      publishWake(Object.freeze({ kind: "disconnected", reasonCode }));
      const event = Object.freeze({ state: "disconnected" as const, reasonCode });
      bufferedLifecycle.push(event);
      for (const listener of lifecycleListeners) listener(event);
      bridge.close();
    };
    const revoke = (reasonCode: string) => disconnect(reasonCode);
    const removeFact = bridge.onFact((fact) => {
      const converted = toWorldFact(fact);
      if (fact.type === "execution_receipt") {
        const receipt = fact.payload;
        if (receipt.state === "invalidated") {
          // An invalidated receipt means this adapter can no longer admit a
          // subsequent action until a fresh launcher instance is established.
          executionGate.executable = false;
          publishWake(Object.freeze({ kind: "invalidated", reasonCode: receipt.reasonCode }));
        }
        else if (isTerminalReceiptState(receipt.state))
          publishWake(
            Object.freeze({
              kind: "terminal",
              requestId: receipt.requestId,
              executionId: receipt.executionId,
              state: receipt.state,
              reasonCode: receipt.reasonCode,
            }),
          );
      }
      bufferedFacts.push(converted);
      for (const listener of factListeners) listener(converted);
    });
    const removeLifecycle = bridge.onConnectionFact((fact) => revoke(fact.reasonCode));
    try {
      const snapshot = await bridge.observe();
      if (!executionGate.executable) throw new Error("stardew_launch_disconnected");
      // `observe()` is received through the same validated listener as later
      // bridge traffic. Hand that exact snapshot to bootstrap once, so the
      // subscription buffer cannot duplicate it after runtime creation.
      const initialFacts = Object.freeze(bufferedFacts.splice(0));
      if (!initialFacts.some((fact) => fact.kind === "snapshot" && fact.revision === snapshot.revision)) {
        throw new Error("stardew_initial_snapshot_not_observed");
      }
      const events: IntegrationEventSource = Object.freeze({
        onFact: (listener) => {
          for (const fact of bufferedFacts) listener(fact);
          bufferedFacts.length = 0;
          factListeners.add(listener);
          return () => factListeners.delete(listener);
        },
        onLifecycle: (listener) => {
          for (const event of bufferedLifecycle) listener(event);
          bufferedLifecycle.length = 0;
          lifecycleListeners.add(listener);
          return () => lifecycleListeners.delete(listener);
        },
        onExecutionWake: (listener) => {
          executionWakeListeners.add(listener);
          return () => executionWakeListeners.delete(listener);
        },
      });
      const connection = Object.freeze({
        scope,
        module: STARDEW_INTEGRATION_MODULE,
        get state() {
          return bridge.state;
        },
        knowledge: local.knowledge,
        gameVersion: local.gameVersion,
        executionWakeSource: {
          onExecutionWake: (listener: (wake: ExecutionWake) => void) => {
            executionWakeListeners.add(listener);
            return () => executionWakeListeners.delete(listener);
          },
        },
        executionGate,
        execute: (request: Parameters<typeof bridge.execute>[0]) =>
          executionGate.executable ? bridge.execute(request) : Promise.reject(new Error("integration_not_ready")),
        cancel: (requestId: string, executionId: string, reasonCode: string) =>
          executionGate.executable
            ? bridge.cancel(requestId, executionId, reasonCode)
            : Promise.reject(new Error("integration_not_ready")),
      });
      return Object.freeze({
        connection,
        events,
        authority: RECEIPT_BACKED_INTEGRATION_AUTHORITY,
        lifecycle: "ready" as const,
        initialFacts,
        revoke,
        close: () => {
          disconnect("integration_closed");
          removeFact();
          removeLifecycle();
        },
      });
    } catch (error) {
      executionGate.executable = false;
      removeFact();
      removeLifecycle();
      bridge.close();
      throw error;
    }
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
      (key) => key !== "pipeName" && key !== "bridgeToken" && key !== "knowledge" && key !== "gameVersion",
    ) ||
    typeof value.pipeName !== "string" ||
    !/^[A-Za-z0-9_-]{1,128}$/.test(value.pipeName) ||
    typeof value.bridgeToken !== "string" ||
    !/^[A-Za-z0-9_-]{16,256}$/.test(value.bridgeToken) ||
    (value.knowledge !== undefined && value.gameVersion === undefined) ||
    (value.gameVersion !== undefined &&
      (typeof value.gameVersion !== "string" || !/^[A-Za-z0-9_.-]{1,64}$/.test(value.gameVersion)))
  ) {
    throw new Error("invalid_stardew_launcher_config");
  }
  return Object.freeze({
    pipeName: value.pipeName,
    bridgeToken: value.bridgeToken,
    ...(value.knowledge === undefined
      ? {}
      : { knowledge: parseKnowledgeBundle(value.knowledge, value.gameVersion as string) }),
    ...(value.gameVersion === undefined ? {} : { gameVersion: value.gameVersion }),
  });
}

function isTerminalReceiptState(state: string): boolean {
  return ["blocked", "invalidated", "succeeded", "partially_succeeded", "failed", "cancelled", "expired", "rejected", "uncertain"].includes(state);
}

function toWorldFact(message: LocalStardewBridgeFact): WorldFact {
  switch (message.type) {
    case "snapshot":
      return {
        source: "stardew_mod",
        kind: "snapshot",
        eventId: message.messageId,
        occurredAtMs: message.timestampMs,
        correlationId: message.correlationId,
        revision: message.payload.revision,
        payload: message.payload,
      };
    case "execution_receipt":
      return {
        source: "stardew_mod",
        kind: "execution_receipt",
        eventId: message.messageId,
        occurredAtMs: message.timestampMs,
        correlationId: message.payload.executionId,
        revision: message.payload.revision,
        executionId: message.payload.executionId,
        requestId: message.payload.requestId,
        payload: message.payload,
      };
    case "semantic_event":
      return {
        source: "stardew_mod",
        kind: "semantic_event",
        eventId: message.messageId,
        occurredAtMs: message.timestampMs,
        correlationId: message.correlationId,
        revision: message.payload.revision,
        executionId: message.payload.activeExecution?.executionId,
        payload: message.payload,
      };
    case "lifecycle":
      return {
        source: "stardew_mod",
        kind: "lifecycle",
        eventId: message.messageId,
        occurredAtMs: message.timestampMs,
        correlationId: message.correlationId,
        revision: 0,
        payload: message.payload,
      };
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
