/**
 * The verdict for one ladder run, with every number's source named.
 *
 * <p>
 * Written before the run finished, so the criteria could not be read off the result. Each row prints PASS / FAIL /
 * NOT EXERCISED, and NOT EXERCISED is a real answer: a criterion whose precondition never happened in this run cannot be
 * supported by it, and calling that a pass is how a broken instrument gets read as a healthy product.
 * </p>
 *
 * <p>
 * Every counter reads ONE file and says which. Mixing a harness field with a session field is how two true numbers became
 * one false claim earlier in this loop.
 * </p>
 *
 * Usage: node tools/live-run/round-verdict.mjs [run-dir]
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

const LADDER = ".live-runs/game-ladder";

function newestRun() {
  const root = resolve(LADDER);
  if (!existsSync(root)) return null;
  const runs = readdirSync(root)
    .map((name) => ({ path: join(root, name), mtime: statSync(join(root, name)).mtimeMs }))
    .sort((left, right) => right.mtime - left.mtime);
  return runs[0]?.path ?? null;
}

/** The session file the harness bound to this run, from its own `toolTiming.record`. */
function sessionPath(runDir) {
  const resultPath = join(runDir, "result.json");
  if (!existsSync(resultPath)) return null;
  const record = JSON.parse(readFileSync(resultPath, "utf8")).toolTiming?.record;
  if (typeof record !== "string") return null;
  const found = [];
  const walk = (directory, depth) => {
    if (depth < 0) return;
    let entries;
    try {
      entries = readdirSync(directory);
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = join(directory, entry);
      let stat;
      try {
        stat = statSync(path);
      } catch {
        continue;
      }
      if (stat.isDirectory()) walk(path, depth - 1);
      else if (entry === record) found.push(path);
    }
  };
  walk(join(runDir, "runtime-root", "contexts"), 6);
  return found[0] ?? null;
}

/**
 * Whether the prompt the model received is still readable.
 *
 * <p>
 * Magic Context folds old fact batches, so a run's per-turn `<runtime-environment>` block survives only until it is folded -
 * measured 2026-11-01: one `gamebuddy_fact_batch` left in a 285-turn session. A prompt-level criterion answering "no" from
 * that absence would be answering from the fold, not from the run.
 * </p>
 */
function promptEvidenceReadable(sessionText, contextSummary) {
  if (sessionText.length === 0) return { readable: false, why: "no session found" };
  const batches = sessionText.split("gamebuddy_fact_batch").length - 1;
  if (batches === 0) return { readable: false, why: "no fact batch survives in the session" };
  const dropped = contextSummary?.droppedTokens ?? 0;
  if (dropped > 0)
    return {
      readable: false,
      why: `${batches} batch(es) survive but ${dropped} tokens were folded away, so earlier turns' facts are gone`,
    };
  return { readable: true, why: `${batches} batch(es), nothing folded` };
}

const rows = [];
const record = (name, verdict, detail, source) => rows.push({ name, verdict, detail, source });

const runDir = process.argv[2] === undefined ? newestRun() : resolve(process.argv[2]);
if (runDir === null || !existsSync(runDir)) {
  process.stderr.write("no run directory\n");
  process.exit(2);
}

const resultPath = join(runDir, "result.json");
const result = existsSync(resultPath) ? JSON.parse(readFileSync(resultPath, "utf8")) : {};
const smapiPath = join(process.env.APPDATA ?? "", "StardewValley", "ErrorLogs", "SMAPI-latest.txt");
const modLogPath = join(runDir, "mod-log.txt");
const boundSession = sessionPath(runDir);

// 1. Contract errors: the run is worthless as evidence if these are non-zero. SMAPI log only.
const modLog = existsSync(modLogPath)
  ? readFileSync(modLogPath, "utf8")
  : existsSync(smapiPath)
    ? readFileSync(smapiPath, "utf8")
    : "";
const contractErrors = ["invalid_snapshot", "invalid_args", "invalid_observe_scene_result"].map((code) => ({
  code,
  count: modLog.split(code).length - 1,
}));
const contractTotal = contractErrors.reduce((total, entry) => total + entry.count, 0);
record(
  "1 contract errors",
  contractTotal === 0 ? "PASS" : "FAIL",
  contractErrors.map((entry) => `${entry.code}=${entry.count}`).join(" "),
  modLogPath + " (or SMAPI-latest.txt)",
);

// Everything the MODEL saw lives in the bound session, not in mod-log.txt: the environment fact line is delivered as a
// user message each turn. Reading the prompt from the Mod log answered "not exercised" from an absence that only meant
// "wrong file" - which is the same class of mistake this report exists to prevent.
const sessionText = boundSession === null ? "" : readFileSync(boundSession, "utf8");
const promptEvidence = promptEvidenceReadable(sessionText, result.contextSummary ?? result.multiday?.contextSummary);

// 2. The false zero: did the prompt ever print a non-zero unwatered count with a nearest tile?
const unwateredLines = sessionText.split("\\n").filter((line) => /unwatered|待浇水/.test(line));
const unwateredNonZero = unwateredLines.filter((line) => /待浇水作物: [1-9]|unwatered crops: [1-9]/.test(line));
record(
  "2 unwatered false zero",
  unwateredNonZero.length > 0
    ? "PASS"
    : unwateredLines.length === 0
      ? promptEvidence.readable
        ? "NOT EXERCISED"
        : "UNOBSERVABLE"
      : "FAIL",
  unwateredLines.length === 0
    ? promptEvidence.readable
      ? "no unwatered fact reached the model at all"
      : `cannot tell: ${promptEvidence.why}`
    : `${unwateredNonZero.length} non-zero of ${unwateredLines.length} rendered`,
  boundSession ?? "no session",
);

// 3. Tool choice: plan_work vs submit_action_program, from the session's own tool calls.
let planWork = 0;
let submitProgram = 0;
if (boundSession !== null)
  for (const line of readFileSync(boundSession, "utf8").split("\n")) {
    if (!line.trim()) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    for (const part of entry.message?.content ?? []) {
      if (part.type !== "toolCall") continue;
      if (part.name === "stardew_plan_work") planWork += 1;
      if (part.name === "stardew_submit_action_program") submitProgram += 1;
    }
  }
record(
  "3 submit_action_program share",
  boundSession === null
    ? "NOT EXERCISED"
    : submitProgram === 0
      ? "PASS"
      : submitProgram / (planWork + submitProgram) < 0.16
        ? "PASS (reduced)"
        : "FAIL",
  `plan_work=${planWork} submit=${submitProgram}`,
  boundSession ?? "no session",
);

// 4. Night attribution, from the harness's own assessment.
const assessment = result.multiday?.assessment ?? result.assessment ?? null;
const dayRecords = result.multiday?.dayRecords ?? result.dayRecords ?? [];
const nightsNull = dayRecords.filter((day) => day?.night === null || day?.night === undefined).length;
record(
  "4 night mechanism",
  assessment === null
    ? "NOT EXERCISED"
    : nightsNull === 0 || (assessment.unobservedNights ?? 0) === 0
      ? "PASS"
      : "FAIL",
  assessment === null
    ? "no assessment in result.json"
    : `crossed=${assessment.daysCrossed} passOut=${assessment.passOutNights} unobserved=${assessment.unobservedNights ?? "n/a"} nightsNull=${nightsNull}`,
  resultPath,
);

// 5. Same-map villager coordinates in the rendered prompt.
const villagerLines = sessionText.split("\\n").filter((line) => /on this map:|本图村民|另有 \d+ 人/.test(line));
const withCoords = villagerLines.filter((line) => /\(\d+,\d+\)/.test(line));
record(
  "5 villager coordinates",
  withCoords.length > 0
    ? "PASS"
    : villagerLines.length === 0
      ? promptEvidence.readable
        ? "NOT EXERCISED"
        : "UNOBSERVABLE"
      : "FAIL",
  `${withCoords.length} with coordinates of ${villagerLines.length} rendered`,
  boundSession ?? "no session",
);

// 6. pickup_forage, which needs the scene binding to be constructible.
const forageCalls = modLog.split("pickup_forage").length - 1;
const forageSucceeded = modLog.split("forage_picked_up").length - 1;
record(
  "6 pickup_forage",
  forageCalls === 0 ? "NOT EXERCISED" : forageSucceeded > 0 ? "PASS" : "FAIL",
  `attempts≈${forageCalls} succeeded=${forageSucceeded}`,
  modLogPath,
);

const width = Math.max(...rows.map((row) => row.name.length));
process.stdout.write(`run   ${runDir}\n`);
process.stdout.write(`state ${result.state ?? "?"}  verdict ${result.sessionVerdict ?? "?"}\n\n`);
for (const row of rows)
  process.stdout.write(`${row.name.padEnd(width)}  ${row.verdict.padEnd(14)} ${row.detail}\n    <- ${row.source}\n`);
