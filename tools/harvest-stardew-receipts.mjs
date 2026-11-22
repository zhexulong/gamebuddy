#!/usr/bin/env node
/**
 * Gate input: harvest the terminal receipts the Mod ACTUALLY minted, out of the live runs, into a committed corpus.
 *
 * WHY THIS EXISTS. The Host's completion contracts are the consumer of a receipt shape the Mod produces, and until now
 * both sides were checked against HAND-WRITTEN fixtures. So when the Mod published one more field, the Mod's tests were
 * green, the Host's tests were green, and only a 35-minute live run reddened - four times, for four different actions
 * (`remove_placed_item` on round92; `pickup_forage`, `place_owned_object`, `move_placed_furniture` and
 * `rotate_furniture` on round93). A fixture written by the same hand as the rule cannot see that.
 *
 * WHAT IT WRITES, AND WHERE. `host/src/test-fixtures/stardew-receipts/corpus.json`:
 *   - `receipts`: one entry per distinct (action, terminal, FIELD SET) the runs produced, in the Mod's own field order,
 *     carrying the run it came from - so a failure names the receipt and the field rather than a count;
 *   - `runs`: the run directories harvested, with how many successes each contributed;
 *   - `modSourceDigest`: the Mod code the harvest describes (comments stripped), which the Host test re-derives and
 *     compares - a corpus that stops being regenerated fails there instead of silently reading an older producer.
 *
 * SELECTION IS THE NEWEST RUN OF EACH SCENARIO. A receipt corpus must describe the producer that exists NOW: an older
 * run's shape that the Mod has since stopped minting is not a shape the Host has to read. The scenario is the run
 * directory's trailing name (`2026-11-22T13-10-47-678Z-multiday_routine` -> `multiday_routine`), and the newest
 * timestamp wins. Passing directories on the command line overrides that and harvests exactly those (plus the dialogue
 * batch, when it is mounted).
 *
 * The reading of a run is `tools/record-stardew-live-receipts.mjs`'s own: `timeline.jsonl`'s `execution_receipt` rows
 * for the game ladder, and `live.out.txt`'s result lines for the dialogue batch. This tool writes the corpus; that one
 * writes the per-terminal fixture the receipt-parity test reads, so both ends of the wire are read by one reader.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { modSourceDigest, RECEIPT_CORPUS_SCHEMA } from "../host/dist-test/stardew-receipt-corpus.js";
import { fromLiveOut, fromTimeline } from "./record-stardew-live-receipts.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const BATCH = join(
  process.env.GAMEBUDDY_STARDEW_FIXTURE_ROOT ?? "D:/gb-fixture-lane/stardew-fixtures",
  "live-batch-dialogue",
);
const LADDER = join(ROOT, ".live-runs", "game-ladder");
const CORPUS = join(ROOT, "host", "src", "test-fixtures", "stardew-receipts", "corpus.json");

/**
 * The newest run overall: the producer generation that exists NOW.
 *
 * NOT ONE RUN PER SCENARIO, because a scenario nobody has run for a month was produced by a month-old Mod: harvesting
 * `morning_routine`'s October shapes beside `multiday_routine`'s November ones puts two different producers in one
 * corpus, and every receipt the current Host refuses then looks like a contract defect instead of an artifact of age.
 * One generation per corpus, and regenerating it is what moving to the next generation costs.
 */
function newestRun() {
  if (!existsSync(LADDER)) return [];
  const runs = readdirSync(LADDER)
    .filter((name) => existsSync(join(LADDER, name, "timeline.jsonl")))
    .sort();
  const newest = runs.at(-1);
  return newest === undefined ? [] : [join(LADDER, newest)];
}

/** The `.cs` sources at the Mod root, by path, for the staleness digest. */
function modSources() {
  const directory = join(ROOT, "integrations", "stardew");
  return readdirSync(directory)
    .filter((name) => name.endsWith(".cs"))
    .map((name) => ({ path: `integrations/stardew/${name}`, source: readFileSync(join(directory, name), "utf8") }));
}

const requested = process.argv.slice(2);
const runDirectories = requested.length > 0 ? requested : newestRun();
if (existsSync(BATCH)) runDirectories.unshift(BATCH);
if (runDirectories.length === 0) {
  console.error(
    `no run directory to harvest: ${LADDER} holds no timeline.jsonl, and no directory was passed on the command line`,
  );
  process.exit(1);
}

/** A batch directory holds one directory per scenario; a run directory IS one run. */
const scenariosOf = (directory) =>
  existsSync(join(directory, "live.out.txt")) || existsSync(join(directory, "timeline.jsonl"))
    ? [directory]
    : readdirSync(directory)
        .sort()
        .map((name) => join(directory, name));

const runs = [];
const harvested = [];
for (const directory of runDirectories) {
  if (!existsSync(directory)) {
    console.error("no run directory at " + directory + " - pass one, or set GAMEBUDDY_STARDEW_FIXTURE_ROOT");
    process.exit(1);
  }
  for (const scenario of scenariosOf(directory)) {
    const entries = [...fromLiveOut(scenario), ...fromTimeline(scenario)];
    const successes = entries.filter((entry) => entry.state === "succeeded");
    if (successes.length === 0) continue;
    runs.push({ run: basename(scenario), receipts: successes.length });
    for (const entry of successes)
      harvested.push({
        run: basename(scenario),
        actionId: entry.actionId,
        state: entry.state,
        reasonCode: entry.reasonCode,
        evidence: entry.evidence,
      });
  }
}

if (harvested.length === 0) {
  console.error("no succeeded receipt found under " + runDirectories.join(", "));
  process.exit(1);
}

// ONE ENTRY PER DISTINCT SHAPE, and the shape is the FIELD SET: two runs that publish the same terminal over the same
// fields are one fact about the producer, while a field added on one side is a different entry - which is the drift this
// corpus exists to make visible.
const shapes = new Map();
for (const entry of harvested) {
  const shape = `${entry.actionId}|${entry.reasonCode}|${Object.keys(entry.evidence).join(",")}`;
  if (shapes.has(shape)) continue;
  shapes.set(shape, {
    run: entry.run,
    actionId: entry.actionId,
    state: entry.state,
    reasonCode: entry.reasonCode,
    evidence: entry.evidence,
  });
}

mkdirSync(dirname(CORPUS), { recursive: true });
const corpus = {
  schema: RECEIPT_CORPUS_SCHEMA,
  generator: "tools/harvest-stardew-receipts.mjs",
  modSourceDigest: modSourceDigest(modSources()),
  runs,
  receipts: [...shapes.values()].sort(
    (left, right) =>
      left.actionId.localeCompare(right.actionId) ||
      left.reasonCode.localeCompare(right.reasonCode) ||
      Object.keys(left.evidence).join(",").localeCompare(Object.keys(right.evidence).join(",")),
  ),
};
writeFileSync(CORPUS, `${JSON.stringify(corpus, null, 2)}\n`);
console.log(
  `harvested ${corpus.receipts.length} receipt shape(s) from ${runs.length} run(s) into ${CORPUS.slice(ROOT.length + 1)}`,
);
for (const run of runs) console.log(`  ${run.run}: ${run.receipts} succeeded receipt(s)`);
