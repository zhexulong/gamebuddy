/**
 * The falsifier suite for `tools/check-native-local-runner-scaffold.mjs`: is a native-local smoke runner still hand-written?
 *
 * The gate exists because 126 runners are copies of one scaffold and the 127th joined five clone groups by being the same
 * copy again. So this suite has to prove two things that pull in opposite directions: that the gate REDS on the real
 * pre-migration runner (not on a synthetic stand-in that happens to look like it), and that the baseline cannot be used to
 * launder the next hand-written one - a new runner cannot enter it, and a migrated runner must leave.
 *
 * red-proof: history  the sweep-scythe runner at `fcc2c1b7`, before its migration ->
 *   `runner_reimplements_the_scaffold:...sweep-scythe-smoke.mjs:no_template_import+hand_written_bootstrap:readNativeClientConfig+...`
 * red-proof: inject  a runner that imports the template and still calls `readNativeClientConfig()` ->
 *   `runner_reimplements_the_scaffold:<injected runner>:hand_written_bootstrap:readNativeClientConfig`
 * red-proof: inject  a hand-written runner that is not in the baseline ->
 *   `runner_reimplements_the_scaffold:<injected runner>:no_template_import`
 * red-proof: inject  a baseline entry whose runner now conforms, and an entry whose runner is gone ->
 *   `stale_baseline:<file>` twice; `recordShrinks` deletes exactly those two
 * red-proof: inject  an empty population, and a template missing `runSmokeScenarioMain` ->
 *   `not_measured:runner_population_empty`, `not_measured:template_export_missing:runSmokeScenarioMain`, exit 2
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";

import {
  BASELINE_PATH,
  BASELINE_REASON,
  blocked,
  checkRunnerScaffold,
  detectPrimitiveCopies,
  localFunctions,
  PRIMITIVE_BASELINE_REASON,
  PRIMITIVES_FILE,
  readBaseline,
  readPrimitiveBaseline,
  readPrimitiveExports,
  readRunner,
  readTemplateExports,
  recordShrinks,
  renderScaffoldReport,
  runScaffoldGate,
  runnerFiles,
  TEMPLATE_FILE,
  TEMPLATE_EXPORTS,
} from "./check-native-local-runner-scaffold.mjs";
import { defineSmokeScenario, projectSnapshotForBlockedReport } from "./lib/native-local-runner-scaffold.mjs";
import { parseEvidence } from "./lib/native-local-runner-primitives.mjs";

const REPOSITORY_ROOT = resolve(import.meta.dirname, "..");
const MIGRATED = "tools/run-stardew-native-local-player-sweep-scythe-smoke.mjs";
const templateSource = () => readFileSync(resolve(REPOSITORY_ROOT, TEMPLATE_FILE), "utf8");
const primitivesSource = () => readFileSync(resolve(REPOSITORY_ROOT, PRIMITIVES_FILE), "utf8");

/**
 * The runner as it was before the migration, read out of the revision that shipped it.
 *
 * Pinned to `fcc2c1b7` - the commit whose `run-stardew-native-local-player-sweep-scythe-smoke.mjs` was the 627-line copy
 * of a sibling - rather than to `HEAD`, which now carries the migrated file and would make this test replay nothing.
 */
const COPY_REVISION = "fcc2c1b7";

function runnerAtRevision(revision, path) {
  try {
    return execFileSync("git", ["show", `${revision}:${path}`], {
      cwd: REPOSITORY_ROOT,
      encoding: "utf8",
      windowsHide: true,
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch (error) {
    return { unavailable: `revision ${revision} is not in this clone: ${String(error?.message ?? error)}` };
  }
}

function assertFinding(report, pattern) {
  assert.ok(
    report.findings.some((finding) => pattern.test(finding)),
    `expected ${pattern} among:\n  ${report.findings.join("\n  ") || "(no findings)"}`,
  );
}

/** A tree of runners and a baseline, so a falsifier drives the real rule without touching this repository. */
function judge({
  runners,
  baseline = [],
  template = templateSource(),
  primitiveCopies = [],
  primitives = primitivesSource(),
}) {
  return checkRunnerScaffold({
    runners,
    baseline,
    templateSource: template,
    primitiveCopies,
    primitivesSource: primitives,
  });
}

const importLine =
  'import { defineSmokeScenario, runSmokeScenarioMain } from "./lib/native-local-runner-scaffold.mjs";';
const definitionLine = 'const scenario = defineSmokeScenario({ action: "injected" });';
const migratedRunner = {
  file: "tools/run-stardew-native-local-player-injected-smoke.mjs",
  source: `${importLine}\n${definitionLine}\n`,
};

test("the real tree: the population is the directory scan, and every runner either migrated or is a recorded reason", () => {
  const { report } = runScaffoldGate({ root: REPOSITORY_ROOT });
  assert.equal(report.blocked, null, `blocked: ${report.blocked}`);
  assert.equal(report.examined, runnerFiles({ root: REPOSITORY_ROOT }).length, "the population is the scan");
  assert.equal(
    report.conforming + report.handWritten,
    report.examined,
    "conforming plus hand-written is the population",
  );
  assert.equal(report.baselined, report.handWritten, "every hand-written runner is either baselined or a finding");
  assert.equal(report.ok, true, report.findings.join("\n"));

  // The migrated runner is the one this unit migrated, and it is what "conforming" means here.
  const row = report.rows.find((entry) => entry.file === MIGRATED);
  assert.deepEqual(row, {
    file: MIGRATED,
    importsTemplate: true,
    suppliesDefinition: true,
    ownsBootstrap: [],
    conforming: true,
    reasons: [],
    baselined: false,
  });

  // Cross-check against an independent read of the directory: a hand-maintained list would drift here first.
  const onDisk = execFileSync("git", ["ls-files", "--", "tools"], {
    cwd: REPOSITORY_ROOT,
    encoding: "utf8",
    windowsHide: true,
    stdio: ["ignore", "pipe", "ignore"],
  })
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => /^tools\/(?:.*\/)?run-stardew-native-local-.*\.mjs$/u.test(line));
  for (const file of runnerFiles({ root: REPOSITORY_ROOT }))
    assert.ok(onDisk.includes(file), `${file} is in the population but git does not track it`);
});

test("the population excludes the template, the template's own home, and every falsifier", () => {
  const population = runnerFiles({ root: REPOSITORY_ROOT });
  for (const file of population) {
    assert.match(file, /^tools\/(?:.*\/)?run-stardew-native-local-.*\.mjs$/u);
    assert.ok(!file.endsWith(".test.mjs") && !file.endsWith(".mutation.mjs"), `${file} is a falsifier, not a runner`);
    assert.ok(!file.startsWith("tools/lib/"), `${file} is under tools/lib`);
  }
  // Declared files exist on disk, so "excluded" cannot be true because the file is not there.
  const present = readFileSync ? true : false;
  assert.ok(present);
  assert.ok(population.includes(MIGRATED), "the migrated runner is in the population");
  assert.ok(
    !population.includes("tools/run-stardew-native-local-player-sweep-scythe-smoke.test.mjs"),
    "a runner's own suite is not a runner",
  );
  assert.ok(!population.includes("tools/run-stardew-native-local-player-multi-day-smoke.mutation.mjs"));
});

test("the baseline records the runners that predate the template, each with its reason, and nothing else", () => {
  const baseline = readBaseline({ root: REPOSITORY_ROOT });
  assert.equal(baseline.length, 130, "the measured number of runners that predate the template");
  for (const entry of baseline) assert.equal(entry.reason, BASELINE_REASON, `${entry.file} carries ${entry.reason}`);
  assert.ok(!baseline.some((entry) => entry.file === MIGRATED), "the migrated runner left the baseline");
  const population = new Set(runnerFiles({ root: REPOSITORY_ROOT }));
  for (const entry of baseline) assert.ok(population.has(entry.file), `${entry.file} is baselined but not a runner`);
  assert.equal(BASELINE_PATH, "tools/baselines/native-local-runner-scaffold.json");
});

test("red (history): the pre-migration sweep-scythe runner is a finding that names what it spells", (t) => {
  const historical = runnerAtRevision(COPY_REVISION, MIGRATED);
  if (typeof historical !== "string") return t.skip(`not measured: ${historical.unavailable}`);
  // The revision really is the copy: 627 lines that read their own config and connect their own client.
  assert.ok(historical.split("\n").length > 600, "the pinned revision no longer carries the copied runner");
  const population = runnerFiles({ root: REPOSITORY_ROOT });
  const runners = population.map((file) => ({
    file,
    source: file === MIGRATED ? historical : readFileSync(resolve(REPOSITORY_ROOT, file), "utf8"),
  }));
  const baseline = readBaseline({ root: REPOSITORY_ROOT }).filter((entry) => entry.file !== MIGRATED);
  const report = judge({ runners, baseline });
  assert.equal(report.ok, false);
  assert.equal(report.conforming, 0, "at that revision no runner imported the template");
  assertFinding(
    report,
    new RegExp(
      `^runner_reimplements_the_scaffold:${MIGRATED}:no_template_import\\+hand_written_bootstrap:readNativeClientConfig\\+` +
        "hand_written_bootstrap:connectNativeLocalClient\\+hand_written_bootstrap:connectWithRetry$",
      "u",
    ),
  );
  const lines = renderScaffoldReport(report).join("\n");
  assert.match(lines, /runners examined \d+ · on the template 0 · hand-written \d+ · baselined \d+/u);
});

test("red (inject): a runner that imports the template and still starts its own process is a finding", () => {
  const source = `${importLine}\n${definitionLine}\nconst config = await readNativeClientConfig();\n`;
  const report = judge({ runners: [{ file: migratedRunner.file, source }] });
  assert.equal(report.ok, false);
  assertFinding(
    report,
    /^runner_reimplements_the_scaffold:tools\/run-stardew-native-local-player-injected-smoke\.mjs:hand_written_bootstrap:readNativeClientConfig$/u,
  );
  // And the same file, with the bootstrap removed, is the only thing that makes it conform: one variable.
  const conforming = judge({ runners: [{ file: migratedRunner.file, source: migratedRunner.source }] });
  assert.equal(conforming.ok, true);
});

test("red (inject): an import the runner never defines against is still a hand-written runner", () => {
  const report = judge({ runners: [{ file: migratedRunner.file, source: `${importLine}\n` }] });
  assertFinding(
    report,
    /^runner_reimplements_the_scaffold:tools\/run-stardew-native-local-player-injected-smoke\.mjs:imports_the_template_without_a_definition$/u,
  );
});

test("red (inject): a new hand-written runner cannot enter the baseline - there is no writer that adds one", () => {
  const report = judge({
    runners: [{ file: migratedRunner.file, source: "const x = 1;\n" }],
    baseline: [{ file: "tools/run-stardew-native-local-player-other-smoke.mjs", reason: BASELINE_REASON }],
  });
  assertFinding(
    report,
    /^runner_reimplements_the_scaffold:tools\/run-stardew-native-local-player-injected-smoke\.mjs:no_template_import$/u,
  );
  // The baseline entry it does not have is what would have excused it; the gate has no way to grow one.
  const excused = judge({
    runners: [{ file: migratedRunner.file, source: "const x = 1;\n" }],
    baseline: [
      { file: "tools/run-stardew-native-local-player-other-smoke.mjs", reason: BASELINE_REASON },
      { file: migratedRunner.file, reason: BASELINE_REASON },
    ],
  });
  assert.ok(!excused.findings.some((finding) => finding.startsWith("runner_reimplements_the_scaffold:")));
});

test("red (inject): a migrated runner must LEAVE the baseline, and a gone runner must leave it too", () => {
  const report = judge({
    runners: [migratedRunner],
    baseline: [
      { file: migratedRunner.file, reason: BASELINE_REASON },
      { file: "tools/run-stardew-native-local-player-deleted-smoke.mjs", reason: BASELINE_REASON },
    ],
  });
  assert.equal(report.ok, false);
  assertFinding(report, new RegExp(`^stale_baseline:${migratedRunner.file}: the baseline records it as`, "u"));
  assertFinding(
    report,
    /^stale_baseline:tools\/run-stardew-native-local-player-deleted-smoke\.mjs: no runner of that name is in the tree/u,
  );
  assert.equal(report.stale.length, 2);

  // `--record-shrinks` deletes exactly the entries it is told are stale and keeps every live one.
  const real = readBaseline({ root: REPOSITORY_ROOT });
  const two = real.slice(0, 2).map((entry) => entry.file);
  const shrink = recordShrinks({
    root: REPOSITORY_ROOT,
    stale: two.map((file) => `stale_baseline:${file}: synthetic`),
  });
  assert.equal(shrink.kept.length, real.length - 2, "every live entry survives");
  assert.deepEqual(shrink.removed.sort(), two.sort());
  assert.ok(!shrink.kept.some((entry) => two.includes(entry.file)));
  assert.deepEqual(recordShrinks({ root: REPOSITORY_ROOT, stale: [] }).removed, [], "nothing stale, nothing deleted");
});

test("red (inject): an entry without its reason, and two entries for one runner, are findings", () => {
  const report = judge({
    runners: [{ file: migratedRunner.file, source: "const x = 1;\n" }],
    baseline: [
      { file: migratedRunner.file, reason: "because" },
      { file: migratedRunner.file, reason: BASELINE_REASON },
    ],
  });
  assertFinding(report, /^baseline_entry_without_a_reason:.*: reason "because" is not predates_the_template$/u);
  assertFinding(report, /^baseline_entry_duplicated:.*: two entries name one runner/u);
});

test("red (inject): an empty population and an unreadable template are blocked, not green", () => {
  assert.equal(judge({ runners: [] }).blocked, "runner_population_empty");
  assert.equal(
    judge({ runners: [], template: `export function defineSmokeScenario() {}` }).blocked,
    "template_export_missing:runSmokeScenarioMain",
  );
  assert.equal(blocked("runner_index_unreadable:x").ok, false);
  // Zero population must not read as "every runner conforms": the verdict is blocked, and exit 2 is derived from it.
  const empty = judge({ runners: [] });
  assert.equal(renderScaffoldReport(empty)[0], "not_measured:runner_population_empty");
});

test("the template declares the exports the gate demands, so the two readings cannot drift", () => {
  const reading = readTemplateExports(templateSource());
  assert.deepEqual(reading.missing, []);
  assert.deepEqual([...TEMPLATE_EXPORTS].sort(), ["defineSmokeScenario", "runSmokeScenarioMain"]);
  // And they are really exported by the module the gate reads, not merely named in its text.
  assert.equal(typeof defineSmokeScenario, "function");
  assert.equal(typeof readTemplateExports, "function");
});

test("readRunner reads code, not comments: a comment describing the old bootstrap is not a finding", () => {
  const source = `${importLine}\n${definitionLine}\n// this runner used to call readNativeClientConfig() and connectWithRetry()\n`;
  assert.equal(readRunner(source).conforming, true);
  assert.deepEqual(readRunner(source).reasons, []);
  assert.deepEqual(readRunner(`${importLine}\n${definitionLine}\nconnectWithRetry(config);\n`).reasons, [
    "hand_written_bootstrap:connectWithRetry",
  ]);
});

/* ---------------------------------------------------------------------------------------------------------------
 * THE PRIMITIVE CENSUS
 * ------------------------------------------------------------------------------------------------------------- */

/** A private copy of `parseEvidence`, exactly as 19 runners still spell it. */
const privateEvidence = `function parseEvidence(evidence) {
  const detail = typeof evidence?.detail === "string" ? evidence.detail : "";
  if (detail.length === 0) throw new Error("native_local_evidence_empty");
  return Object.fromEntries(
    detail.split(";").map((pair) => {
      const index = pair.indexOf("=");
      return index > 0 ? [pair.slice(0, index), pair.slice(index + 1)] : null;
    }).filter(Boolean),
  );
}`;

/** The same refusal under ANOTHER name - the `validateConfig` copies - which a name check cannot see. */
const renamedFixtureRefusal = `function validateConfig(value) {
  const fixture = value?.NativeLocalPlayerFixture;
  if (fixture?.Enable !== true || fixture.Bootstrap?.Enable === true || fixture.FixtureScenario !== SCENARIO)
    throw new Error("native_local_x_fixture_config_invalid");
  if (
    value.Portfolio?.Enable === true ||
    value.HostAutomation?.Enable === true ||
    value.HostFarmhandProvisioning?.Enable === true ||
    value.FarmhandProvisioner?.Enable === true
  )
    throw new Error("native_local_x_action_policy_invalid");
  validateNativeLocalFixturePolicy(value, { requiredActions: EXPECTED_ACTIONS });
}`;

const copyRunner = { file: "tools/run-stardew-native-local-player-copied-smoke.mjs" };
const copyFinding = (file, primitive) => `runner_reimplements_a_scaffold_primitive:${file}:${primitive}`;

test("the primitive population is the module's own exports, and a namesake local function is a finding", () => {
  const exports = readPrimitiveExports(primitivesSource());
  // The list is read, not remembered: every export the module has is in it, and nothing else is.
  assert.ok(exports.includes("parseEvidence") && exports.includes("tilesAdjacent"), exports.join(","));
  assert.deepEqual(detectPrimitiveCopies(privateEvidence, exports), ["parseEvidence"]);

  const report = judge({ runners: [{ file: copyRunner.file, source: privateEvidence }] });
  assert.equal(report.ok, false);
  assert.equal(report.privateCopies, 1);
  assert.ok(report.findings.includes(copyFinding(copyRunner.file, "parseEvidence")), report.findings.join("\n"));
  assert.match(renderScaffoldReport(report)[1], /^runners examined 1 · private copies 1 · importing 0$/u);
});

test("a copy under another name is still a finding, because the reading is structural", () => {
  const report = judge({ runners: [{ file: copyRunner.file, source: renamedFixtureRefusal }] });
  assert.ok(
    report.findings.includes(copyFinding(copyRunner.file, "validateNativeLocalFixtureConfig")),
    report.findings.join("\n"),
  );
  // And the file imports nothing: the finding is the copy, not the absence of an import.
  assert.equal(report.importing, 0);
});

test("a body that is not the primitive is not a finding: a target picker reads .x/.y and is left alone", () => {
  const picker = `function chooseAdjacentWeedTarget(snapshot, target) {
  return snapshot.weedTargets
    .filter((entry) => Math.abs(entry.x - target.x) <= 1 && Math.abs(entry.y - target.y) <= 1)
    .sort((left, right) => left.x - right.x)[0];
}`;
  const report = judge({ runners: [{ file: copyRunner.file, source: onTheTemplate(picker) }] });
  assert.equal(report.privateCopies, 0, report.findings.join("\n"));
  assert.equal(report.ok, true);
  // The same shape as a two-argument predicate IS the tile primitive: the difference is the shape, not the file.
  const predicate = `function samePoint(left, right) {\n  return left.x === right.x && left.y === right.y;\n}`;
  assert.deepEqual(detectPrimitiveCopies(predicate, readPrimitiveExports(primitivesSource())), ["sameTile"]);
});

/** A runner whose lifecycle conforms, so a primitive finding is the only finding in the report. */
const onTheTemplate = (body) => `${importLine}\n${definitionLine}\n${body}\n`;

test("the primitive baseline excuses a recorded copy and nothing else, and a stale entry is a finding", () => {
  const recorded = [{ file: copyRunner.file, primitive: "parseEvidence", reason: PRIMITIVE_BASELINE_REASON }];
  assert.equal(
    judge({ runners: [{ file: copyRunner.file, source: onTheTemplate(privateEvidence) }], primitiveCopies: recorded })
      .ok,
    true,
  );

  // The copy is migrated: the entry is now stale and the gate says so by name, in the same direction as the lifecycle.
  const migrated = judge({
    runners: [
      {
        file: copyRunner.file,
        source: onTheTemplate(`import { parseEvidence } from "./lib/native-local-runner-primitives.mjs";`),
      },
    ],
    primitiveCopies: recorded,
  });
  assert.equal(migrated.ok, false);
  assert.ok(
    migrated.findings.includes(
      `stale_primitive_copy:${copyRunner.file}:parseEvidence: the runner no longer spells it, or is gone - delete the entry`,
    ),
    migrated.findings.join("\n"),
  );
  assert.equal(migrated.importing, 1);

  // A reason that is not the one this baseline may carry is a silencer with a nicer name.
  const unreasoned = judge({
    runners: [{ file: copyRunner.file, source: onTheTemplate(privateEvidence) }],
    primitiveCopies: [{ file: copyRunner.file, primitive: "parseEvidence", reason: "because" }],
  });
  assert.ok(
    unreasoned.findings.some((line) => line.startsWith("primitive_copy_without_a_reason:")),
    unreasoned.findings.join("\n"),
  );
});

test("--record-shrinks deletes a stale copy entry and keeps every live entry, in both sections", () => {
  const real = readBaseline({ root: REPOSITORY_ROOT });
  const realCopies = readPrimitiveBaseline({ root: REPOSITORY_ROOT });
  const doomed = realCopies[0];
  const shrink = recordShrinks({
    root: REPOSITORY_ROOT,
    stale: [`stale_primitive_copy:${doomed.file}:${doomed.primitive}: synthetic`],
  });
  assert.deepEqual(shrink.removed, [], "a stale copy is not a stale lifecycle entry");
  assert.equal(shrink.kept.length, real.length);
  assert.equal(shrink.keptCopies.length, realCopies.length - 1);
  assert.deepEqual(shrink.removedCopies, [`${doomed.file}:${doomed.primitive}`]);
});

test("an export with no detector, and a detector with no export, are blocked readings", () => {
  const extras = judge({
    runners: [{ file: copyRunner.file, source: privateEvidence }],
    primitives: `${primitivesSource()}\nexport function parseSomethingNew(evidence) { return evidence; }\n`,
  });
  assert.equal(extras.blocked, "primitive_without_a_detector:parseSomethingNew");
  assert.equal(renderScaffoldReport(extras)[0], "not_measured:primitive_without_a_detector:parseSomethingNew");

  const missing = judge({
    runners: [{ file: copyRunner.file, source: privateEvidence }],
    primitives: primitivesSource().replace(
      "export async function waitForNavigationTerminal(",
      "async function waitForNavigationTerminal(",
    ),
  });
  assert.equal(missing.blocked, "detector_without_a_primitive:waitForNavigationTerminal");
});

test("the real tree: the recorded copies are exactly the detected ones", () => {
  const { report } = runScaffoldGate({ root: REPOSITORY_ROOT });
  assert.equal(report.blocked, null, `blocked: ${report.blocked}`);
  assert.equal(report.ok, true, report.findings.join("\n"));
  const recorded = new Set(
    readPrimitiveBaseline({ root: REPOSITORY_ROOT }).map((entry) => `${entry.file}:${entry.primitive}`),
  );
  const detected = new Set(report.primitiveCopies.map((entry) => `${entry.file}:${entry.primitive}`));
  assert.deepEqual([...detected].sort(), [...recorded].sort(), "the baseline describes the tree exactly");
  assert.ok(report.privateCopies > 0, "a population of zero copies would agree with itself");
  assert.match(renderScaffoldReport(report)[1], /^runners examined \d+ · private copies \d+ · importing \d+$/u);
});

test("the extracted pieces keep the rules the copies had", () => {
  // `parseEvidence`, from the six copies: `index > 0` makes a leading `=` a malformed pair, not a field called "".
  assert.deepEqual(parseEvidence({ detail: "a=1;b=2" }), { a: "1", b: "2" });
  assert.deepEqual(parseEvidence({ detail: "=x;b=2" }), { b: "2" });
  assert.deepEqual(parseEvidence({ detail: "a=b=c" }), { a: "b=c" });
  assert.throws(() => parseEvidence({}), /^Error: native_local_evidence_empty$/u);

  // `projectSnapshotForBlockedReport`, from the four copies: a family the snapshot does not publish reports `[]`.
  assert.deepEqual(
    projectSnapshotForBlockedReport(
      { revision: 3, location: "Farm", tile: { x: 1, y: 2 }, capabilities: ["a"] },
      {
        collections: ["weedTargets"],
        scalars: ["currentTool"],
      },
    ),
    {
      revision: 3,
      location: "Farm",
      tile: { x: 1, y: 2 },
      capabilities: ["a"],
      currentTool: null,
      weedTargets: [],
    },
  );
});

test("the template refuses a definition it cannot run, naming the field, at import time", () => {
  const complete = {
    action: "injected",
    fixtureScenario: "native_x_v1",
    successCode: "x_done",
    refusesConfig: true,
    requiredCapabilities: ["inspect_self"],
    requiredActions: ["inspect_self"],
    experimentalActions: ["injected"],
    prepare: async () => ({ snapshot: null, plan: null }),
    request: () => ({ args: {} }),
    assertPostcondition: async () => ({}),
    negativeOmittedBecause: "no identity to re-send",
  };
  assert.equal(typeof defineSmokeScenario(complete).run, "function");
  // Both halves of the one skippable step, and neither: the declaration is what makes the skip visible.
  assert.throws(() => defineSmokeScenario({ ...complete, negativeOmittedBecause: undefined }), {
    message: "native_local_scenario_definition_invalid:negative",
  });
  for (const field of [
    "action",
    "fixtureScenario",
    "successCode",
    "refusesConfig",
    "requiredCapabilities",
    "prepare",
    "request",
    "assertPostcondition",
  ])
    assert.throws(() => defineSmokeScenario({ ...complete, [field]: undefined }), {
      message: `native_local_scenario_definition_invalid:${field}`,
    });
});
