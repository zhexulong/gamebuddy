import { type WorldFact } from "./event-pump.js";
import {
  RECEIPT_BACKED_INTEGRATION_AUTHORITY,
  type IntegrationEventSource,
  type IntegrationLauncher,
  type IntegrationLifecycleEvent,
  type IntegrationLaunchHandle,
} from "./integration-launcher.js";
import { parseKnowledgeBundle, type KnowledgeBundle } from "./knowledge.js";
import { LocalStardewBridgeClient, type LocalStardewBridgeFact, type LocalStardewConnectionFact } from "./local-stardew-bridge.js";
import { type Scope } from "./protocol.js";
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
export const STARDEW_INTEGRATION_LAUNCHER: IntegrationLauncher = Object.freeze({
  integrationId: "stardew",
  module: STARDEW_INTEGRATION_MODULE,
  async launch({ identity, config }): Promise<IntegrationLaunchHandle> {
    const local = parseStardewLauncherConfig(config);
    if (identity.saveId === undefined || identity.worldId === undefined) throw new Error("stardew_identity_scope_required");
    const scope: Scope = {
      integrationId: "stardew",
      saveId: identity.saveId,
      worldId: identity.worldId,
      playerId: identity.playerId,
      companionId: identity.companionId,
    };
    const bridge = await LocalStardewBridgeClient.connect(scope, local.pipeName, local.bridgeToken, local.knowledge, local.gameVersion);
    const executionGate = { executable: true };
    let closed = false;
    const bufferedFacts: WorldFact[] = [];
    const bufferedLifecycle: IntegrationLifecycleEvent[] = [];
    const factListeners = new Set<(fact: WorldFact) => void>();
    const lifecycleListeners = new Set<(event: IntegrationLifecycleEvent) => void>();
    const revoke = (reasonCode: string) => {
      if (closed) return;
      // Mark before transport.close(), whose synchronous close callback may
      // re-enter this function. The closed gate is the first safety boundary.
      closed = true;
      executionGate.executable = false;
      bridge.close();
      const event = Object.freeze({ state: "disconnected" as const, reasonCode });
      bufferedLifecycle.push(event);
      for (const listener of lifecycleListeners) listener(event);
    };
    const removeFact = bridge.onFact((fact) => {
      const converted = toWorldFact(fact);
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
      });
      const connection = Object.freeze({
        scope,
        module: STARDEW_INTEGRATION_MODULE,
        get state() { return bridge.state; },
        knowledge: local.knowledge,
        gameVersion: local.gameVersion,
        executionGate,
        execute: (request: Parameters<typeof bridge.execute>[0]) => executionGate.executable ? bridge.execute(request) : Promise.reject(new Error("integration_not_ready")),
        cancel: (requestId: string, executionId: string, reasonCode: string) => executionGate.executable ? bridge.cancel(requestId, executionId, reasonCode) : Promise.reject(new Error("integration_not_ready")),
      });
      return Object.freeze({
        connection,
        events,
        authority: RECEIPT_BACKED_INTEGRATION_AUTHORITY,
        lifecycle: "ready" as const,
        initialFacts,
        revoke,
        close: () => { if (!closed) { executionGate.executable = false; closed = true; } removeFact(); removeLifecycle(); bridge.close(); },
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

export function parseStardewLauncherConfig(value: unknown): StardewLauncherConfig {
  if (!isRecord(value)
    || Object.keys(value).some((key) => key !== "pipeName" && key !== "bridgeToken" && key !== "knowledge" && key !== "gameVersion")
    || typeof value.pipeName !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(value.pipeName)
    || typeof value.bridgeToken !== "string" || !/^[A-Za-z0-9_-]{16,256}$/.test(value.bridgeToken)
    || (value.knowledge !== undefined && value.gameVersion === undefined)
    || (value.gameVersion !== undefined && (typeof value.gameVersion !== "string" || !/^[A-Za-z0-9_.-]{1,64}$/.test(value.gameVersion)))) {
    throw new Error("invalid_stardew_launcher_config");
  }
  return Object.freeze({
    pipeName: value.pipeName,
    bridgeToken: value.bridgeToken,
    ...(value.knowledge === undefined ? {} : { knowledge: parseKnowledgeBundle(value.knowledge, value.gameVersion as string) }),
    ...(value.gameVersion === undefined ? {} : { gameVersion: value.gameVersion }),
  });
}

function toWorldFact(message: LocalStardewBridgeFact): WorldFact {
  switch (message.type) {
    case "snapshot":
      return { source: "stardew_mod", kind: "snapshot", eventId: message.messageId, occurredAtMs: message.timestampMs, correlationId: message.correlationId, revision: message.payload.revision, payload: message.payload };
    case "execution_receipt":
      return { source: "stardew_mod", kind: "execution_receipt", eventId: message.messageId, occurredAtMs: message.timestampMs, correlationId: message.payload.executionId, revision: message.payload.revision, executionId: message.payload.executionId, requestId: message.payload.requestId, payload: message.payload };
    case "semantic_event":
      return { source: "stardew_mod", kind: "semantic_event", eventId: message.messageId, occurredAtMs: message.timestampMs, correlationId: message.correlationId, revision: message.payload.revision, executionId: message.payload.activeExecution?.executionId, payload: message.payload };
    case "lifecycle":
      return { source: "stardew_mod", kind: "lifecycle", eventId: message.messageId, occurredAtMs: message.timestampMs, correlationId: message.correlationId, revision: 0, payload: message.payload };
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
