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
      ["registry", "host/src/action-registry.ts"],
      ["gameTools", "host/src/game-tools.ts"],
      ["protocol", "host/src/protocol.ts"],
      ["schema", "protocol/bridge-v1.schema.json"],
    ].map(async ([key, path]) => [key, await readFile(resolve(root, path), "utf8")]),
  ),
);

function failuresFor(mutated) {
  return validatePromotionSources({ ...sources, ...mutated }).failures;
}

test("promotion checker accepts the Mod-owned registration projection", () => {
  assert.deepEqual(failuresFor({}), []);
});

test("promotion checker rejects a Bridge hello that stops projecting Mod registrations", () => {
  const failures = failuresFor({
    bridgeSession: sources.bridgeSession.replace(
      "FarmhandActionCatalog.Registrations.Select(registration => new FarmhandActionRegistrationWire(",
      "Array.Empty<FarmhandActionRegistration>().Select(registration => new FarmhandActionRegistrationWire(",
    ),
  });

  assert.ok(failures.includes("bridge_hello_registration_advertisement_missing:move_to_tile"));
});

test("promotion checker rejects a duplicate or missing source-owned projection", () => {
  assert.ok(
    failuresFor({
      farmhandActionDefinitions: sources.farmhandActionDefinitions.replace(
        'Registration("move_to_tile", "movement_navigation", 1, FarmhandActionHandlerGroup.Movement),',
        'Registration("move_to_tile", "movement_navigation", 1, FarmhandActionHandlerGroup.Movement),\n        Registration("move_to_tile", "movement_navigation", 1, FarmhandActionHandlerGroup.Movement),',
      ),
    }).includes("mod_definition_duplicates"),
  );
  assert.ok(
    failuresFor({
      registry: sources.registry.replace('actionAdapter(\n    "move_to_tile",', 'actionAdapter(\n    "missing_adapter",'),
    }).includes("published_host_projection:move_to_tile"),
  );
  assert.ok(
    failuresFor({
      gameTools: sources.gameTools.replace(
        'if (isVisible("move_to_tile")) {',
        'if (isVisible("clear_debris")) {',
      ),
    }).includes("host_tool_count:move_to_tile:0"),
  );
});

test("promotion checker preserves transport, schema, and game-thread guard checks", () => {
  assert.ok(
    failuresFor({ protocol: sources.protocol.replace('      value.action === "bait_crab_pot" ||\n', "") }).includes(
      "missing_envelope_validator:bait_crab_pot",
    ),
  );
  assert.ok(
    failuresFor({ schema: sources.schema.replace('"bait_crab_pot",', '"orphan_execution_action",') }).includes(
      "schema_execution_action_not_in_definition:orphan_execution_action",
    ),
  );
  assert.ok(
    failuresFor({
      farmhandActionRouter: sources.farmhandActionRouter.replace("if (!this.IsOnOwnerThread)", "if (false)"),
    }).includes("router_missing_game_thread_guard"),
  );
});

test("gate descriptors remain non-authoritative coverage metadata", () => {
  const failures = failuresFor({
    descriptors: [{ actionId: "move_to_tile", runner: "invented.mjs", terminalReasonCode: "succeeded" }],
  });

  assert.equal(failures.includes("published_missing_gate_descriptor:equip_tool"), true);
  assert.equal(failures.some((failure) => failure.startsWith("host_tool_count:")), false);
  assert.equal(
    failures.some((failure) => failure.startsWith("missing_envelope_validator:")),
    false,
  );
  assert.equal(STARDEW_PUBLISHED_ACTION_GATES.some((entry) => entry.actionId === "move_to_tile"), true);
});
