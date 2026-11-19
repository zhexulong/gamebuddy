#!/usr/bin/env node
/**
 * Did this run USE the action surface it was given, or repeat the few actions that cannot go wrong?
 *
 * WHY. Measured 2026-11-07: a completed `multiday_routine` run (`round39`) published `executionTrace: { ok: true,
 * rows: 124 }` and was judged on its other clauses. It had attempted 15 distinct actions, one of them (`cut_weeds`)
 * for a quarter of its executions, and its catalog said nothing about either fact. This entry is the on-demand half of
 * the fix; the other half is the `action_breadth` clause the runner publishes in every bundle
 * (`tools/live-run/game/run-stardew-native-local-agent-ab-live.mjs`), so a narrow run is visible in its own verdict.
 *
 * THE DENOMINATOR IS THE RUN'S OWN WORLD, NOT THE CATALOG. The first version divided by the 95 published actions; but
 * a target-bound action is only constructible while its `*Targets` family has a row in the snapshot, and the snapshot
 * is the player's own location within Chebyshev radius 6. One `FixtureScenario` string arms one world, so a run can
 * address a fraction of the catalog - and dividing by the catalog charged the companion for the fixture. The
 * denominator is now the run's own published `snapshotCensus`, joined to actions through the discovery audit's
 * `TARGET_FIELD` map, plus the actions that name no snapshot family at all.
 *
 *   node tools/live-run/analysis/action-breadth.mjs --run <runDir> [--result <result.json>] [--log <log>] [--baseline <path>]
 *
 * MID-RUN, FROM THE LOG. A run publishes `result.json` only when it ENDS, and breadth is exactly the reading that
 * matters while a run is going: a run that goes narrow looks like a run that is working. Measured 2026-11-19: `round78`
 * was stopped eleven minutes in and this tool could print nothing, although its runner log carried all 74 execution
 * receipts - ten action families, counted by hand during the audit. So every reading here is available from the log as
 * well, and each one prints WHICH FILE it read: `result.json` and the log cannot agree on a partial run (the bundle
 * holds executions that settled without a receipt), and the difference is a fact about the run, printed beside both
 * numbers, never summed into one.
 *
 * POPULATION (derived, printed, never hand-listed): the published execution actions of the Mod's registration table,
 * read through `tools/lib/stardew-published-action-registry.mjs`, minus the actions this fixture declares it cannot
 * reach (`tools/action-breadth-baseline.json` -> `exclusions`, each with the native precondition that says why).
 *
 * MEASURED: the bundle's own `attemptedActionIds` / `succeededActionIds` against its own `snapshotCensus`
 * (addressable); the per-action execution counts, joined from the program journal to the submitted candidate and, for
 * a flat-only run, from the run directory's `actionTrace.jsonl`; and the concentration the largest single action
 * holds. From the log: the same attempted/succeeded/executions/counts, keyed on the `executionId` each receipt carries,
 * with the count of identities beside the count of lines so a doubled row cannot double a number. The census is the
 * BUNDLE's fact alone, so a mid-run reading has no addressable width and says `not_measured:no_snapshot_census`.
 *
 * VERDICT: `rich` / `narrow:<reason>` / `not_measured:<missing input>`. Exit 0 for `rich`, 1 for `narrow:`, 2 for
 * `not_measured:` - a reading this tree could not take is refused rather than reported as a pass. A bundle that
 * publishes no census is `not_measured:no_snapshot_census` and is never measured against the catalog instead: the
 * numbers of the bundles that predate the census (`round38`, `round39`) are not gate verdicts and are not recorded as
 * any. A reading taken from the log is marked `partial: true`, because it is what the run had done when the log was
 * last written rather than an account of the run.
 *
 * red-proof (this tree cannot take it): run against `E:/projects/round39/tools/_multiday_routine-round39.result.json`
 * and the reading exits 2 with `action_breadth: verdict not_measured:no_snapshot_census`. The number it used to print
 * - `attempted 15 of 95` - is the catalog denominator that charged the companion for the fixture's world.
 */
import { existsSync, readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import {
  formatActionBreadth,
  measureActionBreadth,
  readActionBreadthBaseline,
  readActionBreadthSurface,
} from "../../lib/action-breadth.mjs";
import {
  actionExecutions,
  attemptedActions,
  describeRunnerLog,
  locateRunnerLog,
  readRunnerLog,
  succeededActions,
} from "../../lib/live-runner-log.mjs";
import { createReadingLedger, FROM_RESULT, FROM_RUNNER_LOG } from "../../lib/reading-source.mjs";
// The one definition of what a program execution IS, so this reading cannot count a redelivered journal event twice
// while the run's own manifest counted it once.
import { programExecutionRows } from "../game/execution-trace.mjs";

function out(line) {
  process.stdout.write(`${line}\n`);
}

function parseArgs(argv) {
  const options = { result: null, run: null, logPath: null, logDir: null, baselinePath: undefined };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--result") options.result = argv[(index += 1)] ?? null;
    else if (argv[index] === "--run") options.run = argv[(index += 1)] ?? null;
    else if (argv[index] === "--log") options.logPath = argv[(index += 1)] ?? null;
    else if (argv[index] === "--log-dir") options.logDir = argv[(index += 1)] ?? null;
    else if (argv[index] === "--baseline") options.baselinePath = argv[(index += 1)] ?? undefined;
  }
  return options;
}

/** One run directory's flat request frames: the only place a flat dispatch's action id is recorded. */
async function readFlatActionRows(runDir) {
  if (typeof runDir !== "string" || runDir.length === 0) return null;
  const path = join(runDir, "actionTrace.jsonl");
  if (!existsSync(path)) return null;
  const text = await readFile(path, "utf8");
  return text
    .split(/\r?\n/u)
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line));
}

function reportPerAction(breadth) {
  for (const row of breadth.perAction) {
    const marks = [
      row.excluded ? "excluded" : null,
      row.withheld === null || row.withheld === undefined
        ? row.addressable === null
          ? null
          : row.addressable
            ? "addressable"
            : "outside_addressable"
        : `withheld:${row.withheld}`,
      row.succeeded ? "succeeded" : "not_succeeded",
    ].filter((mark) => mark !== null);
    out(
      `action_breadth_action: ${row.actionId} family=${row.family} executions=${String(row.executions)} ${marks.join(" ")}`,
    );
  }
}

/**
 * Why the addressable number is what it is, one line per family that gave the run anything to address.
 *
 * Printed beside the summary because an addressable set nobody can decompose is a number a reader has to trust: the
 * rows each family published and the actions they made constructible say which part of the world this run had.
 */
function reportAddressable(breadth) {
  const census = breadth.census ?? null;
  if (census === null) {
    out(
      "action_breadth_census: none - this run publishes no snapshotCensus, so the world it ran in cannot be read back",
    );
    return;
  }
  out(
    `action_breadth_census: ${String(census.snapshots)} snapshots from ${census.source}; ${String(census.families.filter((entry) => entry.rows > 0).length)} of ${String(census.families.length)} target families carried rows`,
  );
  for (const entry of breadth.addressableFamilies ?? [])
    out(
      `action_breadth_addressable_family: ${entry.family} rows=${String(entry.rows)} actions=${entry.actionIds.join(",")}`,
    );
  if (breadth.addressableExcluded !== null && breadth.addressableExcluded.length > 0)
    out(
      `action_breadth_addressable_excluded: ${breadth.addressableExcluded.join(",")} - addressable in this world, withheld by the baseline's declared exclusions`,
    );
  const withoutRows = census.families.filter((entry) => entry.rows === 0).map((entry) => entry.family);
  if (withoutRows.length > 0)
    out(`action_breadth_addressable_absent: ${withoutRows.join(",")} carried no row in any of the run's snapshots`);
}

/**
 * The target families the run's OWN receipts say it acted in, from the run directory's `timeline.jsonl`.
 *
 * Every Mod settlement states its chore by the family name the observation publishes (`chore=itemTargets`, …), so this is
 * the run's own statement of which families its work reached - the one reading that can tell a census which sampled too
 * little apart from a world that held nothing. Null when the run directory or its timeline is absent: a bundle without
 * one is not evidence that the census was right.
 */
async function readActedFamilies(runDir) {
  if (typeof runDir !== "string" || runDir.length === 0) return null;
  const path = join(runDir, "timeline.jsonl");
  if (!existsSync(path)) return null;
  const acted = new Map();
  for (const line of (await readFile(path, "utf8")).split(/\r?\n/u)) {
    if (line.trim().length === 0) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    const detail = entry?.worldFactPayload?.evidence?.detail ?? entry?.evidence?.detail;
    if (typeof detail !== "string") continue;
    for (const pair of detail.split(";")) {
      const index = pair.indexOf("=");
      if (index <= 0 || pair.slice(0, index) !== "chore") continue;
      const family = pair.slice(index + 1);
      if (family.length > 0) acted.set(family, (acted.get(family) ?? 0) + 1);
    }
  }
  return acted;
}

/**
 * Whether the census sampled the families the run actually worked in.
 *
 * The census is a sample of the world this run was given, so it is only as good as its sample rate: `round76` published 8
 * snapshots, and the families of its 40 successful `pickup_item`/`chop_tree`/`chop_stump` executions carried no row in any
 * of them - which reads as "she acted outside her addressable surface" when the truth is "the census never looked".
 * Each family the run's own receipts name is a family it SAW, so a zero here is our sampling gap and is reported as one.
 */
function reportCensusContact(breadth, actedFamilies) {
  const census = breadth.census ?? null;
  if (census === null || actedFamilies === null) return;
  const rowsOf = new Map(census.families.map((entry) => [entry.family, entry.rows]));
  const missed = [...actedFamilies]
    .filter(([family]) => (rowsOf.get(family) ?? 0) === 0)
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]));
  const unsampled = [...actedFamilies.keys()].filter((family) => !rowsOf.has(family)).sort();
  if (unsampled.length > 0)
    out(
      `action_breadth_census_unmapped: ${unsampled.join(",")} carried the run's work but names no action's target family, so no denominator can join it`,
    );
  for (const [family, count] of missed)
    out(
      `action_breadth_census_gap: ${family} carried ${String(count)} of the run's own settlements but had no row in any of the ${String(census.snapshots)} snapshots the census sampled; the sample missed the frames the run really worked in`,
    );
  if (missed.length === 0 && unsampled.length === 0)
    out(
      `action_breadth_census_contact: all ${String(actedFamilies.size)} families the run worked in carried a row in its census`,
    );
}

function reportFindings(breadth, flatDispatchCount, rowsRead) {
  for (const actionId of breadth.excludedAttempted)
    out(
      `action_breadth_exclusion_stale: ${actionId} is excluded as unreachable but this run attempted it; remove the exclusion or say why it still holds`,
    );
  for (const actionId of breadth.staleExclusions)
    out(
      `action_breadth_exclusion_orphaned: ${actionId} is excluded but is no longer a published action; delete the entry`,
    );
  for (const actionId of breadth.outsidePopulation)
    out(
      `action_breadth_outside_population: ${actionId} was attempted and is not in this tree's published population; an experimental or withdrawn action is not published, so a fixture that enabled one measures against a wider surface than this ratchet records`,
    );
  for (const actionId of breadth.outsideAddressable)
    out(
      `action_breadth_outside_addressable: ${actionId} was dispatched and is not addressable in this run's own census; the census missed a family the run used, so the coverage above is measured against the wrong world`,
    );
  if (rowsRead === null && flatDispatchCount > 0)
    out(
      `action_breadth_flat_trace_unread: ${String(flatDispatchCount)} flat dispatches have no rows (no run directory or no actionTrace.jsonl), so they are unattributed to any action`,
    );
}

/** The run directory the arguments named, whichever way they named it. */
function runDirOf(options) {
  if (typeof options.run === "string" && options.run.length > 0) return resolve(options.run);
  const anchor = options.result ?? options.logPath;
  return typeof anchor === "string" && anchor.length > 0 ? dirname(resolve(anchor)) : null;
}

/**
 * The run's launch receipt: the only thing on disk that binds a run directory to the log it wrote.
 *
 * `startedAtMs` is the instant the launcher armed the directory, and the log's own first line carries the instant its
 * process started writing - which is what makes the log identifiable by CONTENT rather than by "newest".
 */
function readLaunch(runDir) {
  if (runDir === null) return null;
  const path = join(runDir, "launch.json");
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    return {
      startedAtMs: Number.isFinite(parsed?.startedAtMs) ? parsed.startedAtMs : null,
      label: typeof parsed?.label === "string" && parsed.label.length > 0 ? parsed.label : null,
    };
  } catch {
    return null;
  }
}

/** The bundle, or the reason it cannot be read: an absent file and a broken one are two different facts. */
function readBundle(path) {
  if (path === null)
    return { value: null, path: null, why: "no --result and no run directory, so no bundle was named" };
  if (!existsSync(path)) return { value: null, path, why: `${path} does not exist` };
  try {
    return { value: JSON.parse(readFileSync(path, "utf8")), path, why: null };
  } catch (error) {
    return {
      value: null,
      path,
      why: `${path} is not JSON - ${String(error instanceof Error ? error.message : error)}`,
    };
  }
}

/**
 * The reading the bundle answers, in the shape both sources fill.
 *
 * `attempted` is `null` rather than empty when the bundle does not publish it: a hand-stopped run can have a
 * `result.json` with no attempted list, and "no list" is what lets the log answer in its place instead.
 */
function bundleReading(result) {
  const value = result ?? {};
  return {
    source: FROM_RESULT,
    partial: false,
    scenario: typeof value.scenario === "string" ? value.scenario : null,
    attempted: Array.isArray(value.attemptedActionIds) ? value.attemptedActionIds : null,
    succeeded: Array.isArray(value.succeededActionIds) ? value.succeededActionIds : [],
    executions: Number.isInteger(value.executionTrace?.rows) ? value.executionTrace.rows : 0,
    programRows: programExecutionRows(value.programOutcomes ?? []),
    programSubmissions: value.programSubmissions ?? [],
    executedRows: [],
    census: value.snapshotCensus ?? null,
    flatDispatchCount: Number.isInteger(value.executionTrace?.flat) ? value.executionTrace.flat : 0,
  };
}

/**
 * The reading the runner log answers: the same questions, keyed on the identity each receipt carries.
 *
 * The census is absent here deliberately - it is the bundle's own fact about the world the run's snapshots showed it -
 * so a mid-run reading has no addressable width and says `not_measured:no_snapshot_census` rather than falling back to
 * the catalog. `executions` is the number of receipt IDENTITIES, not of receipt lines.
 */
function logReading(log) {
  return {
    source: FROM_RUNNER_LOG,
    partial: true,
    attempted: attemptedActions(log),
    succeeded: succeededActions(log),
    executions: log.counts.receipts,
    programRows: [],
    programSubmissions: [],
    executedRows: log.receipts,
    census: null,
    flatDispatchCount: 0,
  };
}

/** What the log's identities are, and what counting its lines instead would have said. */
function identityLine(log) {
  const counts = log.counts;
  return (
    `${String(counts.receipts)} executions keyed on the executionId each receipt carries, out of ${String(counts.receiptLines)} receipt lines (${String(counts.collapsedReceipts)} collapsed on that identity)` +
    ` · ${String(counts.detailInBoth)} carry the same detail in evidence.detail and worldFactPayload.evidence.detail and are read once` +
    ` · ${String(counts.submissions)} programme identities out of ${String(counts.submissionLines)} submissions (${String(counts.collapsedSubmissions)} re-submitted) naming ${String(counts.submittedNodes)} nodes`
  );
}

/**
 * The same run read twice: the bundle's counts beside the log's, and the difference named rather than reconciled.
 *
 * They CANNOT agree, and the difference is a fact: an execution that settled without publishing a receipt is in the
 * bundle and not in the log, so the log is a lower bound on executions. Summing them would count every execution that
 * did publish one twice; printing one and hiding the other would lose exactly the executions a reader is asking about.
 */
function reportBothSources({ fromBundle, fromLog, breadth, readings, log }) {
  if (fromBundle === null || fromBundle.attempted === null) return;
  readings.fromResult("action_breadth.bundle_executions", fromBundle.executions);
  readings.fromLog("action_breadth.log_executions", fromLog.executions);
  const inLog = actionExecutions(log).counts;
  const differing = [];
  for (const row of breadth.perAction) {
    const logged = inLog.get(row.actionId) ?? 0;
    if (row.executions !== logged) differing.push(`${row.actionId} ${String(row.executions)} vs ${String(logged)}`);
  }
  for (const [actionId, count] of inLog)
    if (!breadth.perAction.some((row) => row.actionId === actionId))
      differing.push(`${actionId} 0 vs ${String(count)}`);
  const executions = fromBundle.executions - fromLog.executions;
  out(
    `action_breadth_log_vs_bundle: result.json names ${String(fromBundle.attempted.length)} actions in ${String(fromBundle.executions)} executions, live-runner.log ${String(fromLog.attempted.length)} in ${String(fromLog.executions)} identities - ${String(executions)} execution(s) the bundle counts and no receipt names (the log is a lower bound); ` +
      (differing.length === 0
        ? "every per-action count agrees"
        : `${String(differing.length)} per-action count(s) differ: ${differing.join(", ")}`) +
      " - two readings of one run, never summed",
  );
}

/** The verdict's exit code, with an unsourced reading failing the run before the verdict is read. */
function exitCodeFor(breadth, gateFailed) {
  if (gateFailed) return 1;
  return breadth.verdict === "rich" ? 0 : breadth.verdict.startsWith("narrow:") ? 1 : 2;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.result === null && options.run === null && options.logPath === null) {
    out(
      "action_breadth_usage: node tools/live-run/analysis/action-breadth.mjs --run <runDir> | --result <result.json> | --log <live-runner.log> [--baseline <path>]",
    );
    process.exitCode = 2;
    return;
  }
  const readings = createReadingLedger();
  const runDir = runDirOf(options);
  const launch = readLaunch(runDir);
  const bundle = readBundle(
    options.result !== null ? resolve(options.result) : runDir === null ? null : join(runDir, "result.json"),
  );
  const located = locateRunnerLog({
    runDir,
    logPath: options.logPath,
    logDir: options.logDir,
    startedAtMs: launch?.startedAtMs ?? null,
  });
  const log = located.path === null ? null : readRunnerLog(located.path);
  if (bundle.value === null && log === null) {
    // Refuse to hand back "nothing to measure": neither record exists, and passing would be the silence the gate
    // exists to end. WHICH record was missing is the reader's first question, so both are named with their reasons.
    out(`action_breadth_refused: no reading can be taken from this run - neither a bundle nor a log was read`);
    out(`action_breadth_bundle: ${bundle.why}`);
    out(`action_breadth_log: ${located.why}`);
    for (const line of readings.lines()) out(line);
    process.exitCode = 2;
    return;
  }
  const fromBundle = bundle.value === null ? null : bundleReading(bundle.value);
  const fromLog = log === null ? null : logReading(log);
  // The bundle is the run's own account and answers first; the log speaks when the bundle is absent OR when it
  // publishes no attempted list (a hand-stopped run can have neither field), and the source line says which spoke.
  const chosen = fromBundle !== null && fromBundle.attempted !== null ? fromBundle : fromLog;
  if (chosen === null) {
    out(
      `action_breadth_refused: ${bundle.path} publishes no attemptedActionIds and no runner log answers this run; breadth cannot be measured`,
    );
    out(`action_breadth_log: ${located.why}`);
    for (const line of readings.lines()) out(line);
    process.exitCode = 2;
    return;
  }
  if (chosen.source === FROM_RESULT) {
    out(`action_breadth_source: ${FROM_RESULT} - the run's own bundle, ${bundle.path}`);
  } else {
    out(
      `action_breadth_source: live-runner.log - ${fromBundle === null ? "this run publishes no result.json" : "its result.json publishes no attemptedActionIds"}, so every reading below is taken from the runner's log the run wrote while it was running`,
    );
    out(`action_breadth_log_binding: ${located.path} - ${located.how}`);
    out(`action_breadth_log: ${describeRunnerLog(log)}`);
    out(
      `action_breadth_partial: true - no result.json in this run directory, so these readings are what the run had done when its log was last written, not a verdict on the run`,
    );
  }
  if (log !== null && chosen.source === FROM_RESULT)
    out(
      `action_breadth_log_binding: ${located.path} - ${located.how} (read as a second source, never added to the bundle's counts)`,
    );
  const surface = await readActionBreadthSurface();
  const baseline = await readActionBreadthBaseline(
    options.baselinePath === undefined ? undefined : { path: options.baselinePath },
  );
  const scenario = fromBundle?.scenario ?? launch?.label ?? null;
  const trailDir = bundle.value?.bundle?.runDir ?? bundle.value?.capture?.dir ?? runDir;
  const flatRows = await readFlatActionRows(trailDir);
  const actedFamilies = await readActedFamilies(trailDir);
  const breadth = await measureActionBreadth({
    scenario,
    attempted: chosen.attempted,
    succeeded: chosen.succeeded,
    executions: chosen.executions,
    actionRows: chosen.source === FROM_RESULT ? flatRows : null,
    programRows: chosen.programRows,
    programSubmissions: chosen.programSubmissions,
    // The receipts of the runner's log, each already keyed on the identity its producer gave it.
    executedRows: chosen.executedRows,
    // The run's own account of the world it ran in: the families its snapshots published. Absent (a bundle from
    // before this field existed, or a run that has not ended) is `not_measured:no_snapshot_census`, never a fall
    // back to the catalog.
    census: chosen.census,
    surface,
    baseline,
  });
  const reading = chosen.source;
  readings[reading === FROM_RESULT ? "fromResult" : "fromLog"]("action_breadth.attempted", breadth.attempted);
  readings[reading === FROM_RESULT ? "fromResult" : "fromLog"]("action_breadth.families", breadth.families);
  readings[reading === FROM_RESULT ? "fromResult" : "fromLog"]("action_breadth.executions", breadth.executions);
  // The addressable width is the BUNDLE's fact: the log carries no snapshot census, so a mid-run reading has none.
  readings.fromResult(
    "action_breadth.addressable",
    breadth.addressable === null ? "not_measured (the run published no snapshot census)" : breadth.addressable,
  );
  const excluded = baseline.exclusions
    .map((entry) => entry.actionId)
    .filter((actionId) => surface.actionIds.includes(actionId));
  out(
    `action_breadth_population: ${String(surface.actionIds.length)} published${excluded.length === 0 ? "" : `, excluded ${String(excluded.length)}: ${excluded.sort().join(",")}`}`,
  );
  if (chosen.source === FROM_RUNNER_LOG) out(`action_breadth_identities: ${identityLine(log)}`);
  reportAddressable(breadth);
  for (const line of formatActionBreadth(breadth)) out(line);
  out(
    `action_breadth_baseline: ${
      breadth.baseline === null
        ? `none recorded for scenario ${breadth.scenario ?? "none"}`
        : `best seen ${breadth.baseline.label} - attempted ${String(breadth.baseline.attempted)}, families ${String(breadth.baseline.families)}, addressable ${breadth.baseline.addressable === null ? "not recorded" : String(breadth.baseline.addressable)}, coverage floor ${breadth.baseline.coverageFloor === undefined ? "not recorded" : `${String(breadth.baseline.coverageFloor.attempted)} of ${String(breadth.baseline.coverageFloor.addressable)} (${String(breadth.baseline.coverageFloor.label)})`}`
    }`,
  );
  if ((breadth.baselineMissedFamilies ?? []).length > 0)
    out(
      `action_breadth_baseline_families: ${breadth.baselineMissedFamilies.join(",")} - this run's world offered these families, the recorded best worked in them, and this run did not`,
    );
  reportFindings(breadth, chosen.flatDispatchCount, chosen.source === FROM_RESULT ? flatRows : null);
  reportCensusContact(breadth, actedFamilies);
  reportPerAction(breadth);
  if (log !== null && fromLog !== null)
    reportBothSources({
      fromBundle: fromBundle === null || fromBundle.attempted === null ? null : fromBundle,
      fromLog,
      breadth,
      readings,
      log,
    });
  if (bundle.value?.actionBreadth !== undefined && bundle.value.actionBreadth !== null) {
    // The bundle already publishes this reading (every run from this commit on does). Comparing the recorded numbers
    // against today's derivation is how a stale bundle is told apart from a moved tree.
    const recorded = bundle.value.actionBreadth;
    const agrees =
      recorded.attempted === breadth.attempted &&
      recorded.published === breadth.published &&
      (recorded.addressable ?? null) === breadth.addressable;
    out(
      `action_breadth_bundle: recorded attempted=${String(recorded.attempted)} published=${String(recorded.published)} addressable=${String(recorded.addressable ?? "none")} verdict=${String(recorded.verdict)}${agrees ? "" : " - DISAGREES with this reading"}`,
    );
  }
  out(
    `action_breadth_verdict: ${breadth.verdict}${chosen.partial ? " (partial - the run has not ended, so this is what it had done and not what it did)" : ""}`,
  );
  for (const line of readings.lines()) out(line);
  process.exitCode = exitCodeFor(breadth, readings.failed());
}

await main();
