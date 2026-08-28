import assert from "node:assert/strict";
import test from "node:test";

import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { normalizeExecutionWake } from "./action-execution-coordinator.internal.js";
import type { WorldFact } from "./event-pump.js";
import {
  assertReceiptBackedLaunch,
  type IntegrationLauncher,
  type IntegrationLaunchHandle,
  RECEIPT_BACKED_INTEGRATION_AUTHORITY,
} from "./integration-launcher.js";
import { createIntegrationActionCatalog, type GameIntegrationModule } from "./integration-module.js";
import type { IntegrationConnection } from "./integration-types.js";
import { STARDEW_INTEGRATION_MODULE } from "./stardew-integration-module.js";

const identity = { playerId: "player_01", companionId: "companion_01", saveId: "save_01", worldId: "world_01" };
const snapshot: WorldFact = {
  source: "arcade_adapter",
  kind: "snapshot",
  correlationId: "snapshot_01",
  revision: 3,
  payload: { zone: "alpha" },
};

function module(): GameIntegrationModule {
  const catalog = createIntegrationActionCatalog(
    [
      {
        actionId: "activate_console",
        familyId: "interaction",
        actionClass: "primitive",
        lifecycle: "published",
        label: "Activate",
        description: "Activate a live console.",
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
  const action = defineTool({
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
  });
  return {
    descriptor: { integrationId: "test-arcade", version: "fixture-v2", toolNamePrefix: "arcade_" },
    actionCatalog: catalog,
    defaultPolicy: { policyVersion: 1, deniedActions: [], deniedFamilies: [] },
    parsePolicy: (value) => value as never,
    actorId: (connection) => {
      if (connection.scope.integrationId !== "test-arcade")
        throw new Error("integration_identity_binding_mismatch");
      return "arcade_actor_01";
    },
    assertIdentityBinding: (connection, boundIdentity) => {
      if (
        connection.scope.integrationId !== "test-arcade" ||
        boundIdentity.companionId !== identity.companionId
      )
        throw new Error("integration_identity_binding_mismatch");
    },
    worldScope: () => ({ integrationId: "test-arcade", saveId: "save_01", worldId: "world_01" }),
    createToolSet: ({ connection, dispatchAdmissionFactory }) => ({
      observation: [],
      actions:
        dispatchAdmissionFactory !== undefined &&
        (connection.state as { connected: boolean }).connected &&
        connection.executionGate?.executable === true
          ? [action]
          : [],
      knowledge: [],
    }),
    knowledgeMetadata: () => ({ mounted: false, gameVersion: null, bundleVersion: null }),
    status: (connection) => ({
      connected: (connection.state as { connected: boolean }).connected,
      capabilities: ["activate_console"],
      snapshotRevision: 3,
      latestReceiptState: null,
      latestReasonCode: null,
    }),
    readState: (connection) => ({
      connected: (connection.state as { connected: boolean }).connected,
      sessionId: "arcade_session",
      capabilities: ["activate_console"],
      registrations: [{
        actionId: "activate_console",
        familyId: "interaction",
        identityVersion: 1,
        lifecycle: "published" as const,
      }],
      snapshotRevision: 3,
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
    actionIdForToolName: (name) => (name === "arcade_activate_console" ? "activate_console" : null),
    isCancellationTool: () => false,
  };
}

function receiptBackedHandle(overrides: Partial<IntegrationLaunchHandle> = {}): {
  launcher: IntegrationLauncher;
  handle: IntegrationLaunchHandle;
} {
  const integrationModule = module();
  const connection: IntegrationConnection = {
    scope: { integrationId: "test-arcade" },
    module: integrationModule,
    state: { connected: true },
    executionGate: { executable: true },
  };
  const handle: IntegrationLaunchHandle = {
    connection,
    events: { onFact: () => () => undefined, onLifecycle: () => () => undefined },
    authority: RECEIPT_BACKED_INTEGRATION_AUTHORITY,
    lifecycle: "ready",
    initialFacts: [snapshot],
    revoke() {},
    close() {},
    ...overrides,
  };
  return { launcher: { integrationId: "test-arcade", module: integrationModule, launch: async () => handle }, handle };
}

test("ExecutionWake normalization accepts only complete adapter projections", () => {
  assert.deepEqual(
    normalizeExecutionWake({
      kind: "terminal",
      requestId: "request_01",
      executionId: "execution_01",
      state: "succeeded",
      reasonCode: "done",
    }),
    { kind: "terminal", requestId: "request_01", executionId: "execution_01", state: "succeeded", reasonCode: "done" },
  );
  assert.deepEqual(normalizeExecutionWake({ kind: "disconnected", reasonCode: "pipe_closed" }), {
    kind: "disconnected",
    reasonCode: "pipe_closed",
  });
  assert.equal(
    normalizeExecutionWake({
      kind: "terminal",
      requestId: "",
      executionId: "x",
      state: "succeeded",
      reasonCode: "done",
    }),
    null,
  );
  assert.equal(normalizeExecutionWake({ kind: "invalidated", reasonCode: "" }), null);
});

test("receipt-backed launcher accepts a publishable non-Stardew action without materializing tools", () => {
  const { launcher, handle } = receiptBackedHandle();
  assert.doesNotThrow(() => assertReceiptBackedLaunch(launcher, handle, identity));
  assert.deepEqual(handle.connection.module.createToolSet({ connection: handle.connection }).actions, []);
});

test("receipt-backed launcher rejects an invalid adapter-authenticated actor", () => {
  const { launcher, handle } = receiptBackedHandle();
  const invalidActorModule = { ...launcher.module, actorId: () => "not valid" };
  const invalidActorHandle = {
    ...handle,
    connection: { ...handle.connection, module: invalidActorModule },
  };
  assert.throws(
    () =>
      assertReceiptBackedLaunch(
        { ...launcher, module: invalidActorModule },
        invalidActorHandle,
        identity,
      ),
    /receipt_backed_integration_actor_required/,
  );
});

test("receipt-backed launcher rejects capability strings without authenticated registrations", () => {
  const { launcher, handle } = receiptBackedHandle();
  const moduleWithoutRegistrations = {
    ...launcher.module,
    readState: (connection: IntegrationConnection) => ({
      ...launcher.module.readState(connection),
      registrations: [],
    }),
  };
  const unregisteredHandle = {
    ...handle,
    connection: { ...handle.connection, module: moduleWithoutRegistrations },
  };
  assert.throws(
    () => assertReceiptBackedLaunch({ ...launcher, module: moduleWithoutRegistrations }, unregisteredHandle, identity),
    /authoritative_initial_state_required/,
  );
});

test("Stardew launch validates catalog/live capability/policy without materializing executable tools", () => {
  let createToolSetCalls = 0;
  const module: GameIntegrationModule = {
    ...STARDEW_INTEGRATION_MODULE,
    createToolSet: (context) => {
      createToolSetCalls++;
      return STARDEW_INTEGRATION_MODULE.createToolSet(context);
    },
  };
  const stardewIdentity = {
    playerId: "player_01",
    companionId: "companion_01",
    saveId: "save_01",
    worldId: "world_01",
  };
  const connection: IntegrationConnection = {
    scope: {
      integrationId: "stardew",
      saveId: stardewIdentity.saveId,
      worldId: stardewIdentity.worldId,
      playerId: stardewIdentity.playerId,
      companionId: stardewIdentity.companionId,
    } as import("./protocol.js").Scope,
    module,
    executionGate: { executable: true },
    state: {
      connected: true,
      sessionId: "stardew_session",
      capabilities: ["move_to_tile"],
      catalogRegistrations: [{
        actionId: "move_to_tile",
        familyId: "movement_navigation",
        identityVersion: 1,
        lifecycle: "published",
        kind: "execution",
      }],
      snapshot: { revision: 7, capabilities: ["move_to_tile"], activeExecution: null },
      latestReceipt: null,
      latestReasonCode: null,
    },
  };
  const handle: IntegrationLaunchHandle = {
    connection,
    events: { onFact: () => () => undefined, onLifecycle: () => () => undefined },
    authority: RECEIPT_BACKED_INTEGRATION_AUTHORITY,
    lifecycle: "ready",
    initialFacts: [
      { source: "stardew_adapter", kind: "snapshot", correlationId: "snapshot_07", revision: 7, payload: {} },
    ],
    revoke() {},
    close() {},
  };
  const launcher: IntegrationLauncher = { integrationId: "stardew", module, launch: async () => handle };
  assert.doesNotThrow(() => assertReceiptBackedLaunch(launcher, handle, stardewIdentity));
  assert.equal(createToolSetCalls, 0);
});

test("launcher rejects a self-attested adapter without a publishable action", () => {
  const { launcher, handle } = receiptBackedHandle();
  const noActionModule = { ...launcher.module, actionCatalog: createIntegrationActionCatalog([]) };
  const noActionLauncher = { ...launcher, module: noActionModule };
  const noActionHandle = { ...handle, connection: { ...handle.connection, module: noActionModule } };
  assert.throws(
    () => assertReceiptBackedLaunch(noActionLauncher, noActionHandle, identity),
    /authoritative_initial_state_required/,
  );
});

test("launcher rejects non-executable authority profiles before tools can mount", () => {
  const { launcher, handle } = receiptBackedHandle({
    authority: { observation: "authoritative", execution: "human_confirmed" } as never,
  });
  assert.throws(
    () => assertReceiptBackedLaunch(launcher, handle, identity),
    /receipt_backed_integration_launch_required/,
  );
});

test("launcher requires a ready connection and matching authoritative initial snapshot", () => {
  const { launcher, handle } = receiptBackedHandle({ initialFacts: [] });
  assert.throws(
    () => assertReceiptBackedLaunch(launcher, handle, identity),
    /receipt_backed_integration_launch_required/,
  );
  const staleBase = receiptBackedHandle();
  const stale = { ...staleBase.handle, initialFacts: [{ ...snapshot, revision: 2 }] };
  assert.throws(
    () => assertReceiptBackedLaunch(staleBase.launcher, stale, identity),
    /authoritative_initial_state_required/,
  );
  const disconnectedBase = receiptBackedHandle();
  const disconnected = {
    ...disconnectedBase.handle,
    connection: { ...disconnectedBase.handle.connection, state: { connected: false } },
  };
  assert.throws(
    () => assertReceiptBackedLaunch(disconnectedBase.launcher, disconnected, identity),
    /authoritative_initial_state_required/,
  );
});

test("launcher rejects module and connection identity drift", () => {
  const { launcher, handle } = receiptBackedHandle({
    connection: { ...receiptBackedHandle().handle.connection, scope: { integrationId: "wrong-game" } },
  });
  assert.throws(
    () => assertReceiptBackedLaunch(launcher, handle, identity),
    /receipt_backed_integration_launch_required/,
  );
});
