#!/usr/bin/env node
/**
 * Did this run USE the action surface it was given, or repeat the few actions that cannot go wrong?
 *
 * WHY. Measured 2026-11-07: a completed `multiday_routine` run (`round39`) published `executionTrace: { ok: true,
 * rows: 124 }` and was judged on its other clauses. It had attempted 15 of the 95 published actions, one of them
 * (`cut_weeds`) for a quarter of its executions, and 79 published actions were never touched. Because the verdict
 * only counted executions, a day that degenerated to cutting weeds read exactly like a varied one. This entry is the
 * on-demand half of the fix; the other half is the `action_breadth` clause the runner publishes in every bundle
 * (`tools/live-run/game/run-stardew-native-local-agent-ab-live.mjs`), so a narrow run is visible in its own verdict.
 *
 *   node tools/audit-action-breadth.mjs --result <bundle>/result.json [--baseline <path>]
 *
 * POPULATION (derived, printed, never hand-listed): the published execution actions of the Mod's registration table,
 * read through `tools/lib/stardew-published-action-registry.mjs`, minus the actions this fixture declares it cannot
 * reach (`tools/action-breadth-baseline.json` -> `exclusions`, each with the native precondition that says why).
 *
 * MEASURED: the bundle's own `attemptedActionIds` / `succeededActionIds`; the per-action execution counts, joined
 * from the program journal to the submitted candidate and, for a flat-only run, from the run directory's
 * `actionTrace.jsonl`; and the concentration the largest single action holds.
 *
 * VERDICT: `rich` / `narrow:<reason>` / `not_measured:<missing input>`. Exit 0 for `rich`, 1 for `narrow:`, 2 for
 * `not_measured:` - a reading this tree could not take is refused rather than reported as a pass, and an empty
 * population or an empty attempted list is a refusal, never "0 of 0, nothing to see".
 *
 * red-proof: run against `E:/projects/round39/tools/_multiday_routine-round39.result.json`; it exits 1 with
 *   `action_breadth: verdict narrow:below_baseline:round38` and `attempted 15 of 95`.
 */
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import {
  formatActionBreadth,
  measureActionBreadth,
  readActionBreadthBaseline,
  readActionBreadthSurface,
} from "./lib/action-breadth.mjs";
// The one definition of what a program execution IS, so this reading cannot count a redelivered journal event twice
// while the run's own manifest counted it once.
import { programExecutionRows } from "./live-run/game/execution-trace.mjs";

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
    const marks = [row.excluded ? "excluded" : null, row.succeeded ? "succeeded" : "not_succeeded"].filter(
      (mark) => mark !== null,
    );
    out(
      `action_breadth_action: ${row.actionId} family=${row.family} executions=${String(row.executions)} ${marks.join(" ")}`,
    );
  }
}

function reportFindings(breadth, flatDispatchCount, flatRows) {
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
  if (flatRows === null && flatDispatchCount > 0)
    out(
      `action_breadth_flat_trace_unread: ${String(flatDispatchCount)} flat dispatches have no rows (no run directory or no actionTrace.jsonl), so they are unattributed to any action`,
    );
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.result === null) {
    out("action_breadth_usage: node tools/audit-action-breadth.mjs --result <result.json> [--baseline <path>]");
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
    surface,
    baseline,
  });
  const excluded = baseline.exclusions
    .map((entry) => entry.actionId)
    .filter((actionId) => surface.actionIds.includes(actionId));
  out(
    `action_breadth_population: ${String(surface.actionIds.length)} published${excluded.length === 0 ? "" : `, excluded ${String(excluded.length)}: ${excluded.sort().join(",")}`}`,
  );
  for (const line of formatActionBreadth(breadth)) out(line);
  out(
    `action_breadth_baseline: ${breadth.baseline === null ? `none recorded for scenario ${breadth.scenario ?? "none"}` : `best seen ${breadth.baseline.label} - attempted ${String(breadth.baseline.attempted)}, families ${String(breadth.baseline.families)}`}`,
  );
  reportFindings(breadth, flatDispatchCount, flatRows);
  reportPerAction(breadth);
  if (result?.actionBreadth !== undefined && result.actionBreadth !== null) {
    // The bundle already publishes this reading (every run from this commit on does). Comparing the recorded numbers
    // against today's derivation is how a stale bundle is told apart from a moved tree.
    const recorded = result.actionBreadth;
    const agrees = recorded.attempted === breadth.attempted && recorded.published === breadth.published;
    out(
      `action_breadth_bundle: recorded attempted=${String(recorded.attempted)} published=${String(recorded.published)} verdict=${String(recorded.verdict)}${agrees ? "" : " - DISAGREES with this reading"}`,
    );
  }
  out(`action_breadth_verdict: ${breadth.verdict}`);
  process.exitCode = breadth.verdict === "rich" ? 0 : breadth.verdict.startsWith("narrow:") ? 1 : 2;
}

await main();
