/**
 * What a multiday run has to show, in one pass over its artifacts.
 *
 * Written before the run finished so the questions are fixed in advance: a criterion chosen after looking at the
 * data is not a criterion.
 *
 * TWO FILE-SCOPE RULES, both learned by getting them wrong:
 *
 *  - The MOD LOG is the record. The SMAPI log is a rolling window that keeps only recent lines, so counting a
 *    receipt there and comparing it against a full mod-log count compares two different things. Earlier in this
 *    session that produced a confident, wrong "NodeNotEligible 151 -> 2" while the record said 314.
 *  - Counters read ONE file each, and say which.
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

// The full runtime log for this run. Every mod-side counter below reads THIS.
const modLog = read("mod-log.txt");

// 1. The latch: a cutscene must not close the launcher for the rest of the run.
const invalidatedFacts = count(modLog, /state=Invalidated|state=invalidated/g);
const portsNotLive = count(modLog, /stardew_launcher_ports_not_live/g);
// 2. The waiting line, per program rather than per frame (6e69b478).
const nodeNotEligible = count(modLog, /NodeNotEligible/g);
const distinctWaitingPrograms = new Set(
  [...modLog.matchAll(/challenge_not_created;program=(plan_\d+)/g)].map((match) => match[1]),
).size;

// 3. Is the repeated line bounded by programs or by frames? That is the whole question 6e69b478 answers.
const waitingLinesPerProgram = distinctWaitingPrograms === 0 ? null : nodeNotEligible / distinctWaitingPrograms;

// 4. Context pressure, from the session rather than the mod log - it is the only place input tokens are recorded.
let inputMax = null;
let lengthStops = 0;
try {
  const sessionRoot =
    "C:/Users/long/AppData/Local/GameBuddy/contexts/28b640f414390b353dc283a041897d95d405cfd106804b756969e312e00a23b9/surface-sessions";
  const session = readdirSync(sessionRoot)
    .filter((name) => name.startsWith("game-"))
    .sort()
    .at(-1);
  const sessions = join(sessionRoot, session, "sessions");
  const file = readdirSync(sessions)
    .filter((name) => name.endsWith(".jsonl"))
    .sort()
    .at(-1);
  const raw = readFileSync(join(sessions, file), "utf8");
  lengthStops = count(raw, /"stopReason":"length"/g);
  inputMax = 0;
  for (const match of raw.matchAll(/"input":(\d+)/g)) inputMax = Math.max(inputMax, Number(match[1]));
} catch (error) {
  console.log(`session unreadable: ${String(error instanceof Error ? error.message : error)}`);
}

// 5. The acceptance this whole sequence exists for.
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
  ["invalidated receipts", invalidatedFacts, ">0 means a cutscene DID interrupt something - else NOT EXERCISED"],
  ["ports_not_live", portsNotLive, "0 while invalidated > 0 is what f84b0d8b claims"],
  ["NodeNotEligible lines", nodeNotEligible, "bounded by programs, not frames (6e69b478)"],
  ["distinct waiting progs", distinctWaitingPrograms, ""],
  ["waiting lines/program", waitingLinesPerProgram ?? "n/a", "1 means one line per program; 120 means per frame"],
  ["inputMax tokens", inputMax ?? "unreadable", "<40000 for the batch work to be doing its job"],
  ["stopReason length", lengthStops, "0"],
  ["crossings", crossings ?? "n/a", ">=2 is the acceptance"],
  ["violations", violations.length === 0 ? "none" : violations.join(", "), ""],
];

console.log(`run: ${newest.name}\n`);
for (const [name, value, expect] of rows) {
  console.log(`  ${String(name).padEnd(24)} ${String(value).padEnd(26)} ${expect}`);
}
console.log("");

// Three separate verdicts, because they fail for different reasons and one word would hide which.
const latchHeld = invalidatedFacts > 0 && portsNotLive === 0;
const contextJudged = typeof inputMax === "number" && inputMax > 0;
const contextHeld = contextJudged && inputMax < 40_000 && lengthStops === 0;
const crossed = typeof crossings === "number" && crossings >= 2;
const waitingBounded = waitingLinesPerProgram !== null && waitingLinesPerProgram <= 3;

console.log(
  `latch     ${latchHeld ? "HELD" : invalidatedFacts === 0 ? "NOT EXERCISED (no invalidated receipt)" : "BROKEN"}`,
);
console.log(`waiting   ${waitingBounded ? "BOUNDED" : "PER-FRAME"}`);
console.log(`context   ${contextJudged ? (contextHeld ? "HELD" : "REGRESSED") : "UNREADABLE"}`);
console.log(`crossings ${crossed ? "PASSED" : "NOT REACHED"}`);
