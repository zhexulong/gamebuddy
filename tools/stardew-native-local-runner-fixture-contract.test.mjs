// The behavior the static runner-contract audit cannot check: does each runner
// ACCEPT the config the fixture actually writes?
//
// red-proof: history  a0d756df added `result.EnabledActions` to the fixture writer, a key ModConfig no longer
//   declares: that revision's config carried it, the replica this file used to compare against a literal stayed green,
//   and reading the writer's output instead, the same revision reds here naming `EnabledActions`.
//
// The audit reads runner source text for two retired patterns. That cannot see a
// runner whose check mentions neither pattern but still contradicts the fixture
// -- `npc-relationship` kept requiring `ExperimentalActions == ["npc_relationship"]`
// after the action was promoted to live-verified, so it rejected every real
// config while the audit called it conforming and its own test (which built the
// same stale shape by hand) stayed green.
//
// So the config comes from the WRITER: `configureNativeLocalPlayer` is what
// `prepareNativeLocalPlayerFixture` calls to build the `config.json` a run ships,
// and it is invoked here once per runner. This file used to carry its own copy of
// that block (`fixturePolicyFor`) and compare the copy against a literal, which
// left its "carries no retired field" case green while the writer held a key the
// Mod's `ModConfig` had stopped declaring - a copy can only fail when someone
// edits the copy.
//
// The action each runner serves comes from the authoritative gate table, not
// from its filename: several runners are not per-action gates (recovery chains,
// multi-action probes) and their action set is declared below.
//
// Scope is deliberately the POLICY axis: the block that drifted (EnabledActions
// -> deny-by-exception, and the experimental opt-in). Fields the Mod writes back
// at live time, and capabilities the world reports, are not this test's subject.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { configureNativeLocalPlayer, fixtureActions } from "./lib/stardew-native-local-player-fixture.mjs";
import { readExperimentalStardewActionIds } from "./lib/stardew-published-action-registry.mjs";
import {
  STARDEW_EXPERIMENTAL_ACTION_RUNNERS,
  STARDEW_PUBLISHED_ACTION_GATES,
} from "./stardew-action-gate-descriptors.mjs";

const TOOLS = resolve(fileURLToPath(new URL(".", import.meta.url)));

/** The Mod's config record: the consumer side of every key the writer emits. */
const MOD_CONFIG_PATH = resolve(TOOLS, "..", "integrations", "stardew", "ModConfig.cs");

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
  "run-stardew-native-local-player-break-container-source-smoke.mjs": "break_container",
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
  // The body-ownership and dialogue-stream runners report facts about the BODY and about a CONVERSATION rather
  // than completing an action, so neither has a published gate entry (their fixtures are scenarios, not actions)
  // - but they are still runners whose config contract must be checked, which is what this list is for.
  "run-stardew-native-local-player-body-owner-hold-smoke.mjs": "body_owner_hold",
  // The pond runner drives the action whose fixture it uses, so this table names that action: the fixture
  // library keys the scenario on it.
  "run-stardew-native-local-player-clear-fish-pond-smoke.mjs": "clear_fish_pond",
  "run-stardew-native-local-player-build-farm-building-smoke.mjs": "build_farm_building",
  // A synchronous name write with no target id: the subject is the actor's own horse, so the
  // fixture scenario is keyed on the action alone.
  "run-stardew-native-local-player-name-entity-smoke.mjs": "name_entity",
  "run-stardew-native-local-player-accept-daily-quest-smoke.mjs": "accept_daily_quest",
  "run-stardew-native-local-player-accept-special-order-smoke.mjs": "accept_special_order",
  "run-stardew-native-local-player-claim-museum-reward-smoke.mjs": "claim_museum_reward",
  // A synchronous public-call-sequence write with no target id: the subject is the actor's own ticket
  // stack and the machine's own track position, so the fixture scenario is keyed on the action alone.
  "run-stardew-native-local-player-prize-ticket-smoke.mjs": "redeem_prize_ticket",
  "run-stardew-native-local-player-tailor-clothing-smoke.mjs": "tailor_clothing",
  "run-stardew-native-local-player-dye-clothing-with-item-smoke.mjs": "dye_clothing_with_item",
  "run-stardew-native-local-player-color-placed-object-smoke.mjs": "color_placed_object",
  // The chat deed is NOT a native-local fixture: it lives on the farmhand lane of the
  // two-process launcher (a true client of the host), so the native-local fixture
  // library has no send_multiplayer_chat mapping - the policy-check subtest skipping
  // it is the honest outcome, and the runner itself refuses any non-farmhand topology.
  "run-stardew-native-local-player-send-multiplayer-chat-smoke.mjs": "send_multiplayer_chat",
  "run-stardew-native-local-player-dialogue-stream-smoke.mjs": "dialogue_stream",
  // A read-only reachability probe: no gate entry either, declared for the same reason. It belongs to the L3
  // scene-reachability lane; declared here because this completeness invariant was red with it uncovered.
  "run-stardew-native-local-player-scene-reachable-probe-smoke.mjs": "scene_reachable_probe",
  // Loop-closure wave (2026-10-04): the 14 lane smoke runners are fixture-family
  // drivers keyed on the action they exercise, matching the gate table entries.
  "run-stardew-native-local-player-clear-cask-smoke.mjs": "clear_cask",
  "run-stardew-native-local-player-deposit-silo-hay-smoke.mjs": "deposit_silo_hay",
  // 2026-10-06: the two facility/transport actions wired this session. Same rule as the wave
  // above — keyed on the action the runner exercises.
  "run-stardew-native-local-player-withdraw-silo-hay-smoke.mjs": "withdraw_silo_hay",
  "run-stardew-native-local-player-toggle-animal-door-smoke.mjs": "toggle_animal_door",
  // 2026-10-07 item/tile lane. Same rule as the wave above -- keyed on the action the runner
  // exercises.
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
  "run-stardew-native-local-player-chop-tree-approach-smoke.mjs": "chop_tree",
  "run-stardew-native-local-player-cut-grass-smoke.mjs": "cut_grass",
  "run-stardew-native-local-player-move-stall-probe-smoke.mjs": "move_stall_probe_pet",
  // The ladder probe keys its scenario on its own harness label ("move_ladder"),
  // because the SAME published move_to_tile action is what it drives.
  "run-stardew-native-local-player-move-ladder-smoke.mjs": "move_ladder",
  // The multi-day crossing is the same shape: the SAME published advance_day is what it
  // drives, and its Given is selected by its own harness label.
  "run-stardew-native-local-player-multi-day-smoke.mjs": "multi_day",
  // `respond_level_up`'s MILESTONE half: the SAME published action over the branch world, selected by this runner's own
  // harness label exactly as `multi_day` selects its Given. It is on disk, so the coverage rule above needs it stated.
  "run-stardew-native-local-player-respond-level-up-branch-smoke.mjs": "respond_level_up_branch",
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

const experimentalIds = await readExperimentalStardewActionIds();

/** Where a native-local run's save lands, and the binding its launcher mints for it. */
const OBSERVED_SAVE_SLOT = "GameBuddyFixture_1";
const FIXTURE_TIMEOUT_SECONDS = 90;
const FIXTURE_BINDING = Object.freeze({
  version: 1,
  observedSaveSlot: OBSERVED_SAVE_SLOT,
  logicalSaveName: "GameBuddyFixture",
  saveId: "save",
  worldId: "world",
  playerId: "player",
  companionId: "companion",
});

/**
 * The config a native-local run ships, built by the writer itself.
 *
 * Nothing about its shape is restated here: `configureNativeLocalPlayer` mints the bridge identity, arms the scenario
 * and derives the policy block, so a field it stops (or starts) writing is what the runners below are handed.
 */
function configWrittenFor(actions, action) {
  return configureNativeLocalPlayer(
    null,
    OBSERVED_SAVE_SLOT,
    FIXTURE_TIMEOUT_SECONDS,
    actions,
    FIXTURE_BINDING,
    action,
    experimentalIds,
    "",
  );
}

/** Every runner on disk, paired with the action its config is derived from. */
// A LONG-SESSION DRIVER, not a single-action fixture runner: it drives the multiplayer live loop rather than completing
// one published action, so neither the gate table nor CONFIG_DRIVER_ACTION can describe it - and its filename matches
// this test's runner pattern, which is why the completeness check swept it in. Declared by name for the same reason
// FIXTURE_UNOWNED_RUNNERS is: any OTHER runner missing from all of these still fails.
const SESSION_DRIVER_RUNNERS = new Set(["run-stardew-native-local-player-multiplayer-live-loop-smoke.mjs"]);

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
  // The third registration authority, and the one that answers for a gate that completes no published action: an
  // Experimental key maps its own harness label to the runner that drives it. Derived, not listed, because a hand
  // ledger is exactly what missed `hold_absorption` when 3d446f3c shipped its gate - the runner, its fixture label and
  // its descriptor entry all existed while `cases` had no way to see any of them. Declared entries above still win,
  // because a runner whose fixture family is keyed on a DIFFERENT action states that deliberately.
  for (const [actionId, runner] of Object.entries(STARDEW_EXPERIMENTAL_ACTION_RUNNERS)) {
    if (onDisk.has(runner) && !cases.has(runner)) cases.set(runner, actionId);
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
    execute: async () => {
      throw new Error("fixture_contract_stub_no_execute");
    },
    navigationRead: async () => {
      throw new Error("fixture_contract_stub_no_navigation");
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

  // The action set is the fixture's own declaration for this action; the config is what the writer makes of it.
  let actions;
  let config;
  try {
    actions = fixtureActions(actionId);
    config = configWrittenFor(actions, actionId);
  } catch {
    return { skipped: `fixture does not own action id ${actionId}` };
  }

  const fn = entry[1];
  const client = stubClient(actions);
  const receipts = { subscribe: () => () => {}, [Symbol.iterator]: function* () {} };
  const args =
    fn.length >= 3
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

/**
 * The config contract the Mod itself declares.
 *
 * `ModConfig` is the record SMAPI deserializes `config.json` into, so a key it does not declare is a key the Mod
 * drops: the run still loads, and whatever that key was meant to arm silently is not armed. The policy fields are
 * read from the record's own `ActionPolicyOptions` mapping rather than listed here, so a field the policy engine
 * stops consuming is demanded of the writer only while the mapping still names it.
 *
 * Read rather than generated: the record is C# the Mod compiles, and a missing or unparsable record throws instead of
 * leaving this test with an empty population that agrees with itself.
 */
function modConfigContract() {
  const source = readFileSync(MOD_CONFIG_PATH, "utf8");
  const body = /public sealed record ModConfig\s*\{([\s\S]*?)\n\}/u.exec(source)?.[1];
  if (!body) throw new Error(`stardew_mod_config_unreadable: ${MOD_CONFIG_PATH}`);
  const fields = new Map(
    [...body.matchAll(/public\s+([A-Za-z0-9_<>?,\s]+?)\s+([A-Za-z0-9_]+)\s*\{\s*get;\s*init;\s*\}/gu)].map(
      ([, type, name]) => [name, type.trim()],
    ),
  );
  if (fields.size === 0) throw new Error(`stardew_mod_config_declares_no_field: ${MOD_CONFIG_PATH}`);
  const mapping = /ActionPolicyOptions\s*=>\s*new\(([\s\S]*?)\);/u.exec(body)?.[1];
  if (!mapping) throw new Error(`stardew_mod_config_has_no_action_policy_mapping: ${MOD_CONFIG_PATH}`);
  const policyFields = [...mapping.matchAll(/([A-Za-z0-9_]+)\s*:\s*this\.([A-Za-z0-9_]+)/gu)].map(
    ([, option, member]) => ({ option, member }),
  );
  if (policyFields.length === 0)
    throw new Error(`stardew_mod_config_action_policy_mapping_is_empty: ${MOD_CONFIG_PATH}`);
  return { fields, policyFields };
}

test("the gate table and the declared non-gate runners cover every runner on disk", () => {
  // Completeness first: a runner missing from both sources would silently skip
  // the assertion below, which is how this class of defect hides.
  const { cases, onDisk } = runnerCases();
  const uncovered = [...onDisk].filter((name) => !cases.has(name) && !SESSION_DRIVER_RUNNERS.has(name)).sort();
  assert.deepEqual(
    uncovered,
    [],
    "these runners are neither in the gate table, nor declared in CONFIG_DRIVER_ACTION, nor declared as a session driver, so nothing checks their config contract",
  );
});

test("the gate table names only runners that exist", () => {
  const { onDisk } = runnerCases();
  const missing = STARDEW_PUBLISHED_ACTION_GATES.filter((gate) => !onDisk.has(gate.runner)).map(
    (gate) => `${gate.actionId}: ${gate.runner}`,
  );
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
    if (outcome.skipped) {
      skipped.push(`${short}: ${outcome.skipped}`);
      continue;
    }
    evaluated += 1;
    if (outcome.code) rejections.push(`${short}: ${outcome.code}`);
  }

  assert.ok(evaluated > 40, `expected to evaluate most runners, got ${evaluated}`);
  assert.deepEqual(
    rejections,
    [],
    "these runners refuse the config the fixture writes, so their live gate can never open:\n" + rejections.join("\n"),
  );
  // The chat deed runs on the FARMHAND lane, not a native-local fixture, so `fixtureActions`
  // cannot describe it - and it must be a DECLARED, named exemption rather than a silently
  // skipped runner, so any OTHER runner that becomes undescribable still fails this test.
  const FIXTURE_UNOWNED_RUNNERS = new Set(["send-multiplayer-chat"]);
  assert.deepEqual(
    skipped.filter((entry) => !FIXTURE_UNOWNED_RUNNERS.has(entry.split(":")[0].trim())),
    [],
    `runners the fixture could not describe which are not the declared farmhand-lane exemption:\n` + skipped.join("\n"),
  );
});

test("the policy block the fixture writes is the one the Mod reads, and carries no retired field", () => {
  const { fields, policyFields } = modConfigContract();
  // The subject is the writer's output for an ordinary run, so a field the writer retires or renames is read here
  // rather than in a copy of the writer that would have to be edited to notice it.
  const config = configWrittenFor(fixtureActions("move_to_tile"), "move_to_tile");
  const written = Object.keys(config).sort();
  assert.ok(written.length > 0, "the fixture wrote no config at all, so nothing about its keys can be judged");

  const retired = written.filter((key) => Array.isArray(config[key]) && !fields.has(key));
  assert.deepEqual(
    retired,
    [],
    `the fixture writes policy fields ModConfig does not declare, so the Mod drops them and the rule they stated never applies:\n${retired.join("\n")}`,
  );

  for (const { option, member } of policyFields) {
    assert.equal(member, option, `ActionPolicyOptions reads ${option} from this.${member}, which are two facts`);
    assert.ok(fields.has(option), `ActionPolicyOptions maps ${option}, which ModConfig does not declare`);
    assert.ok(
      Object.hasOwn(config, option),
      `the fixture writes no ${option}: the Mod's policy engine reads it, so the scenario's own policy never lands`,
    );
    assert.ok(
      Array.isArray(config[option]),
      `${option} must be an array; ModConfig deserializes it as ${fields.get(option)}`,
    );
  }
});
