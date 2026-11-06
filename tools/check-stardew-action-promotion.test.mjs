import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

import { readDurableLiveEvidence, validatePromotionSources } from "./check-stardew-action-promotion.mjs";
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
      // The Host's own lifecycle admission set, which runs BEFORE every other clause: a lifecycle it drops makes a
      // registration malformed, so no downstream predicate can rescue it. Without this source the whole suite was
      // red on `admission_vocabulary_not_found` while the gate itself was green - the falsifier could not fail for
      // the reason it exists for.
      ["integrationAdapter", "host/src/game-integration-adapter.ts"],
    ].map(async ([key, path]) => [key, await readFile(resolve(root, path), "utf8")]),
  ),
);

// The durable recorded runs, read the same way the CLI's `main()` reads them: the
// lag check is only worth its failure message if it is driven by the real stores.
const evidence = await readDurableLiveEvidence({ root });

/**
 * Flip one live registration back to `experimental` in the catalog text - the real
 * defect this gate exists for, injected at the exact place it happens (a promotion
 * that never landed). Anchored on the registration's own action id so a rename
 * makes the mutation fail loudly instead of silently editing a neighbour.
 */
function flipToExperimental(source, actionId) {
  const mutated = source.replace(
    new RegExp(`(\\bE\\("${actionId}"[^\\n]*?)FarmhandActionLifecycle\\.LiveVerified`),
    "$1FarmhandActionLifecycle.Experimental",
  );
  assert.notEqual(mutated, source, `the mutation must actually apply: ${actionId}`);
  return mutated;
}

function failuresFor(mutated) {
  return validatePromotionSources({ ...sources, promotionEvidence: evidence.receipts, ...mutated }).failures;
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

test("promotion checker rejects a Host admission vocabulary that drops a descriptor-eligible lifecycle", () => {
  // The rule this falsifies is the one that ran in the Host and discarded 66 actions as malformed registrations.
  // It is asserted through the SAME source map the passing case uses, so a mutation here is the only way the
  // admission clause is proven able to fail.
  const dropped = sources.integrationAdapter.replace('  "live_verified",\n', "");
  assert.notEqual(dropped, sources.integrationAdapter, "the mutation must actually apply");
  const failures = failuresFor({ integrationAdapter: dropped });
  assert.ok(failures.includes("admission_vocabulary_missing:live_verified"), JSON.stringify(failures));
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
      // The anchor keys on the CALL, not on the formatter's line breaking: this spelling is
      // written on one line while the call fits and broken across lines when it does not, and a
      // mutation that silently matches nothing reports a checker failure that never happened.
      registry: sources.registry.replace(/actionAdapter\(\s*"move_to_tile",/u, (match) =>
        match.replace('"move_to_tile",', '"missing_adapter",'),
      ),
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
  assert.ok(failuresFor({ farmhandActionRouter: dispatcherGuardRemoved }).includes("router_missing_game_thread_guard"));

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
  assert.equal(
    failures.some((failure) => failure.startsWith("host_tool_count:")),
    false,
  );
  assert.equal(
    failures.some((failure) => failure.startsWith("missing_envelope_validator:")),
    false,
  );
  assert.equal(
    STARDEW_PUBLISHED_ACTION_GATES.some((entry) => entry.actionId === "move_to_tile"),
    true,
  );
});
test("promotion rejects a published target action whose snapshot family the schema omits", () => {
  const schema = JSON.parse(sources.schema);
  delete schema.$defs.snapshot.properties.farmBuildingTargets;
  const failures = failuresFor({ schema: JSON.stringify(schema) });
  assert.ok(
    failures.includes("published_action_missing_snapshot_family:build_farm_building:FarmBuildingTargets"),
    JSON.stringify(failures),
  );
});

test("promotion rejects a target-bearing action with no declared snapshot field", () => {
  const failures = failuresFor({ snapshotTargetField: {} });
  assert.ok(
    failures.includes("published_target_action_missing_snapshot_field:build_farm_building"),
    JSON.stringify(failures),
  );
});

test("promotion rejects an action a recorded receipt already proved and the catalog still calls experimental", () => {
  // The defect this whole ladder keeps producing: the run passed, its receipt is in
  // the corpus, and the status never moved - so the Agent cannot see the action.
  const failures = failuresFor({
    farmhandActionDefinitions: flipToExperimental(sources.farmhandActionDefinitions, "talk_to_npc"),
  });

  assert.ok(
    failures.includes(
      "experimental_action_has_live_evidence:talk_to_npc:host/src/test-fixtures/stardew-live-receipts.json",
    ),
    JSON.stringify(failures),
  );
});

test("promotion rejects a lag whose evidence is a native-local live-run bundle", () => {
  // The second durable store, which is the only one a native-local run can reach:
  // the runner's stdout is ephemeral, so the run is recorded as a
  // `gamebuddy-stardew-native-local-live-run-evidence/v1` bundle or not at all.
  const failures = failuresFor({
    farmhandActionDefinitions: flipToExperimental(sources.farmhandActionDefinitions, "express_emote"),
  });

  assert.ok(
    failures.includes(
      "experimental_action_has_live_evidence:express_emote:integrations/stardew/tests/GameBuddy.Stardew.Integration.Tests/target-version-evidence/expression-native-local-live-run.json",
    ),
    JSON.stringify(failures),
  );
});

test("promotion refuses to check the lag at all when the evidence sources are not supplied", () => {
  const failures = validatePromotionSources({ ...sources }).failures;
  assert.ok(failures.includes("live_evidence_sources_not_supplied"), JSON.stringify(failures));
});

test("a run that did not succeed is not evidence", () => {
  // Only `succeeded` proves the action ran. A blocked or rejected run is the
  // failure the live gate caught, and promoting on it would promote a defect.
  const { failures } = validatePromotionSources({
    ...sources,
    promotionEvidence: [
      { actionId: "pet_farm_animal", state: "blocked", reasonCode: "x", artifact: "a.json" },
      { actionId: "pet_farm_animal", state: "rejected", reasonCode: "y", artifact: "b.json" },
    ],
  });
  assert.deepEqual(
    failures.filter((failure) => failure.startsWith("experimental_action_has_live_evidence:")),
    [],
  );
});

test("the promoted actions' terminals are re-derivable from the recorded runs", () => {
  // This is the evidence rule itself: the status of each of these three is what it
  // is because a run recorded it, not because someone wrote `live_verified`.
  assert.deepEqual(evidence.problems, []);
  const byAction = new Map();
  for (const receipt of evidence.receipts) {
    if (receipt.state !== "succeeded") continue;
    byAction.set(receipt.actionId, receipt);
  }
  const expected = {
    use_mine_ladder: {
      reasonCode: "mine_left",
      artifact:
        "integrations/stardew/tests/GameBuddy.Stardew.Integration.Tests/target-version-evidence/use-mine-ladder-native-local-live-run.json",
    },
    move_placed_furniture: {
      reasonCode: "placed_furniture_picked_up",
      artifact:
        "integrations/stardew/tests/GameBuddy.Stardew.Integration.Tests/target-version-evidence/move-placed-furniture-native-local-live-run.json",
    },
    pet_farm_animal: {
      reasonCode: "farm_animal_petted",
      artifact:
        "integrations/stardew/tests/GameBuddy.Stardew.Integration.Tests/target-version-evidence/pet-farm-animal-native-local-live-run.json",
    },
  };
  for (const [actionId, { reasonCode, artifact }] of Object.entries(expected)) {
    assert.deepEqual(byAction.get(actionId), { actionId, state: "succeeded", reasonCode, artifact });
  }
  const definitions = validatePromotionSources({ ...sources, promotionEvidence: evidence.receipts }).definitions;
  for (const actionId of Object.keys(expected))
    assert.equal(
      definitions.find((definition) => definition.actionId === actionId)?.lifecycle,
      "live_verified",
      `${actionId} is only live_verified because the run above says so`,
    );
});

test("an unreadable evidence store is a failure, not an empty pass", async () => {
  // A renamed corpus that reads as zero receipts would turn the lag check into a
  // silent no-op while the gate still reported a pass.
  const { receipts, problems } = await readDurableLiveEvidence({ root: resolve(root, "tools") });
  assert.deepEqual(receipts, []);
  assert.ok(
    problems.some((problem) => problem.startsWith("live_evidence_corpus_unreadable:")),
    JSON.stringify(problems),
  );
  assert.ok(
    problems.some((problem) => problem.startsWith("live_evidence_directory_unreadable:")),
    JSON.stringify(problems),
  );
});
