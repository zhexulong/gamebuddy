import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

import { publishedActionRegistrations } from "./lib/stardew-native-smoke-harness-v1.mjs";
import {
  exportedNames,
  planMigration,
  readImport,
  readLifecycle,
  renderMigratedSource,
  splitStatements,
  resolveScenario,
} from "./migrate-runner-to-template.mjs";

const ROOT = resolve(import.meta.dirname, "..");
const TEMPLATE = readFileSync(resolve(ROOT, "tools/lib/native-local-runner-scaffold.mjs"), "utf8");

/**
 * A runner with the template's lifecycle shape and nothing else, so the census and the codemod are exercised against a
 * source this test owns rather than against a file the next migration will rewrite.
 */
const SHAPED = `import { assertRequiredCapabilities, executeFresh, observeFresh, waitForTerminal } from "./lib/stardew-native-smoke-harness-v1.mjs";

const ACTION = "shape_example";
const SCENARIO = "native_shape_example_v1";
const REQUIRED_CAPABILITIES = ["cancel_active_execution", "inspect_self", ACTION];

export async function runShapeExampleSmoke(client, receipts, config, { terminalTimeoutMs = 5_000 } = {}) {
  const trace = [];
  const startedAt = Date.now();
  validateFixtureConfig(config);
  try {
    const before = await observeFresh(client, { actionable: true });
    assertRequiredCapabilities(before, REQUIRED_CAPABILITIES);
    const target = chooseTarget(before);
    const requestId = \`native_local_shape_example_\${Date.now()}\`;
    const accepted = await executeFresh(client, {
      requestId,
      idempotencyKey: \`\${requestId}_idem\`,
      action: ACTION,
      args: { expectedTargetId: target.targetId },
      snapshot: before,
      timeoutMs: 30_000,
    });
    trace.push({ action: ACTION, receipt: accepted });
    const terminal = await waitForTerminal(receipts, accepted, terminalTimeoutMs);
    if (terminal.requestId !== requestId || terminal.executionId !== accepted.executionId)
      throw new Error("shape_example_terminal_identity_mismatch");
    if (terminal.state !== "succeeded" || terminal.reasonCode !== "shape_example_done")
      throw new Error(\`shape_example_failed:\${terminal.reasonCode}\`);
    const evidence = parseStrictEvidence(terminal.evidence);
    const after = await observeFresh(client, { actionable: true });
    const passed = after.revision >= terminal.revision && evidence.moved === "true";
    return {
      state: passed ? "passed" : "blocked",
      topology: "native_local_player_fixture",
      reasonCode: passed ? "shape_example_done" : "shape_example_postcondition_mismatch",
      target: target.targetId,
      receipt: summarizeReceipt(terminal),
      evidence,
      trace,
      durationMs: Date.now() - startedAt,
    };
  } catch (error) {
    return {
      state: "blocked",
      topology: "native_local_player_fixture",
      reasonCode: String(error instanceof Error ? error.message : error).slice(0, 256),
      trace,
    };
  }
}

function chooseTarget(snapshot) {
  return (snapshot.exampleTargets ?? [])[0];
}

function validateFixtureConfig(value) {
  if (value?.NativeLocalPlayerFixture?.Enable !== true)
    throw new Error("native_local_shape_example_fixture_not_enabled");
}

function parseStrictEvidence(evidence) {
  const detail = typeof evidence?.detail === "string" ? evidence.detail : "";
  if (detail.length === 0) throw new Error("native_local_evidence_empty");
  return Object.fromEntries(
    detail
      .split(";")
      .map((pair) => {
        const index = pair.indexOf("=");
        return index > 0 ? [pair.slice(0, index), pair.slice(index + 1)] : null;
      })
      .filter(Boolean),
  );
}

if (import.meta.main) {
  const config = await runShapeExampleSmoke(session.client, session.receipts, config);
}
`;

const plan = (source, scenario = "native_shape_example_v1") =>
  planMigration(source, { scenario, templateSource: TEMPLATE });

test("the scanner keeps an import list and an object literal whole, and still splits block statements", () => {
  const source = `import {
  a,
  b,
} from "./m.mjs";
const table = { one: 1, two: 2 };
if (table) { work(); }
export { a as b };`;
  const split = splitStatements(source);
  assert.equal(split.unterminated, null);
  assert.equal(split.statements.length, 4, split.statements.map((entry) => entry.code).join(" | "));
  assert.deepEqual(readImport(split.statements[0].code), { module: "./m.mjs", names: ["a", "b"] });
});

test("a runner with the template's lifecycle shape matches", () => {
  const reading = readLifecycle(SHAPED);
  assert.equal(reading.reason, null);
  assert.equal(reading.match, true);
});

test("a runner that sends another action first does not match, and the reason names it", () => {
  const source = SHAPED.replace(
    "    const requestId = `native_local_shape_example_${Date.now()}`;",
    '    await executeFresh(client, { requestId: "x", idempotencyKey: "x", action: "equip_tool", args: {}, snapshot: before, timeoutMs: 30_000 });\n' +
      "    const requestId = `native_local_shape_example_${Date.now()}`;",
  );
  const reading = readLifecycle(source);
  assert.equal(reading.match, false);
  assert.match(reading.reason, /^no_equip_first:equip_tool/u);
});

test("a second send that is not the refused stale re-send does not match, and the reason says which half is missing", () => {
  const source = SHAPED.replace(
    "    const terminal = await waitForTerminal(receipts, accepted, terminalTimeoutMs);",
    "    const again = await executeFresh(client, { requestId, idempotencyKey: `${requestId}_idem`, action: ACTION, args: {}, snapshot: before, timeoutMs: 30_000 });\n" +
      "    const terminal = await waitForTerminal(receipts, accepted, terminalTimeoutMs);",
  );
  const reading = readLifecycle(source);
  assert.equal(reading.match, false);
  assert.match(reading.reason, /^standard_stale_re_send:not_sent_against_the_post_run_world$/u);
});

test("a stale re-send against the pre-run snapshot does not match: the template re-sends against the post-run world", () => {
  const source = SHAPED.replace(
    '    const passed = after.revision >= terminal.revision && evidence.moved === "true";',
    "    const stale = await executeFresh(client, { requestId, idempotencyKey: `${requestId}_idem`, action: ACTION, args: {}, snapshot: before, timeoutMs: 30_000 });\n" +
      '    if (stale.state !== "rejected") throw new Error("shape_example_stale_not_refused");\n' +
      '    const passed = after.revision >= terminal.revision && evidence.moved === "true";',
  );
  const reading = readLifecycle(source);
  assert.equal(reading.match, false);
  assert.match(reading.reason, /^standard_stale_re_send:/u);
});

test("the codemod lifts the judgement verbatim and replaces the lifecycle", () => {
  const result = plan(SHAPED);
  assert.equal(result.ok, true, result.why);
  assert.equal(result.successCode, "shape_example_done");
  assert.equal(result.scenario, "native_shape_example_v1");
  const rendered = renderMigratedSource(SHAPED, result);
  assert.equal(rendered.ok, true, rendered.why);
  assert.match(rendered.output, /defineSmokeScenario\(\{/u);
  assert.match(rendered.output, /evidence\.moved === "true"/u);
  assert.match(rendered.output, /if \(!\(passed\)\) throw new Error\("shape_example_postcondition_mismatch"\);/u);
  assert.match(rendered.output, /const \{ target \} = plan;/u);
  assert.deepEqual(exportedNames(rendered.output), exportedNames(SHAPED));
  assert.equal(rendered.output.includes("waitForTerminal("), false, "the wait belongs to the template now");
});

test("the codemod refuses a statement it cannot place rather than dropping it", () => {
  const source = SHAPED.replace(
    '    if (terminal.state !== "succeeded"',
    '    noteSomething(terminal);\n    if (terminal.state !== "succeeded"',
  );
  const result = plan(source);
  assert.equal(result.ok, false);
  assert.match(result.why, /^terminal_success_check_is_not_the_canonical_step/u);
});

test("the codemod refuses a copy whose evidence parser is not the template's", () => {
  const source = SHAPED.replace(
    "return index > 0 ? [pair.slice(0, index), pair.slice(index + 1)] : null;",
    "return index >= 0 ? [pair.slice(0, index), pair.slice(index + 1)] : null;",
  );
  const result = plan(source);
  assert.equal(result.ok, false);
  assert.match(result.why, /^evidence_parser_differs/u);
});

test("the codemod refuses when the copy's own SCENARIO disagrees with the action's gate descriptor", () => {
  const source = SHAPED.replace(
    'const SCENARIO = "native_shape_example_v1";',
    'const SCENARIO = "native_something_else_v1";',
  );
  const result = plan(source);
  assert.equal(result.ok, false);
  assert.match(result.why, /^fixture_scenario_disagrees:native_something_else_v1:native_shape_example_v1/u);
});

test("the codemod refuses a copy that never refused its own fixture config", () => {
  const source = SHAPED.replace("  validateFixtureConfig(config);\n", "");
  assert.notEqual(source, SHAPED, "the injection point moved; update this falsifier with the fixture");
  const result = plan(source);
  assert.equal(result.ok, false);
  assert.match(result.why, /^config_refusal_missing:/u);
});

test("the codemod is a no-op on a runner that is already on the template", () => {
  const first = renderMigratedSource(SHAPED, plan(SHAPED));
  assert.equal(first.ok, true);
  const second = plan(first.output);
  assert.equal(second.ok, true);
  assert.equal(second.alreadyMigrated, true);
  assert.equal(second.output, first.output);
});

test("the codemod refuses when the template starts requiring a field it does not write", () => {
  const moved = TEMPLATE.replace(
    'const prepare = requireField(definition, "prepare", "function");',
    'const prepare = requireField(definition, "prepare", "function");\n  const negativeHook = requireField(definition, "negativeHook", "function");',
  );
  assert.notEqual(moved, TEMPLATE, "the injection point moved; update this falsifier with the template");
  const result = planMigration(SHAPED, { scenario: "native_shape_example_v1", templateSource: moved });
  assert.equal(result.ok, false);
  assert.equal(result.why, "template_definition_required_field_not_written:negativeHook");
});

test("the codemod refuses when the template stops reading a field it writes", () => {
  const moved = TEMPLATE.replace("const negative = definition.negative ?? null;", "");
  assert.notEqual(moved, TEMPLATE, "the injection point moved; update this falsifier with the template");
  const result = planMigration(SHAPED, { scenario: "native_shape_example_v1", templateSource: moved });
  assert.equal(result.ok, false);
  assert.equal(result.why, "template_definition_field_unknown:negative");
});

test("a runner that arms no fixture world is refused by name", () => {
  assert.deepEqual(resolveScenario([{ actionId: "move_placed_furniture", scenario: "" }]), {
    ok: false,
    why: "fixture_scenario_empty:move_placed_furniture",
  });
});

test("a runner serving two worlds is refused rather than pinned to one", () => {
  const result = resolveScenario([
    { actionId: "chest_store", scenario: "native_chest_store_v1" },
    { actionId: "fridge_store", scenario: "native_fridge_store_v1" },
  ]);
  assert.equal(result.ok, false);
  assert.match(result.why, /^fixture_scenario_ambiguous:/u);
});

/* ---------------------------------------------------------------------------------------------------------------
 * THE MIGRATED RUNNERS, DRIVEN THROUGH A FAKE SESSION.
 *
 * Each case is a way a live run could lie: the honest receipt, and the postcondition the copy's own judgement refuses.
 * The reason code on the failing path is the one the HAND-WRITTEN copy produced, which is what makes this a proof that
 * the migration kept the judgement rather than replaced it.
 * ------------------------------------------------------------------------------------------------------------- */

const CONFIG = (scenario) => ({
  NativeLocalPlayerFixture: { Enable: true, Bootstrap: { Enable: false }, FixtureScenario: scenario },
  Portfolio: { Enable: false },
  HostAutomation: { Enable: false },
  HostFarmhandProvisioning: { Enable: false },
  FarmhandProvisioner: { Enable: false },
  DeniedActions: [],
  DeniedActionFamilies: [],
  ExperimentalActions: [],
});

function snapshot(revision, extra) {
  return {
    revision,
    location: "FarmHouse",
    tile: { x: 5, y: 5 },
    capabilities: ["cancel_active_execution", "inspect_self", "craft_item", "cook_recipe", "collect_crab_pot_output"],
    actionable: true,
    activeExecution: null,
    ...extra,
  };
}

function session({ before, after, evidence, reasonCode }) {
  const receipts = [];
  let observations = 0;
  const client = {
    state: { catalogRegistrations: publishedActionRegistrations(), snapshot: before, latestReceipt: null },
    async observe() {
      observations++;
      const answer = observations === 1 ? before : after;
      client.state.snapshot = answer;
      return answer;
    },
    async execute(envelope) {
      const accepted = { requestId: envelope.requestId, executionId: "execution-1", state: "accepted" };
      receipts.push({
        ...accepted,
        state: "succeeded",
        reasonCode,
        revision: after.revision,
        evidence: { detail: evidence },
      });
      client.state.latestReceipt = accepted;
      return accepted;
    },
  };
  return { client, receipts };
}

test("craft_item: the migrated runner passes on the honest receipt and blocks on a wrong count", async () => {
  const { runCraftItemSmoke } = await import("./run-stardew-native-local-player-craft-item-smoke.mjs");
  const evidence = (countAfter) =>
    `disposition=added_to_inventory;materials_consumed_exactly=true;inventory_postcondition=true;count_postcondition=true;` +
    `native_menu_opened=false;count_before=7;count_after=${countAfter}`;

  const honest = session({
    before: snapshot(3, {}),
    after: snapshot(5, {}),
    evidence: evidence(8),
    reasonCode: "crafted_item_created",
  });
  const passed = await runCraftItemSmoke(honest.client, honest.receipts, CONFIG("native_craft_item_v1"));
  assert.equal(passed.state, "passed");
  assert.equal(passed.reasonCode, "crafted_item_created");
  assert.equal(passed.recipe, "Wood_Fence");

  const wrong = session({
    before: snapshot(3, {}),
    after: snapshot(5, {}),
    evidence: evidence(9),
    reasonCode: "crafted_item_created",
  });
  const blocked = await runCraftItemSmoke(wrong.client, wrong.receipts, CONFIG("native_craft_item_v1"));
  assert.equal(blocked.state, "blocked");
  assert.equal(blocked.reasonCode, "craft_item_postcondition_mismatch");
});

test("cook_recipe: the migrated runner passes on the honest receipt and blocks when the station is not the kitchen", async () => {
  const { runCookRecipeSmoke } = await import("./run-stardew-native-local-player-cook-recipe-smoke.mjs");
  const evidence = (station) =>
    `station=${station};disposition=inventory;count_incremented=true;native_menu_opened=false;` +
    `recipes_cooked_before=2;recipes_cooked_after=3;inventory_before=4;inventory_after=5;delivered=1`;

  const honest = session({
    before: snapshot(3, {}),
    after: snapshot(5, {}),
    evidence: evidence("cookout_kit@Home"),
    reasonCode: "dish_cooked",
  });
  const passed = await runCookRecipeSmoke(honest.client, honest.receipts, CONFIG("native_cook_recipe_v1"));
  assert.equal(passed.state, "passed");
  assert.equal(passed.reasonCode, "dish_cooked");

  const wrong = session({
    before: snapshot(3, {}),
    after: snapshot(5, {}),
    evidence: evidence("stove"),
    reasonCode: "dish_cooked",
  });
  const blocked = await runCookRecipeSmoke(wrong.client, wrong.receipts, CONFIG("native_cook_recipe_v1"));
  assert.equal(blocked.state, "blocked");
  assert.equal(blocked.reasonCode, "cook_recipe_postcondition_mismatch");
});

test("crab_pot_collect: the migrated runner passes when the pot left the mature set and blocks when it did not", async () => {
  const { runCrabPotCollectSmoke } = await import("./run-stardew-native-local-player-crab-pot-collect-smoke.mjs");
  const TARGET = {
    targetId: "collect_crab_pot_0123456789abcdef",
    x: 6,
    y: 5,
    qualifiedItemId: "(O)710",
    outputQualifiedItemId: "(O)715",
    outputStack: 1,
  };
  const evidence =
    `target=${TARGET.targetId};pot=(O)710;pot_retained=true;native_handled=true;held_after=none;ready_after=false;` +
    "tile_index_after=710;bait_after=none;stack_delivered=1;inventory_before=4;inventory_after=5";

  const honest = session({
    before: snapshot(3, { crabPotCollectTargets: [TARGET] }),
    after: snapshot(5, { crabPotCollectTargets: [] }),
    evidence,
    reasonCode: "crab_pot_output_collected",
  });
  const passed = await runCrabPotCollectSmoke(honest.client, honest.receipts, CONFIG("native_crab_pot_collect_v1"));
  assert.equal(passed.state, "passed");
  assert.equal(passed.reasonCode, "crab_pot_output_collected");
  assert.equal(passed.target.targetId, TARGET.targetId);

  const wrong = session({
    before: snapshot(3, { crabPotCollectTargets: [TARGET] }),
    after: snapshot(5, { crabPotCollectTargets: [TARGET] }),
    evidence,
    reasonCode: "crab_pot_output_collected",
  });
  const blocked = await runCrabPotCollectSmoke(wrong.client, wrong.receipts, CONFIG("native_crab_pot_collect_v1"));
  assert.equal(blocked.state, "blocked");
  assert.equal(blocked.reasonCode, "crab_pot_collect_postcondition_mismatch");
});
