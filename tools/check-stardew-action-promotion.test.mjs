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
      ["executionManager", "integrations/stardew/farmhandexecutioncontroller.cs"],
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
        'E("move_to_tile", "movement_navigation", FarmhandActionHandlerGroup.Movement,',
        'E("move_to_tile", "movement_navigation", FarmhandActionHandlerGroup.Movement, A(null, null, "native_action_postcondition", ("x","integer"),("y","integer"))),\n        E("move_to_tile", "movement_navigation", FarmhandActionHandlerGroup.Movement,',
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
        // Constant mount (36608fa): the tool is mounted unconditionally and its
        // `action` id is the visible identity. Renaming it to another action
        // leaves move_to_tile with no tool, which is the drift this asserts.
        '        action: "move_to_tile",',
        '        action: "clear_debris",',
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

  // The router has TWO `!this.IsOnOwnerThread` guards: one in `CanExecute`
  // (:43, off the dispatch path) and one in the dispatching `TryRoute`
  // overload (:78, the one that matters). A plain `String.replace(string, ...)`
  // swaps only the FIRST occurrence, which is CanExecute's -- so this test used
  // to leave the guard that matters intact and then assert the checker reported
  // its removal. That could never pass, and, worse, the checker's own predicate
  // was a file-wide `indexOf`, so neither side was actually testing the guard
  // on the dispatch path.
  //
  // Remove the dispatcher's guard by index, and assert the other guard is left
  // alone (otherwise the mutation would prove nothing about which guard the
  // predicate tracks).
  const guard = "if (!this.IsOnOwnerThread)";
  const firstAt = sources.farmhandActionRouter.indexOf(guard);
  const dispatcherAt = sources.farmhandActionRouter.indexOf(guard, firstAt + 1);
  assert.ok(dispatcherAt > firstAt, "router must keep both the CanExecute and TryRoute guards");
  const dispatcherGuardRemoved =
    sources.farmhandActionRouter.slice(0, dispatcherAt) +
    "if (false)" +
    sources.farmhandActionRouter.slice(dispatcherAt + guard.length);
  assert.ok(
    dispatcherGuardRemoved.includes(guard),
    "removing the dispatcher guard must leave the CanExecute guard in place",
  );
  assert.ok(
    failuresFor({ farmhandActionRouter: dispatcherGuardRemoved }).includes("router_missing_game_thread_guard"),
  );

  // And the converse: removing only the off-path guard must NOT be reported,
  // otherwise the predicate is still just counting occurrences in the file.
  const canExecuteGuardRemoved =
    sources.farmhandActionRouter.slice(0, firstAt) +
    "if (false)" +
    sources.farmhandActionRouter.slice(firstAt + guard.length);
  assert.ok(
    !failuresFor({ farmhandActionRouter: canExecuteGuardRemoved }).includes("router_missing_game_thread_guard"),
    "the predicate must track the dispatch path, not any occurrence in the file",
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
