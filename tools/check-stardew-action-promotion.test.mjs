import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

import { validatePromotionSources } from "./check-stardew-action-promotion.mjs";
import { STARDEW_PUBLISHED_ACTION_GATES } from "./stardew-action-gate-descriptors.mjs";

const root = resolve(import.meta.dirname, "..");
const sources = await Object.fromEntries(
  await Promise.all(
    [
      ["farmhandActionDefinitions", "integrations/stardew/src/Core/Policy/FarmhandActionDefinitions.cs"],
      ["bridgeSession", "integrations/stardew/BridgeSession.cs"],
      ["executionManager", "integrations/stardew/ExecutionManager.cs"],
      ["farmhandActionRouter", "integrations/stardew/src/Core/Routing/FarmhandActionRouter.cs"],
      ["farmingHandler", "integrations/stardew/Handlers/FarmingActionHandler.cs"],
      ["gatheringHandler", "integrations/stardew/Handlers/GatheringActionHandler.cs"],
      ["movementHandler", "integrations/stardew/Handlers/MovementActionHandler.cs"],
      ["machineHandler", "integrations/stardew/Handlers/MachineAndAnimalActionHandler.cs"],
      ["resourceHandler", "integrations/stardew/Handlers/ResourceToolActionHandler.cs"],
      ["modConfig", "integrations/stardew/ModConfig.cs"],
      ["registry", "host/src/action-registry.ts"],
      ["gameTools", "host/src/game-tools.ts"],
      ["protocol", "host/src/protocol.ts"],
      ["schema", "protocol/bridge-v1.schema.json"],
    ].map(async ([key, path]) => [key, await readFile(resolve(root, path), "utf8")]),
  ),
);

function failuresFor(mutated) {
  const merged = { ...sources, ...mutated };
  const handlerSources = [
    merged.farmingHandler,
    merged.gatheringHandler,
    merged.movementHandler,
    merged.machineHandler,
    merged.resourceHandler,
  ];
  return validatePromotionSources({ ...merged, handlerSources }).failures;
}

test("promotion checker accepts the checked projection", () => {
  assert.deepEqual(failuresFor({}), []);
});

test("promotion checker rejects a subtractive Bridge hello advertisement using Mod-derived published identities", () => {
  const failures = failuresFor({
    bridgeSession: sources.bridgeSession.replace(
      "this.publishedCapabilities.Capabilities, locale",
      'this.publishedCapabilities.Capabilities.Where(capability => capability != "move_to_tile").ToArray(), locale',
    ),
  });

  assert.ok(failures.includes("bridge_hello_advertisement_missing:move_to_tile"));
  assert.equal(failures.includes("hello_not_from_capability_surface"), false);
});

test("promotion checker rejects independent identity, route, tool, and descriptor mutations", () => {
  assert.ok(
    failuresFor({
      registry: sources.registry.replace(
        /"move_to_tile",\r?\n {4}"movement_navigation",/,
        '"move_to_tile",\n    "inventory_items",',
      ),
    }).includes("published_identity_drift:move_to_tile"),
  );
  assert.ok(
    failuresFor({
      registry: sources.registry.replace(
        /publishedAction\(\r?\n {4}"move_to_tile",/,
        'experimentalAction(\n    "move_to_tile",',
      ),
    }).includes("published_identity_drift:move_to_tile"),
  );
  assert.ok(
    failuresFor({
      gameTools: sources.gameTools.replace('if (isVisible("move_to_tile")) {', 'if (isVisible("clear_debris")) {'),
    }).includes("host_tool_count:move_to_tile:0"),
  );
  assert.ok(
    failuresFor({
      gameTools: sources.gameTools.replace(
        'if (isVisible("move_to_tile")) {',
        'if (isVisible("move_to_tile")) {\n  if (isVisible("move_to_tile")) {',
      ),
    }).includes("host_tool_count:move_to_tile:2"),
  );
  assert.ok(
    failuresFor({
      bridgeSession: sources.bridgeSession.replace(
        'else if (request.Action is "pickup_forage" or "pickup_item")',
        'else if (request.Action == "pickup_item")',
      ),
    }).includes("missing_validator:pickup_forage"),
  );
  assert.ok(
    failuresFor({
      movementHandler: sources.movementHandler.replace('"move_to_tile",', '"missing_move_route",'),
    }).includes("missing_dispatcher:move_to_tile"),
  );
  assert.ok(
    failuresFor({
      executionManager: sources.executionManager.replace(
        "            advertisedCapabilities,",
        "            Array.Empty<string>(),",
      ),
    }).includes("snapshot_not_from_capability_surface"),
  );
  assert.ok(
    failuresFor({
      executionManager: sources.executionManager.replace(
        "CreateWorldNotReadyBridgeSnapshot(advertisedCapabilities)",
        "CreateWorldNotReadyBridgeSnapshot(Array.Empty<string>())",
      ),
    }).includes("snapshot_not_from_capability_surface"),
  );
  assert.ok(
    failuresFor({ protocol: sources.protocol.replace('      value.action === "bait_crab_pot" ||\n', "") }).includes(
      "missing_envelope_validator:bait_crab_pot",
    ),
  );
  assert.ok(
    failuresFor({
      protocol: sources.protocol.replace('    | "bait_crab_pot"\n', '    | "orphan_execution_action"\n'),
    }).includes("execution_request_union_not_in_definition:orphan_execution_action"),
  );
  assert.ok(
    failuresFor({ schema: sources.schema.replace('"bait_crab_pot",', '"orphan_execution_action",') }).includes(
      "schema_execution_action_not_in_definition:orphan_execution_action",
    ),
  );
  assert.ok(
    failuresFor({ schema: sources.schema.replace(/^\s*"companion_presentation_request",\r?\n/m, "") }).includes(
      "schema_missing_message_type:companion_presentation_request",
    ),
  );
  assert.ok(
    failuresFor({ protocol: sources.protocol.replace('    | "body_settled"\n', "") }).includes(
      "schema_orphan_semantic_event_kind:body_settled",
    ),
  );
  assert.ok(
    failuresFor({
      schema: sources.schema.replace('"body_settled", "execution_started"', '"execution_started"'),
    }).includes("schema_missing_semantic_event_kind:body_settled"),
  );
  assert.ok(
    failuresFor({ protocol: sources.protocol.replace('    | "bait_crab_pot"\n', "") }).includes(
      "missing_execution_request_union:bait_crab_pot",
    ),
  );
  assert.ok(
    failuresFor({ schema: sources.schema.replace('"bait_crab_pot",', "") }).includes(
      "missing_schema_execution_action:bait_crab_pot",
    ),
  );
  assert.ok(
    failuresFor({
      protocol: sources.protocol.replace('    | "bait_crab_pot"\n', '    | "bait_crab_pot"\n    | "bait_crab_pot"\n'),
    }).includes("execution_request_union_duplicates"),
  );
  assert.ok(
    failuresFor({
      schema: sources.schema.replace('"bait_crab_pot",', '"bait_crab_pot",\n            "bait_crab_pot",'),
    }).includes("schema_execution_action_duplicates"),
  );
  assert.ok(
    failuresFor({
      bridgeSession: sources.bridgeSession.replace(
        'else if (request.Action is "pickup_forage" or "pickup_item")',
        'else if (request.Action == "pickup_item")',
      ),
    }).includes("missing_validator:pickup_forage"),
  );
  assert.ok(
    failuresFor({
      bridgeSession: sources.bridgeSession.replace(
        'else if (request.Action is "pickup_forage" or "pickup_item")',
        'else if (request.Action is "pickup_forage" or "pickup_item" or "undeclared_validator")',
      ),
    }).includes("validator_not_in_definition:undeclared_validator"),
  );
  assert.ok(
    failuresFor({
      resourceHandler: sources.resourceHandler.replace('"equip_tool",', '"undeclared_dispatcher",'),
    }).includes("dispatcher_not_in_definition:undeclared_dispatcher"),
  );
  assert.ok(
    failuresFor({
      resourceHandler: sources.resourceHandler.replace('"equip_tool",', '"move_to_tile",'),
    }).includes("dispatcher_route_duplicates"),
  );
  assert.ok(
    failuresFor({
      farmhandActionDefinitions: sources.farmhandActionDefinitions.replace(
        'Definition("move_to_tile", "movement_navigation", 1),',
        'Definition("move_to_tile", "movement_navigation", 1), Definition("move_to_tile", "movement_navigation", 1),',
      ),
    }).includes("mod_definition_duplicates"),
  );
  assert.ok(
    failuresFor({
      registry: sources.registry.replace(
        /publishedAction\(\r?\n {4}"move_to_tile",/,
        'publishedAction("move_to_tile", "movement_navigation", 1, "Duplicate", "Duplicate", ["tile"]),\n  publishedAction(\n    "move_to_tile",',
      ),
    }).includes("host_registry_duplicates"),
  );
  assert.ok(
    failuresFor({
      gameTools: sources.gameTools.replace(
        'if (isVisible("move_to_tile")) {',
        'if (isVisible("move_to_tile")) {\n  if (isVisible("clear_debris")) {',
      ),
    }).includes("experimental_host_tool:clear_debris"),
  );
  assert.ok(
    failuresFor({
      gameTools: sources.gameTools.replace('action: "move_to_tile",', 'action: "travel",'),
    }).includes("host_tool_adapter_identity_drift:move_to_tile:travel"),
  );
  assert.ok(
    failuresFor({
      gameTools: sources.gameTools.replace(
        "executeGameAction(\n          integration,",
        "executeUnreviewedAction(\n          integration,",
      ),
    }).includes("host_shared_wrapper_factory_invalid"),
  );
  assert.ok(
    failuresFor({
      descriptors: [
        ...STARDEW_PUBLISHED_ACTION_GATES,
        { actionId: "descriptor_only", runner: "none.mjs", terminalReasonCode: "none" },
      ],
    }).includes("gate_descriptor_not_published:descriptor_only"),
  );
});

test("promotion checker rejects missing or reordered Farmhand router guards", () => {
  assert.ok(
    failuresFor({
      farmhandActionRouter: sources.farmhandActionRouter.replace("if (!this.IsOnOwnerThread)", "if (false)"),
    }).includes("router_missing_game_thread_guard"),
  );
  assert.ok(
    failuresFor({
      farmhandActionRouter: sources.farmhandActionRouter.replace(
        "if (ledger.TryGetExistingReceipt(request.RequestId",
        "if (false && ledger.TryGetExistingReceipt(request.RequestId",
      ),
    }).includes("router_missing_replay_guard"),
  );
  assert.ok(
    failuresFor({
      bridgeSession: sources.bridgeSession.replace(
        "if (!IsFreshExecutionRequest(request, out reasonCode)) return false;\n        if (this.idempotency.TryGetValue(",
        "if (this.idempotency.TryGetValue(\n        if (!IsFreshExecutionRequest(request, out reasonCode)) return false;\n        if (this.idempotency.TryGetValue(",
      ),
    }).includes("bridge_session_router_guard_order_invalid"),
  );
  const sessionWithOutOfMethodGuardText = `// if (!IsFreshExecutionRequest(request, out reasonCode)) return false;\n${sources.bridgeSession.replaceAll(
    "if (!IsFreshExecutionRequest(request, out reasonCode)) return false;",
    "if (false) return false;",
  )}`;
  assert.ok(
    failuresFor({ bridgeSession: sessionWithOutOfMethodGuardText }).includes(
      "bridge_session_router_guard_order_invalid",
    ),
  );
});

test("ordinary Farmhand and Portfolio action identities remain bilaterally isolated", () => {
  const portfolioIds = [
    "single_player_sleep_and_advance_day",
    "select_mine_elevator_floor",
    "use_mine_ladder",
    "enter_mine",
  ];
  const definitions = validatePromotionSources(sources).definitions.map((entry) => entry.actionId);
  const hostOrdinaryIds = validatePromotionSources(sources).hostEntries.map((entry) => entry.actionId);
  const descriptorIds = STARDEW_PUBLISHED_ACTION_GATES.map((entry) => entry.actionId);
  const portfolioConfig =
    sources.modConfig.match(/PortfolioActionIds = new HashSet<string>\(\s*new\[\] \{([\s\S]*?)\},/s)?.[1] ?? "";
  for (const id of portfolioIds) {
    assert.equal(definitions.includes(id), false, `Portfolio ID ${id} must not enter ordinary Mod definitions`);
    assert.equal(hostOrdinaryIds.includes(id), false, `Portfolio ID ${id} must not enter Host ordinary registry/tools`);
    assert.equal(descriptorIds.includes(id), false, `Portfolio ID ${id} must not enter ordinary descriptors`);
  }
  for (const id of definitions)
    assert.equal(
      portfolioConfig.includes(`"${id}"`),
      false,
      `ordinary Farmhand ID ${id} must not enter Portfolio allowlist`,
    );
});

test("descriptors are non-authoritative planning metadata", () => {
  const baseline = failuresFor({});
  const descriptorOnly = failuresFor({
    descriptors: [{ actionId: "move_to_tile", runner: "invented.mjs", terminalReasonCode: "succeeded" }],
  });
  assert.deepEqual(baseline, []);
  assert.equal(
    descriptorOnly.some(
      (failure) =>
        failure.startsWith("missing_validator:") ||
        failure.startsWith("missing_dispatcher:") ||
        failure.startsWith("host_tool_count:"),
    ),
    false,
  );
  assert.equal(descriptorOnly.includes("published_missing_gate_descriptor:equip_tool"), true);
});
