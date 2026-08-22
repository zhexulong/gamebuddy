import assert from "node:assert/strict";
import test from "node:test";
import { TEST_MOD_REGISTRATIONS } from "./stardew-test-fixtures.js";
import {
  createStardewKnowledgeTool,
  decideCapability,
  decideKnowledge,
  formatExecutionForPlayer,
  type KnowledgeBundle,
  parseKnowledgeBundle,
} from "./knowledge.js";
import { STARDEW_INTEGRATION_MODULE } from "./stardew-integration-module.js";

const snapshot = {
  revision: 4,
  location: "Farm",
  tile: { x: 1, y: 2 },
  stamina: 100,
  health: 100,
  actionable: true,
  capabilities: ["move_to_tile"],
  presentationLocale: "en-US",
  activeExecution: null,
} as const;
const bundle: KnowledgeBundle = {
  bundleVersion: 1,
  integrationId: "stardew",
  gameVersion: "1.6.15",
  rules: [
    {
      id: "move-v1",
      integrationId: "stardew",
      gameVersion: "1.6.15",
      capability: "move_to_tile",
      text: "Movement needs a fresh actionable snapshot.",
    },
  ],
};

test("knowledge bundles are versioned, bounded, and fail closed on duplicates or scope drift", () => {
  assert.equal(parseKnowledgeBundle(bundle, "1.6.15").rules.length, 1);
  assert.throws(() => parseKnowledgeBundle(bundle, "1.6.14"), /knowledge_game_version_mismatch/);
  assert.throws(() => parseKnowledgeBundle({ ...bundle, integrationId: "other" }), /invalid_knowledge_bundle/);
  assert.throws(
    () => parseKnowledgeBundle({ ...bundle, rules: [bundle.rules[0], bundle.rules[0]] }),
    /duplicate_knowledge_rule/,
  );
  assert.throws(
    () => parseKnowledgeBundle({ ...bundle, rules: [{ ...bundle.rules[0], gameVersion: "1.6.14" }] }),
    /invalid_knowledge_rule/,
  );
});

test("knowledge remains versioned advice and cannot override live capability facts", () => {
  assert.equal(decideCapability(bundle, snapshot, "move_to_tile", "1.6.15", TEST_MOD_REGISTRATIONS).kind, "supported");
  assert.deepEqual(
    decideCapability(bundle, snapshot, "move_to_tile", "different", TEST_MOD_REGISTRATIONS).reasonCode,
    "knowledge_bundle_not_applicable",
  );
  assert.deepEqual(
    decideCapability(bundle, { ...snapshot, capabilities: [] }, "move_to_tile", "1.6.15", TEST_MOD_REGISTRATIONS).reasonCode,
    "capability_not_declared",
  );
});

test("mounted knowledge exposes advisory rules only for live, version-matched capabilities", async () => {
  const integration = {
    scope: {
      integrationId: "stardew",
      saveId: "save_01",
      worldId: "world_01",
      playerId: "player_01",
      companionId: "companion_01",
    },
    module: STARDEW_INTEGRATION_MODULE,
    gameVersion: "1.6.15",
    knowledge: bundle,
    state: {
      connected: true,
      sessionId: "session_01",
      capabilities: ["move_to_tile"],
      snapshot,
      latestReceipt: null,
      latestReasonCode: null,
        catalogRegistrations: TEST_MOD_REGISTRATIONS,
    },
  };
  const tool = createStardewKnowledgeTool(integration);
  const supported = await tool.execute(
    "knowledge",
    { capability: "move_to_tile" },
    new AbortController().signal,
    () => {},
    {} as never,
  );
  assert.equal((supported.details as { kind: string }).kind, "supported");
  assert.equal((supported.details as { snapshotRevision: number }).snapshotRevision, 4);
  const unavailable = await tool.execute(
    "knowledge",
    { capability: "equip_tool" },
    new AbortController().signal,
    () => {},
    {} as never,
  );
  assert.equal((unavailable.details as { reasonCode: string }).reasonCode, "capability_not_declared");
  integration.gameVersion = "1.6.14";
  const wrongVersion = await tool.execute(
    "knowledge",
    { capability: "move_to_tile" },
    new AbortController().signal,
    () => {},
    {} as never,
  );
  assert.equal((wrongVersion.details as { reasonCode: string }).reasonCode, "knowledge_bundle_not_applicable");
});

test("unmounted knowledge remains unavailable rather than inventing guidance", async () => {
  const integration = {
    scope: {
      integrationId: "stardew",
      saveId: "save_01",
      worldId: "world_01",
      playerId: "player_01",
      companionId: "companion_01",
    },
    module: STARDEW_INTEGRATION_MODULE,
    state: {
      connected: true,
      sessionId: "session_01",
      capabilities: ["move_to_tile"],
      snapshot,
      latestReceipt: null,
      latestReasonCode: null,
        catalogRegistrations: TEST_MOD_REGISTRATIONS,
    },
  };
  const result = await createStardewKnowledgeTool(integration).execute(
    "knowledge",
    { capability: "move_to_tile" },
    new AbortController().signal,
    () => {},
    {} as never,
  );
  assert.equal((result.details as { reasonCode: string }).reasonCode, "knowledge_not_mounted");
});

test("knowledge cannot disclose a denied action or its advisory rules", () => {
  const actionBundle: KnowledgeBundle = {
    bundleVersion: 1,
    integrationId: "stardew",
    gameVersion: "1.6.15",
    rules: [
      {
        id: "equip-v1",
        integrationId: "stardew",
        gameVersion: "1.6.15",
        capability: "equip_tool",
        actionId: "equip_tool",
        topicId: "tools",
        text: "Equip a live tool first.",
      },
    ],
  };
  const denied = decideKnowledge(
    actionBundle,
    { ...snapshot, capabilities: ["equip_tool"] },
    { actionId: "equip_tool" },
    "1.6.15",
    { policyVersion: 1, deniedActions: ["equip_tool"], deniedFamilies: [] },
    TEST_MOD_REGISTRATIONS,
  );
  assert.equal(denied.reasonCode, "action_not_available");
  assert.deepEqual(denied.rules, []);
});

test("execution presentation never calls acceptance or unsupported success a completion", () => {
  assert.match(
    formatExecutionForPlayer({
      executionId: "execution_01",
      requestId: "request_01",
      state: "accepted",
      reasonCode: "accepted",
      revision: 1,
      evidence: null,
    }),
    /尚未完成/,
  );
  assert.match(
    formatExecutionForPlayer({
      executionId: "execution_01",
      requestId: "request_01",
      state: "succeeded",
      reasonCode: "postcondition",
      revision: 2,
      evidence: { detail: "target" },
    }),
    /已完成/,
  );
  assert.match(
    formatExecutionForPlayer({
      executionId: "execution_01",
      requestId: "request_01",
      state: "succeeded",
      reasonCode: "missing_evidence",
      revision: 2,
      evidence: null,
    }),
    /尚未证实/,
  );
});
