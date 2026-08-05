import assert from "node:assert/strict";
import test from "node:test";

import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  assertIntegrationModule,
  assertIntegrationModuleConformance,
  createIntegrationActionCatalog,
  type GameIntegrationModule,
  type IntegrationToolContext,
} from "./integration-module.js";
import { STARDEW_INTEGRATION_MODULE } from "./stardew-integration-module.js";
import type { IntegrationConnection } from "./integration-types.js";

const scope = { integrationId: "test-arcade", saveId: "save_01", worldId: "world_01", playerId: "player_01", companionId: "companion_01" } as const;

const fakeCatalog = createIntegrationActionCatalog([
  { actionId: "inspect_zone", familyId: "observation", lifecycle: "published", label: "Inspect zone", description: "Read the current arcade zone.", targetKinds: ["zone"], requiredCapability: "inspect_zone" },
  { actionId: "activate_console", familyId: "interaction", lifecycle: "published", label: "Activate console", description: "Activate a live console.", targetKinds: ["console"], requiredCapability: "activate_console" },
  { actionId: "planned_action", familyId: "future", lifecycle: "planned", label: "Planned", description: "Not yet available.", targetKinds: ["zone"], requiredCapability: "planned_action" },
], (actionId, receipt) => actionId === "activate_console" && receipt.state === "succeeded" && receipt.reasonCode === "console_activated" && receipt.evidence?.postcondition === "active");

function fakeModule(): GameIntegrationModule {
  const inspectZone = defineTool({
    name: "arcade_inspect_zone",
    label: "Inspect arcade zone",
    description: "Read-only fake-game observation.",
    parameters: Type.Object({}),
    execute: async () => ({ content: [{ type: "text" as const, text: "zone" }], details: { zone: "alpha" } }),
  });
  const activateConsole = defineTool({
    name: "arcade_activate_console",
    label: "Activate arcade console",
    description: "Fake integration action used only to verify the Host module seam.",
    parameters: Type.Object({ consoleId: Type.String({ minLength: 1, maxLength: 32 }) }),
    execute: async (_toolCallId, params) => {
      const receipt = { requestId: "arcade_request_01", executionId: "arcade_execution_01", state: "succeeded", reasonCode: "console_activated", revision: 1, evidence: { postcondition: "active", consoleId: params.consoleId } };
      return { content: [{ type: "text" as const, text: JSON.stringify(receipt) }], details: { receiptJson: JSON.stringify(receipt) } };
    },
  });
  return Object.freeze({
    descriptor: Object.freeze({ integrationId: "test-arcade", version: "fixture-v1", toolNamePrefix: "arcade_" }),
    actionCatalog: fakeCatalog,
    defaultPolicy: Object.freeze({ policyVersion: 1 as const, deniedActions: Object.freeze([]), deniedFamilies: Object.freeze([]) }),
    parsePolicy: (value: unknown) => {
      if (typeof value !== "object" || value === null) throw new Error("invalid_test_arcade_policy");
      return value as never;
    },
    createToolSet: (context: IntegrationToolContext) => {
      const state = context.connection.state as { capabilities?: readonly string[] };
      const visible = fakeCatalog.visibleActions(state.capabilities ?? [], context.policy);
      return {
        observation: [inspectZone],
        actions: visible.some((entry) => entry.actionId === "activate_console") ? [activateConsole] : [],
        knowledge: [],
      };
    },
    knowledgeMetadata: () => ({ mounted: false, gameVersion: null, bundleVersion: null }),
    status: (connection) => {
      const state = connection.state as { connected?: boolean; capabilities?: readonly string[] };
      return { connected: state.connected === true, capabilities: state.capabilities ?? [], snapshotRevision: null, latestReceiptState: null, latestReasonCode: null };
    },
    readState: (connection) => {
      const state = connection.state as { connected?: boolean; capabilities?: readonly string[] };
      return { connected: state.connected === true, sessionId: null, capabilities: state.capabilities ?? [], snapshotRevision: null, activeExecution: null, latestReceipt: null, latestReasonCode: null };
    },
    cancelExecution: () => "not_supported",
    parseReceipt: () => null,
    actionIdForToolName: (toolName: string) => toolName === "arcade_activate_console" ? "activate_console" : null,
    isCancellationTool: (toolName: string) => toolName === "arcade_cancel_execution",
  });
}

test("integration action catalog is deterministic, capability gated, and fail closed", () => {
  assert.equal(fakeCatalog.entries.length, 3);
  assert.equal(fakeCatalog.revision, createIntegrationActionCatalog(fakeCatalog.entries, fakeCatalog.hasCompletionEvidence).revision);
  assert.deepEqual(fakeCatalog.visibleActions(["inspect_zone", "planned_action"]).map((entry) => entry.actionId), ["inspect_zone"]);
  assert.deepEqual(fakeCatalog.searchVisibleActions(["inspect_zone"], "console"), []);
  assert.deepEqual(fakeCatalog.visibleActions(["inspect_zone", "activate_console"], { policyVersion: 1, deniedActions: ["activate_console"], deniedFamilies: [] }).map((entry) => entry.actionId), ["inspect_zone"]);
  assert.equal(fakeCatalog.hasCompletionEvidence("activate_console", { state: "succeeded", reasonCode: "console_activated", evidence: { postcondition: "active" } }), true);
  assert.equal(fakeCatalog.hasCompletionEvidence("activate_console", { state: "succeeded", reasonCode: "console_activated", evidence: null }), false);
});

test("catalog rejects duplicate and malformed action descriptors", () => {
  const descriptor = { actionId: "same", familyId: "one", lifecycle: "published" as const, label: "One", description: "One", targetKinds: ["zone"], requiredCapability: "same" };
  assert.throws(() => createIntegrationActionCatalog([descriptor, descriptor]), /duplicate_integration_action/);
  assert.throws(() => createIntegrationActionCatalog([{ ...descriptor, actionId: "bad id" }]), /invalid_integration_action_catalog/);
  assert.throws(() => createIntegrationActionCatalog([{ ...descriptor, lifecycle: "invalid" as never }]), /invalid_integration_action_catalog/);
});

test("module descriptor must match the connection integration identity", () => {
  const module = fakeModule();
  assert.doesNotThrow(() => assertIntegrationModule(module, "test-arcade"));
  assert.throws(() => assertIntegrationModule(module, "stardew"), /integration_module_scope_mismatch/);
  assert.throws(() => assertIntegrationModule({ ...module, parsePolicy: undefined } as never, "test-arcade"), /integration_module_scope_mismatch/);
  assert.throws(() => assertIntegrationModule({ ...module, knowledgeMetadata: undefined } as never, "test-arcade"), /integration_module_scope_mismatch/);
  assert.throws(() => assertIntegrationModule({ ...module, status: undefined } as never, "test-arcade"), /integration_module_scope_mismatch/);
  assert.throws(() => assertIntegrationModule({ ...module, descriptor: { ...module.descriptor, toolNamePrefix: "invalid" } } as never, "test-arcade"), /integration_module_scope_mismatch/);
});

test("module tools require their owning module and scope identity", () => {
  const module = STARDEW_INTEGRATION_MODULE;
  const connection: IntegrationConnection = {
    scope: { integrationId: "stardew", saveId: "save_01", worldId: "world_01", playerId: "player_01", companionId: "companion_01" },
    state: { connected: true, sessionId: "session_01", capabilities: ["move_to_tile"], snapshot: null, latestReceipt: null, latestReasonCode: null },
    module,
  };
  assert.throws(() => assertIntegrationModuleConformance(module, { ...connection, scope: { ...connection.scope, integrationId: "test-arcade" } } as IntegrationConnection), /integration_module_scope_mismatch/);
  assert.throws(() => assertIntegrationModuleConformance(module, { ...connection, module: fakeModule() }), /integration_module_scope_mismatch/);
});

test("fake second-game module owns its tools and does not expose Stardew tools", () => {
  const module = fakeModule();
  const connection: IntegrationConnection = { scope, state: { capabilities: ["activate_console"] }, module };
  const conformance = assertIntegrationModuleConformance(module, connection);
  assert.deepEqual(conformance.toolNames, ["arcade_activate_console", "arcade_inspect_zone"]);
  const tools = module.createToolSet({ connection });
  assert.deepEqual(tools.observation.map((tool) => tool.name), ["arcade_inspect_zone"]);
  assert.deepEqual(tools.actions.map((tool) => tool.name), ["arcade_activate_console"]);
  assert.deepEqual(module.createToolSet({ connection, policy: { policyVersion: 1, deniedActions: ["activate_console"], deniedFamilies: [] } }).actions, []);
  assert.equal(tools.observation.some((tool) => tool.name.startsWith("stardew_")), false);
  assert.equal(tools.actions.some((tool) => tool.name.startsWith("stardew_")), false);
});

test("conformance rejects a module status projection with malformed capabilities", () => {
  const module = fakeModule();
  const connection: IntegrationConnection = { scope, state: { opaque: true }, module: { ...module, status: () => ({ connected: true, capabilities: ["not valid"], snapshotRevision: null, latestReceiptState: null, latestReasonCode: null }) } };
  assert.throws(() => assertIntegrationModuleConformance(connection.module, connection), /integration_status_view_invalid/);
});

test("Stardew and fake catalogs remain isolated", () => {
  const module = fakeModule();
  assert.equal(STARDEW_INTEGRATION_MODULE.descriptor.integrationId, "stardew");
  assert.equal(module.descriptor.integrationId, "test-arcade");
  assert.equal(STARDEW_INTEGRATION_MODULE.actionCatalog.get("activate_console"), undefined);
  assert.equal(module.actionCatalog.get("move_to_tile"), undefined);
});
