/**
 * The falsifier suite for `tools/check-stardew-live-runner-coverage.mjs`: which catalog actions a live runner can drive.
 *
 * The gate exists because two green gates say nothing about coverage - the promotion gate checks that a published row's
 * runner exists on disk, and the parity gate accepts an experimental action with no runner at all. So this suite has to
 * prove the coverage question is asked of the whole catalog, and that each way of losing a route is named rather than
 * silently tolerated.
 *
 * red-proof: history  the pre-fcc2c1b7 tree, where `sweep_scythe` had a table entry naming a runner the tree did not
 *   carry -> `runner_file_missing:sweep_scythe:run-stardew-native-local-player-sweep-scythe-smoke.mjs`
 * red-proof: inject  a catalog registration with no table entry anywhere ->
 *   `action_without_a_live_runner:no_runner_probe`
 * red-proof: inject  one action deleted from the resolver's tables ->
 *   `action_without_a_live_runner:use_mine_ladder`
 * red-proof: inject  an index that does not carry a resolved runner file ->
 *   `runner_file_missing:move_to_tile:run-stardew-native-local-player-move-smoke.mjs`
 * red-proof: inject  an empty catalog, a catalog below the recorded floor, a registration helper this gate cannot read,
 *   and a runner census git refuses to answer -> `not_measured:catalog_unreadable`,
 *   `not_measured:catalog_population_too_small:*`, `not_measured:catalog_registration_helper_unknown:X`,
 *   `not_measured:runner_index_unreadable:*`, each at exit 2
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";

import {
  CATALOG_PATH,
  checkLiveRunnerCoverage,
  measureRunnerDuplication,
  readCatalogRegistrationCalls,
  renderCoverage,
  runCoverage,
  runnerFilesInIndex,
} from "./check-stardew-live-runner-coverage.mjs";
import { resolveStardewActionGateRunner } from "./resolve-stardew-action-gate-runner.mjs";

const REPOSITORY_ROOT = resolve(import.meta.dirname, "..");
const realCatalog = () => readFileSync(resolve(REPOSITORY_ROOT, CATALOG_PATH), "utf8");
const realCensus = () => runnerFilesInIndex({ root: REPOSITORY_ROOT });

/** A finding is asserted whole: a message that names the drift is the point of the gate. */
function assertFinding(report, pattern) {
  assert.ok(
    report.findings.some((finding) => pattern.test(finding)),
    `expected ${pattern} among:\n  ${report.findings.join("\n  ") || "(no findings)"}`,
  );
}

/** The runner file names a revision carried, read out of this repository's own history. */
function historicalRunnerFiles(revision) {
  try {
    const output = execFileSync("git", ["ls-tree", "-r", "--name-only", revision, "--", "tools"], {
      cwd: REPOSITORY_ROOT,
      encoding: "utf8",
      windowsHide: true,
      stdio: ["ignore", "pipe", "ignore"],
    });
    return output
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => /^tools\/run-stardew-native-local-player-[a-z0-9-]+-smoke\.mjs$/u.test(line))
      .map((line) => line.slice("tools/".length));
  } catch (error) {
    return { unavailable: `revision ${revision} is not in this clone: ${String(error?.message ?? error)}` };
  }
}

/** The catalog with one extra registration line, cloned from a real one so the array stays what the catalog declares. */
function catalogWithAction(actionId) {
  const source = realCatalog();
  const line = /^.*E\("sweep_scythe".*$/mu.exec(source)?.[0];
  assert.ok(line !== undefined, "the catalog no longer carries the sweep_scythe registration this fixture clones");
  return source.replace(line, `${line}\n${line.replace('"sweep_scythe"', `"${actionId}"`)}`);
}

test("the real tree: the census adds up, and every action without a route is named in the verdict", () => {
  const catalogSource = realCatalog();
  const census = realCensus();
  const report = checkLiveRunnerCoverage({ catalogSource, runnerFiles: census.indexed });
  assert.equal(report.blocked, null);
  const executable = readCatalogRegistrationCalls(catalogSource).filter((call) => call.helper === "E");
  assert.equal(report.examined, executable.length, "every executable registration is one row");
  assert.equal(report.withRunner + report.without, report.examined, "routed plus unrouted is the population");
  assert.equal(report.ok, report.findings.length === 0, "green means no finding");

  const executableIds = new Set(executable.map((call) => call.actionId));
  for (const finding of report.findings) {
    const actionId =
      /^(?:action_without_a_live_runner|runner_file_missing|runner_name_is_not_a_runner):([a-z0-9_]+)/u.exec(
        finding,
      )?.[1];
    assert.ok(
      executableIds.has(actionId),
      `${finding} does not name an executable catalog action, so it is not a coverage finding`,
    );
  }

  const lines = renderCoverage({ report, census }).join("\n");
  assert.match(lines, new RegExp(`^actions examined ${report.examined} · with a runner \\d+ · without \\d+`, "mu"));
  for (const entry of report.unrouted)
    assert.ok(lines.includes(`${entry.actionId} (`), `${entry.actionId} is counted without a route but not named`);
});

test("the runner census is the index, and it publishes what it dropped", () => {
  const census = realCensus();
  assert.equal(census.indexed.length + census.untracked.length, census.onDisk.length);
  for (const name of census.indexed) assert.ok(!census.untracked.includes(name), `${name} is both indexed and not`);
});

test("red (inject): a catalog action with no table entry is named", () => {
  const report = checkLiveRunnerCoverage({
    catalogSource: catalogWithAction("no_runner_probe"),
    runnerFiles: realCensus().indexed,
  });
  assertFinding(report, /^action_without_a_live_runner:no_runner_probe$/u);
  assert.equal(report.ok, false);
});

test("red (inject): an action deleted from the resolver's tables is named, and only that one moves", () => {
  const deleted = "use_mine_ladder";
  const deletedResolver = (actionId) => {
    if (actionId === deleted) throw new Error("unknown_stardew_action_id");
    return resolveStardewActionGateRunner(actionId);
  };
  const runnerFiles = realCensus().indexed;
  const before = checkLiveRunnerCoverage({ catalogSource: realCatalog(), runnerFiles });
  const after = checkLiveRunnerCoverage({ catalogSource: realCatalog(), runnerFiles, resolveRunner: deletedResolver });
  assertFinding(after, new RegExp(`^action_without_a_live_runner:${deleted}$`, "u"));
  assert.equal(
    after.findings.filter((finding) => !before.findings.includes(finding)).length,
    1,
    `deleting one mapping must add exactly one finding to: ${before.findings.join(", ")}`,
  );
});

test("red (inject): a resolved runner the index does not carry is named with the file and the action", () => {
  const runner = "run-stardew-native-local-player-move-smoke.mjs";
  const report = checkLiveRunnerCoverage({
    catalogSource: realCatalog(),
    runnerFiles: realCensus().indexed.filter((name) => name !== runner),
  });
  assertFinding(report, new RegExp(`^runner_file_missing:move_to_tile:${runner}$`, "u"));
});

test("red (history, pre-fcc2c1b7): sweep_scythe's entry named a runner the tree did not carry", (t) => {
  const tree = historicalRunnerFiles("fcc2c1b7~1");
  if (!Array.isArray(tree)) {
    t.skip(`not measured: ${tree.unavailable}`);
    return;
  }
  const report = checkLiveRunnerCoverage({ catalogSource: realCatalog(), runnerFiles: tree });
  assertFinding(report, /^runner_file_missing:sweep_scythe:run-stardew-native-local-player-sweep-scythe-smoke\.mjs$/u);
});

test("blocked: an unreadable catalog, a shrunken population and an unknown helper are not passes", () => {
  const census = realCensus();
  const emptyCatalog = runCoverage({
    catalogSource: "",
    runnerCensus: () => census,
    withDuplication: false,
  });
  assert.equal(emptyCatalog.exitCode, 2);
  assert.match(emptyCatalog.lines[0], /^not_measured:catalog_unreadable$/u);

  const tooSmall = runCoverage({
    catalogSource: realCatalog(),
    runnerCensus: () => census,
    withDuplication: false,
  });
  assert.notEqual(tooSmall.exitCode, 2, "the real tree is measured, not blocked");
  const executable = readCatalogRegistrationCalls(realCatalog()).filter((call) => call.helper === "E").length;
  assert.equal(
    checkLiveRunnerCoverage({
      catalogSource: realCatalog(),
      runnerFiles: census.indexed,
      minimumActions: executable + 1,
    }).blocked,
    `catalog_population_too_small:${executable}<${executable + 1}`,
  );

  const unknownHelper = checkLiveRunnerCoverage({
    catalogSource: realCatalog().replace(
      'E("sweep_scythe"',
      'X("mystery_action", "resource_gathering", FarmhandActionHandlerGroup.ResourceTools, null),\n        E("sweep_scythe"',
    ),
    runnerFiles: census.indexed,
  });
  assert.equal(unknownHelper.blocked, "catalog_registration_helper_unknown:X");
});

test("blocked: a runner census git refuses to answer is not an empty census", () => {
  const result = runCoverage({
    catalogSource: realCatalog(),
    runnerCensus: () => {
      throw new Error("could not ask git what this tree carries");
    },
    withDuplication: false,
  });
  assert.equal(result.exitCode, 2);
  assert.match(result.lines[0], /^not_measured:runner_index_unreadable:could not ask git/u);
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
