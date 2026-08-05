import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { connectIntegrationCompanion, disconnectIntegrationCompanion } from "./integration-bootstrap.js";
import { type WorldFact } from "./event-pump.js";
import { RECEIPT_BACKED_INTEGRATION_AUTHORITY, type IntegrationLaunchHandle, type IntegrationLauncher } from "./integration-launcher.js";
import { createIntegrationActionCatalog, type GameIntegrationModule } from "./integration-module.js";

const identity = { playerId: "player_01", companionId: "companion_01", saveId: "save_01", worldId: "world_01" };

function createArcadeLauncher(onLaunch?: (handle: IntegrationLaunchHandle, emitLifecycle: (event: { state: "disconnected" | "stopped"; reasonCode: string }) => void) => void, terminalState: "disconnected" | "stopped" = "disconnected"): IntegrationLauncher {
  const catalog = createIntegrationActionCatalog([
    { actionId: "activate_console", familyId: "interaction", lifecycle: "published", label: "Activate", description: "Activate a live fixture console.", targetKinds: ["console"], requiredCapability: "activate_console" },
  ], (actionId, receipt) => actionId === "activate_console" && receipt.state === "succeeded" && receipt.reasonCode === "console_activated" && receipt.evidence?.postcondition === "active");
  const module: GameIntegrationModule = {
    descriptor: { integrationId: "test-arcade", version: "fixture-v2", toolNamePrefix: "arcade_" },
    actionCatalog: catalog,
    defaultPolicy: { policyVersion: 1, deniedActions: [], deniedFamilies: [] },
    parsePolicy: (value) => value as never,
    assertIdentityBinding: (connection, expected) => {
      if (connection.scope.integrationId !== "test-arcade" || expected.playerId !== identity.playerId || expected.companionId !== identity.companionId) throw new Error("integration_identity_binding_mismatch");
    },
    worldScope: () => ({ integrationId: "test-arcade", saveId: "save_01", worldId: "world_01" }),
    createToolSet: ({ connection }) => ({
      observation: [],
      actions: (connection.state as { connected: boolean }).connected && connection.executionGate?.executable === true
        ? [defineTool({ name: "arcade_activate_console", label: "Activate", description: "Receipt-backed fixture action.", parameters: Type.Object({}), execute: async () => ({ content: [], details: { receiptJson: JSON.stringify({ requestId: "fixture_request", executionId: "fixture_execution", state: "succeeded", reasonCode: "console_activated", evidence: { postcondition: "active" } }) } }) })]
        : [],
      knowledge: [],
    }),
    knowledgeMetadata: () => ({ mounted: false, gameVersion: null, bundleVersion: null }),
    status: () => ({ connected: true, capabilities: ["activate_console"], snapshotRevision: 7, latestReceiptState: null, latestReasonCode: null }),
    readState: () => ({ connected: true, sessionId: "arcade_session", capabilities: ["activate_console"], snapshotRevision: 7, activeExecution: null, latestReceipt: null, latestReasonCode: null }),
    cancelExecution: () => "cancelled",
    parseReceipt: (details) => {
      const receiptJson = (details as { receiptJson?: unknown })?.receiptJson;
      if (typeof receiptJson !== "string") return null;
      const receipt = JSON.parse(receiptJson) as { requestId: string; executionId: string; state: string; reasonCode: string; evidence: Record<string, unknown> };
      return { ...receipt, revision: null };
    },
    actionIdForToolName: (toolName) => toolName === "arcade_activate_console" ? "activate_console" : null,
    isCancellationTool: () => false,
  };
  return {
    integrationId: "test-arcade",
    module,
    async launch(): Promise<IntegrationLaunchHandle> {
      const initialFact: WorldFact = { source: "arcade_adapter", kind: "snapshot", correlationId: "arcade_initial_snapshot", revision: 7, payload: { zone: "alpha" } };
      const executionGate = { executable: true };
      let revoked = false;
      const lifecycleListeners = new Set<(event: { state: "disconnected" | "stopped"; reasonCode: string }) => void>();
      const emitLifecycle = (event: { state: "disconnected" | "stopped"; reasonCode: string }) => { for (const listener of lifecycleListeners) listener(event); };
      const handle: IntegrationLaunchHandle = {
        connection: { scope: { integrationId: "test-arcade" }, module, state: { connected: true }, executionGate },
        events: { onFact: () => () => undefined, onLifecycle: (listener) => { lifecycleListeners.add(listener); return () => lifecycleListeners.delete(listener); } },
        authority: RECEIPT_BACKED_INTEGRATION_AUTHORITY,
        lifecycle: "ready",
        initialFacts: [initialFact],
        revoke(reasonCode) { if (revoked) return; revoked = true; executionGate.executable = false; emitLifecycle({ state: terminalState, reasonCode }); },
        close() { executionGate.executable = false; },
      };
      onLaunch?.(handle, emitLifecycle);
      return handle;
    },
  };
}

test("generic bootstrap mounts a receipt-backed non-Stardew launcher without bridge-v1 types", async () => {
  const root = await mkdtemp(join(tmpdir(), "gamebuddy-arcade-bootstrap-"));
  const connected = await connectIntegrationCompanion({ identity, launcher: createArcadeLauncher(), launcherConfig: { fixture: true }, runtimeRoot: root });
  try {
    assert.equal(connected.launch.connection.scope.integrationId, "test-arcade");
    assert.deepEqual(connected.runtime.session.agent.state.tools.map((tool) => tool.name).sort(), ["arcade_activate_console", "companion_status", "todowrite"]);
    const action = connected.runtime.session.agent.state.tools.find((tool) => tool.name === "arcade_activate_console");
    assert.notEqual(action, undefined);
    const result = await action!.execute("fixture-call", {});
    const receipt = connected.launch.connection.module.parseReceipt(result.details);
    assert.notEqual(receipt, null);
    assert.equal(connected.launch.connection.module.actionCatalog.hasCompletionEvidence("activate_console", receipt!), true);
  } finally {
    disconnectIntegrationCompanion(connected);
  }
});

test("generic bootstrap revokes the adapter execution gate on disconnect", async () => {
  let launched: IntegrationLaunchHandle | undefined;
  const root = await mkdtemp(join(tmpdir(), "gamebuddy-arcade-disconnect-"));
  const connected = await connectIntegrationCompanion({ identity, launcher: createArcadeLauncher((handle) => { launched = handle; }), launcherConfig: {}, runtimeRoot: root });
  try {
    assert.equal(launched?.connection.executionGate?.executable, true);
    const action = connected.runtime.session.agent.state.tools.find((tool) => tool.name === "arcade_activate_console");
    const delegate = connected.runtime.session.agent.state.tools.find((tool) => tool.name === "delegate_gameplay_task");
    assert.notEqual(action, undefined);
    // Recreate with the delegate enabled only for this stale-entrypoint check.
    launched?.revoke("fixture_disconnect");
    assert.equal(launched?.connection.executionGate?.executable, false);
    assert.deepEqual(launched?.connection.module.createToolSet({ connection: launched.connection }).actions, []);
    await assert.rejects(() => action!.execute("post-disconnect", {}), /integration_not_ready/);
    if (delegate !== undefined) await assert.rejects(() => delegate.execute("post-disconnect-delegate", { task: "fixture" }), /integration_not_ready/);
  } finally {
    disconnectIntegrationCompanion(connected);
  }
});

test("generic bootstrap revokes the adapter execution gate on orderly stop", async () => {
  let launched: IntegrationLaunchHandle | undefined;
  let emitStopped: ((event: { state: "disconnected" | "stopped"; reasonCode: string }) => void) | undefined;
  const root = await mkdtemp(join(tmpdir(), "gamebuddy-arcade-stop-"));
  const connected = await connectIntegrationCompanion({ identity, launcher: createArcadeLauncher((handle, emit) => { launched = handle; emitStopped = emit; }), launcherConfig: {}, runtimeRoot: root });
  try {
    const action = connected.runtime.session.agent.state.tools.find((tool) => tool.name === "arcade_activate_console");
    assert.notEqual(action, undefined);
    emitStopped?.({ state: "stopped", reasonCode: "fixture_stop" });
    assert.equal(launched?.connection.executionGate?.executable, false);
    await assert.rejects(() => action!.execute("post-stop", {}), /integration_not_ready/);
  } finally {
    disconnectIntegrationCompanion(connected);
  }
});

test("generic bootstrap closes an integration that fails the receipt-backed gate", async () => {
  let closed = false;
  const launcher = createArcadeLauncher();
  const originalLaunch = launcher.launch;
  const invalidLauncher: IntegrationLauncher = { ...launcher, launch: async (request) => ({ ...(await originalLaunch(request)), authority: { observation: "authoritative", execution: "human_confirmed" } as never, revoke() {}, close() { closed = true; } }) };
  await assert.rejects(
    () => connectIntegrationCompanion({ identity, launcher: invalidLauncher, launcherConfig: {} }),
    /receipt_backed_integration_launch_required/,
  );
  assert.equal(closed, true);
});
