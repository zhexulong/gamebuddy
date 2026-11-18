import { readdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Record the terminal receipt each live run actually produced, so a test can run the HOST's completion rule against the
 * MOD's real output.
 *
 * WHY THIS EXISTS: the two sides of that contract are written separately, and a field added on one side has silently
 * broken live gates at least four times - a `leftover_returned` the Host did not list (a successful retrieval was then
 * never "complete"), a `tailoringTargets` snapshot the Host's predicate could not accept (the bridge disconnected), and
 * on `round73` the settlement envelope (`chore`/`steps`/`folded`/`held_ms`) that made every world-changing action's
 * success unreadable. None was visible offline, because a runner drives the Mod directly and the Host's rule never runs.
 *
 * The corpus is the ARGUMENT, so it lives in the repo; the run artifacts are the source, so regenerating it is a tool
 * run rather than a hand edit. A run directory reaches this tool in one of two shapes, and both are the producer's own
 * text: the dialogue batch's `live.out.txt` (a runner's JSON result line, whose trace carries the structured `evidence`
 * object in the order the Mod emitted it) and the game ladder's `timeline.jsonl` (one `execution_receipt` row per
 * settlement, carrying `worldFactPayload.evidence.detail` verbatim).
 */
const ROOT = process.env.GAMEBUDDY_STARDEW_FIXTURE_ROOT ?? "D:/gb-fixture-lane/stardew-fixtures";
const BATCH = join(ROOT, "live-batch-dialogue");
const OUT = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "host",
  "src",
  "test-fixtures",
  "stardew-live-receipts.json",
);

/** `key=value;…` in the order the Mod wrote it: the wire detail back into the field set this corpus stores. */
function fieldsOf(detail) {
  const fields = {};
  for (const clause of detail.split(";")) {
    const separator = clause.indexOf("=");
    if (separator <= 0) continue;
    fields[clause.slice(0, separator)] = clause.slice(separator + 1);
  }
  return fields;
}

/** The dialogue batch's shape: one result line per dispatch, evidence on the trace or the result itself. */
function fromLiveOut(dir) {
  const file = join(dir, "live.out.txt");
  if (!existsSync(file)) return [];
  const entries = [];
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line.startsWith('{"state":"passed"')) continue;
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    const trace = Array.isArray(parsed.trace) ? parsed.trace : [];
    // The terminal receipt is the one a step recorded with a state and reason; the action that produced it is the
    // SAME step's action (the wia_* chains run several actions, so the first action string is not the one this
    // terminal belongs to). The evidence rides on the observation step that followed, OR on the result's top-level
    // `evidence` when no trace step carries it.
    const step = trace.find((s) => s.receipt && s.receipt.state === "succeeded");
    if (step === undefined) continue;
    const action = typeof step.action === "string" ? step.action : undefined;
    const receipt = step.receipt && step.receipt.state === "succeeded" ? step.receipt : undefined;
    const evidence =
      trace.map((s) => s.evidence).find((e) => e && typeof e === "object" && !Array.isArray(e)) ??
      (parsed.evidence && typeof parsed.evidence === "object" && !Array.isArray(parsed.evidence)
        ? parsed.evidence
        : undefined);
    if (typeof action !== "string" || receipt === undefined || evidence === undefined) continue;
    entries.push({
      fromRun: basename(dir),
      actionId: action,
      state: receipt.state,
      reasonCode: receipt.reasonCode,
      evidence,
    });
  }
  return entries;
}

/** The game ladder's shape: one settled receipt per `execution_receipt` row of the run's timeline. */
function fromTimeline(dir) {
  const file = join(dir, "timeline.jsonl");
  if (!existsSync(file)) return [];
  const entries = [];
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line.includes("execution_receipt")) continue;
    let row;
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }
    if (row.type !== "execution_receipt") continue;
    const payload = row.worldFactPayload;
    // Only a SUCCESS is a postcondition to compare: a refusal, a hold or an uncertain outcome is not evidence that
    // the action completed, and this corpus is the set of receipts the Host's rules must read.
    if (
      payload?.state !== "succeeded" ||
      typeof payload.actionId !== "string" ||
      typeof payload.evidence?.detail !== "string"
    )
      continue;
    entries.push({
      fromRun: basename(dir),
      actionId: payload.actionId,
      state: payload.state,
      reasonCode: payload.reasonCode,
      evidence: fieldsOf(payload.evidence.detail),
    });
  }
  return entries;
}

const runDirectories = [BATCH, ...process.argv.slice(2)];
const entries = [];
for (const dir of runDirectories) {
  if (!existsSync(dir)) {
    console.error("no run directory at " + dir + " - set GAMEBUDDY_STARDEW_FIXTURE_ROOT or pass one");
    process.exit(1);
  }
  // A batch directory holds one directory per scenario; a run directory IS one run.
  const scenarios =
    existsSync(join(dir, "live.out.txt")) || existsSync(join(dir, "timeline.jsonl"))
      ? [dir]
      : readdirSync(dir).map((name) => join(dir, name));
  for (const scenario of scenarios) entries.push(...fromLiveOut(scenario), ...fromTimeline(scenario));
}

if (entries.length === 0) {
  console.error("no terminal receipt found under " + runDirectories.join(", "));
  process.exit(1);
}

const unique = new Map(entries.map((e) => [e.actionId + "|" + e.reasonCode, e]));
const corpus = [...unique.values()].sort((a, b) => a.actionId.localeCompare(b.actionId));
writeFileSync(
  OUT,
  JSON.stringify(
    {
      note: "Terminal receipts recorded from real live runs. Regenerate with tools/record-stardew-live-receipts.mjs.",
      receipts: corpus,
    },
    null,
    2,
  ) + "\n",
);
console.log("recorded " + corpus.length + " terminal receipt(s) to " + OUT.split(/[\\/]/u).slice(-2).join("/"));
for (const e of corpus)
  console.log(
    "  " + e.actionId.padEnd(32) + e.reasonCode + "   (" + Object.keys(e.evidence).length + " evidence fields)",
  );
