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
 *   node tools/live-run/analysis/action-breadth.mjs --result <bundle>/result.json [--baseline <path>]
 *
 * POPULATION (derived, printed, never hand-listed): the published execution actions of the Mod's registration table,
 * read through `tools/lib/stardew-published-action-registry.mjs`, minus the actions this fixture declares it cannot
 * reach (`tools/action-breadth-baseline.json` -> `exclusions`, each with the native precondition that says why).
 *
 * MEASURED: the bundle's own `attemptedActionIds` / `succeededActionIds` against its own `snapshotCensus`
 * (addressable); the per-action execution counts, joined from the program journal to the submitted candidate and, for
 * a flat-only run, from the run directory's `actionTrace.jsonl`; and the concentration the largest single action
 * holds.
 *
 * VERDICT: `rich` / `narrow:<reason>` / `not_measured:<missing input>`. Exit 0 for `rich`, 1 for `narrow:`, 2 for
 * `not_measured:` - a reading this tree could not take is refused rather than reported as a pass. A bundle that
 * publishes no census is `not_measured:no_snapshot_census` and is never measured against the catalog instead: the
 * numbers of the bundles that predate the census (`round38`, `round39`) are not gate verdicts and are not recorded as
 * any.
 *
 * red-proof (this tree cannot take it): run against `E:/projects/round39/tools/_multiday_routine-round39.result.json`
 * and the reading exits 2 with `action_breadth: verdict not_measured:no_snapshot_census`. The number it used to print
 * - `attempted 15 of 95` - is the catalog denominator that charged the companion for the fixture's world.
 */
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import {
  formatActionBreadth,
  measureActionBreadth,
  readActionBreadthBaseline,
  readActionBreadthSurface,
} from "../../lib/action-breadth.mjs";
// The one definition of what a program execution IS, so this reading cannot count a redelivered journal event twice
// while the run's own manifest counted it once.
import { programExecutionRows } from "../game/execution-trace.mjs";

function out(line) {
  process.stdout.write(`${line}\n`);
}

function parseArgs(argv) {
  const options = { result: null, baselinePath: undefined };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--result") options.result = argv[(index += 1)] ?? null;
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
      row.addressable === null ? null : row.addressable ? "addressable" : "outside_addressable",
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
      "action_breadth_census: none - this bundle publishes no snapshotCensus, so the world it ran in cannot be read back",
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

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.result === null) {
    out(
      "action_breadth_usage: node tools/live-run/analysis/action-breadth.mjs --result <result.json> [--baseline <path>]",
    );
    process.exitCode = 2;
    return;
  }
  let result;
  try {
    result = JSON.parse(await readFile(options.result, "utf8"));
  } catch (error) {
    out(
      `action_breadth_result_unreadable: ${options.result} - ${String(error instanceof Error ? error.message : error)}`,
    );
    process.exitCode = 2;
    return;
  }
  const attempted = Array.isArray(result?.attemptedActionIds) ? result.attemptedActionIds : null;
  const succeeded = Array.isArray(result?.succeededActionIds) ? result.succeededActionIds : [];
  if (attempted === null) {
    // Refuse to hand back "nothing to measure": a bundle with no attempted list is a bundle this gate cannot read,
    // and passing it would be the silence the gate exists to end.
    out(`action_breadth_refused: ${options.result} publishes no attemptedActionIds, so breadth cannot be measured`);
    process.exitCode = 2;
    return;
  }
  const surface = await readActionBreadthSurface();
  const baseline = await readActionBreadthBaseline(
    options.baselinePath === undefined ? undefined : { path: options.baselinePath },
  );
  const flatDispatchCount = Number.isInteger(result?.executionTrace?.flat) ? result.executionTrace.flat : 0;
  const runDir = result?.bundle?.runDir ?? result?.capture?.dir ?? null;
  const flatRows = await readFlatActionRows(runDir);
  const breadth = await measureActionBreadth({
    scenario: typeof result?.scenario === "string" ? result.scenario : null,
    attempted,
    succeeded,
    executions: Number.isInteger(result?.executionTrace?.rows) ? result.executionTrace.rows : 0,
    actionRows: flatRows,
    programRows: programExecutionRows(result?.programOutcomes ?? []),
    programSubmissions: result?.programSubmissions ?? [],
    // The run's own account of the world it ran in: the families its snapshots published. Absent (a bundle from
    // before this field existed) is `not_measured:no_snapshot_census`, never a fall back to the catalog.
    census: result?.snapshotCensus ?? null,
    surface,
    baseline,
  });
  const excluded = baseline.exclusions
    .map((entry) => entry.actionId)
    .filter((actionId) => surface.actionIds.includes(actionId));
  out(
    `action_breadth_population: ${String(surface.actionIds.length)} published${excluded.length === 0 ? "" : `, excluded ${String(excluded.length)}: ${excluded.sort().join(",")}`}`,
  );
  reportAddressable(breadth);
  for (const line of formatActionBreadth(breadth)) out(line);
  out(
    `action_breadth_baseline: ${
      breadth.baseline === null
        ? `none recorded for scenario ${breadth.scenario ?? "none"}`
        : `best seen ${breadth.baseline.label} - attempted ${String(breadth.baseline.attempted)}, families ${String(breadth.baseline.families)}, addressable ${breadth.baseline.addressable === null ? "not recorded" : String(breadth.baseline.addressable)}`
    }`,
  );
  reportFindings(breadth, flatDispatchCount, flatRows);
  reportPerAction(breadth);
  if (result?.actionBreadth !== undefined && result.actionBreadth !== null) {
    // The bundle already publishes this reading (every run from this commit on does). Comparing the recorded numbers
    // against today's derivation is how a stale bundle is told apart from a moved tree.
    const recorded = result.actionBreadth;
    const agrees =
      recorded.attempted === breadth.attempted &&
      recorded.published === breadth.published &&
      (recorded.addressable ?? null) === breadth.addressable;
    out(
      `action_breadth_bundle: recorded attempted=${String(recorded.attempted)} published=${String(recorded.published)} addressable=${String(recorded.addressable ?? "none")} verdict=${String(recorded.verdict)}${agrees ? "" : " - DISAGREES with this reading"}`,
    );
  }
  out(`action_breadth_verdict: ${breadth.verdict}`);
  process.exitCode = breadth.verdict === "rich" ? 0 : breadth.verdict.startsWith("narrow:") ? 1 : 2;
}

await main();
