import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { connectIntegrationCompanion } from "./integration-bootstrap.js";
import type { HostPresentationAdmissionProvider } from "./presentation.js";
import { type WorldFact } from "./event-pump.js";
import { resolveRuntimePaths } from "./runtime.js";
import {
  RECEIPT_BACKED_INTEGRATION_AUTHORITY,
  type IntegrationLaunchHandle,
  type IntegrationLauncher,
} from "./integration-launcher.js";
import { createIntegrationActionCatalog, type GameIntegrationModule } from "./integration-module.js";

const identity = { playerId: "player_01", companionId: "companion_01", saveId: "save_01", worldId: "world_01" };

function createArcadeLauncher(
  onLaunch?: (
    handle: IntegrationLaunchHandle,
    emitLifecycle: (event: { state: "disconnected" | "stopped"; reasonCode: string }) => void,
  ) => void,
  terminalState: "disconnected" | "stopped" = "disconnected",
  closeFailure?: Error,
  onClose?: () => void,
): IntegrationLauncher {
  const catalog = createIntegrationActionCatalog(
    [
      {
        actionId: "activate_console",
        familyId: "interaction",
        actionClass: "primitive",
        lifecycle: "published",
        label: "Activate",
        description: "Activate a live fixture console.",
        targetKinds: ["console"],
        requiredCapability: "activate_console",
      },
    ],
    (actionId, receipt) =>
      actionId === "activate_console" &&
      receipt.state === "succeeded" &&
      receipt.reasonCode === "console_activated" &&
      receipt.evidence?.postcondition === "active",
  );
  const module: GameIntegrationModule = {
    descriptor: { integrationId: "test-arcade", version: "fixture-v2", toolNamePrefix: "arcade_" },
    actionCatalog: catalog,
    defaultPolicy: { policyVersion: 1, deniedActions: [], deniedFamilies: [] },
    parsePolicy: (value) => value as never,
    assertIdentityBinding: (connection, expected) => {
      if (
        connection.scope.integrationId !== "test-arcade" ||
        expected.playerId !== identity.playerId ||
        expected.companionId !== identity.companionId
      )
        throw new Error("integration_identity_binding_mismatch");
    },
    worldScope: () => ({ integrationId: "test-arcade", saveId: "save_01", worldId: "world_01" }),
    createToolSet: ({ connection }) => ({
      observation: [],
      actions:
        (connection.state as { connected: boolean }).connected && connection.executionGate?.executable === true
          ? [
              defineTool({
                name: "arcade_activate_console",
                label: "Activate",
                description: "Receipt-backed fixture action.",
                parameters: Type.Object({}),
                execute: async () => ({
                  content: [],
                  details: {
                    receiptJson: JSON.stringify({
                      requestId: "fixture_request",
                      executionId: "fixture_execution",
                      state: "succeeded",
                      reasonCode: "console_activated",
                      evidence: { postcondition: "active" },
                    }),
                  },
                }),
              }),
            ]
          : [],
      knowledge: [],
    }),
    knowledgeMetadata: () => ({ mounted: false, gameVersion: null, bundleVersion: null }),
    status: () => ({
      connected: true,
      capabilities: ["activate_console"],
      snapshotRevision: 7,
      latestReceiptState: null,
      latestReasonCode: null,
    }),
    readState: () => ({
      connected: true,
      sessionId: "arcade_session",
      capabilities: ["activate_console"],
      snapshotRevision: 7,
      activeExecution: null,
      latestReceipt: null,
      latestReasonCode: null,
    }),
    cancelExecution: () => "cancelled",
    parseReceipt: (details) => {
      const receiptJson = (details as { receiptJson?: unknown })?.receiptJson;
      if (typeof receiptJson !== "string") return null;
      const receipt = JSON.parse(receiptJson) as {
        requestId: string;
        executionId: string;
        state: string;
        reasonCode: string;
        evidence: Record<string, unknown>;
      };
      return { ...receipt, revision: null };
    },
    actionIdForToolName: (toolName) => (toolName === "arcade_activate_console" ? "activate_console" : null),
    isCancellationTool: () => false,
  };
  return {
    integrationId: "test-arcade",
    module,
    async launch(): Promise<IntegrationLaunchHandle> {
      const initialFact: WorldFact = {
        source: "arcade_adapter",
        kind: "snapshot",
        correlationId: "arcade_initial_snapshot",
        revision: 7,
        payload: { zone: "alpha" },
      };
      const executionGate = { executable: true };
      let revoked = false;
      const lifecycleListeners = new Set<(event: { state: "disconnected" | "stopped"; reasonCode: string }) => void>();
      const emitLifecycle = (event: { state: "disconnected" | "stopped"; reasonCode: string }) => {
        for (const listener of lifecycleListeners) listener(event);
      };
      const handle: IntegrationLaunchHandle = {
        connection: { scope: { integrationId: "test-arcade" }, module, state: { connected: true }, executionGate },
        events: {
          onFact: () => () => undefined,
          onLifecycle: (listener) => {
            lifecycleListeners.add(listener);
            return () => lifecycleListeners.delete(listener);
          },
        },
        authority: RECEIPT_BACKED_INTEGRATION_AUTHORITY,
        lifecycle: "ready",
        initialFacts: [initialFact],
        revoke(reasonCode) {
          if (revoked) return;
          revoked = true;
          executionGate.executable = false;
          emitLifecycle({ state: terminalState, reasonCode });
        },
        close() {
          onClose?.();
          executionGate.executable = false;
          if (closeFailure !== undefined) throw closeFailure;
        },
      };
      onLaunch?.(handle, emitLifecycle);
      return handle;
    },
  };
}

test("receipt-backed Game starts independently while Chat remains active and closes without changing Chat", async () => {
 const root = await mkdtemp(join(tmpdir(), "gamebuddy-independent-bootstrap-")); const continuityIdentity = { ...identity, continuityId: "continuity_01" }; const paths = resolveRuntimePaths(continuityIdentity, root); const chat = await (await import("./continuity.js")).selectContinuitySession(paths, continuityIdentity, { surface: "chat", sessionId: "chat_01" }); const connected = await connectIntegrationCompanion({ identity: continuityIdentity, launcher: createArcadeLauncher(), launcherConfig: {}, runtimeRoot: root }); try { const ledger = await (await import("./continuity.js")).readCurrentContinuityLedger(paths, continuityIdentity.continuityId); assert.equal(ledger.sessions.find((s) => s.sessionId === chat.session.sessionId)?.state, "active"); assert.equal(ledger.sessions.find((s) => s.sessionId === connected.surfaceSession?.sessionId)?.state, "active"); } finally { await connected.close(); } const ledger = await (await import("./continuity.js")).readCurrentContinuityLedger(paths, continuityIdentity.continuityId); assert.equal(ledger.sessions.find((s) => s.sessionId === chat.session.sessionId)?.state, "active"); assert.equal(ledger.sessions.find((s) => s.surface === "game")?.state, "ended");
});
