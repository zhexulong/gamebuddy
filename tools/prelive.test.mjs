/**
 * `tools/prelive.mjs` - the static ladder, tested without a game.
 *
 * Each rung is a pure function over the authorities (linkage, paths, runner sources), so every rule is falsified here
 * by fabricating the drift rather than by waiting for it to appear in the tree.
 *
 * Test (v) proves the ladder's own composition green over a synthetic clean tree. The REAL tree's L3 state is not a
 * green: it is the recorded baseline in `tools/prelive-l3-baseline.json` (11 known sites, every one of them a runner
 * that asserts a world fact from a one-shot observation), and the ratchet can only move that number down.
 *
 * red-proof: fixture  the ladder's rules are falsified by fabricating the drift in a synthetic tree
 * rather than by waiting for it to appear: test (iv) drives a one-shot actionable observation whose
 * assertion reads a world fact and expects the ladder to report it red, and test (iii) plants a sibling
 * directory sharing the installation's name prefix and expects it to be refused. A rung that stopped
 * checking either would fail those tests, not pass silently.
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_GAME_INSTALL,
  actionRegistryRung,
  actionRung,
  checkDeployIsolation,
  checkLinkageClosure,
  checkPopulationAgreement,
  checkRunnerShape,
  compileHostTestArtifact,
  deployRung,
  firstTypeScriptError,
  format,
  isInside,
  linkageRung,
  optOutRules,
  parseActionPopulations,
  parseArgs,
  parseKnownFixtureScenarios,
  parseModDispatchScenarios,
  reachableRunnerNames,
  runGateRung,
  runLadder,
  shapeRung,
} from "./prelive.mjs";
import { GATE_EXEMPT_PUBLISHED_ACTIONS } from "./lib/stardew-published-action-registry.mjs";
import { resolveStardewActionGateRunner } from "./resolve-stardew-action-gate-runner.mjs";
import {
  STARDEW_EXPERIMENTAL_ACTION_RUNNERS,
  STARDEW_PUBLISHED_ACTION_GATES,
} from "./stardew-action-gate-descriptors.mjs";

const HARNESS_SOURCE = `
export function assertRequiredCapabilities(snapshot, required) {
  if (!Array.isArray(snapshot.capabilities)) throw new Error("invalid_capability_surface");
}
`;

const cleanLinkage = () => ({
  runnerMap: { only_action: "run-only-action-smoke.mjs" },
  resolveScenario: () => "native_only_action_v1",
  knownScenarios: new Set(["native_only_action_v1"]),
  dispatchScenarios: new Set(["native_only_action_v1"]),
  noScenarioReason: {},
  fileExists: () => true,
});

const cleanRunner = `
const before = await observeFresh(client, { actionable: true });
assertRequiredCapabilities(before, REQUIRED_CAPABILITIES);
const settled = await waitForActionable(client, before, 5_000);
`;

test("(i) an action with a runner but no scenario is reported by name", () => {
  const report = checkLinkageClosure({
    ...cleanLinkage(),
    resolveScenario: () => "",
  });
  assert.equal(report.status, "failed");
  assert.equal(report.linked, 0);
  assert.equal(report.violations.length, 1);
  assert.equal(report.violations[0].action, "only_action");
  assert.deepEqual(report.violations[0].failed, ["a:no_scenario_undeclared"]);
});

test("(i) the same empty scenario is accepted when the action declares a noScenarioReason", () => {
  const report = checkLinkageClosure({
    ...cleanLinkage(),
    resolveScenario: () => "",
    noScenarioReason: { only_action: "the ordinary world is the whole Given" },
  });
  assert.equal(report.status, "passed");
  assert.equal(report.linked, 1);
});

test("(i) a noScenarioReason for an action that now resolves to a scenario is stale, not silent", () => {
  const report = checkLinkageClosure({
    ...cleanLinkage(),
    noScenarioReason: { only_action: "no longer true" },
  });
  assert.equal(report.status, "failed");
  assert.deepEqual(report.staleReasons, ["only_action"]);
});

test("(ii) a tools-side scenario missing from KnownFixtureScenarios is reported by name", () => {
  const report = checkLinkageClosure({
    ...cleanLinkage(),
    resolveScenario: () => "native_unwritten_v1",
    knownScenarios: new Set(["native_only_action_v1"]),
    dispatchScenarios: new Set(["native_only_action_v1", "native_unwritten_v1"]),
  });
  assert.equal(report.status, "failed");
  assert.equal(report.violations[0].action, "only_action");
  assert.equal(report.violations[0].scenario, "native_unwritten_v1");
  assert.deepEqual(report.violations[0].failed, ["b:scenario_not_in_KnownFixtureScenarios"]);
});

test("(ii) a scenario known to the config but with no Mod dispatch block is reported, and so is a missing runner", () => {
  const report = checkLinkageClosure({
    ...cleanLinkage(),
    resolveScenario: () => "native_known_v1",
    knownScenarios: new Set(["native_known_v1"]),
    dispatchScenarios: new Set(["other_v1"]),
    fileExists: () => false,
  });
  assert.equal(report.status, "failed");
  assert.deepEqual(report.violations[0].failed, ["c:no_mod_dispatch_block", "d:runner_file_missing"]);
});

test("(ii) the real Mod config and the real partials parse into the two scenario authorities", () => {
  const known = parseKnownFixtureScenarios(
    'static readonly string[] KnownFixtureScenarios = new[] { "a_v1", /* "no_v1" */ "b_v1" };',
  );
  assert.deepEqual([...known].sort(), ["a_v1", "b_v1"]);
  const dispatch = parseModDispatchScenarios(
    'if (options.FixtureScenario == "a_v1") {} else if (options.FixtureScenario is "b_v1") {}',
  );
  assert.deepEqual([...dispatch].sort(), ["a_v1", "b_v1"]);
});

test("(iii) a deploy root inside the game installation is red and the message names both paths", () => {
  const gameInstall = "D:\\Steam\\steamapps\\common\\Stardew Valley";
  const deployRoot = `${gameInstall}\\Mods\\GameBuddy.Stardew`;
  const report = checkDeployIsolation({ deployRoot, gameInstall });
  assert.equal(report.status, "failed");
  assert.equal(report.insideGameInstall, true);
  assert.ok(report.message.includes(report.deployRoot), "message must name the deploy root");
  assert.ok(report.message.includes(report.gameInstall), "message must name the game installation");
  assert.match(report.message, /is inside the game installation/u);
});

test("(iii) the opt-in flag is the only way to deploy inside the installation", () => {
  const gameInstall = DEFAULT_GAME_INSTALL;
  const deployRoot = `${gameInstall}/Mods`;
  assert.equal(checkDeployIsolation({ deployRoot, gameInstall }).status, "failed");
  assert.equal(checkDeployIsolation({ deployRoot, gameInstall, allowGameMods: true }).status, "passed");
});

test("(iii) a sibling directory sharing a name prefix is not inside the installation", () => {
  const gameInstall = "D:/Steam/steamapps/common/Stardew Valley";
  assert.equal(isInside(`${gameInstall}-backup/Mods`, gameInstall), false);
  assert.equal(isInside("C:/Users/long/AppData/Local/GameBuddy/stardew-fixtures/mods", gameInstall), false);
  assert.equal(isInside(gameInstall.toUpperCase().replaceAll("/", "\\"), gameInstall), true);
});

test("(iii) the resolved default deploy root is outside the real game installation", () => {
  const report = deployRung({ env: { LOCALAPPDATA: "C:\\Users\\long\\AppData\\Local" } });
  assert.equal(report.status, "passed");
  assert.equal(report.insideGameInstall, false);
});

test("(iv) a one-shot actionable observation whose assertion reads a world fact is red", () => {
  const report = checkRunnerShape({
    runners: [
      {
        file: "run-stardew-native-local-player-fake-smoke.mjs",
        source: `
const before = await observeFresh(client, { actionable: true });
if (!Number.isInteger(before.tile?.x)) throw new Error("fake_snapshot_invalid");
`,
      },
    ],
    harnessSource: HARNESS_SOURCE,
    baseline: { knownSites: [] },
    reachableRunners: new Set(["run-stardew-native-local-player-fake-smoke.mjs"]),
  });
  assert.equal(report.status, "failed");
  assert.equal(report.violations.length, 1);
  assert.equal(report.violations[0].fact, "tile");
  assert.equal(report.violations[0].line, 2);
});

test("(iv) the exemption is what the assertion READS, not the callee's name", () => {
  // A helper NAMED like the capability assertion that reads a world fact is still the defect: reusing the name must
  // not smuggle a world assertion through the exemption.
  const report = checkRunnerShape({
    runners: [
      {
        file: "run-stardew-native-local-player-fake-smoke.mjs",
        source: `
function assertRequiredCapabilities(snapshot, required) {
  if (!Number.isInteger(snapshot.revision)) throw new Error("revision_missing");
}
const before = await observeFresh(client, { actionable: true });
assertRequiredCapabilities(before, REQUIRED_CAPABILITIES);
`,
      },
    ],
    harnessSource: HARNESS_SOURCE,
    baseline: { knownSites: [] },
    reachableRunners: new Set(["run-stardew-native-local-player-fake-smoke.mjs"]),
  });
  assert.equal(report.status, "failed");
  assert.equal(report.violations[0].fact, "revision");
});

test("(iv) the wait helper and a capabilities-only assertion are both accepted", () => {
  const report = checkRunnerShape({
    runners: [{ file: "clean-smoke.mjs", source: cleanRunner }],
    harnessSource: HARNESS_SOURCE,
    baseline: { knownSites: [] },
    reachableRunners: new Set(["clean-smoke.mjs"]),
  });
  assert.equal(report.status, "passed");
});

test("(iv) a runner unreachable from the descriptor map is red unless it carries an inline opt-out with a reason", () => {
  const source = `const before = await observeFresh(client, { actionable: true });
assertRequiredCapabilities(before, []);`;
  const unreachable = (text) =>
    checkRunnerShape({
      runners: [{ file: "aux-smoke.mjs", source: text }],
      harnessSource: HARNESS_SOURCE,
      baseline: { knownSites: [] },
      reachableRunners: new Set(["elsewhere.mjs"]),
    });
  assert.equal(unreachable(source).status, "failed");
  assert.equal(unreachable(source).violations[0].rule, "b:unreachable_runner");
  const optedOut = unreachable(`${source}\n// prelive-l3-opt-out b: a fixture setup step that issues no action\n`);
  assert.equal(optedOut.status, "passed");
  // A marker with no reason is not an opt-out.
  assert.equal(unreachable(`${source}\n// prelive-l3-opt-out b:\n`).status, "failed");
  assert.equal(optOutRules("// prelive-l3-opt-out b:   ").size, 0);
});

test("(iv) rule (b)'s population is what the resolver answers, so the third authority's gate is not called unreachable", () => {
  // Boundary, not implementation: the authority is `tools/resolve-stardew-action-gate-runner.mjs`, which answers from
  // the published gate table, then the experimental/harness map, then the published-action gate exemptions. The ladder
  // read only the first two, so `navigate_to_destination` - published, but on the long-horizon navigation pipeline and
  // therefore named by an exemption rather than a descriptor - had its declared runner reported unreachable. The runner
  // was fine; what the rule READ was not.
  const reachable = reachableRunnerNames();
  const experimentalAction = Object.keys(STARDEW_EXPERIMENTAL_ACTION_RUNNERS).find(
    (action) => !STARDEW_PUBLISHED_ACTION_GATES.some((gate) => gate.actionId === action),
  );
  const answers = {
    "published gate table": resolveStardewActionGateRunner(STARDEW_PUBLISHED_ACTION_GATES[0].actionId),
    "experimental/harness map": resolveStardewActionGateRunner(experimentalAction),
    "published-action gate exemption": resolveStardewActionGateRunner(GATE_EXEMPT_PUBLISHED_ACTIONS[0].actionId),
  };
  for (const [authority, runner] of Object.entries(answers))
    assert.ok(reachable.has(runner), `${authority} resolves ${runner}, so rule (b) may not call it unreachable`);
  // Falsifier: the third source is load-bearing. Drop just that one and the exemption's runner stops being reachable,
  // which is exactly the state the ladder was in when it called this gate unreachable.
  assert.equal(
    reachableRunnerNames({ gateExemptions: [] }).has(answers["published-action gate exemption"]),
    false,
    "an exemption runner must be unreachable once the exemption list is not read",
  );
  // And nothing is reachable that no declaration names: empty the three and the population is empty. That is what makes
  // this a union of the authorities rather than a list somebody typed into the ladder.
  assert.equal(reachableRunnerNames({ experimentalRunners: {}, publishedGates: [], gateExemptions: [] }).size, 0);
  const undeclared = "run-stardew-native-local-player-no-authority-names-this-smoke.mjs";
  assert.equal(reachable.has(undeclared), false);
  const report = checkRunnerShape({
    runners: [{ file: undeclared, source: cleanRunner }],
    harnessSource: HARNESS_SOURCE,
    baseline: { knownSites: [] },
    reachableRunners: reachable,
  });
  assert.deepEqual(
    report.violations.map((entry) => entry.rule),
    ["b:unreachable_runner"],
    "a runner reachable through none of the three is still unreachable",
  );
  // The ratchet half is already covered by "the baseline is a ratchet" below: a listed site whose runner becomes
  // reachable is `baseline_stale`, which is the same match for a rule-(a) or a rule-(b) entry.
});

test("(iv) the baseline is a ratchet: a listed site that stopped violating is red", () => {
  const report = checkRunnerShape({
    runners: [{ file: "clean-smoke.mjs", source: cleanRunner }],
    harnessSource: HARNESS_SOURCE,
    baseline: { knownSites: [{ file: "fiched-smoke.mjs", fact: "tile", count: 1 }] },
    reachableRunners: new Set(["clean-smoke.mjs"]),
  });
  assert.equal(report.status, "failed");
  assert.equal(report.violations[0].rule, "baseline_stale");
});

test("(v) a clean tree is green, end to end through every rung", () => {
  const ladder = runLadder({
    rungs: [
      () =>
        runGateRung({
          gates: ["tools/check-a.mjs", "tools/audit-b.mjs"],
          resolveCommand: () => ({ command: "node tools/check-a.mjs", discovered: false }),
          run: () => ({ status: 0, stdout: "", stderr: "" }),
        }),
      () => checkLinkageClosure(cleanLinkage()),
      () => checkDeployIsolation({ deployRoot: "C:/work/mods", gameInstall: DEFAULT_GAME_INSTALL }),
      () =>
        checkRunnerShape({
          runners: [{ file: "clean-smoke.mjs", source: cleanRunner }],
          harnessSource: HARNESS_SOURCE,
          baseline: { knownSites: [] },
          reachableRunners: new Set(["clean-smoke.mjs"]),
        }),
    ],
  });
  assert.equal(ladder.status, "passed");
  assert.equal(ladder.rungs.length, 4);
  assert.equal(ladder.firstRed, null);
});

test("(v) the ladder stops at the first red rung and does not run the ones after it", () => {
  let laterRan = false;
  const ladder = runLadder({
    rungs: [
      () => ({ id: "l0", status: "failed" }),
      () => {
        laterRan = true;
        return { id: "l1", status: "passed" };
      },
    ],
  });
  assert.equal(ladder.status, "failed");
  assert.equal(ladder.rungs.length, 1);
  assert.equal(laterRan, false);
});

test("(v) L0 reports each gate's exit code by name", () => {
  const report = runGateRung({
    gates: ["tools/green.mjs", "tools/red.mjs"],
    resolveCommand: (gate) => ({ command: `node ${gate}`, discovered: false }),
    run: (command) => ({ status: command.endsWith("green.mjs") ? 0 : 1, stdout: "", stderr: "" }),
  });
  assert.equal(report.status, "failed");
  assert.deepEqual(
    report.gates.map((entry) => [entry.gate, entry.exitCode]),
    [
      ["tools/green.mjs", 0],
      ["tools/red.mjs", 1],
    ],
  );
});

test("L4 delegates the named action to the existing live preflight", () => {
  const commands = [];
  const passed = actionRung({
    action: "till_soil",
    deployRoot: "C:/mods",
    run: (command) => {
      commands.push(command);
      return { status: 0 };
    },
  });
  assert.equal(passed.status, "passed");
  assert.equal(passed.id, "l4");
  assert.equal(commands[0], "node tools/preflight-live-run.mjs --mods-path C:/mods --action till_soil");
  const failed = actionRung({ action: "till_soil", deployRoot: "C:/mods", run: () => ({ status: 1 }) });
  assert.equal(failed.status, "failed");
  assert.equal(failed.exitCode, 1);
});

test("the report prints the counts and the members the ladder names", () => {
  const ladder = runLadder({
    rungs: [
      () =>
        runGateRung({
          gates: ["tools/check-a.mjs"],
          resolveCommand: () => ({ command: "node tools/check-a.mjs", discovered: false }),
          run: () => ({ status: 0, stdout: "", stderr: "" }),
        }),
      () => checkLinkageClosure(cleanLinkage()),
      () => checkDeployIsolation({ deployRoot: "C:/work/mods", gameInstall: DEFAULT_GAME_INSTALL }),
      () =>
        checkRunnerShape({
          runners: [{ file: "clean-smoke.mjs", source: cleanRunner }],
          harnessSource: HARNESS_SOURCE,
          baseline: { knownSites: [] },
          reachableRunners: new Set(["clean-smoke.mjs"]),
        }),
    ],
  });
  const report = format(ladder, {
    elapsedMs: 1,
    options: { noGame: false },
    notice: "l4_skipped: needs --game",
  });
  assert.match(report, /linked 1 of 1/u);
  assert.match(report, /shape checked 1 runners; known 0 of 1/u);
  assert.match(report, /command: node tools\/check-a\.mjs/u);
  assert.match(report, /l4_skipped: needs --game/u);
  assert.match(report, /prelive: passed/u);
  assert.ok(report.includes("C:\\work\\mods") || report.includes("C:/work/mods"), "both deploy paths must print");
});

test("the real tree: linkage closure is closed and the runners' shape is at its recorded baseline", () => {
  const linkage = linkageRung();
  assert.deepEqual(linkage.violations, [], "every runner key must link to a scenario the Mod can arm");
  assert.deepEqual(linkage.staleReasons, []);
  assert.equal(linkage.linked, linkage.total);
  const shape = shapeRung();
  assert.deepEqual(
    shape.violations,
    [],
    "L3 is at its baseline; if a runner was fixed, remove its entry from tools/prelive-l3-baseline.json",
  );
  assert.ok(shape.knownSites > 0, "the baseline must still be describing real sites");
});

//
// L2 - compile and population agreement
//

/** Four populations that agree, so each test below can break exactly one of them. */
const cleanPopulations = () => ({
  adapters: ["place_owned_object", "remove_placed_item"],
  toolNames: ["place_owned_object", "remove_placed_item"],
  descriptorDerived: ["place_owned_object"],
  descriptorValidators: ["place_owned_object"],
  published: ["place_owned_object", "remove_placed_item"],
});

const members = (report, name) =>
  report.differences.filter((entry) => entry.direction === name).map((entry) => entry.actionId);

test("(vi) a tool-name map key with no adapter is red and names the action", () => {
  const report = checkPopulationAgreement({
    ...cleanPopulations(),
    toolNames: ["place_owned_object", "remove_placed_item", "rotate_furniture"],
  });
  assert.equal(report.status, "failed");
  assert.deepEqual(members(report, "map_without_adapter"), ["rotate_furniture"]);
  assert.deepEqual(report.differences, [{ direction: "map_without_adapter", actionId: "rotate_furniture" }]);
});

test("(vi) an adapter with no tool-name map key is red and names the action", () => {
  const report = checkPopulationAgreement({
    ...cleanPopulations(),
    toolNames: ["place_owned_object"],
  });
  assert.equal(report.status, "failed");
  assert.deepEqual(members(report, "adapter_without_map"), ["remove_placed_item"]);
});

test("(vi) the descriptor-derived list, the descriptor arms and the published surface are held to the adapters too", () => {
  const report = checkPopulationAgreement({
    ...cleanPopulations(),
    descriptorDerived: ["place_owned_object", "remove_fence"],
    descriptorValidators: ["put_item_in_fish_tank"],
    published: ["place_owned_object", "place_item_on_pedestal"],
  });
  assert.equal(report.status, "failed");
  assert.deepEqual(members(report, "descriptor_derived_without_adapter"), ["remove_fence"]);
  assert.deepEqual(members(report, "descriptor_validator_without_adapter"), ["put_item_in_fish_tank"]);
  assert.deepEqual(members(report, "published_without_adapter"), ["place_item_on_pedestal"]);
});

test("(vi) agreeing populations are green and report every count", () => {
  const report = checkPopulationAgreement(cleanPopulations());
  assert.equal(report.status, "passed");
  assert.deepEqual(report.differences, []);
  assert.deepEqual(report.counts, {
    adapters: 2,
    toolNames: 2,
    descriptorDerived: 1,
    descriptorValidators: 1,
    publishedExecution: 2,
  });
});

test("(vi) the populations are parsed from the registry source, not listed here", () => {
  const populated = parseActionPopulations(`
    export const STARDEW_ACTION_ADAPTERS = Object.freeze([
      actionAdapter(
        "place_owned_object",
        "Place",
        "Place one object.",
        ["world_object"],
      ),
      actionAdapter("remove_placed_item", "Remove", "Remove one object.", ["world_object"]),
    ]);
    export const STARDEW_ACTION_TOOL_NAMES = {
      // a key whose value is not the tool name is still a key
      place_owned_object: "stardew_place_owned_object",
      rotate_furniture: "stardew_rotate_furniture",
    } as const satisfies Record<string, \`stardew_\${string}\`>;
    export const STARDEW_DESCRIPTOR_DERIVED_ACTION_IDS = Object.freeze([
      "place_owned_object",
      /* "commented_out" */ "remove_fence",
    ] as const);
    export const MOD_DESCRIPTOR_REQUIREMENTS = Object.freeze({
      place_owned_object: [publishesArguments("x", "y")],
      put_item_in_fish_tank: [
        publishesArguments("x", "y", "slot"),
        WRITES_EFFECT,
      ],
    } satisfies Record<string, readonly unknown[]>);
    export function isModDescriptorComplete(actionId, descriptor) {
      return actionId === "a_chain_is_no_longer_the_population";
    }
  `);
  assert.deepEqual(populated.adapters, ["place_owned_object", "remove_placed_item"]);
  assert.deepEqual(populated.toolNames, ["place_owned_object", "rotate_furniture"]);
  assert.deepEqual(populated.descriptorDerived, ["place_owned_object", "remove_fence"]);
  assert.deepEqual(
    populated.descriptorValidators,
    ["place_owned_object", "put_item_in_fish_tank"],
    "the arms are the requirement table's rows: a nested requirement is not a row, and the old arm chain is not read",
  );
});

test("(vi) a population that measured nothing is blocked and names the direction", () => {
  const report = checkPopulationAgreement({ ...cleanPopulations(), descriptorValidators: [] });
  assert.equal(report.status, "blocked", "an empty population agrees with every other population, so it is no pass");
  assert.deepEqual(report.emptyPopulations, ["descriptorValidators"]);
  assert.deepEqual(report.differences, []);
});

test("(vii) --skip-compile is parsed, and the rung says the build was skipped instead of passed", () => {
  assert.equal(parseArgs(["--no-game"]).skipCompile, false);
  assert.equal(parseArgs(["--no-game", "--skip-compile"]).skipCompile, true);
  let compiled = 0;
  const rung = actionRegistryRung({ skipCompile: true, compile: () => (compiled++, { status: "passed", ms: 1 }) });
  assert.equal(rung.status, "passed");
  assert.equal(rung.compile.status, "skipped");
  assert.equal(rung.compile.reason, "--skip-compile");
  assert.equal(compiled, 0, "--skip-compile must not build");
  const ladder = runLadder({ rungs: [() => rung] });
  assert.match(
    format(ladder, { elapsedMs: 1, options: { noGame: true }, notice: null }),
    /compile skipped \(--skip-compile\)/u,
  );
});

test("(vii) a disagreeing population skips the build, because the member is already named", () => {
  let compiled = 0;
  const rung = actionRegistryRung({
    source: () =>
      'export const STARDEW_ACTION_ADAPTERS = Object.freeze([actionAdapter("only_action", "a", "b", ["c"])]);\n' +
      'export const STARDEW_ACTION_TOOL_NAMES = {\n  only_action: "stardew_only_action",\n  rotate_furniture: "stardew_rotate_furniture",\n};\n' +
      'export const STARDEW_DESCRIPTOR_DERIVED_ACTION_IDS = Object.freeze(["only_action"] as const);\n' +
      "export const MOD_DESCRIPTOR_REQUIREMENTS = Object.freeze({\n  only_action: [WRITES_EFFECT],\n});\n",
    publishedIds: () => ["only_action"],
    compile: () => (compiled++, { status: "passed", ms: 1 }),
  });
  assert.equal(rung.status, "failed");
  assert.equal(compiled, 0);
  assert.equal(rung.compile.status, "skipped");
  const text = format(runLadder({ rungs: [() => rung] }), { elapsedMs: 1, options: { noGame: true }, notice: null });
  assert.match(text, /map_without_adapter: rotate_furniture/u);
  assert.match(text, /population agreement failed/u);
  assert.match(text, /STARDEW_ACTION_TOOL_NAMES has a key/u);
});

test("(vii) a build failure keeps the first TypeScript diagnostic verbatim", () => {
  const output =
    "src/action-registry.ts(672,5): error TS2353: Object literal may only specify known properties, and 'rotate_furniture' does not exist in type 'Record<StardewActionId, `stardew_${string}`>'.\n" +
    "src/action-registry.ts(700,5): error TS2353: a second error the reader does not need.\n" +
    "  at run (child-process-tool.mjs:1:1)\n";
  const compiled = compileHostTestArtifact({ run: () => ({ status: 2, stdout: output, stderr: "" }) });
  assert.equal(compiled.status, "failed");
  assert.equal(
    compiled.firstError,
    "src/action-registry.ts(672,5): error TS2353: Object literal may only specify known properties, and 'rotate_furniture' does not exist in type 'Record<StardewActionId, `stardew_${string}`>'.",
  );
  assert.equal(
    firstTypeScriptError("Error: test_runner_failed:code=2:signal=none\n"),
    "Error: test_runner_failed:code=2:signal=none",
  );
  assert.equal(firstTypeScriptError(""), "(the build printed nothing)");
});

test("(vii) a tree without the compiler reports the build as unavailable, never as passed", () => {
  const rung = actionRegistryRung({ exists: () => false });
  assert.equal(rung.population.status, "passed");
  assert.equal(rung.compile.status, "unavailable");
  const text = format(runLadder({ rungs: [() => rung] }), { elapsedMs: 1, options: { noGame: true }, notice: null });
  assert.match(text, /compile UNAVAILABLE/u);
  assert.doesNotMatch(text, /compile passed/u);
});

test("the real tree: every action population names the same members", () => {
  const rung = actionRegistryRung({ skipCompile: true });
  assert.deepEqual(
    rung.population.differences,
    [],
    "a population names an action the Host adapter list does not carry",
  );
  assert.equal(rung.population.status, "passed");
  assert.ok(
    rung.population.counts.adapters > 90,
    `expected the whole adapter list, got ${rung.population.counts.adapters}`,
  );
  assert.equal(rung.population.counts.adapters, rung.population.counts.toolNames);
});
