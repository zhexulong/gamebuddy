/**
 * The promotion tool, exercised against a FIXTURE tree rather than the live
 * repository: a test that edits the real gate table would break every other lane.
 *
 * The fixture is a small stand-in for the two tables the tool edits (the published
 * gate table plus the experimental runner map, and the descriptor test that pins
 * them three ways) with two promotions to cover both row shapes:
 *   * `beta`  - has a fixture scenario, so it takes the five-argument row and joins
 *               the fixture-backed list;
 *   * `gamma` - has none, so it takes the four-argument row and joins the
 *               scenario-less list instead.
 */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { validatePromotionSources } from "./check-stardew-action-promotion.mjs";
import {
  applyPromotionPlan,
  PROMOTION_RESPONSIBILITIES,
  parsePublishedGates,
  planPromotion,
  promoteStardewActions,
  renderGateRow,
  verifyPromotedGateRows,
} from "./promote-stardew-action.mjs";

const GATE_DESCRIPTORS = `export const STARDEW_PUBLISHED_ACTION_GATES = Object.freeze([
  gate("alpha", 1, "run-stardew-alpha-smoke.mjs", "alpha_done", "native_alpha_v1"),
  gate("delta", 1, "run-stardew-delta-smoke.mjs", "delta_done"),
]);

export const STARDEW_EXPERIMENTAL_ACTION_RUNNERS = Object.freeze({
  beta: "run-stardew-beta-smoke.mjs",
  gamma: "run-stardew-gamma-smoke.mjs",
});

function gate(actionId, identityVersion, runner, terminalReasonCode, fixtureScenario = null) {
  return Object.freeze({ actionId, identityVersion, runner, terminalReasonCode, fixtureScenario });
}
`;

const DESCRIPTOR_TEST = `import assert from "node:assert/strict";

test("descriptor runner identity names the shared-harness runner for every published gate", () => {
  const expectedRunners = Object.freeze({
    alpha: "run-stardew-alpha-smoke.mjs",
    delta: "run-stardew-delta-smoke.mjs",
  });
  assert.deepEqual(
    Object.fromEntries(STARDEW_PUBLISHED_ACTION_GATES.map((gate) => [gate.actionId, gate.runner])),
    expectedRunners,
  );
});

test("fixture-backed descriptor coverage is explicit rather than inferred", () => {
  const fixtureBacked = STARDEW_PUBLISHED_ACTION_GATES.filter((gate) => gate.fixtureScenario !== null);
  assert.deepEqual(
    fixtureBacked.map((gate) => gate.actionId),
    [
      "alpha",
    ],
  );
  assert.deepEqual(
    STARDEW_PUBLISHED_ACTION_GATES.filter((gate) => gate.fixtureScenario === null).map((gate) => gate.actionId),
    ["delta"],
  );
});
`;

const MOD_CATALOG = `namespace Fixture
{
    internal static class FarmhandActionCatalog
    {
        private static readonly IReadOnlyList<FarmhandActionRegistration> Registrations = Array.AsReadOnly(new[]
        {
            E("alpha", "fixture_family", FarmhandActionHandlerGroup.Movement, A(null, null, "alpha_done", ("x", "integer")), FarmhandActionLifecycle.LiveVerified),
            E("delta", "fixture_family", FarmhandActionHandlerGroup.Movement, A(null, null, "delta_done", ("x", "integer")), FarmhandActionLifecycle.LiveVerified),
            E("beta", "fixture_family", FarmhandActionHandlerGroup.Movement, A(null, null, "native_action_postcondition", ("x", "integer")), FarmhandActionLifecycle.Experimental),
            E("gamma", "fixture_family", FarmhandActionHandlerGroup.Movement, A(null, null, "native_action_postcondition", ("x", "integer")), FarmhandActionLifecycle.Experimental),
        });
    }
}
`;

const RUNNERS = Object.freeze({
  "run-stardew-beta-smoke.mjs": 'export function runBeta() { return { state: "passed", reasonCode: "beta_done" }; }\n',
  "run-stardew-gamma-smoke.mjs":
    'export function runGamma() { return { state: "passed", reasonCode: "gamma_done" }; }\n',
});

const RECEIPT_CORPUS = {
  receipts: [
    { actionId: "beta", state: "succeeded", reasonCode: "beta_done" },
    { actionId: "gamma", state: "succeeded", reasonCode: "gamma_done" },
  ],
};

const FIXTURES = Object.freeze({
  fixtureActions: (actionId) => {
    if (actionId === "beta" || actionId === "gamma") return [actionId];
    throw new Error("invalid_native_local_fixture_action");
  },
  fixtureScenario: (_actions, actionId) => (actionId === "beta" ? "native_beta_v1" : ""),
});

function readRunner(fileName) {
  const source = RUNNERS[fileName];
  if (source === undefined) throw new Error(`runner_not_found:${fileName}`);
  return source;
}

function sources(overrides = {}) {
  return { gateDescriptors: GATE_DESCRIPTORS, descriptorTest: DESCRIPTOR_TEST, modCatalog: MOD_CATALOG, ...overrides };
}

function plan(actionIds, { overrides, fixtures = FIXTURES, receiptCorpus = RECEIPT_CORPUS } = {}) {
  return planPromotion({ actionIds, sources: sources(overrides), fixtures, readRunner, receiptCorpus });
}

function render(actionIds) {
  const planned = plan(actionIds);
  assert.deepEqual(planned.problems, [], JSON.stringify(planned.problems));
  return { planned, rendered: applyPromotionPlan({ sources: sources(), promotions: planned.promotions }) };
}

function goldenMapEntries(source) {
  const body = /const expectedRunners = Object\.freeze\(\{([\s\S]*?)\n {2}\}\);/u.exec(source)[1];
  return [...body.matchAll(/^[ \t]*([a-z0-9_]+):[ \t]*"([a-z0-9-]+\.mjs)",/gmu)].map((match) => [match[1], match[2]]);
}

function fixtureBackedIds(source) {
  const body = /fixtureBacked\.map\(\(gate\) => gate\.actionId\),\n\s*\[([\s\S]*?)\n\s*\],/u.exec(source)[1];
  return [...body.matchAll(/"([a-z0-9_]+)"/gu)].map((match) => match[1]);
}

function scenarioLessIds(source) {
  const body = /fixtureScenario === null\)\.map\(\(gate\) => gate\.actionId\),\n\s*\[([^\]]*)\],/u.exec(source)[1];
  return [...body.matchAll(/"([a-z0-9_]+)"/gu)].map((match) => match[1]);
}

test("the header's six responsibilities are declared in promotion order", () => {
  assert.equal(PROMOTION_RESPONSIBILITIES.length, 6);
  assert.equal(PROMOTION_RESPONSIBILITIES[0], "mod_catalog_lifecycle_experimental_to_live_verified");
  assert.equal(PROMOTION_RESPONSIBILITIES[5], "derived_artifacts_regenerated_from_producers");
});

test("a scenario-bearing action gets the five-argument gate() row and every anchor moves", () => {
  const { planned, rendered } = render(["beta"]);
  assert.equal(planned.promotions.length, 1);
  assert.deepEqual(rendered.problems, []);
  assert.deepEqual(
    verifyPromotedGateRows({ source: rendered.files.gateDescriptors, promotions: planned.promotions }),
    [],
  );

  // The row is the FACTORY CALL the table uses, with all five values derived.
  assert.equal(
    parsePublishedGates(rendered.files.gateDescriptors).rows.find((row) => row.actionId === "beta").identityVersion,
    1,
  );
  assert.deepEqual(
    parsePublishedGates(rendered.files.gateDescriptors).rows.find((row) => row.actionId === "beta"),
    {
      actionId: "beta",
      identityVersion: 1,
      runner: "run-stardew-beta-smoke.mjs",
      terminalReasonCode: "beta_done",
      fixtureScenario: "native_beta_v1",
    },
  );
  assert.ok(
    rendered.files.gateDescriptors.includes(
      'gate("beta", 1, "run-stardew-beta-smoke.mjs", "beta_done", "native_beta_v1"),',
    ),
  );

  // The same id leaves the experimental map.
  assert.equal(
    rendered.files.gateDescriptors.includes('beta: "run-stardew-beta-smoke.mjs"'),
    false,
    "the experimental map must drop the promoted id",
  );
  assert.ok(rendered.files.gateDescriptors.includes('gamma: "run-stardew-gamma-smoke.mjs"'), "sibling entries stay");

  // The Mod catalog lifecycle moves, and only on that action's line.
  assert.ok(
    rendered.files.modCatalog.includes('FarmhandActionLifecycle.LiveVerified),\n            E("gamma"'),
    "beta must be LiveVerified while gamma stays Experimental",
  );
  assert.equal(
    rendered.files.modCatalog.split("FarmhandActionLifecycle.Experimental").length - 1,
    1,
    "exactly the untouched gamma registration stays Experimental",
  );

  // Both frozen lists follow the published table's order.
  assert.deepEqual(goldenMapEntries(rendered.files.descriptorTest), [
    ["alpha", "run-stardew-alpha-smoke.mjs"],
    ["delta", "run-stardew-delta-smoke.mjs"],
    ["beta", "run-stardew-beta-smoke.mjs"],
  ]);
  assert.deepEqual(fixtureBackedIds(rendered.files.descriptorTest), ["alpha", "beta"]);
  assert.deepEqual(scenarioLessIds(rendered.files.descriptorTest), ["delta"]);
});

test("a scenario-less action gets the four-argument row and joins the scenario-less list only", () => {
  const { planned, rendered } = render(["gamma"]);
  const row = parsePublishedGates(rendered.files.gateDescriptors).rows.find(
    (candidate) => candidate.actionId === "gamma",
  );
  assert.deepEqual(row, {
    actionId: "gamma",
    identityVersion: 1,
    runner: "run-stardew-gamma-smoke.mjs",
    terminalReasonCode: "gamma_done",
    fixtureScenario: null,
  });
  assert.ok(rendered.files.gateDescriptors.includes('gate("gamma", 1, "run-stardew-gamma-smoke.mjs", "gamma_done"),'));
  assert.deepEqual(
    verifyPromotedGateRows({ source: rendered.files.gateDescriptors, promotions: planned.promotions }),
    [],
  );
  // The test pins the two sets separately, so the wrong list fails a different assertion.
  assert.deepEqual(fixtureBackedIds(rendered.files.descriptorTest), ["alpha"]);
  assert.deepEqual(scenarioLessIds(rendered.files.descriptorTest), ["delta", "gamma"]);
  assert.deepEqual(goldenMapEntries(rendered.files.descriptorTest), [
    ["alpha", "run-stardew-alpha-smoke.mjs"],
    ["delta", "run-stardew-delta-smoke.mjs"],
    ["gamma", "run-stardew-gamma-smoke.mjs"],
  ]);
});

test("a row longer than the print width is wrapped and still parses as a gate() call", () => {
  const row = renderGateRow({
    actionId: "talk_to_npc",
    identityVersion: 1,
    runner: "run-stardew-native-local-player-talk-to-npc-smoke.mjs",
    terminalReasonCode: "talk_to_npc_talked",
    fixtureScenario: "native_talk_to_npc_v1",
  });
  assert.ok(row.startsWith("  gate(\n"), row);
  const wrapped = `export const STARDEW_PUBLISHED_ACTION_GATES = Object.freeze([\n${row}\n]);\n`;
  assert.deepEqual(parsePublishedGates(wrapped).rows, [
    {
      actionId: "talk_to_npc",
      identityVersion: 1,
      runner: "run-stardew-native-local-player-talk-to-npc-smoke.mjs",
      terminalReasonCode: "talk_to_npc_talked",
      fixtureScenario: "native_talk_to_npc_v1",
    },
  ]);
});

test("refuses before rendering anything and prints every problem from one pass", () => {
  const planned = planPromotion({
    actionIds: ["beta", "zeta"],
    sources: sources(),
    fixtures: FIXTURES,
    readRunner,
    // beta's recorded receipt names a code its runner never asserts, while zeta
    // has no experimental entry and no Mod registration at all.
    receiptCorpus: { receipts: [{ actionId: "beta", state: "succeeded", reasonCode: "beta_other" }] },
  });
  assert.deepEqual(planned.promotions, [], "nothing may be rendered while any anchor is wrong");
  for (const problem of [
    "terminal_not_asserted_by_runner:beta:beta_other:run-stardew-beta-smoke.mjs",
    "not_in_experimental_runner_map:zeta",
    "mod_catalog_registration_not_found:zeta",
  ])
    assert.ok(planned.problems.includes(problem), `${problem} missing from ${JSON.stringify(planned.problems)}`);
});

test("refuses a terminal that the runner does not assert, and a scenario the fixture cannot own", () => {
  const wrongTerminal = planPromotion({
    actionIds: ["beta"],
    sources: sources(),
    fixtures: FIXTURES,
    readRunner,
    // The recorded live receipt names a code this runner never asserts.
    receiptCorpus: { receipts: [{ actionId: "beta", state: "succeeded", reasonCode: "beta_other" }] },
  });
  assert.deepEqual(wrongTerminal.promotions, []);
  assert.ok(
    wrongTerminal.problems.includes("terminal_not_asserted_by_runner:beta:beta_other:run-stardew-beta-smoke.mjs"),
    JSON.stringify(wrongTerminal.problems),
  );

  const badScenario = plan(["beta"], { fixtures: { ...FIXTURES, fixtureScenario: () => "beta_v1" } });
  assert.ok(badScenario.problems.includes("scenario_shape:beta:beta_v1"), JSON.stringify(badScenario.problems));
});

test("MUTATION: a bare `{ actionId, runner }` row is refused by the pre-write self-check", () => {
  const { planned, rendered } = render(["beta"]);
  assert.deepEqual(
    verifyPromotedGateRows({ source: rendered.files.gateDescriptors, promotions: planned.promotions }),
    [],
  );

  // Exactly what the scratch generator wrote: an object literal, no identityVersion.
  const bare = rendered.files.gateDescriptors.replace(
    '  gate("beta", 1, "run-stardew-beta-smoke.mjs", "beta_done", "native_beta_v1"),',
    '  { actionId: "beta", runner: "run-stardew-beta-smoke.mjs" },',
  );
  assert.notEqual(bare, rendered.files.gateDescriptors, "the mutation must actually change the table");
  assert.deepEqual(verifyPromotedGateRows({ source: bare, promotions: planned.promotions }), [
    "rendered_row_is_not_a_gate_call:beta",
  ]);
});

test("MUTATION: the real promotion gate reports gate_identity_drift for that same bare row", async () => {
  const root = new URL("..", import.meta.url);
  const read = async (path) => readFile(new URL(path, root), "utf8");
  const realSources = Object.fromEntries(
    await Promise.all(
      Object.entries({
        farmhandActionDefinitions: "integrations/stardew/src/Core/Policy/FarmhandActionDefinitions.cs",
        bridgeSession: "integrations/stardew/BridgeSession.cs",
        executionManager: "integrations/stardew/farmhandexecutioncontroller.cs",
        farmhandActionRouter: "integrations/stardew/src/Core/Routing/FarmhandActionRouter.cs",
        registry: "host/src/action-registry.ts",
        gameTools: "host/src/game-tools.ts",
        protocol: "host/src/protocol.ts",
        schema: "protocol/bridge-v1.schema.json",
      }).map(async ([key, path]) => [key, await read(path)]),
    ),
  );
  const { failures } = validatePromotionSources({
    ...realSources,
    descriptors: [{ actionId: "move_to_tile", runner: "run-stardew-native-local-player-move-smoke.mjs" }],
  });
  assert.ok(
    failures.includes("gate_identity_drift:move_to_tile"),
    `the real gate must catch the bare row: ${JSON.stringify(failures.slice(0, 8))}`,
  );
});

test("is idempotent: running on a promoted action reports it and changes nothing", async () => {
  const root = await makeFixtureRoot();
  const promoted = await promoteStardewActions({
    actionIds: ["beta"],
    root,
    fixtures: FIXTURES,
    runGates: ({ gates }) => gates.map((gate) => ({ label: gate.label, exitCode: 0, output: [] })),
  });
  assert.equal(promoted.state, "promoted");
  const after = await readFile(join(root, "tools/stardew-action-gate-descriptors.mjs"), "utf8");

  let gateRuns = 0;
  const again = await promoteStardewActions({
    actionIds: ["beta"],
    root,
    fixtures: FIXTURES,
    runGates: () => {
      gateRuns += 1;
      return [];
    },
  });
  assert.equal(again.state, "noop");
  assert.deepEqual(again.alreadyPromoted, ["beta"]);
  assert.equal(gateRuns, 0, "an already-promoted action must not re-run the gates");
  assert.equal(await readFile(join(root, "tools/stardew-action-gate-descriptors.mjs"), "utf8"), after);
});

test("writes on promotion, runs the gates, and refuses without writing when an anchor is missing", async () => {
  const root = await makeFixtureRoot();
  const before = await readFile(join(root, "tools/stardew-action-gate-descriptors.mjs"), "utf8");
  const gateCalls = [];
  const result = await promoteStardewActions({
    actionIds: ["beta"],
    root,
    fixtures: FIXTURES,
    runGates: ({ root: gateRoot, gates }) => {
      gateCalls.push({
        gateRoot,
        labels: gates.map((gate) => gate.label),
        commands: gates.map((gate) => `node ${gate.args.join(" ")}`),
      });
      return gates.map((gate) => ({
        label: gate.label,
        command: `node ${gate.args.join(" ")}`,
        exitCode: 0,
        output: [],
      }));
    },
  });
  assert.equal(result.state, "promoted");
  assert.equal(result.gates.length, 5);
  assert.equal(gateCalls.length, 1);
  assert.deepEqual(gateCalls[0].commands, [
    "node tools/check-stardew-action-promotion.mjs",
    "node --test tools/stardew-action-gate-descriptors.test.mjs",
    "node --test tools/resolve-stardew-action-gate-runner.test.mjs",
    "node --test tools/stardew-native-local-runner-fixture-contract.test.mjs",
    "node tools/audit-stardew-discovery-channels.mjs",
  ]);
  const after = await readFile(join(root, "tools/stardew-action-gate-descriptors.mjs"), "utf8");
  assert.notEqual(after, before);
  assert.ok(after.includes('gate("beta", 1, "run-stardew-beta-smoke.mjs", "beta_done", "native_beta_v1"),'));

  const refusingRoot = await makeFixtureRoot();
  const refusingBefore = await readFile(join(refusingRoot, "tools/stardew-action-gate-descriptors.mjs"), "utf8");
  let refusingGateRuns = 0;
  const refused = await promoteStardewActions({
    actionIds: ["zeta"],
    root: refusingRoot,
    fixtures: FIXTURES,
    runGates: () => {
      refusingGateRuns += 1;
      return [];
    },
  });
  assert.equal(refused.state, "refused");
  assert.ok(refused.problems.includes("not_in_experimental_runner_map:zeta"));
  assert.equal(refusingGateRuns, 0, "a refusal must not run the gates");
  assert.equal(
    await readFile(join(refusingRoot, "tools/stardew-action-gate-descriptors.mjs"), "utf8"),
    refusingBefore,
    "a refusal must write nothing",
  );
});

test("reports a failed gate as a failure rather than a promotion", async () => {
  const root = await makeFixtureRoot();
  const result = await promoteStardewActions({
    actionIds: ["beta"],
    root,
    fixtures: FIXTURES,
    runGates: ({ gates }) =>
      gates.map((gate, index) => ({
        label: gate.label,
        command: `node ${gate.args.join(" ")}`,
        exitCode: index === 0 ? 1 : 0,
        output: [],
      })),
  });
  assert.equal(result.state, "gate_failed");
  assert.equal(result.gates.filter((gate) => gate.exitCode !== 0).length, 1);
});

test("--dry-run plans and renders without writing or running the gates", async () => {
  const root = await makeFixtureRoot();
  const before = await readFile(join(root, "tools/stardew-action-gate-descriptors.mjs"), "utf8");
  let gateRuns = 0;
  const result = await promoteStardewActions({
    actionIds: ["beta"],
    root,
    dryRun: true,
    fixtures: FIXTURES,
    runGates: () => {
      gateRuns += 1;
      return [];
    },
  });
  assert.equal(result.state, "dry_run");
  assert.deepEqual(result.edits.gateRows, [
    'gate("beta", 1, "run-stardew-beta-smoke.mjs", "beta_done", "native_beta_v1"),',
  ]);
  assert.equal(gateRuns, 0);
  assert.equal(await readFile(join(root, "tools/stardew-action-gate-descriptors.mjs"), "utf8"), before);
});

async function makeFixtureRoot() {
  const root = await mkdtemp(join(tmpdir(), "promote-stardew-action-"));
  await mkdir(join(root, "tools"), { recursive: true });
  await mkdir(join(root, "integrations/stardew/src/Core/Policy"), { recursive: true });
  await mkdir(join(root, "host/src/test-fixtures"), { recursive: true });
  await writeFile(join(root, "tools/stardew-action-gate-descriptors.mjs"), GATE_DESCRIPTORS);
  await writeFile(join(root, "tools/stardew-action-gate-descriptors.test.mjs"), DESCRIPTOR_TEST);
  await writeFile(join(root, "integrations/stardew/src/Core/Policy/FarmhandActionDefinitions.cs"), MOD_CATALOG);
  await writeFile(
    join(root, "host/src/test-fixtures/stardew-live-receipts.json"),
    `${JSON.stringify(RECEIPT_CORPUS)}\n`,
  );
  for (const [name, source] of Object.entries(RUNNERS)) await writeFile(join(root, "tools", name), source);
  return root;
}
