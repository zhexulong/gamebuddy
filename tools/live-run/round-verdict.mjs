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
 * The rendered environment block, read from the run's own record.
 *
 * `<runtime-environment>` is produced by the Magic Context transform when a request is ASSEMBLED and is never
 * written to the session, which stores MESSAGES. Measured 2026-11-01 on round18 (24 minutes, 75 assembled plans):
 * `位置:` 0, `脚下` 0, `待浇水` 0 in the bound session, while `formatGameEnvironmentFacts` renders all three when
 * called directly. So a prompt-level criterion here had no file to read and reported UNOBSERVABLE by
 * construction - a fact about the instrument, not about the product.
 *
 * The file exists now: the registered provider records what it rendered, per request, in
 * `environment-facts.jsonl` beside the run manifest (`createRenderedEnvironmentFactsProvider`,
 * `host/src/runtime-core.internal.ts`), and the run's capture copies it into the run directory. One line reads
 * `{ at, revision, bytes, overCap, dropped?, text }`, so a reader can ask the four questions that were
 * unanswerable: did the block render on every request, what did the unwatered count say, did same-map
 * villagers arrive with tiles, and what did the byte cap drop.
 *
 * A run that PREDATES the record has no such file. That criterion is then NOT EXERCISED, and the detail says why
 * (the record did not exist when that run assembled its requests) rather than claiming the block never rendered.
 * It is deliberately NOT the old structural UNOBSERVABLE: nothing about these criteria is unreadable any more, and
 * every run from the one that introduced the record on can be answered.
 */
const ENVIRONMENT_FACTS_RECORD = "environment-facts.jsonl";

function findEnvironmentFactsRecord(runDir) {
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
      else if (entry === ENVIRONMENT_FACTS_RECORD) found.push({ path, mtime: stat.mtimeMs });
    }
  };
  walk(join(runDir, "runtime-root", "contexts"), 6);
  // A run can hold more than one activation (a disconnect/resume mounts a fresh surface session, and each one
  // keeps its own record). The file named here is the newest, so the verdict says WHICH record it read rather
  // than blending two activations' renders into one number.
  found.sort((left, right) => right.mtime - left.mtime);
  return found[0]?.path ?? null;
}

function readEnvironmentFactsRecord(runDir) {
  const path = findEnvironmentFactsRecord(runDir);
  if (path === null)
    return {
      path: null,
      renders: [],
      truncated: false,
      why: `this run has no ${ENVIRONMENT_FACTS_RECORD}: it predates the record, so nothing captured what the provider rendered`,
    };
  const renders = [];
  let truncated = false;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line.trim()) continue;
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    if (record?.truncated === true) {
      truncated = true;
      continue;
    }
    renders.push(record);
  }
  return { path, renders, truncated, why: null };
}

/** How much of the run the record actually covers - the sentence beside every prompt-level count. */
function renderCoverage(environmentFacts) {
  const renders = environmentFacts.renders.length;
  const blank = environmentFacts.renders.filter((record) => (record?.text ?? "").trim().length === 0).length;
  const dropped = environmentFacts.renders.filter(
    (record) => Array.isArray(record?.dropped) && record.dropped.length > 0,
  ).length;
  const overCap = environmentFacts.renders.filter((record) => record?.overCap === true).length;
  const parts = [`${renders} request(s) rendered`];
  if (blank > 0) parts.push(`${blank} with an empty block`);
  if (dropped > 0) parts.push(`${dropped} with facts dropped by the line's byte cap`);
  if (overCap > 0) parts.push(`${overCap} still over the byte cap after it ran`);
  if (environmentFacts.truncated) parts.push("tail truncated at the record's own cap");
  return parts.join(", ");
}

function unusedPromptEvidenceReadable(sessionText, contextSummary) {
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

// Everything the MODEL saw about the environment lives in the run's own record, not in the bound session: the block
// is delivered inside an assembled request and never persisted. Reading it from the Mod log answered "not exercised"
// from an absence that only meant "wrong file" - the same class of mistake this report exists to prevent.
const environmentFacts = readEnvironmentFactsRecord(runDir);
const renderedTexts = environmentFacts.renders.map((entry) => (typeof entry?.text === "string" ? entry.text : ""));
const environmentRecordSource = environmentFacts.path ?? `no ${ENVIRONMENT_FACTS_RECORD} in this run`;

// 2. The false zero: did the prompt ever print a non-zero unwatered count with a nearest tile?
// The FACT carries a colon and a count ("待浇水作物: 24", "unwatered crops: 24"). The conduct merely mentions the
// concept ("... and unwatered crops") - matching that word alone counted the system prompt 27 times and read it as a rendered
// fact, which is the fourth time in this loop that a counter measured a sentence about the thing instead of the thing.
// The count is read from the RECORD, so it is measured over what was rendered rather than over what survived a fold.
const unwateredFacts = renderedTexts.filter((text) => /待浇水作物: \d|unwatered crops: \d/.test(text));
const unwateredNonZero = unwateredFacts.filter((text) => /待浇水作物: [1-9]|unwatered crops: [1-9]/.test(text));
record(
  "2 unwatered false zero",
  unwateredNonZero.length > 0
    ? "PASS"
    : environmentFacts.path === null
      ? "NOT EXERCISED"
      : unwateredFacts.length === 0
        ? "NOT EXERCISED"
        : "FAIL",
  environmentFacts.path === null
    ? `cannot answer from this run: ${environmentFacts.why} (not a claim that the block never rendered)`
    : unwateredFacts.length === 0
      ? `no unwatered fact reached the model (${renderCoverage(environmentFacts)})`
      : `${unwateredNonZero.length} non-zero of ${unwateredFacts.length} rendered (${renderCoverage(environmentFacts)})`,
  environmentRecordSource,
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

// 5. Same-map villager coordinates in the rendered prompt. Same record, same reason: `本图可去: Shane(72,18)` exists
// only inside a request. A villager fact that arrived as a bare count ("另有 12 人") is a rendered fact with no tile,
// so it stays FAIL rather than being read as a pass from the word "map".
const villagerFacts = renderedTexts.filter((text) => /on this map:|本图可去|本图村民|另有 \d+ 人/.test(text));
const withCoords = villagerFacts.filter((text) => /\(\d+,\d+\)/.test(text));
record(
  "5 villager coordinates",
  withCoords.length > 0
    ? "PASS"
    : environmentFacts.path === null
      ? "NOT EXERCISED"
      : villagerFacts.length === 0
        ? "NOT EXERCISED"
        : "FAIL",
  environmentFacts.path === null
    ? `cannot answer from this run: ${environmentFacts.why} (not a claim that no villager was on her map)`
    : `${withCoords.length} with coordinates of ${villagerFacts.length} rendered (${renderCoverage(environmentFacts)})`,
  environmentRecordSource,
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
