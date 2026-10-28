/**
 * What round 3 has to show, in one pass over the artifacts.
 *
 * Written before the run finished so that the questions are fixed in advance. A criterion chosen after looking
 * at the data is not a criterion.
 *
 * Usage: node tools/live-run/round3-verdict.mjs [runDir]
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const root = process.argv[2] ?? ".live-runs/game-ladder";
const newest = readdirSync(root)
  .filter((name) => name.includes("multiday_routine"))
  .map((name) => ({ name, mtime: statSync(join(root, name)).mtimeMs }))
  .sort((a, b) => b.mtime - a.mtime)[0];

if (newest === undefined) {
  console.log("no multiday run found");
  process.exit(1);
}

const dir = join(root, newest.name);
const read = (file) => {
  try {
    return readFileSync(join(dir, file), "utf8");
  } catch {
    return "";
  }
};

const count = (text, pattern) => (text.match(pattern) ?? []).length;

// 1. The latch: a cutscene must not close the launcher for the rest of the run.
const sessionRoot =
  "C:/Users/long/AppData/Local/GameBuddy/contexts/28b640f414390b353dc283a041897d95d405cfd106804b756969e312e00a23b9/surface-sessions";
let portsNotLive = 0;
let invalidatedFacts = 0;
let inputMax = 0;
let lengthStops = 0;
try {
  const session = readdirSync(sessionRoot)
    .filter((name) => name.startsWith("game-"))
    .sort()
    .at(-1);
  const jsonl = join(sessionRoot, session, "sessions");
  const file = readdirSync(jsonl)
    .filter((name) => name.endsWith(".jsonl"))
    .sort()
    .at(-1);
  const raw = readFileSync(join(jsonl, file), "utf8");
  portsNotLive = count(raw, /stardew_launcher_ports_not_live/g);
  lengthStops = count(raw, /"stopReason":"length"/g);
  for (const line of raw.split("\n")) {
    if (!line.includes('"usage"')) continue;
    const value = /"input":(\d+)/.exec(line);
    if (value !== null) inputMax = Math.max(inputMax, Number(value[1]));
  }
} catch (error) {
  console.log(`session unreadable: ${String(error instanceof Error ? error.message : error)}`);
}

const modLog = read("mod-log.txt");
invalidatedFacts = count(modLog, /state=invalidated/g);
const nodeNotEligible = count(modLog, /NodeNotEligible/g);

// 2. Crossings, the acceptance this whole sequence exists for.
let crossings = null;
let violations = [];
try {
  const result = JSON.parse(read("result.json"));
  crossings = result?.multiday?.crossings ?? null;
  violations = (result?.multiday?.assessment?.violations ?? []).map((entry) => entry.code);
} catch {
  violations = ["result.json unreadable"];
}

const rows = [
  ["ports_not_live", portsNotLive, "0 - the latch is the thing this run tests"],
  ["invalidated receipts", invalidatedFacts, ">0 proves a cutscene or modal DID interrupt something"],
  ["NodeNotEligible", nodeNotEligible, "1 per program - 3e0af0d9 says it once per change"],
  ["inputMax tokens", inputMax, "<40000 - fa90f147 + bbdcbb2a hold"],
  ["stopReason length", lengthStops, "0"],
  ["crossings", crossings ?? "n/a", ">=2 is the acceptance"],
  ["violations", violations.length === 0 ? "none" : violations.join(", "), ""],
];

console.log(`run: ${newest.name}\n`);
for (const [name, value, expect] of rows) {
  console.log(`  ${String(name).padEnd(22)} ${String(value).padEnd(28)} ${expect}`);
}
console.log("");

// The verdict is stated as three separate questions, because a single pass/fail would hide which one failed.
const latchHeld = invalidatedFacts > 0 && portsNotLive === 0;
const contextHeld = inputMax < 40_000 && lengthStops === 0;
const crossed = typeof crossings === "number" && crossings >= 2;

console.log(
  `latch     ${latchHeld ? "HELD" : invalidatedFacts === 0 ? "NOT EXERCISED (no invalidated receipt)" : "BROKEN"}`,
);
console.log(`context   ${contextHeld ? "HELD" : "REGRESSED"}`);
console.log(`crossings ${crossed ? "PASSED" : "NOT REACHED"}`);
