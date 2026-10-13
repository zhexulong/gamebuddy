import { readdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

/**
 * Record the terminal receipt each live run actually produced, so a test can run the HOST's completion rule against the
 * MOD's real output.
 *
 * WHY THIS EXISTS: the two sides of that contract are written separately, and a field added on one side has silently
 * broken live gates at least three times - a `leftover_returned` the Host did not list (a successful retrieval was then
 * never "complete"), and a `tailoringTargets` snapshot the Host's predicate could not accept (the bridge disconnected).
 * Neither was visible offline, because a runner drives the Mod directly and the Host's rule never runs.
 *
 * The corpus is the ARGUMENT, so it lives in the repo; the run artifacts are the source, so regenerating it is a tool
 * run rather than a hand edit. The structured `evidence` object a runner prints IS the Mod's own field set, in the
 * order the Mod emitted it.
 */
const ROOT = process.env.GAMEBUDDY_STARDEW_FIXTURE_ROOT ?? "D:/gb-fixture-lane/stardew-fixtures";
const RUNS = join(ROOT, "live-batch-dialogue");
const OUT = "E:/projects/ai-game-companion/host/src/test-fixtures/stardew-live-receipts.json";

if (!existsSync(RUNS)) {
  console.error("no run directory at " + RUNS + " - set GAMEBUDDY_STARDEW_FIXTURE_ROOT");
  process.exit(1);
}

const entries = [];
for (const dir of readdirSync(RUNS)) {
  const file = join(RUNS, dir, "live.out.txt");
  if (!existsSync(file)) continue;
  const text = readFileSync(file, "utf8");

  for (const line of text.split("\n")) {
    if (!line.startsWith('{"state":"passed"')) continue;
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    const trace = Array.isArray(parsed.trace) ? parsed.trace : [];
    // The terminal receipt is the one a step recorded with a state and reason; the evidence rides on the observation
    // step that followed it.
    const action = trace.map((s) => s.action).find((a) => typeof a === "string");
    const receipt = trace.map((s) => s.receipt).find((r) => r && r.state === "succeeded");
    const evidence = trace.map((s) => s.evidence).find((e) => e && typeof e === "object" && !Array.isArray(e));
    if (typeof action !== "string" || receipt === undefined || evidence === undefined) continue;
    entries.push({
      actionId: action,
      state: receipt.state,
      reasonCode: receipt.reasonCode,
      evidence,
    });
  }
}

const unique = new Map(entries.map((e) => [e.actionId + "|" + e.reasonCode, e]));
const corpus = [...unique.values()].sort((a, b) => a.actionId.localeCompare(b.actionId));
writeFileSync(OUT, JSON.stringify({ note: "Terminal receipts recorded from real live runs. Regenerate with tools/record-stardew-live-receipts.mjs.", receipts: corpus }, null, 2) + "\n");
console.log("recorded " + corpus.length + " terminal receipt(s) to " + OUT.split("/").slice(-2).join("/"));
for (const e of corpus) console.log("  " + e.actionId.padEnd(32) + e.reasonCode + "   (" + Object.keys(e.evidence).length + " evidence fields)");