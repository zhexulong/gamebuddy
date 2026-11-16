/**
 * The falsifier suite for `tools/check-stardew-live-runner-coverage.mjs`: which catalog actions have a live gate.
 *
 * The gate exists because two green gates say nothing about coverage - the promotion gate checks that a published row's
 * runner exists on disk, and the parity gate accepts an experimental action with no gate at all. So this suite has to
 * prove the coverage question is asked of the whole catalog, and that each way of losing a route is named rather than
 * silently tolerated.
 *
 * A route is one of TWO kinds since `tools/lib/stardew-action-gate-route.mjs`: a `tools/<runner>` shared-harness runner,
 * or a `contracts/smoke/<actionId>.json` contract run by the slice driver. A suite that only knew runners read six
 * contract-routed actions as `runner_name_is_not_a_runner:<action>:null` - the gate naming its own vocabulary instead of
 * the fact - so the readings here are per route kind, and the injected deletion drives the REAL resolver's own
 * `stardew_action_gate_route_absent` branch rather than a record written in this file.
 *
 * red-proof: fixture  the frozen fcc2c1b7~1 runner index, where `sweep_scythe` had a table entry naming a runner the
 *   tree did not carry -> `runner_file_missing:sweep_scythe:run-stardew-native-local-player-sweep-scythe-smoke.mjs`
 * red-proof: inject  a catalog registration with no route anywhere -> `action_without_a_live_gate:no_runner_probe`
 * red-proof: inject  one action deleted from the resolver's tables -> `action_without_a_live_gate:use_mine_ladder`
 * red-proof: inject  an index that does not carry a resolved runner file ->
 *   `runner_file_missing:move_to_tile:run-stardew-native-local-player-move-smoke.mjs`
 * red-proof: inject  an index that does not carry a contract-routed action's contract ->
 *   `contract_file_missing:<action>:contracts/smoke/<action>.json`
 * red-proof: inject  a contract-routed row pointed at a contract the tree does not carry ->
 *   `gate_route_refused:<action>:stardew_action_gate_contract_absent contracts/smoke/<action>.json`
 * red-proof: inject  an empty catalog, a catalog below the recorded floor, a registration helper this gate cannot read,
 *   and a gate-artifact census git refuses to answer -> `not_measured:catalog_unreadable`,
 *   `not_measured:catalog_population_too_small:*`, `not_measured:catalog_registration_helper_unknown:X`,
 *   `not_measured:gate_artifact_index_unreadable:*`, each at exit 2
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";

import {
  CATALOG_PATH,
  checkLiveRunnerCoverage,
  gateArtifactsInIndex,
  measureRunnerDuplication,
  readCatalogRegistrationCalls,
  renderCoverage,
  runCoverage,
} from "./check-stardew-live-runner-coverage.mjs";
import { CONTRACT_ROUTE, resolveStardewActionGateRoute } from "./lib/stardew-action-gate-route.mjs";
import { STARDEW_PUBLISHED_ACTION_GATES } from "./stardew-action-gate-descriptors.mjs";

const REPOSITORY_ROOT = resolve(import.meta.dirname, "..");
const HISTORICAL_RUNNER_FILES = "tools/fixtures/stardew-runner-file-index-pre-fcc2c1b7.json";
const realCatalog = () => readFileSync(resolve(REPOSITORY_ROOT, CATALOG_PATH), "utf8");
const realCensus = () => gateArtifactsInIndex({ root: REPOSITORY_ROOT });

/** A finding is asserted whole: a message that names the drift is the point of the gate. */
function assertFinding(report, pattern) {
  assert.ok(
    report.findings.some((finding) => pattern.test(finding)),
    `expected ${pattern} among:\n  ${report.findings.join("\n  ") || "(no findings)"}`,
  );
}

/** The contract-routed action this tree carries, named by the table's own declaration rather than typed in here. */
function firstContractRoutedAction() {
  const row = STARDEW_PUBLISHED_ACTION_GATES.find((gate) => gate.gateRoute === CONTRACT_ROUTE);
  assert.ok(row !== undefined, "this tree carries no contract-routed gate row, so the contract route is untested");
  return row.actionId;
}

/** The runner file names `fcc2c1b7~1` carried, frozen: a shallow checkout does not carry the revision. */
function historicalRunnerFiles() {
  const frozen = JSON.parse(readFileSync(resolve(REPOSITORY_ROOT, HISTORICAL_RUNNER_FILES), "utf8"));
  assert.ok(
    Array.isArray(frozen.files) && frozen.files.length > 0,
    `${HISTORICAL_RUNNER_FILES} carries no runner name, so the historical reading would measure nothing`,
  );
  return frozen.files;
}

/** The catalog with one extra registration line, cloned from a real one so the array stays what the catalog declares. */
function catalogWithAction(actionId) {
  const source = realCatalog();
  const line = /^.*E\("sweep_scythe".*$/mu.exec(source)?.[0];
  assert.ok(line !== undefined, "the catalog no longer carries the sweep_scythe registration this fixture clones");
  return source.replace(line, `${line}\n${line.replace('"sweep_scythe"', `"${actionId}"`)}`);
}

test("the real tree: every examined action is one route or none, and the reading is per route kind", () => {
  const catalogSource = realCatalog();
  const census = realCensus();
  const report = checkLiveRunnerCoverage({ catalogSource, artifacts: census });
  assert.equal(report.blocked, null);
  const executable = readCatalogRegistrationCalls(catalogSource).filter((call) => call.helper === "E");
  assert.equal(report.examined, executable.length, "every executable registration is one row");
  assert.equal(report.runnerRouted + report.contractRouted, report.routed, "the routed count is its two route kinds");
  assert.equal(report.routed + report.without, report.examined, "routed plus unrouted is the population");
  assert.equal(report.ok, report.findings.length === 0, "green means no finding");
  assert.ok(report.runnerRouted > 0, "a tree with no runner-routed action is not measuring the runner route");

  const executableIds = new Set(executable.map((call) => call.actionId));
  for (const finding of report.findings) {
    const actionId =
      /^(?:action_without_a_live_gate|runner_file_missing|gate_is_not_a_runner|contract_file_missing|gate_route_refused):([a-z0-9_]+)/u.exec(
        finding,
      )?.[1];
    assert.ok(
      executableIds.has(actionId),
      `${finding} does not name an executable catalog action, so it is not a coverage finding`,
    );
  }

  const lines = renderCoverage({ report, census }).join("\n");
  assert.match(
    lines,
    new RegExp(
      `^actions examined ${report.examined} · with a live gate ${report.routed} · runner ${report.runnerRouted} · ` +
        `contract ${report.contractRouted} · without ${report.without}`,
      "mu",
    ),
  );
  for (const entry of report.unrouted)
    assert.ok(lines.includes(`${entry.actionId} (`), `${entry.actionId} is counted without a route but not named`);
});

test("a contract-routed action is covered by its contract, and losing that contract is its own finding", () => {
  const action = firstContractRoutedAction();
  const census = realCensus();
  const report = checkLiveRunnerCoverage({ catalogSource: realCatalog(), artifacts: census });
  assert.equal(
    report.unrouted.some((entry) => entry.actionId === action),
    false,
    `${action} is contract-routed, so its route is a live gate and may not be counted without one`,
  );

  const withoutContract = {
    ...census,
    contracts: census.contracts.filter((path) => path !== `contracts/smoke/${action}.json`),
  };
  const broken = checkLiveRunnerCoverage({ catalogSource: realCatalog(), artifacts: withoutContract });
  assertFinding(broken, new RegExp(`^contract_file_missing:${action}:contracts/smoke/${action}\\.json$`, "u"));
  assert.equal(broken.contractRouted, report.contractRouted - 1, "removing one contract moves exactly one route");
});

test("a contract-routed row whose contract is not there is refused by the resolver, and named", () => {
  const action = firstContractRoutedAction();
  const root = mkdtempSync(join(tmpdir(), "gate-route-refused-"));
  try {
    // The row is real and its contract is not: the resolver's own refusal, driven through the gate.
    const report = checkLiveRunnerCoverage({
      catalogSource: realCatalog(),
      artifacts: realCensus(),
      resolveRoute: (candidate) => resolveStardewActionGateRoute(candidate, { root }),
    });
    assertFinding(
      report,
      new RegExp(
        `^gate_route_refused:${action}:stardew_action_gate_contract_absent contracts/smoke/${action}\\.json$`,
        "u",
      ),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the artifact census is the index, for both route kinds", () => {
  const census = realCensus();
  for (const name of census.runners)
    assert.ok(!census.untracked.includes(`tools/${name}`), `${name} is both indexed and not`);
  for (const path of census.contracts) assert.ok(!census.untracked.includes(path), `${path} is both indexed and not`);
  assert.equal(census.runners.length, new Set(census.runners).size, "the runner census is a set");
  assert.equal(census.contracts.length, new Set(census.contracts).size, "the contract census is a set");
  for (const name of census.runners) assert.match(name, /^run-stardew-native-local-player-[a-z0-9-]+-smoke\.mjs$/u);
  for (const path of census.contracts) assert.match(path, /^contracts\/smoke\/[a-z0-9_]+\.json$/u);
});

test("an artifact that is on disk but not in the index is published as not counted", () => {
  const root = mkdtempSync(join(tmpdir(), "gate-census-"));
  try {
    mkdirSync(join(root, "tools"), { recursive: true });
    mkdirSync(join(root, "contracts", "smoke"), { recursive: true });
    writeFileSync(join(root, "tools", "run-stardew-native-local-player-probe-smoke.mjs"), "export {};\n");
    writeFileSync(join(root, "contracts", "smoke", "probe.json"), "{}\n");
    execFileSync("git", ["init", "-q", root], { windowsHide: true, stdio: "ignore" });
    const census = gateArtifactsInIndex({ root });
    assert.deepEqual(census.runners, [], "a runner the index does not carry is not a route");
    assert.deepEqual(census.contracts, [], "a contract the index does not carry is not a route");
    assert.deepEqual(census.onDisk.runners, ["run-stardew-native-local-player-probe-smoke.mjs"]);
    assert.deepEqual(census.onDisk.contracts, ["contracts/smoke/probe.json"]);
    assert.deepEqual(census.untracked.sort(), [
      "contracts/smoke/probe.json",
      "tools/run-stardew-native-local-player-probe-smoke.mjs",
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("red (inject): a catalog action with no route is named", () => {
  const report = checkLiveRunnerCoverage({
    catalogSource: catalogWithAction("no_runner_probe"),
    artifacts: realCensus(),
  });
  assertFinding(report, /^action_without_a_live_gate:no_runner_probe$/u);
  assert.equal(report.ok, false);
});

test("red (inject): an action deleted from the resolver's tables is named, and only that one moves", () => {
  const deleted = "use_mine_ladder";
  const withoutDeletedRow = (action) =>
    resolveStardewActionGateRoute(action, {
      gates: STARDEW_PUBLISHED_ACTION_GATES.filter((gate) => gate.actionId !== deleted),
    });
  const artifacts = realCensus();
  const before = checkLiveRunnerCoverage({ catalogSource: realCatalog(), artifacts });
  const after = checkLiveRunnerCoverage({ catalogSource: realCatalog(), artifacts, resolveRoute: withoutDeletedRow });
  assertFinding(after, new RegExp(`^action_without_a_live_gate:${deleted}$`, "u"));
  assert.equal(
    after.findings.filter((finding) => !before.findings.includes(finding)).length,
    1,
    `deleting one mapping must add exactly one finding to: ${before.findings.join(", ")}`,
  );
  assert.equal(after.routed, before.routed - 1, "and it moves exactly one action out of the routed count");
});

test("red (inject): a resolved runner the index does not carry is named with the file and the action", () => {
  const runner = "run-stardew-native-local-player-move-smoke.mjs";
  const census = realCensus();
  const report = checkLiveRunnerCoverage({
    catalogSource: realCatalog(),
    artifacts: { ...census, runners: census.runners.filter((name) => name !== runner) },
  });
  assertFinding(report, new RegExp(`^runner_file_missing:move_to_tile:${runner}$`, "u"));
});

test("red (fixture, the frozen tree at fcc2c1b7~1): sweep_scythe's entry named a runner the tree did not carry", () => {
  const tree = historicalRunnerFiles();
  assert.ok(
    !tree.includes("run-stardew-native-local-player-sweep-scythe-smoke.mjs"),
    "the frozen index must not carry the runner the catalog named, or this reading would replay nothing",
  );
  const report = checkLiveRunnerCoverage({ catalogSource: realCatalog(), artifacts: { runners: tree, contracts: [] } });
  assertFinding(report, /^runner_file_missing:sweep_scythe:run-stardew-native-local-player-sweep-scythe-smoke\.mjs$/u);
});

test("blocked: an unreadable catalog, a shrunken population and an unknown helper are not passes", () => {
  const census = realCensus();
  const emptyCatalog = runCoverage({
    catalogSource: "",
    census: () => census,
    withDuplication: false,
  });
  assert.equal(emptyCatalog.exitCode, 2);
  assert.match(emptyCatalog.lines[0], /^not_measured:catalog_unreadable$/u);

  const tooSmall = runCoverage({
    catalogSource: realCatalog(),
    census: () => census,
    withDuplication: false,
  });
  assert.notEqual(tooSmall.exitCode, 2, "the real tree is measured, not blocked");
  const executable = readCatalogRegistrationCalls(realCatalog()).filter((call) => call.helper === "E").length;
  assert.equal(
    checkLiveRunnerCoverage({
      catalogSource: realCatalog(),
      artifacts: census,
      minimumActions: executable + 1,
    }).blocked,
    `catalog_population_too_small:${executable}<${executable + 1}`,
  );

  const unknownHelper = checkLiveRunnerCoverage({
    catalogSource: realCatalog().replace(
      'E("sweep_scythe"',
      'X("mystery_action", "resource_gathering", FarmhandActionHandlerGroup.ResourceTools, null),\n        E("sweep_scythe"',
    ),
    artifacts: census,
  });
  assert.equal(unknownHelper.blocked, "catalog_registration_helper_unknown:X");
});

test("blocked: a gate-artifact census git refuses to answer is not an empty census", () => {
  const result = runCoverage({
    catalogSource: realCatalog(),
    census: () => {
      throw new Error("could not ask git what this tree carries");
    },
    withDuplication: false,
  });
  assert.equal(result.exitCode, 2);
  assert.match(result.lines[0], /^not_measured:gate_artifact_index_unreadable:could not ask git/u);
});

test("the duplication census counts spellings from the sources it is handed, not from a list", () => {
  const base = `
import { readNativeClientConfig } from "./lib/stardew-native-smoke-harness-v1.mjs";
async function run(executeFresh, client) {
  const requestId = \`native_local_alpha_\${Date.now()}\`;
  const receipt = await executeFresh(client, { requestId, action: "alpha", args: {}, snapshot, timeoutMs: 1000 });
  return { state: "passed", reasonCode: "alpha_done", receipt, trace };
}`;
  const fixtureShifted = base.replace(
    "readNativeClientConfig }",
    "readNativeClientConfig, validateNativeLocalFixturePolicy }",
  );
  const evidenceShifted = base.replace('return { state: "passed",', 'return { state: "passed", target,');
  const runners = [
    { name: "tools/run-stardew-native-local-player-a-smoke.mjs", source: base },
    { name: "tools/run-stardew-native-local-player-b-smoke.mjs", source: base },
  ];
  const same = measureRunnerDuplication({ runners });
  for (const step of ["fixture", "envelope", "evidence"]) {
    assert.equal(same.steps[step].distinct, 1, `${step}: two identical runners are one spelling`);
    assert.equal(same.steps[step].largest[0].count, 2);
  }

  const fixtureDiffers = measureRunnerDuplication({
    runners: [runners[0], { ...runners[1], source: fixtureShifted }],
  });
  assert.equal(fixtureDiffers.steps.fixture.distinct, 2, "a changed fixture reading is a second spelling");
  assert.equal(fixtureDiffers.steps.envelope.distinct, 1, "and it leaves the other steps alone");

  const evidenceDiffers = measureRunnerDuplication({
    runners: [runners[0], { ...runners[1], source: evidenceShifted }],
  });
  assert.equal(evidenceDiffers.steps.evidence.distinct, 2, "a changed evidence shape is a second spelling");
});
