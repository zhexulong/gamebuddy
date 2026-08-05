import assert from "node:assert/strict";
import test from "node:test";
import { bindIntegrationIdentity, createIntegrationCatalog, type ConfigurableIntegrationLauncher } from "./integration-catalog.js";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { createIntegrationActionCatalog, type GameIntegrationModule } from "./integration-module.js";
import type { IntegrationConnection } from "./integration-types.js";
import { STARDEW_INTEGRATION_LAUNCHER, parseStardewOperatorConfig } from "./stardew-integration-launcher.js";

function launcher(id = "arcade"): ConfigurableIntegrationLauncher {
  const action = defineTool({ name: "arcade_execute", label: "Execute", description: "Fixture receipt-backed action.", parameters: Type.Object({}), execute: async () => ({ content: [], details: {} }) });
  const module: GameIntegrationModule = {
    descriptor: { integrationId: id, version: "fixture-v1", toolNamePrefix: "arcade_" },
    actionCatalog: createIntegrationActionCatalog([{ actionId: "execute", familyId: "fixture", lifecycle: "published", label: "Execute", description: "Fixture action.", targetKinds: ["fixture"], requiredCapability: "execute" }]),
    defaultPolicy: { policyVersion: 1, deniedActions: [], deniedFamilies: [] },
    parsePolicy: (value) => value as never,
    assertIdentityBinding: () => undefined,
    worldScope: () => ({ integrationId: id, saveId: "fixture-save", worldId: "fixture-world" }),
    createToolSet: () => ({ observation: [], actions: [action], knowledge: [] }),
    knowledgeMetadata: () => ({ mounted: false, gameVersion: null, bundleVersion: null }),
    readState: () => ({ connected: true, sessionId: "fixture", capabilities: ["execute"], snapshotRevision: 1, activeExecution: null, latestReceipt: null, latestReasonCode: null }),
    status: () => ({ connected: true, capabilities: ["execute"], snapshotRevision: 1, latestReceiptState: null, latestReasonCode: null }),
    cancelExecution: () => undefined,
    parseReceipt: () => null,
    actionIdForToolName: (name) => name === "arcade_execute" ? "execute" : null,
    isCancellationTool: () => false,
  };
  return Object.freeze({
    integrationId: id,
    module,
    launch: async () => { throw new Error("fixture_launcher_not_started"); },
    prepare: async (config: unknown) => {
      if (config === null || typeof config !== "object" || Array.isArray(config)) throw new Error("invalid_fixture_config");
      return Object.freeze({ launchConfig: Object.freeze({ fixture: true }), identityScope: Object.freeze({ saveId: "fixture-save", worldId: "fixture-world" }) });
    },
  });
}

test("catalog selects only registered configurable launchers and preserves opaque config", async () => {
  const arcade = launcher();
  const catalog = createIntegrationCatalog([arcade]);
  assert.deepEqual(catalog.ids, ["arcade"]);
  const selected = await catalog.select("arcade", { adapterOnly: true }, { configDirectory: "C:/profile" });
  assert.equal(selected.launcher, arcade);
  assert.equal(selected.prepared.identityScope.saveId, "fixture-save");
  await assert.rejects(() => catalog.select("stardew", {}, { configDirectory: "C:/profile" }), /integration_not_registered/);
  await assert.rejects(() => catalog.select("arcade", {}, { configDirectory: "" }), /invalid_integration_selection/);
});

test("catalog rejects duplicate, malformed, and fixture-free composition errors", () => {
  const arcade = launcher();
  assert.throws(() => createIntegrationCatalog([]), /invalid_integration_catalog/);
  assert.throws(() => createIntegrationCatalog([arcade, arcade]), /invalid_integration_catalog/);
  assert.throws(() => createIntegrationCatalog([{ integrationId: "broken" } as ConfigurableIntegrationLauncher]), /invalid_integration_catalog/);
});

test("Host identity binds only validated adapter scope", () => {
  assert.deepEqual(bindIntegrationIdentity({ playerId: "player", companionId: "companion" }, { saveId: "save", worldId: "world" }), { playerId: "player", companionId: "companion", saveId: "save", worldId: "world" });
  assert.throws(() => bindIntegrationIdentity({ playerId: "player", companionId: "companion" }, {} as never), /invalid_integration_identity_scope/);
  assert.deepEqual(bindIntegrationIdentity({ playerId: "player", companionId: "companion", continuityId: "continuity" }, { saveId: "save", worldId: "world" }), { playerId: "player", companionId: "companion", continuityId: "continuity", saveId: "save", worldId: "world" });
});

test("Stardew adapter alone parses Stardew operator config", () => {
  const parsed = parseStardewOperatorConfig({ saveId: "save", worldId: "world", pipeName: "pipe", bridgeToken: "1234567890abcdef" });
  assert.equal(parsed.saveId, "save");
  assert.throws(() => parseStardewOperatorConfig({ saveId: "save", worldId: "world", pipeName: "pipe", bridgeToken: "1234567890abcdef", unknown: true }), /invalid_stardew_operator_config/);
  assert.equal(STARDEW_INTEGRATION_LAUNCHER.integrationId, "stardew");
});
