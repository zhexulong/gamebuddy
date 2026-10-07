// The behavior the static runner-contract audit cannot check: does each runner
// ACCEPT the config the fixture actually writes?
//
// The audit reads runner source text for two retired patterns. That cannot see a
// runner whose check mentions neither pattern but still contradicts the fixture
// -- `npc-relationship` kept requiring `ExperimentalActions == ["npc_relationship"]`
// after the action was promoted to live-verified, so it rejected every real
// config while the audit called it conforming and its own test (which built the
// same stale shape by hand) stayed green.
//
// Here the config comes from the fixture's own functions -- `fixtureActions`,
// `fixtureScenario`, and the experimental set read from the Mod catalog -- so a
// runner and the fixture can no longer agree with each other while disagreeing
// with the live path.
//
// The action each runner serves comes from the authoritative gate table, not
// from its filename: several runners are not per-action gates (recovery chains,
// multi-action probes) and their action set is declared below.
//
// Scope is deliberately the POLICY axis: the block that drifted (EnabledActions
// -> deny-by-exception, and the experimental opt-in). Fields the Mod writes back
// at live time, and capabilities the world reports, are supplied as valid-shaped
// placeholders because this test is not about them.
import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  fixtureActions,
  fixtureScenario,
} from "./lib/stardew-native-local-player-fixture.mjs";
import { readExperimentalStardewActionIds } from "./lib/stardew-published-action-registry.mjs";
import { STARDEW_PUBLISHED_ACTION_GATES } from "./stardew-action-gate-descriptors.mjs";

const TOOLS = resolve(fileURLToPath(new URL(".", import.meta.url)));

/**
 * The action id each runner's fixture config is derived from.
 *
 * This is not always the runner's own filename or its gate actionId:
 *   * `expression` is one runner serving two gate actions, so it is driven by the
 *     first one the fixture owns;
 *   * the recovery chains and probes key on bespoke scenarios, so the action
 *     below is the one whose fixture-family they belong to;
 *   * `navigation-read-only` is a read-only probe with no gate entry.
 * Stating them explicitly keeps the mapping reviewable instead of guessed.
 */
const CONFIG_DRIVER_ACTION = Object.freeze({
  "run-stardew-native-local-player-craft-partial-recovery-chain-smoke.mjs": "craft_item",
  "run-stardew-native-local-player-place-owned-object-smoke.mjs": "place_owned_object",
  "run-stardew-native-local-player-remove-placed-item-smoke.mjs": "remove_placed_item",
  "run-stardew-native-local-player-break-container-source-smoke.mjs": "break_container_source",
  "run-stardew-native-local-player-harvest-inventory-full-recovery-chain-smoke.mjs": "harvest_crop",
  "run-stardew-native-local-player-machine-ab-smoke.mjs": "machine_inspect",
  "run-stardew-native-local-player-navigation-mutation-smoke.mjs": "navigation_mutation",
  "run-stardew-native-local-player-navigation-read-only-smoke.mjs": "navigation_mutation",
  "run-stardew-native-local-player-place-crab-pot-fixture-smoke.mjs": "place_crab_pot",
  "run-stardew-native-local-player-ride-minecart-smoke.mjs": "ride_minecart",
  "run-stardew-native-local-player-stamina-recovery-chain-smoke.mjs": "use_item",
  "run-stardew-native-local-player-tool-recovery-chain-smoke.mjs": "till_soil",
  "run-stardew-native-local-player-water-crop-resource-recovery-chain-smoke.mjs": "water_crop",
  // One runner, two gate actions; the fixture keys the scenario on the first.
  "run-stardew-native-local-player-expression-smoke.mjs": "express_emote",
  // Loop-closure wave (2026-10-04): the 14 lane smoke runners are fixture-family
  // drivers keyed on the action they exercise, matching the gate table entries.
  "run-stardew-native-local-player-clear-cask-smoke.mjs": "clear_cask",
  "run-stardew-native-local-player-deposit-silo-hay-smoke.mjs": "deposit_silo_hay",
  // 2026-10-06: the two facility/transport actions wired this session. Same rule as the wave
  // above — keyed on the action the runner exercises.
  "run-stardew-native-local-player-withdraw-silo-hay-smoke.mjs": "withdraw_silo_hay",
  "run-stardew-native-local-player-toggle-animal-door-smoke.mjs": "toggle_animal_door",
  // 2026-10-07 item/tile lane. Same rule as the wave above -- keyed on the action the
  // runner exercises.
  "run-stardew-native-local-player-use-warp-item-smoke.mjs": "use_warp_item",
  "run-stardew-native-local-player-pan-ore-smoke.mjs": "pan_ore",
  "run-stardew-native-local-player-claim-mail-attachment-smoke.mjs": "claim_mail_attachment",
  // 2026-10-07: the building-chest pair. Same rule as the wave above — keyed on the action the
  // runner exercises.
  "run-stardew-native-local-player-load-building-chest-smoke.mjs": "load_building_chest",
  "run-stardew-native-local-player-collect-building-chest-output-smoke.mjs": "collect_building_chest_output",
  "run-stardew-native-local-player-enter-exit-warp-action-smoke.mjs": "enter_exit_warp_action",
  "run-stardew-native-local-player-enter-mine-ladder-smoke.mjs": "enter_mine_ladder",
  "run-stardew-native-local-player-talk-to-npc-smoke.mjs": "talk_to_npc",
  "run-stardew-native-local-player-use-obelisk-smoke.mjs": "use_obelisk",
  "run-stardew-native-local-player-dress-mannequin-smoke.mjs": "dress_mannequin",
  "run-stardew-native-local-player-enter-mine-smoke.mjs": "enter_mine",
  "run-stardew-native-local-player-harvest-bush-smoke.mjs": "harvest_bush",
  "run-stardew-native-local-player-harvest-fruit-tree-smoke.mjs": "harvest_fruit_tree",
  "run-stardew-native-local-player-mount-transport-smoke.mjs": "mount_transport",
  "run-stardew-native-local-player-equip-wearable-smoke.mjs": "equip_wearable",
  "run-stardew-native-local-player-unequip-wearable-smoke.mjs": "unequip_wearable",
  "run-stardew-native-local-player-dismount-transport-smoke.mjs": "dismount_transport",
  "run-stardew-native-local-player-set-sign-display-smoke.mjs": "set_sign_display",
  "run-stardew-native-local-player-shake-tree-smoke.mjs": "shake_tree",
  "run-stardew-native-local-player-take-pedestal-item-smoke.mjs": "take_pedestal_item",
  "run-stardew-native-local-player-toggle-fence-gate-smoke.mjs": "toggle_fence_gate",
  "run-stardew-native-local-player-toggle-tool-light-smoke.mjs": "toggle_tool_light",
  "run-stardew-native-local-player-use-raft-smoke.mjs": "use_raft",
  // Pre-existing fixture-family drivers whose runner does not carry the action
  // id in the fixture derive path; they were already covered by STALE baselines
  // before the loop-closure wave and stay declared here.
  "run-stardew-native-local-player-chop-tree-approach-smoke.mjs": "chop_tree_source",
  "run-stardew-native-local-player-cut-grass-smoke.mjs": "cut_grass",
  "run-stardew-native-local-player-move-stall-probe-smoke.mjs": "move_stall_probe_pet",
  "run-stardew-native-local-player-wia-modal-dismiss-chain-smoke.mjs": "wia_modal_dismiss_chain",
  "run-stardew-native-local-player-wia-modal-interrupt-smoke.mjs": "wia_modal_interrupt",
  "run-stardew-native-local-player-wia-eat-interrupt-smoke.mjs": "wia_eat_interrupt",
  "run-stardew-native-local-player-wia-passout-smoke.mjs": "wia_pass_out",
  "run-stardew-native-local-player-wia-answer-question-smoke.mjs": "wia_answer_question",
  // The three slot lanes each key their own WIA fixture family.
  "run-stardew-native-local-player-wia-tool-approach-smoke.mjs": "wia_tool_approach_interrupt",
  "run-stardew-native-local-player-wia-animal-product-smoke.mjs": "wia_animal_product_interrupt",
  "run-stardew-native-local-player-wia-item-pickup-smoke.mjs": "wia_item_pickup_interrupt",
  // Declared by the loop-closure action wave; the runner ships on disk with a
  // gate-table entry pending, so the contract test must still cover it.
});

/**
 * Error codes that mean the runner refused the POLICY block.
 *
 * Deliberately policy-only. A code like `native_local_fixture_config_invalid`
 * also fires on a scenario mismatch, which is a different axis: the recovery
 * chains key on bespoke scenarios (`native_craft_item_partial_v1`) that the
 * fixture does not derive from an action id, and a runner is right to check
 * that. Mixing the two would make this test assert something it is not about.
 */
const POLICY_REJECTION = new RegExp(
  [
    "native_local_[a-z_]*_action_policy_invalid",
    "native_local_[a-z_]*_action_set_invalid",
    "native_fixture_policy_invalid",
    "native_fixture_policy_denies_required",
    "native_fixture_policy_illegal_opt_in",
    "shared_world_action_policy_invalid",
    "fixture_capability_profile_invalid",
    "production_capability_profile_invalid",
  ].join("|"),
);

const experimentalIds = new Set(await readExperimentalStardewActionIds());

/** The policy block `applyDerivedPolicy` writes, for one run's actions. */
function fixturePolicyFor(actions) {
  return {
    DeniedActions: [],
    DeniedActionFamilies: [],
    ExperimentalActions: actions.filter((action) => experimentalIds.has(action)),
  };
}

/** Every runner on disk, paired with the action its config is derived from. */
function runnerCases() {
  const onDisk = new Set(
    readdirSync(TOOLS).filter((name) => /^run-stardew-native-local-player-.*-smoke\.mjs$/.test(name)),
  );
  const cases = new Map();
  for (const gate of STARDEW_PUBLISHED_ACTION_GATES) {
    if (!onDisk.has(gate.runner)) continue; // covered by the completeness assertion below
    cases.set(gate.runner, gate.actionId);
  }
  for (const [runner, actionId] of Object.entries(CONFIG_DRIVER_ACTION)) {
    if (onDisk.has(runner)) cases.set(runner, actionId);
  }
  return { cases, onDisk };
}

function stubClient(actions) {
  const snapshot = {
    revision: 1,
    location: "Farm",
    tile: { x: 1, y: 1 },
    actionable: true,
    activeExecution: null,
    capabilities: [...actions],
    toolSlots: [],
    warps: [],
  };
  return {
    state: { snapshot, latestReceipt: null },
    onFact: () => () => {},
    observe: async () => snapshot,
    execute: async () => { throw new Error("fixture_contract_stub_no_execute"); },
    navigationRead: async () => { throw new Error("fixture_contract_stub_no_navigation"); },
  };
}

function configFor(actions, scenario) {
  return {
    ...fixturePolicyFor(actions),
    // The fixture forces these four off for a native-local run; a runner that
    // requires them false is checking topology, not policy.
    Portfolio: { Enable: false },
    HostAutomation: { Enable: false },
    HostFarmhandProvisioning: { Enable: false },
    FarmhandProvisioner: { Enable: false },
    SaveId: "save",
    WorldId: "world",
    PlayerId: "player",
    CompanionId: "companion",
    PipeName: "pipe",
    BridgeToken: "0123456789abcdef0123456789abcdef",
    NativeLocalPlayerFixture: {
      Enable: true,
      FixtureScenario: scenario,
      LogicalSaveName: "GameBuddyFixture",
      ObservedSaveSlot: "GameBuddyFixture_1",
      TimeoutSeconds: 90,
      // Written by the Mod at live time for this scenario.
      NavigationMutationTargetLabel: "game-derived-target",
      Bootstrap: { Enable: false },
    },
  };
}

/** Run one runner far enough to see whether it refuses the fixture's config. */
async function configRejectionFor(name, actionId) {
  const mod = await import(`./${name}`);
  const entry = Object.entries(mod).find(
    ([key, value]) => key.startsWith("run") && typeof value === "function" && /Smoke$|Chain$|[Pp]robe$/.test(key),
  );
  if (!entry) return { skipped: "no runnable export" };

  // Prefer the runner's own action table when it exposes one; else the declared
  // action id, which is what the fixture keys its scenario on.
  let actions;
  let scenario;
  try {
    actions = fixtureActions(actionId);
    scenario = fixtureScenario(actions, actionId);
  } catch {
    return { skipped: `fixture does not own action id ${actionId}` };
  }

  const fn = entry[1];
  const client = stubClient(actions);
  const receipts = { subscribe: () => () => {}, [Symbol.iterator]: function* () {} };
  const config = configFor(actions, scenario);
  const args = fn.length >= 3
    ? [client, receipts, config, { terminalTimeoutMs: 1, postconditionTimeoutMs: 1 }]
    : [client, config, { postconditionTimeoutMs: 1 }];

  try {
    const result = await fn(...args);
    const code = String(result?.reasonCode ?? "");
    return POLICY_REJECTION.test(code) ? { code } : {};
  } catch (error) {
    const code = String(error?.message ?? error);
    return POLICY_REJECTION.test(code) ? { code: code.slice(0, 120) } : {};
  }
}

test("the gate table and the declared non-gate runners cover every runner on disk", () => {
  // Completeness first: a runner missing from both sources would silently skip
  // the assertion below, which is how this class of defect hides.
  const { cases, onDisk } = runnerCases();
  const uncovered = [...onDisk].filter((name) => !cases.has(name)).sort();
  assert.deepEqual(
    uncovered,
    [],
    "these runners are neither in the gate table nor declared in CONFIG_DRIVER_ACTION, so nothing checks their config contract",
  );
});

test("the gate table names only runners that exist", () => {
  const { onDisk } = runnerCases();
  const missing = STARDEW_PUBLISHED_ACTION_GATES
    .filter((gate) => !onDisk.has(gate.runner))
    .map((gate) => `${gate.actionId}: ${gate.runner}`);
  assert.deepEqual(missing, [], "gate table entries without a runner file");
});

test("every native-local runner accepts the policy block the fixture writes", async () => {
  const { cases } = runnerCases();
  const rejections = [];
  const skipped = [];
  let evaluated = 0;

  for (const [name, actionId] of [...cases].sort(([a], [b]) => a.localeCompare(b))) {
    const outcome = await configRejectionFor(name, actionId);
    const short = name.replace("run-stardew-native-local-player-", "").replace("-smoke.mjs", "");
    if (outcome.skipped) { skipped.push(`${short}: ${outcome.skipped}`); continue; }
    evaluated += 1;
    if (outcome.code) rejections.push(`${short}: ${outcome.code}`);
  }

  assert.ok(evaluated > 40, `expected to evaluate most runners, got ${evaluated}`);
  assert.deepEqual(
    rejections,
    [],
    "these runners refuse the config the fixture writes, so their live gate can never open:\n" +
      rejections.join("\n"),
  );
  assert.deepEqual(skipped, [], `runners the fixture could not describe:\n${skipped.join("\n")}`);
});

test("the fixture's own policy block carries no retired field", () => {
  // The authority this test trusts must itself be on the current contract.
  const policy = fixturePolicyFor(fixtureActions("move_to_tile"));
  assert.deepEqual(
    Object.keys(policy).sort(),
    ["DeniedActionFamilies", "DeniedActions", "ExperimentalActions"],
  );
  for (const key of Object.keys(policy)) assert.ok(Array.isArray(policy[key]), key);
});