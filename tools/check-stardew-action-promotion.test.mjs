import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

import {
  findPlaceholderWritePostconditions,
  readDurableLiveEvidence,
  readWritePostconditionBaseline,
  validatePromotionSources,
} from "./check-stardew-action-promotion.mjs";
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
//
// red-proof: inject  reverting rotate_furniture's postcondition to the generic
//   `native_action_postcondition` while no baseline entry records it ->
//   `write_postcondition_placeholder:rotate_furniture:handler_reads=rotation+rotations`
//   (tools/check-stardew-action-promotion.test.mjs)
const evidence = await readDurableLiveEvidence({ root });

// The write-postcondition rule's two inputs, read the way the CLI reads them: the
// generated surface and the recorded debt. A suite that supplied its own copies
// would prove the rule against a tree that does not exist.
const surfaceSource = await readFile(
  resolve(root, "integrations/stardew/action-development/contracts/generated/action-surface.v1.json"),
  "utf8",
);
const surface = JSON.parse(surfaceSource);
const writePostconditionBaseline = readWritePostconditionBaseline(
  await readFile(resolve(root, "tools/stardew-write-postcondition-baseline.json"), "utf8"),
);

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
  return validatePromotionSources({
    ...sources,
    promotionEvidence: evidence.receipts,
    surface,
    writePostconditionBaseline,
    ...mutated,
  }).failures;
}

test("promotion checker accepts the Mod-owned registration projection", () => {
  assert.deepEqual(failuresFor({}), []);
});

test("promotion checker rejects a Bridge hello that stops projecting Mod registrations", () => {
  const failures = failuresFor({
    bridgeSession: sources.bridgeSession.replace(
      "FarmhandActionCatalog.Registrations.Concat(FarmhandPlanFormCatalog.Registrations).Select(registration => new FarmhandActionRegistrationWire(",
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

test("the Host request validator's population is its own declaration, and a reader that reads nothing is blocked", () => {
  // The reading used to harvest `value.action !== "…"` comparisons out of a chain anchored between two functions. The
  // validator is a lookup over `EXECUTION_REQUEST_ARGUMENT_RULES` now, so the falsifier has to drive the ways a
  // source-derived reader stops working - and assert the one thing the old shape got wrong: a reader that reads nothing
  // must report THAT, not one finding per action.
  const renamed = sources.protocol.replace(
    "export const EXECUTION_REQUEST_ARGUMENT_RULES",
    "export const RENAMED_REQUEST_RULES",
  );
  assert.notEqual(renamed, sources.protocol, "the mutation must actually apply");
  const unreadable = failuresFor({ protocol: renamed });
  assert.ok(
    unreadable.includes("host_request_declaration_not_found:EXECUTION_REQUEST_ARGUMENT_RULES"),
    JSON.stringify(unreadable),
  );
  assert.deepEqual(
    unreadable.filter((failure) => failure.startsWith("missing_host_request_validator:")),
    [],
    "a declaration nobody could read is one blocked reading, not every action losing its validator",
  );

  // An action id the union still declares and the table lost is named on both readings rather than resolved by
  // preferring one of them.
  const dropped = sources.protocol.replace(/^ {2}move_to_tile: \[.*$/mu, "");
  assert.notEqual(dropped, sources.protocol, "the mutation must actually apply");
  assert.ok(failuresFor({ protocol: dropped }).includes("host_request_declaration_missing:move_to_tile"));
});

test("every action the Host's declaration carries has argument rules, and none of them is empty", () => {
  const result = validatePromotionSources({
    ...sources,
    promotionEvidence: evidence.receipts,
    surface,
    writePostconditionBaseline,
  });
  assert.deepEqual(result.failures, []);
  assert.ok(
    result.hostRequestDeclaration.actions > 90,
    `the declaration must have been read (found ${result.hostRequestDeclaration.actions} actions)`,
  );
  assert.equal(
    result.hostRequestDeclaration.withArgumentRules,
    result.hostRequestDeclaration.actions,
    "an action id with no argument rule is an action the Host admits with nothing checked",
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

//
// A WRITE ACTION'S POSTCONDITION MUST NAME WHAT WAS RE-READ
//
// Until this, a write action could declare `native_action_postcondition` - a name that
// names nothing - and promotion never asked which engine member a handler re-reads to
// prove the effect happened. The cases below are the two ways the rule can be false: a
// placeholder the baseline does not record, and a baseline entry that outlived its own
// action. The engine member a finding names comes from the observation-gap report's
// section H reader (`handlerFieldReads`), imported by the gate rather than re-derived.
//
function surfaceWith(actionId, postconditionName) {
  const mutated = JSON.parse(surfaceSource);
  const action = mutated.actions.find((entry) => entry.actionId === actionId);
  assert.ok(action !== undefined, `the surface must carry ${actionId}`);
  action.postcondition = { name: postconditionName };
  return mutated;
}

test("the real tree's write postconditions pass, and the population is every write action", () => {
  const report = findPlaceholderWritePostconditions({
    surface: JSON.parse(surfaceSource),
    baseline: writePostconditionBaseline,
  });
  assert.deepEqual(report.findings, [], JSON.stringify(report.findings));
  const writeActions = JSON.parse(surfaceSource).actions.filter((action) => action.effect === "write");
  assert.equal(report.checked, writeActions.length, "every write action is examined, read-only ones are not");
  assert.ok(report.checked > 90, `the population must be the whole write surface, measured ${report.checked}`);
  assert.equal(report.specific + report.placeholders, report.checked, "the two kinds partition the population");
  assert.ok(report.placeholders > 0, "the recorded debt is what this tree actually carries");
});

test("a placeholder the baseline does not record is refused by name, with the member the handler reads", () => {
  // rotate_furniture names `furniture_rotated` today, so reverting it to the generic
  // name is the real regression: a specific claim replaced by one that names nothing.
  const report = findPlaceholderWritePostconditions({
    surface: surfaceWith("rotate_furniture", "native_action_postcondition"),
    baseline: writePostconditionBaseline,
    engineFacts: (actionId) => (actionId === "rotate_furniture" ? ["rotation", "rotations"] : []),
  });
  assert.deepEqual(
    report.findings.filter((finding) => finding.startsWith("write_postcondition_placeholder:")),
    ["write_postcondition_placeholder:rotate_furniture:handler_reads=rotation+rotations"],
    JSON.stringify(report.findings),
  );
});

test("a recorded placeholder passes, and an entry whose action names a member again is stale", () => {
  const recorded = writePostconditionBaseline.entries.find((entry) => entry === "till_soil");
  assert.equal(recorded, "till_soil", "till_soil is the measured placeholder this case uses");
  const recordedSurface = JSON.parse(surfaceSource);
  assert.deepEqual(
    findPlaceholderWritePostconditions({ surface: recordedSurface, baseline: writePostconditionBaseline }).findings,
    [],
  );
  // The other direction: give the action a specific name and keep its debt entry.
  assert.deepEqual(
    findPlaceholderWritePostconditions({
      surface: surfaceWith("till_soil", "soil_tilled"),
      baseline: writePostconditionBaseline,
    }).findings,
    ["stale_write_postcondition_debt:till_soil"],
  );
});

test("a baseline entry for an action the surface no longer carries is stale, not silently dropped", () => {
  const report = findPlaceholderWritePostconditions({
    surface: surfaceWith("move_to_tile", "target_reached"),
    baseline: {
      reason: writePostconditionBaseline.reason,
      entries: [...writePostconditionBaseline.entries, "an_action_that_left_the_surface"],
    },
  });
  assert.ok(report.findings.includes("stale_write_postcondition_debt:move_to_tile"), JSON.stringify(report.findings));
  assert.ok(
    report.findings.includes("write_postcondition_debt_unknown_action:an_action_that_left_the_surface"),
    JSON.stringify(report.findings),
  );
});

test("an unreadable or unreasoned baseline is a finding, never an empty pass", () => {
  assert.equal(readWritePostconditionBaseline("{not json").problem, "write_postcondition_baseline_malformed");
  assert.equal(
    readWritePostconditionBaseline(JSON.stringify({ schema: "other/v1", entries: [] })).problem,
    "write_postcondition_baseline_schema_mismatch",
  );
  assert.equal(
    readWritePostconditionBaseline(
      JSON.stringify({ schema: "gamebuddy-stardew-write-postcondition-baseline/v1", entries: ["a"] }),
    ).problem,
    "write_postcondition_baseline_unreasoned",
  );
  assert.equal(
    readWritePostconditionBaseline(
      JSON.stringify({
        schema: "gamebuddy-stardew-write-postcondition-baseline/v1",
        reason: "because",
        entries: ["a", "a"],
      }),
    ).problem,
    "write_postcondition_baseline_duplicates",
  );
});

test("the promotion gate refuses to run the postcondition check without its inputs", () => {
  const missingSurface = validatePromotionSources({
    ...sources,
    promotionEvidence: evidence.receipts,
    surface: undefined,
  }).failures;
  assert.ok(missingSurface.includes("action_surface_not_supplied"), JSON.stringify(missingSurface));
  const missingBaseline = validatePromotionSources({
    ...sources,
    promotionEvidence: evidence.receipts,
    writePostconditionBaseline: undefined,
  }).failures;
  assert.ok(missingBaseline.includes("write_postcondition_baseline_not_supplied"), JSON.stringify(missingBaseline));
});
