import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import {
  adHocContract,
  CAPABILITY_SET_PATH,
  deriveActionFacts,
  loadSmokeContractFile,
  readActionSurface,
  readProtocolControls,
  SMOKE_CONTRACT_SCHEMA,
  validateSmokeContract,
} from "./lib/stardew-action-smoke-contract.mjs";
import { publishedActionRegistrations } from "./lib/stardew-native-smoke-harness-v1.mjs";
import { chooseTarget, judgeSlice, runActionSlice } from "./run-native-action-slice.mjs";
import { runAcceptDailyQuestSmoke } from "./run-stardew-native-local-player-accept-daily-quest-smoke.mjs";
import { runAcceptSpecialOrderSmoke } from "./run-stardew-native-local-player-accept-special-order-smoke.mjs";
import { runToggleAnimalDoorSmoke } from "./run-stardew-native-local-player-toggle-animal-door-smoke.mjs";
import { STARDEW_PUBLISHED_ACTION_GATES } from "./stardew-action-gate-descriptors.mjs";

/**
 * The engine and the three hand-written runners it must agree with.
 *
 * THE AGREEMENT IS THE POINT. Each case below builds ONE fake world, drives the hand-written runner over it, then
 * drives the contract engine over an identical world, and asserts the two verdicts are the same - so the day a
 * runner changes an assertion the contract does not make, this fails instead of the contract quietly passing.
 *
 * The transport is a fake for the same reason the runners' own tests use one: the bridge is a boundary this tree
 * does not own, and every assertion here is about the engine's own orchestration and judgement.
 */

const CONTRACTS_DIR = join(import.meta.dirname, "..", "contracts", "smoke");

/**
 * One fake world per action: `execute` answers the way the native seam would, moving the world only when the
 * request named the target the world actually holds.
 */
function makeWorld(kind) {
  const receipts = [];
  let calls = 0;
  const client = {
    state: { catalogRegistrations: publishedActionRegistrations(), snapshot: null, latestReceipt: null },
    observe: async () => client.state.snapshot,
    execute: async (request) => {
      calls += 1;
      const receipt = answer(kind, client, request);
      receipts.push(receipt);
      return receipt;
    },
  };
  client.state.snapshot = initialWorld(kind);
  return { client, receipts, callCount: () => calls };
}

function initialWorld(kind) {
  if (kind === "accept_daily_quest")
    return {
      revision: 1,
      location: "Farm",
      tile: { x: 5, y: 5 },
      actionable: true,
      activeExecution: null,
      capabilities: ["cancel_active_execution", "inspect_self", "accept_daily_quest"],
      dailyQuestTargets: [{ targetId: "daily_quest_0123456789abcdef", questType: 10, title: "Help Wanted" }],
      acceptedDailyQuest: false,
    };
  if (kind === "accept_special_order")
    return {
      revision: 1,
      location: "Farm",
      tile: { x: 5, y: 5 },
      actionable: true,
      activeExecution: null,
      capabilities: ["cancel_active_execution", "inspect_self", "accept_special_order"],
      specialOrderTargets: [{ targetId: "special_order_0123", questKey: "DoctorOrder" }],
      activeSpecialOrderKeys: [],
    };
  if (kind === "toggle_animal_door")
    return {
      revision: 1,
      location: "Farm",
      tile: { x: 30, y: 21 },
      actionable: true,
      activeExecution: null,
      capabilities: ["cancel_active_execution", "inspect_self", "toggle_animal_door"],
      animalDoorTargets: [{ targetId: "animal_door_state_closed", x: 31, y: 20, buildingType: "Coop", isOpen: false }],
    };
  if (kind === "clear_fish_pond")
    return {
      revision: 1,
      location: "Farm",
      tile: { x: 10, y: 12 },
      actionable: true,
      activeExecution: null,
      capabilities: ["cancel_active_execution", "inspect_self", "clear_fish_pond"],
      // The pond's fish type is UNQUALIFIED, as the Mod publishes it; the ground items it becomes are qualified. The
      // hook's normalisation exists for exactly this pair of surfaces, so the fake world has to carry both forms.
      fishPondTargets: [
        {
          targetId: "fish_pond_0123456789abcdef",
          location: "Farm",
          x: 10,
          y: 12,
          buildingType: "Fish Pond",
          occupants: 2,
          fishType: "128",
        },
      ],
      itemTargets: [],
    };
  throw new Error(`unknown world ${kind}`);
}

function answer(kind, client, request) {
  if (kind === "accept_daily_quest") {
    const live = client.state.snapshot.dailyQuestTargets?.[0];
    if (live !== undefined && request.args.expectedTargetId === live.targetId) {
      client.state.snapshot = {
        ...client.state.snapshot,
        revision: 2,
        dailyQuestTargets: [],
        acceptedDailyQuest: true,
      };
      return {
        requestId: request.requestId,
        executionId: "daily-quest-execution",
        state: "succeeded",
        reasonCode: "daily_quest_accepted",
        revision: 2,
        evidence: {
          detail:
            `daily_quest_id=${live.targetId};accepted_before=false;accepted_daily_before=false;days_left_before=-1` +
            `;quest_log_before=0;quest_log_after=1;accepted_after=true;accepted_daily_after=true` +
            `;daily_after=true;can_be_cancelled_after=true;days_left_after=2;day_accepted_after=120`,
        },
      };
    }
    return {
      requestId: request.requestId,
      executionId: "daily-quest-execution-stale",
      state: "rejected",
      reasonCode: "daily_quest_already_accepted",
      revision: client.state.snapshot.revision,
      evidence: { detail: "daily_quest_id=none;accepted_daily_after=true" },
    };
  }
  if (kind === "accept_special_order") {
    const live = client.state.snapshot.specialOrderTargets?.[0];
    if (live !== undefined && request.args.expectedTargetId === live.targetId) {
      client.state.snapshot = {
        ...client.state.snapshot,
        revision: 2,
        specialOrderTargets: [],
        activeSpecialOrderKeys: [live.questKey],
      };
      return {
        requestId: request.requestId,
        executionId: "special-order-execution",
        state: "succeeded",
        reasonCode: "special_order_accepted",
        revision: 2,
        evidence: {
          detail:
            `quest_key=${live.questKey};board_marker_before=false;board_marker_after=true` +
            `;order_present_after=true;order_in_progress_after=true;orders_before=0;orders_after=1`,
        },
      };
    }
    return {
      requestId: request.requestId,
      executionId: "special-order-execution-stale",
      state: "rejected",
      reasonCode: "special_order_already_active",
      revision: client.state.snapshot.revision,
      evidence: { detail: "quest_key=DoctorOrder;board_marker_after=true" },
    };
  }
  if (kind === "clear_fish_pond") {
    const pond = client.state.snapshot.fishPondTargets?.[0];
    if (pond !== undefined && request.args.expectedTargetId === pond.targetId) {
      const ejected = Array.from({ length: pond.occupants }, () => ({
        qualifiedItemId: `(O)${pond.fishType}`,
        x: 11,
        y: 12,
      }));
      client.state.snapshot = {
        ...client.state.snapshot,
        revision: 2,
        fishPondTargets: [],
        itemTargets: [...client.state.snapshot.itemTargets, ...ejected],
      };
      return {
        requestId: request.requestId,
        executionId: "fish-pond-execution",
        state: "succeeded",
        reasonCode: "fish_pond_cleared",
        revision: 2,
        evidence: {
          detail:
            `pond_id=${pond.targetId};location=Farm;fish_type_before=${pond.fishType};fish_type_after=none` +
            `;occupants_before=${pond.occupants};occupants_after=0;fish_ejected=${pond.occupants}`,
        },
      };
    }
    return {
      requestId: request.requestId,
      executionId: "fish-pond-execution-stale",
      state: "rejected",
      reasonCode: "pond_already_empty",
      revision: client.state.snapshot.revision,
      evidence: { detail: `pond_id=none;fish_type_after=none;occupants_after=0` },
    };
  }
  const live = client.state.snapshot.animalDoorTargets?.[0];
  if (request.args.expectedTargetId === live.targetId) {
    client.state.snapshot = {
      ...client.state.snapshot,
      revision: 2,
      animalDoorTargets: [
        { targetId: "animal_door_state_open", x: live.x, y: live.y, buildingType: live.buildingType, isOpen: true },
      ],
    };
    return {
      requestId: request.requestId,
      executionId: "animal-door-execution",
      state: "succeeded",
      reasonCode: "animal_door_toggled",
      revision: 2,
      evidence: {
        detail:
          `target=${live.targetId};tile=${live.x},${live.y};building_type=${live.buildingType}` +
          `;animal_door_open_before=false;animal_door_open_after=true;animal_door_open_changed=true` +
          `;animal_door_amount_before=0;animal_door_amount_after=1`,
      },
    };
  }
  return {
    requestId: request.requestId,
    executionId: "animal-door-execution-refused",
    state: "rejected",
    reasonCode: "animal_door_target_changed",
    revision: client.state.snapshot.revision,
    evidence: { detail: `tile=${live.x},${live.y};published=${request.args.expectedTargetId};live=${live.targetId}` },
  };
}

const HANDS_WRITTEN = Object.freeze({
  accept_daily_quest: (client, receipts) =>
    runAcceptDailyQuestSmoke(client, receipts, {}, { terminalTimeoutMs: 1_000 }),
  accept_special_order: (client, receipts) =>
    runAcceptSpecialOrderSmoke(client, receipts, {}, { terminalTimeoutMs: 1_000 }),
  toggle_animal_door: (client, receipts) =>
    runToggleAnimalDoorSmoke(client, receipts, {}, { terminalTimeoutMs: 1_000 }),
});

const contractOf = (actionId) => loadSmokeContractFile(join(CONTRACTS_DIR, `${actionId}.json`));

/**
 * THE GATE: every contract on disk is a row the declarations can carry.
 *
 * The population is the contracts directory, so a fourth contract is judged the moment it is written, and every
 * assertion below is against the action's OWN declaration (the generated surface) or against the gate table that
 * already names the terminal word and the world each gate runs in - never against a copy written here.
 */
test("every contract derives from its own declaration and agrees with the gate table", () => {
  const files = readdirSync(CONTRACTS_DIR).filter((name) => name.endsWith(".json"));
  assert.ok(files.length >= 3, `the contracts directory must carry the converted rows, found ${files.length}`);
  const surface = readActionSurface();
  const controls = readProtocolControls();
  const gates = new Map(STARDEW_PUBLISHED_ACTION_GATES.map((gate) => [gate.actionId, gate]));
  for (const file of files) {
    const contract = loadSmokeContractFile(join(CONTRACTS_DIR, file), { surface, protocolControls: controls });
    const facts = deriveActionFacts(contract.action, { surface, protocolControls: controls });
    assert.equal(
      contract.derived.targetFamily,
      facts.targetFamily,
      `${file}: discovery source is the declaration's targetFamily`,
    );
    assert.deepEqual(
      contract.derived.requiredCapabilities,
      [...new Set([...controls, contract.action])].sort(),
      `${file}: required capabilities are the Mod's protocol controls plus the action itself`,
    );
    // The contract's argument names must be a subset of the declared ones, and the engine must be able to fill every
    // substitution from the discovery row: an argument the declaration does not name is a request the Mod refuses.
    for (const name of Object.keys(contract.args))
      assert.ok(facts.argumentSchema[name] !== undefined, `${file}: argument '${name}' is not declared`);
    const gate = gates.get(contract.action);
    assert.ok(gate !== undefined, `${file}: '${contract.action}' has no gate row`);
    assert.equal(
      contract.expectedReasonCode,
      gate.terminalReasonCode,
      `${file}: success word disagrees with the gate row`,
    );
    assert.equal(
      contract.derived.fixtureScenario,
      gate.fixtureScenario,
      `${file}: fixture scenario disagrees with the gate row`,
    );
  }
});

/**
 * THE AGREEMENT: the engine's verdict equals the hand-written runner's, over the same world.
 *
 * `checks` is deliberately compared where they overlap rather than for equality: the runner may make an assertion
 * the contract does not, and the engine names those keys in `unassertedEvidence` instead of silently passing them.
 * What must never differ is the verdict.
 */
for (const actionId of Object.keys(HANDS_WRITTEN)) {
  test(`${actionId}: the contract engine and the hand-written runner reach the same verdict`, async () => {
    const contract = contractOf(actionId);

    const handed = makeWorld(actionId);
    const runnerResult = await HANDS_WRITTEN[actionId](handed.client, handed.receipts);

    const sliced = makeWorld(actionId);
    const engineResult = await runActionSlice({
      client: sliced.client,
      receipts: sliced.receipts,
      contract,
      terminalTimeoutMs: 1_000,
    });

    assert.equal(
      runnerResult.state,
      "passed",
      `the hand-written runner must pass this world: ${runnerResult.reasonCode}`,
    );
    assert.equal(engineResult.state, "passed", `the engine must pass the same world: ${engineResult.reasonCode}`);
    assert.equal(engineResult.reasonCode, runnerResult.reasonCode, "both must name the same success word");
    // One execution frame plus the contract's own stale re-send, and nothing else: a slice is not a program.
    assert.equal(sliced.callCount(), 2, "the engine dispatches exactly one frame plus its stale re-send");
    // The engine reports every receipt key it did not constrain, derived from the receipt it actually read: that
    // list is the honest measure of what the contract could not cover for this action. A key either side of a
    // `delta` entry is constrained by it.
    const constrained = new Set([
      ...Object.keys(contract.evidence),
      ...contract.delta.flatMap((relation) => (relation.from === null ? [relation.to] : [relation.to, relation.from])),
    ]);
    const unconstrained = Object.keys(engineResult.evidence)
      .filter((key) => !constrained.has(key))
      .sort();
    assert.deepEqual(engineResult.unassertedEvidence, unconstrained);
    for (const [name, value] of Object.entries(engineResult.checks))
      assert.equal(value, true, `${actionId}: engine check '${name}' is not true (${JSON.stringify(value)})`);
  });
}

test("accept_special_order: the engine names the evidence keys it could not assert", async () => {
  // `orders_after - orders_before === 1` used to be the shape the contract format could not express, and the engine
  // named both keys as unasserted. The `delta` entry now states it, so the only key left unasserted is the one the
  // receipt carries and the contract never mentions - which is what this reading is for.
  const contract = contractOf("accept_special_order");
  const world = makeWorld("accept_special_order");
  const original = world.client.execute;
  world.client.execute = async (request) => {
    const receipt = await original(request);
    if (receipt.state === "succeeded") receipt.evidence = { detail: `${receipt.evidence.detail};extra_count=7` };
    return receipt;
  };
  const result = await runActionSlice({
    client: world.client,
    receipts: world.receipts,
    contract,
    terminalTimeoutMs: 1_000,
  });
  assert.equal(result.state, "passed");
  assert.deepEqual(result.unassertedEvidence, ["extra_count"]);
});

test("a slice that fails its contract is blocked, and the refusal names the check and both values", async () => {
  const contract = contractOf("accept_daily_quest");
  const world = makeWorld("accept_daily_quest");
  const original = world.client.execute;
  world.client.execute = async (request) => {
    const receipt = await original(request);
    // The receipt claims the accept, and the log did not grow: the write half is missing.
    if (receipt.state === "succeeded")
      receipt.evidence = { detail: receipt.evidence.detail.replace("quest_log_after=1", "quest_log_after=0") };
    return receipt;
  };
  const result = await runActionSlice({
    client: world.client,
    receipts: world.receipts,
    contract,
    terminalTimeoutMs: 1_000,
  });
  assert.equal(result.state, "blocked");
  assert.equal(result.reasonCode, "slice_evidence_mismatch:quest_log_after:expected=1:actual=0");
});

test("a terminal whose state is not the declared one is blocked, quoting the Mod's own words", async () => {
  const contract = adHocContract({
    action: "till_soil",
    args: { x: 6, y: 6, charge: 0 },
    expectReasonCode: "soil_tilled",
  });
  const world = makeWorld("accept_daily_quest");
  world.client.state.snapshot = {
    ...world.client.state.snapshot,
    capabilities: ["cancel_active_execution", "inspect_self", "till_soil"],
    soilTiles: [],
  };
  world.client.execute = async (request) => ({
    requestId: request.requestId,
    executionId: "till-refused",
    state: "rejected",
    reasonCode: "not_tillable",
    revision: 1,
    evidence: { detail: "tile=6,6;occupant=none;why=water" },
  });
  const result = await runActionSlice({
    client: world.client,
    receipts: world.receipts,
    contract,
    terminalTimeoutMs: 1_000,
  });
  assert.equal(result.state, "blocked");
  assert.equal(result.reasonCode, "slice_terminal_not_expected:rejected:not_tillable");
});

test("a stale re-send that is not refused by name fails the slice", async () => {
  const contract = contractOf("toggle_animal_door");
  const world = makeWorld("toggle_animal_door");
  const original = world.client.execute;
  world.client.execute = async (request) => {
    const receipt = await original(request);
    if (receipt.reasonCode === "animal_door_target_changed") receipt.reasonCode = "animal_door_unavailable";
    return receipt;
  };
  const result = await runActionSlice({
    client: world.client,
    receipts: world.receipts,
    contract,
    terminalTimeoutMs: 1_000,
  });
  assert.equal(result.state, "blocked");
  assert.equal(result.checks.staleRefused, false);
});

test("a world-after assertion whose field the surface does not carry is not_checked, never a pass", async () => {
  const contract = contractOf("accept_daily_quest");
  const world = makeWorld("accept_daily_quest");
  const original = world.client.execute;
  world.client.execute = async (request) => {
    const receipt = await original(request);
    if (receipt.state === "succeeded") {
      const { dailyQuestTargets, ...withoutSurface } = world.client.state.snapshot;
      world.client.state.snapshot = withoutSurface;
    }
    return receipt;
  };
  const result = await runActionSlice({
    client: world.client,
    receipts: world.receipts,
    contract,
    terminalTimeoutMs: 1_000,
  });
  assert.equal(result.state, "blocked");
  assert.equal(result.checks["world.dailyQuestTargets.excludesTarget"], "not_checked");
});

test("the first observation is taken when the world can act, and a world that never can is refused by name", async () => {
  // Measured live 2026-11-14: the bridge opens while the fixture's warp fade is still in flight, and
  // `toggle_animal_door` refused `native_snapshot_not_actionable` on the first observation. The engine must wait
  // that transition out - and must still refuse, by name, when the world never becomes actionable.
  const contract = contractOf("toggle_animal_door");
  const handling = makeWorld("toggle_animal_door");
  const inner = handling.client.observe;
  let reads = 0;
  handling.client.observe = async () => {
    reads += 1;
    const snapshot = await inner();
    return reads === 1 ? { ...snapshot, actionable: false } : snapshot;
  };
  const result = await runActionSlice({
    client: handling.client,
    receipts: handling.receipts,
    contract,
    terminalTimeoutMs: 1_000,
    actionableTimeoutMs: 1_000,
  });
  assert.equal(result.state, "passed", `the fade must be waited out: ${result.reasonCode}`);
  assert.ok(reads > 1, "the engine must have observed again after the non-actionable snapshot");

  const stuck = makeWorld("toggle_animal_door");
  const stuckInner = stuck.client.observe;
  stuck.client.observe = async () => ({ ...(await stuckInner()), actionable: false });
  const refused = await runActionSlice({
    client: stuck.client,
    receipts: stuck.receipts,
    contract,
    terminalTimeoutMs: 1_000,
    actionableTimeoutMs: 250,
  });
  assert.equal(refused.state, "blocked");
  assert.equal(refused.reasonCode, "native_snapshot_not_actionable");
});

/**
 * THE MOMENT AFTER THE REFUSAL.
 *
 * `worldAfter` is read before the stale re-send; a contract that says "and nothing moved once the re-send was refused"
 * needs a read at that later moment, judged by its own named checks. The three readings below are the same world with
 * one difference each: quiet, moved, and a surface that cannot be looked at - and the last two must fail, because "I
 * could not look" and "nothing moved" can never read the same.
 */
function afterStaleWorld(kind, mutate) {
  const world = makeWorld(kind);
  const inner = world.client.execute;
  world.client.execute = async (request) => {
    const receipt = await inner(request);
    if (receipt.state === "rejected") world.client.state.snapshot = mutate(world.client.state.snapshot, receipt);
    return receipt;
  };
  return world;
}

test("the afterStale block is judged on the world the refusal left behind, and costs no extra frame", async () => {
  const contract = contractOf("toggle_animal_door");
  const quiet = afterStaleWorld("toggle_animal_door", (snapshot, receipt) => ({
    ...snapshot,
    revision: receipt.revision + 1,
  }));
  const result = await runActionSlice({
    client: quiet.client,
    receipts: quiet.receipts,
    contract,
    terminalTimeoutMs: 1_000,
  });
  assert.equal(result.state, "passed", `the refusal left the door open, as the block says: ${result.reasonCode}`);
  assert.equal(result.checks["afterStale.animalDoorTargets.rowAtTargetTile"], true);
  assert.equal(result.checks["afterStale.animalDoorTargets.excludesTarget"], true);
  assert.equal(quiet.callCount(), 2, "the later reading is an observation, not a second dispatch");
});

test("a world that moves after the refusal fails the afterStale check, named with the field and the form", async () => {
  const contract = contractOf("toggle_animal_door");
  const moving = afterStaleWorld("toggle_animal_door", (snapshot, receipt) => ({
    ...snapshot,
    revision: receipt.revision + 1,
    animalDoorTargets: [{ targetId: "animal_door_state_closed", x: 31, y: 20, buildingType: "Coop", isOpen: false }],
  }));
  const result = await runActionSlice({
    client: moving.client,
    receipts: moving.receipts,
    contract,
    terminalTimeoutMs: 1_000,
  });
  assert.equal(result.state, "blocked");
  assert.equal(result.checks["afterStale.animalDoorTargets.rowAtTargetTile"], false);
  assert.equal(result.checks["afterStale.animalDoorTargets.excludesTarget"], false);
  // The first failing entry names itself: the closed-door target came back into the discovery projection.
  assert.equal(result.reasonCode, "slice_after_stale_unmet:animalDoorTargets.excludesTarget:false");
});

test("an afterStale field the surface does not carry after the refusal is not_checked, never a pass", async () => {
  const contract = contractOf("toggle_animal_door");
  const blind = afterStaleWorld("toggle_animal_door", (snapshot, receipt) => {
    const { animalDoorTargets, ...withoutSurface } = snapshot;
    return { ...withoutSurface, revision: receipt.revision + 1 };
  });
  const result = await runActionSlice({
    client: blind.client,
    receipts: blind.receipts,
    contract,
    terminalTimeoutMs: 1_000,
  });
  assert.equal(result.state, "blocked");
  assert.equal(result.checks["afterStale.animalDoorTargets.rowAtTargetTile"], "not_checked");
  assert.equal(result.checks["afterStale.animalDoorTargets.excludesTarget"], "not_checked");
  assert.equal(result.reasonCode, "slice_after_stale_unmet:animalDoorTargets.excludesTarget:not_checked");
});

test("the discovery refuses a world that does not advertise the declared family", () => {
  const contract = contractOf("accept_daily_quest");
  assert.throws(() => chooseTarget({ revision: 1 }, contract), /slice_discovery_surface_absent:dailyQuestTargets/u);
  assert.throws(
    () => chooseTarget({ revision: 1, dailyQuestTargets: [] }, contract),
    /slice_declared_given_absent:dailyQuestTargets:0/u,
  );
  const two = { revision: 1, dailyQuestTargets: [{ targetId: "a" }, { targetId: "b" }] };
  assert.throws(() => chooseTarget(two, contract), /slice_declared_given_absent:dailyQuestTargets:2/u);
});

test("a contract may not restate what the declaration already owns", () => {
  const surface = readActionSurface();
  const controls = readProtocolControls();
  const base = JSON.parse(readFileSync(join(CONTRACTS_DIR, "accept_daily_quest.json"), "utf8"));
  const refuses = (patch, pattern) =>
    assert.throws(() => validateSmokeContract({ ...base, ...patch }, { surface, protocolControls: controls }), pattern);
  refuses({ targetFamily: "dailyQuestTargets" }, /smoke_contract_rederived_key:targetFamily/u);
  refuses({ requiredCapabilities: ["accept_daily_quest"] }, /smoke_contract_rederived_key:requiredCapabilities/u);
  refuses({ fixtureScenario: "native_x_v1" }, /smoke_contract_rederived_key:fixtureScenario/u);
  refuses({ expectedReasonCode: "daily_quest_accepted" }, /smoke_contract_reason_code_redeclared/u);
  refuses({ unforeseen: true }, /smoke_contract_unknown_key:contract\.unforeseen/u);
  refuses({ args: { nonexistentArgument: "x" } }, /smoke_contract_args_undeclared/u);
  refuses({ args: { expectedTargetId: 7 } }, /smoke_contract_args_type_mismatch/u);
  refuses(
    { discovery: { cardinality: "exactly_one", source: "specialOrderTargets" } },
    /smoke_contract_discovery_source_disagrees_with_declaration/u,
  );
  // The shapes the format exists to keep OUT of data, each refused with the place it has to live. `delta` is a
  // supported list now, so what is refused is a delta that is not one relation: the entry below carries two bounds,
  // which no single flat entry can mean.
  refuses(
    { delta: [{ from: "orders_before", to: "orders_after", equals: 1, atLeast: 1 }] },
    /smoke_contract_delta_bound_invalid/u,
  );
  refuses({ delta: [{ from: "orders_before", equals: 1 }] }, /smoke_contract_delta_key_missing/u);
  refuses({ steps: [] }, /smoke_contract_not_expressible:contract\.steps/u);
  refuses({ arithmetic: {} }, /smoke_contract_not_expressible:contract\.arithmetic/u);
});

test("a generic postcondition derives no success word, and says so instead of guessing", () => {
  const facts = deriveActionFacts("till_soil");
  assert.equal(facts.declaredPostcondition, "native_action_postcondition");
  assert.equal(facts.expectedReasonCode, null);
  assert.match(facts.notDerived, /^not_derived:postcondition_is_generic:/u);
  assert.throws(
    () => adHocContract({ action: "till_soil", args: { x: 1, y: 1, charge: 0 } }),
    /smoke_contract_reason_code_underivable:till_soil/u,
  );
  // ...and with the operator's word it validates, which is the documented escape hatch.
  const contract = adHocContract({
    action: "till_soil",
    args: { x: 1, y: 1, charge: 0 },
    expectReasonCode: "soil_tilled",
  });
  assert.equal(contract.expectedReasonCode, "soil_tilled");
  assert.equal(contract.derived.reasonCodeSource, "operator:--expect");
});

test("the judgement is pure: it takes facts and returns a check per assertion", () => {
  const contract = contractOf("toggle_animal_door");
  const target = { targetId: "animal_door_state_closed", x: 31, y: 20, isOpen: false };
  const evidence = new Map([
    ["animal_door_open_before", "false"],
    ["animal_door_open_after", "true"],
    ["animal_door_open_changed", "true"],
  ]);
  const after = {
    animalDoorTargets: [{ targetId: "animal_door_state_open", x: 31, y: 20, isOpen: true }],
  };
  const checks = judgeSlice({
    contract,
    target,
    terminal: { state: "succeeded", reasonCode: "animal_door_toggled" },
    after,
    afterStale: after,
    evidence,
    staleTerminal: { state: "rejected", reasonCode: "animal_door_target_changed" },
  });
  assert.deepEqual(checks, {
    terminalStateExpected: true,
    terminalReasonExpected: true,
    evidenceParsed: true,
    "evidence.animal_door_open_before": true,
    "evidence.animal_door_open_after": true,
    "evidence.animal_door_open_changed": true,
    "world.animalDoorTargets.excludesTarget": true,
    "world.animalDoorTargets.rowAtTargetTile": true,
    staleRefused: true,
    "afterStale.animalDoorTargets.excludesTarget": true,
    "afterStale.animalDoorTargets.rowAtTargetTile": true,
  });
  // Falsifier: the same facts with the door still closed in the world take the same guard red.
  const red = judgeSlice({
    contract,
    target,
    terminal: { state: "succeeded", reasonCode: "animal_door_toggled" },
    after: { animalDoorTargets: [{ targetId: "animal_door_state_closed", x: 31, y: 20, isOpen: false }] },
    evidence,
    staleTerminal: { state: "rejected", reasonCode: "animal_door_target_changed" },
  });
  assert.equal(red["world.animalDoorTargets.excludesTarget"], false);
  assert.equal(red["world.animalDoorTargets.rowAtTargetTile"], false);
});

test("a delta entry is judged as the relation it states, and both numbers appear when it fails", () => {
  // The one kind that replaced nine hand-written declarations across three runners: `count_after = count_before + 1`
  // and `mail_flags_after > mail_flags_before`. Written once here, judged once here, and no receipt is involved.
  const contract = {
    expectedState: "succeeded",
    expectedReasonCode: "crafted_item_created",
    evidence: {},
    worldAfter: [],
    afterStale: [],
    stale: null,
    delta: [
      { to: "count_after", from: "count_before", bound: { form: "equals", value: 1 } },
      { to: "mail_flags_after", from: "mail_flags_before", bound: { form: "atLeast", value: 1 } },
      { to: "rewards_before", from: null, bound: { form: "atLeast", value: 1 } },
    ],
  };
  const judge = (fields) =>
    judgeSlice({
      contract,
      target: null,
      terminal: { state: "succeeded", reasonCode: "crafted_item_created" },
      after: {},
      evidence: new Map(Object.entries(fields)),
      staleTerminal: null,
    });
  const same = { count_before: "2", mail_flags_before: "0", mail_flags_after: "1", rewards_before: "1" };

  const green = judge({ ...same, count_after: "3" });
  assert.equal(green["delta.count_after"], true);
  assert.equal(green["delta.mail_flags_after"], true);
  assert.equal(green["delta.rewards_before"], true);

  // Falsifier: the same relation one short, one not greater, and an absolute bound of zero.
  const red = judge({
    count_before: "2",
    count_after: "2",
    mail_flags_before: "1",
    mail_flags_after: "1",
    rewards_before: "0",
  });
  assert.equal(red["delta.count_after"], false);
  assert.equal(red["delta.mail_flags_after"], false);
  assert.equal(red["delta.rewards_before"], false);

  // A receipt that does not carry one side fails the relation instead of crashing or reading NaN.
  const missing = judge(same);
  assert.equal(missing["delta.count_after"], false);
  const notANumber = judge({ ...same, count_before: "two", count_after: "3" });
  assert.equal(notANumber["delta.count_after"], false);
});

test("the contract schema string is the one the files carry", () => {
  assert.equal(SMOKE_CONTRACT_SCHEMA, "stardew-action-smoke-contract/v1");
  for (const file of readdirSync(CONTRACTS_DIR).filter((name) => name.endsWith(".json")))
    assert.equal(JSON.parse(readFileSync(join(CONTRACTS_DIR, file), "utf8")).schema, SMOKE_CONTRACT_SCHEMA);
});

test("the protocol controls are read from the Mod's own capability set, not copied here", () => {
  const controls = readProtocolControls();
  assert.deepEqual([...controls].sort(), ["cancel_active_execution", "inspect_self"]);
  assert.ok(CAPABILITY_SET_PATH.endsWith("FarmhandCapabilitySet.cs"));
});

/**
 * THE HOOK, DRIVEN BY THE ENGINE OVER A WHOLE SLICE.
 *
 * `clear_fish_pond` is the one contract whose clause is code rather than data: the ejected ground debris must be at
 * least the pond's occupants. These two runs are the two directions of that clause, and the second is the case the
 * format could never catch - every built-in check passes (the receipt says `fish_ejected=2`, the pond left discovery,
 * the stale id is refused) and the WORLD holds only one ejected fish.
 */
test("clear_fish_pond: the hook's clause is a check of the run, and a short ejection blocks it on that check", async () => {
  const contract = contractOf("clear_fish_pond");
  const satisfied = makeWorld("clear_fish_pond");
  const passed = await runActionSlice({
    client: satisfied.client,
    receipts: satisfied.receipts,
    contract,
    terminalTimeoutMs: 1_000,
  });
  assert.equal(passed.state, "passed", `the hook's own world must pass: ${passed.reasonCode}`);
  assert.equal(passed.checks["assertion.worldAfter.itemTargets"], true, "the hook's clause is a named check");
  assert.deepEqual(passed.assertion, { hook: "clear_fish_pond", clauses: ["worldAfter.itemTargets"], failures: [] });

  const short = makeWorld("clear_fish_pond");
  const execute = short.client.execute;
  short.client.execute = async (request) => {
    const receipt = await execute(request);
    // The pond emptied and the receipt agrees with itself; the ground holds ONE of the two fish it claims to have
    // ejected. Nothing the contract states as data can see this.
    if (receipt.state === "succeeded")
      short.client.state.snapshot = {
        ...short.client.state.snapshot,
        itemTargets: [{ qualifiedItemId: "(O)128", x: 11, y: 12 }],
      };
    return receipt;
  };
  const blocked = await runActionSlice({
    client: short.client,
    receipts: short.receipts,
    contract,
    terminalTimeoutMs: 1_000,
  });
  assert.equal(blocked.state, "blocked", "a world one fish short must not pass");
  assert.equal(blocked.checks["assertion.worldAfter.itemTargets"], false);
  assert.match(blocked.reasonCode, /^slice_assertion_unmet:worldAfter\.itemTargets:/u, blocked.reasonCode);
  assert.match(blocked.reasonCode, /= 1\b/u, `the failure names the count it found: ${blocked.reasonCode}`);
  assert.match(
    blocked.reasonCode,
    /occupants before = 2\b/u,
    `and the count it was measured against: ${blocked.reasonCode}`,
  );
});
