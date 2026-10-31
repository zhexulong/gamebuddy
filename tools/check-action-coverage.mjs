#!/usr/bin/env node
/**
 * Which published actions has a run ever actually DISPATCHED?
 *
 * <p>
 * The question this answers came from a wrong measurement of mine, and the error is the reason it exists. I asked "how many
 * actions do the daily tasks name" and got 36 of 95 - 38%, after adding six tasks to improve it. Then the real journal
 * showed **11 dispatches out of 95** in one run: `move_to_tile` 83 times, `cut_weeds` 18, and 84 actions never dispatched
 * at all. Prompt coverage and dispatch coverage differ by a factor of three, and only the second one is a fact about the
 * product.
 * </p>
 * <p>
 * So this reads DISPATCHES, from artifacts a run already writes, and derives its population from the published catalog
 * rather than from a list somebody maintains. That is the whole point: a capability can be published, correct, gated, and
 * used zero times for months - `enter_mine` was, and it looked finished the entire time.
 * </p>
 *
 * <h2>Sources, in order of authority</h2>
 * <ol>
 *   <li>`programTrace.jsonl` - one row per Body Program node dispatch (`programId`, `nodeId`). It carries no actionId, so it
 *       can count dispatches but not name them.</li>
 *   <li>`timeline.jsonl` - one row per world fact, and an execution receipt's payload carries `actionId`. This is the source
 *       that names actions.</li>
 *   <li>`mod-log.txt` - the Mod's own `receipt-publish` lines, used when the run predates `atMs` on the timeline.</li>
 * </ol>
 *
 * <h2>Usage</h2>
 * <pre>
 *   node tools/check-action-coverage.mjs                          # every run under .live-runs/game-ladder
 *   node tools/check-action-coverage.mjs --run-dir DIR            # one run
 *   node tools/check-action-coverage.mjs --json                   # machine-readable
 *   node tools/check-action-coverage.mjs --fail-under 40          # exit 1 below a percentage
 * </pre>
 *
 * <p>
 * EXIT CODE is 0 unless `--fail-under` is given and missed. It is a report, not a gate, until someone puts a number on what
 * "well covered" means - and that number has to come from what fixtures can support, not from the action count.
 * </p>
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const OPTIONS = parseArgs(process.argv.slice(2));
const CATALOG = JSON.parse(
  readFileSync(
    join(repoRoot(), "integrations/stardew/action-development/contracts/generated/action-surface.v1.json"),
    "utf8",
  ),
);
const PUBLISHED = (CATALOG.actions ?? []).map((action) => action.actionId).filter((id) => typeof id === "string");

const runDirs =
  OPTIONS["run-dir"] === undefined || OPTIONS["run-dir"] === true
    ? listRuns(join(repoRoot(), ".live-runs", "game-ladder"))
    : [String(OPTIONS["run-dir"])];

if (runDirs.length === 0) fail("no run directories found");

const perRun = [];
const everSucceeded = new Map();
const everAttempted = new Map();
const everRejected = new Map();
for (const dir of runDirs) {
  const counted = countDispatches(dir);
  perRun.push({ dir: relative(repoRoot(), dir), ...counted });
  for (const [id, count] of counted.succeededActions) everSucceeded.set(id, (everSucceeded.get(id) ?? 0) + count);
  for (const [id, count] of counted.attemptedActions) everAttempted.set(id, (everAttempted.get(id) ?? 0) + count);
  for (const [id, count] of counted.rejectedActions) everRejected.set(id, (everRejected.get(id) ?? 0) + count);
}

// THE MEASUREMENT THAT MATTERS IS SUCCESS. An action that was only ever rejected is not covered: the run that rejected it
// is the evidence it does not work.
const neverSucceeded = PUBLISHED.filter((id) => !everSucceeded.has(id));
const succeeded = PUBLISHED.length - neverSucceeded.length;
const percent = PUBLISHED.length === 0 ? 0 : Math.round((succeeded / PUBLISHED.length) * 100);

const report = {
  published: PUBLISHED.length,
  everSucceeded: succeeded,
  percent,
  everAttempted: everAttempted.size,
  everRejected: [...everRejected.entries()]
    .sort((left, right) => right[1] - left[1])
    .map(([actionId, count]) => ({ actionId, count })),
  neverSucceeded,
  neverAttempted: PUBLISHED.filter((id) => !everAttempted.has(id)),
  runs: perRun,
};

if (OPTIONS.json === true) {
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} else {
  render(report);
}

if (OPTIONS["fail-under"] !== undefined && OPTIONS["fail-under"] !== true) {
  const floor = Number(OPTIONS["fail-under"]);
  if (!Number.isFinite(floor)) fail(`--fail-under must be a number, got ${String(OPTIONS["fail-under"])}`);
  if (percent < floor) {
    process.stderr.write(`\naction coverage ${percent}% is below the floor of ${floor}%\n`);
    process.exit(1);
  }
}
process.exit(0);

function parseArgs(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) continue;
    const name = token.slice(2);
    const next = argv[index + 1];
    if (next === undefined || next.startsWith("--")) parsed[name] = true;
    else {
      parsed[name] = next;
      index += 1;
    }
  }
  return parsed;
}

function repoRoot() {
  let directory = import.meta.dirname;
  while (directory !== undefined && !existsSync(join(directory, "integrations"))) {
    const parent = join(directory, "..");
    if (parent === directory) break;
    directory = parent;
  }
  return directory ?? process.cwd();
}

function listRuns(root) {
  if (!existsSync(root)) return [];
  return readdirSync(root)
    .map((name) => join(root, name))
    .filter((path) => statSync(path, { throwIfNoEntry: false })?.isDirectory() === true)
    .sort();
}

/**
 * Every actionId this run completed SUCCESSFULLY, with how many times.
 *
 * <p>
 * SUCCEEDED, not dispatched. A dispatch covers "the companion asked"; a `rejected` dispatch covers the opposite of
 * coverage - the action ran into a wall and did nothing. Counting dispatches would report an action as exercised by the
 * very run that proves it does not work, which is the defect family this whole session kept tripping over: a check whose
 * boundary is not the thing it claims to measure.
 * </p>
 * <p>
 * The timeline carries `state` on every execution receipt (`accepted`, `running`, `meaningful_progress`, `succeeded`,
 * `rejected`), so the distinction is already in the artifact. Measured on one run: 1259 action-tagged rows, of which 178
 * were `succeeded` and 7 `rejected`.
 * </p>
 */
function countDispatches(dir) {
  const succeeded = new Map();
  const attempted = new Map();
  const rejected = new Map();
  let source = null;

  const timeline = join(dir, "timeline.jsonl");
  if (existsSync(timeline)) {
    source = "timeline.jsonl";
    for (const row of readJsonLines(timeline)) {
      const payload = row?.worldFactPayload;
      const actionId = payload?.actionId;
      if (typeof actionId !== "string" || actionId.length === 0) continue;
      attempted.set(actionId, (attempted.get(actionId) ?? 0) + 1);
      if (payload.state === "succeeded") succeeded.set(actionId, (succeeded.get(actionId) ?? 0) + 1);
      else if (payload.state === "rejected") rejected.set(actionId, (rejected.get(actionId) ?? 0) + 1);
    }
  }

  // Fall back to the Mod's own receipt markers, which name the action and its terminal state.
  if (attempted.size === 0) {
    for (const name of ["mod-log.txt"]) {
      const path = join(dir, name);
      if (!existsSync(path)) continue;
      source = name;
      for (const line of readFileSync(path, "utf8").split("\n")) {
        const action = /actionId=([a-z0-9_]+)/.exec(line);
        if (action === null) continue;
        attempted.set(action[1], (attempted.get(action[1]) ?? 0) + 1);
        if (/state=Succeeded/.test(line)) succeeded.set(action[1], (succeeded.get(action[1]) ?? 0) + 1);
        else if (/state=Rejected/.test(line)) rejected.set(action[1], (rejected.get(action[1]) ?? 0) + 1);
      }
    }
  }

  let nodes = 0;
  const trace = join(dir, "programTrace.jsonl");
  if (existsSync(trace)) nodes = readJsonLines(trace).length;

  return {
    source,
    succeededActions: succeeded,
    attemptedActions: attempted,
    rejectedActions: rejected,
    distinctSucceeded: succeeded.size,
    distinctAttempted: attempted.size,
    successes: [...succeeded.values()].reduce((sum, n) => sum + n, 0),
    attempts: [...attempted.values()].reduce((sum, n) => sum + n, 0),
    nodes,
  };
}

function readJsonLines(path) {
  const out = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (line.trim().length === 0) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      // A truncated last line is ordinary for a killed run; skipping it must not silence the rest.
    }
  }
  return out;
}

function render(report) {
  process.stdout.write(`published actions: ${report.published}\n`);
  process.stdout.write(`SUCCEEDED at least once: ${report.everSucceeded} (${report.percent}%)\n`);
  process.stdout.write(`attempted at least once: ${report.everAttempted} of ${report.published}\n`);
  process.stdout.write(`never attempted: ${report.neverAttempted.length}\n\n`);

  for (const run of report.runs) {
    const label = run.dir.split(/[\\/]/).pop();
    process.stdout.write(
      `${label}: ${run.distinctSucceeded} succeeded / ${run.distinctAttempted} attempted · ${run.successes} successes, ${run.attempts} attempts, ${run.nodes} node rows (from ${run.source ?? "nothing"})\n`,
    );
  }

  if (report.everRejected.length > 0) {
    process.stdout.write(`\nattempted but NEVER succeeded (published, and the world refused it):\n`);
    for (const { actionId, count } of report.everRejected)
      if (!report.neverSucceeded.includes(actionId))
        process.stdout.write(`  ${actionId}: ${count} rejections, and it never succeeded once\n`);
  }

  if (report.neverSucceeded.length > 0) {
    process.stdout.write(`\nnever SUCCEEDED, by prefix:\n`);
    const grouped = new Map();
    for (const id of report.neverSucceeded) {
      const prefix = id.split("_")[0];
      if (!grouped.has(prefix)) grouped.set(prefix, []);
      grouped.get(prefix).push(id);
    }
    for (const [prefix, ids] of [...grouped.entries()].sort((left, right) => right[1].length - left[1].length))
      process.stdout.write(`  ${prefix} (${ids.length}): ${ids.join(", ")}\n`);
  }
}

function fail(message) {
  process.stderr.write(`check-action-coverage: ${message}\n`);
  process.exit(1);
}
