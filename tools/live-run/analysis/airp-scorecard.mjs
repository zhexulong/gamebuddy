#!/usr/bin/env node
// The AIRP scorecard: what a run demonstrates about living with the companion, not just whether actions landed.
//
// WHY THIS EXISTS. We kept answering "does AIRP work?" with `124/124 actions succeeded` - a number that is orthogonal
// to every question a player actually asks, and whose best run was also our narrowest (15 of ~23 addressable actions)
// and our most silent (709 s before the first visible thing). The research note beside this script
// (.tmp/airp-evaluation-rubric.md) says what to measure instead; this prints it.
//
// HONESTY RULE. Every metric is either computed from an artifact or printed as `not_measured: <reason>`. A number the
// harness cannot support is not estimated here. Autonomy is NOT a defect: Amber is the player's childhood friend, so
// deciding on her own is in character. What is measured is whether her initiative was LEGIBLE (she said what she was
// doing and why) and whether she was REDIRECTABLE (pushback changed the next plan).
//
// BEFORE THE RUN ENDS THERE IS NO BUNDLE. A run publishes `result.json` at its END, so the version of this scorecard that
// read only that file printed `not_measured:no_bundle` for every run still in flight - which is the moment a scorecard is
// worth reading, because a run that goes narrow looks exactly like a run that is working. Measured 2026-11-19: `round78`
// was stopped eleven minutes in and its ten action families and seventy-four executions, all of them in the runner's own
// log, reached no reading at all. So each metric below says WHICH FILE it was read from (`result.json` or
// `live-runner.log`), a reading taken before the bundle exists is marked partial, and the ledger at the end counts the
// readings whose source nobody named - which is what makes a number readable on a run that has not ended.
//
// Usage: node tools/live-run/analysis/airp-scorecard.mjs [runDir] [--log <live-runner.log>] [--log-dir <dir>]
//
// WHAT THE DAY ASKED FOR. Measured 2026-11-19 (`round79`): her day-one task was `furnish_and_arrange` and the scorecard read
// the run by the farm counts it did not have, so a day spent on exactly its task read as a day that did almost nothing. The
// day's task is now printed before the counts (from the bundle's `taskPurposes`, or from the run's session record when the
// run never published a bundle), each day prints `attempted X of N` beside `succeeded S of E executions`, and
// `a_reading_of_productivity_names_the_day_it_judged` fails naming any row that scores her work and names no day.

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

import {
  actionExecutions,
  actionStates,
  attemptedActions,
  describeRunnerLog,
  locateRunnerLog,
  programmeNodes,
  readRunnerLog,
} from "../../lib/live-runner-log.mjs";
import { createReadingLedger, FROM_RESULT, FROM_RUNNER_LOG } from "../../lib/reading-source.mjs";
// What the day ASKED for, from the tool that owns that reading: a scorecard that counts her executions and never says
// which day's work they answer is how "she did almost nothing" gets printed over a day spent on exactly its task.
import {
  dayTaskAnchor,
  executionsByDay,
  formatDayTasks,
  productivityGate,
  readDayTasks,
  settlementsByAction,
} from "./action-breadth.mjs";

const RUNS_ROOT = ".live-runs/game-ladder";

function latestRun() {
  const dirs = readdirSync(RUNS_ROOT, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  return dirs.length === 0 ? null : join(RUNS_ROOT, dirs[dirs.length - 1]);
}

function readJsonFiles(runDir, name) {
  const candidates = [join(runDir, name)];
  for (const entry of readdirSync(runDir, { withFileTypes: true })) {
    if (entry.isDirectory()) candidates.push(join(runDir, entry.name, name));
  }
  return candidates.filter((path) => existsSync(path));
}

function findSessionFiles(runDir, result) {
  const found = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "node_modules") continue;
        walk(full);
      } else if (entry.name.endsWith(".jsonl") && full.replaceAll("\\", "/").includes("surface-sessions")) {
        found.push(full);
      }
    }
  };
  walk(runDir);
  // A run's runtime-root can carry sessions from earlier runs. Keep the ones that overlap this run's window; when the
  // bundle has no window, keep all of them rather than guessing which one is the run's.
  const started = result?.startedAtMs ?? null;
  const ended = result?.endedAtMs ?? null;
  if (started === null || ended === null) return found.sort();
  return found
    .filter((path) => {
      const modified = statSync(path).mtimeMs;
      return modified >= started - 60_000 && modified <= ended + 60_000;
    })
    .sort();
}

function parseSessionLines(files) {
  const records = [];
  const seen = new Set();
  for (const path of files) {
    for (const line of readFileSync(path, "utf8").split("\n")) {
      const trimmed = line.trim();
      if (trimmed.length === 0) continue;
      if (seen.has(trimmed)) continue;
      seen.add(trimmed);
      try {
        records.push(JSON.parse(trimmed));
      } catch {
        // A truncated tail line is not a record; skip it rather than guess.
      }
    }
  }
  return records;
}

function readSessions(runDir, result) {
  return parseSessionLines(findSessionFiles(runDir, result));
}

/**
 * The one session record THIS run wrote, bound by the name the run itself published.
 *
 * `result.toolTiming.record` is the file the runner read its turns from, so a reading taken from any other file is a
 * reading of a neighbour's run - the defect `agent-session-record.mjs` names above `findRunSessionJsonl`. A run that
 * publishes no record name, or whose name is not under its own directory, answers WHY instead of borrowing one.
 */
function boundSessionFiles(runDir, result) {
  const files = findSessionFiles(runDir, result);
  const record = typeof result?.toolTiming?.record === "string" ? result.toolTiming.record : null;
  if (record === null) return { files: [], reason: "not_measured:the bundle names no session record" };
  const own = files.filter((path) => (path.split(/[\\/]/u).pop() ?? "") === record);
  if (own.length === 0) return { files: [], reason: `not_measured:${record} is not under this run` };
  return { files: own, reason: null };
}

function toolCalls(records) {
  const calls = [];
  for (const record of records) {
    const message = record?.message ?? record;
    if (message?.role !== "assistant") continue;
    const parts = Array.isArray(message.content) ? message.content : [];
    for (const part of parts) {
      if (part?.type === "toolCall" || part?.type === "tool_use") {
        calls.push({
          name: part.name ?? part.toolName ?? "unknown",
          args: part.arguments ?? part.input ?? {},
          at: record.timestamp ? Date.parse(record.timestamp) : null,
        });
      }
    }
  }
  return calls;
}

function firstAssistantTextAt(records) {
  for (const record of records) {
    const message = record?.message ?? record;
    if (message?.role !== "assistant") continue;
    const parts = Array.isArray(message.content) ? message.content : [];
    const text = parts
      .filter((part) => part?.type === "text" && typeof part.text === "string")
      .map((part) => part.text)
      .join("")
      .trim();
    if (text.length > 0 && record.timestamp) return Date.parse(record.timestamp);
  }
  return null;
}

function playerInputs(records) {
  const inputs = [];
  for (const record of records) {
    const message = record?.message ?? record;
    if (message?.role !== "user") continue;
    const parts = Array.isArray(message.content) ? message.content : [];
    const text = parts
      .filter((part) => typeof part === "string" || part?.type === "text")
      .map((part) => (typeof part === "string" ? part : part.text))
      .join("")
      .trim();
    if (text.length === 0) continue;
    if (text.includes("gamebuddy_fact_batch")) continue;
    inputs.push({ text, at: record.timestamp ? Date.parse(record.timestamp) : null });
  }
  return inputs;
}

/**
 * Every turn opening in a session record, in order: one per user message.
 *
 * A user message IS a turn opening - the prompt the Host delivered, whether the day loop issued it or the fact pump did -
 * which makes the record the only authority for "when was she last woken" that spans both layers.
 */
function turnOpenings(records) {
  const times = [];
  for (const record of records) {
    const message = record?.message ?? record;
    if (message?.role !== "user") continue;
    const at = record.timestamp ? Date.parse(record.timestamp) : Number.NaN;
    if (Number.isFinite(at)) times.push(at);
  }
  return times.sort((left, right) => left - right);
}

/** The longest stretch between two turn openings, or `null` when the record holds fewer than two. */
function longestGapMs(times) {
  let longest = null;
  for (let index = 1; index < times.length; index += 1) {
    const gap = times[index] - times[index - 1];
    if (longest === null || gap > longest) longest = gap;
  }
  return longest;
}

/** The launcher's receipt: the only file that binds a run directory to the log it wrote. */
function readLaunch(runDir) {
  const path = join(runDir, "launch.json");
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    return { startedAtMs: Number.isFinite(parsed?.startedAtMs) ? parsed.startedAtMs : null };
  } catch {
    return null;
  }
}

/** The settled states a run's own account calls a mistake - the same set the bundle's node outcomes are read with. */
const BAD_STATES = new Set(["rejected", "failed", "recovery_required", "abandoned"]);

/**
 * The work the runner's log answers, keyed on the identities its producer gave it.
 *
 * This is the mid-run half of sections 2 and 3: the bundle's `programOutcomes` do not exist before the run ends, but the
 * receipts do, each naming its own action, its settlement and - for a programme node - its `(programId, nodeId)`.
 */
function logWork(log) {
  const receipts = log.receipts;
  const firstBadIndex = receipts.findIndex((receipt) => BAD_STATES.has(receipt.state));
  const firstBad = firstBadIndex < 0 ? null : receipts[firstBadIndex];
  return {
    firstBad,
    firstBadIndex,
    laterSameAction:
      firstBad !== null &&
      receipts
        .slice(firstBadIndex + 1)
        .some((receipt) => receipt.actionId === firstBad.actionId && receipt.state === "succeeded"),
    succeededBefore:
      firstBadIndex < 0
        ? receipts.filter((receipt) => receipt.state === "succeeded").length
        : receipts.slice(0, firstBadIndex).filter((receipt) => receipt.state === "succeeded").length,
    nodes: programmeNodes(log),
    states: actionStates(log),
    executions: actionExecutions(log),
  };
}

const argv = process.argv.slice(2);
const optionValue = (name) => {
  const index = argv.indexOf(name);
  return index < 0 || index + 1 >= argv.length ? null : argv[index + 1];
};
const logOption = optionValue("--log");
const logDir = optionValue("--log-dir");
const runArg =
  argv.find((argument) => !argument.startsWith("--") && argument !== logOption && argument !== logDir) ?? null;
const runDir = runArg === null ? latestRun() : resolve(runArg);
if (runDir === null) {
  console.log("airp scorecard: no run directory under " + RUNS_ROOT);
  process.exit(2);
}

// BOTH RECORDS, because the one that exists decides what can be read: the bundle on a finished run, the runner's log on
// one still going. A run with neither is refused by name rather than scored as a run that did nothing.
const resultPaths = readJsonFiles(runDir, "result.json");
const result = resultPaths.length === 0 ? {} : JSON.parse(readFileSync(resultPaths[0], "utf8"));
const hasResult = resultPaths.length > 0;
const readings = createReadingLedger();
const launch = readLaunch(runDir);
const located = locateRunnerLog({ runDir, logPath: logOption, logDir, startedAtMs: launch?.startedAtMs ?? null });
const log = located.path === null ? null : readRunnerLog(located.path);
if (!hasResult && log === null) {
  console.log(`airp scorecard: not_measured:no_bundle in ${runDir}`);
  console.log(`airp scorecard: result.json absent · ${located.why}`);
  process.exit(2);
}
// PARTIAL: the bundle is the run's final account, so a reading taken without it is what the run had done at the moment
// its log was last written. Every reading from the log carries this, and the header says it once.
const partial = !hasResult;
const sessionPresent = findSessionFiles(runDir, result).length > 0;
const SESSION_ABSENT =
  "not_measured:no session record in this run directory - a run copies its runtime root at capture, which has not happened yet, so nothing here holds its turns";

const records = sessionPresent ? readSessions(runDir, result) : [];
const calls = toolCalls(records);
const inputs = playerInputs(records);

const lines = [];
/** A header: a path or a source name, not a reading. */
const head = (label, value) => lines.push(`${label.padEnd(34)} ${value}`);
/**
 * A reading, with the file it was read from.
 *
 * The third argument is not decoration: a value printed with no source is the one state the ledger fails on, and a
 * `not_measured` value is the other honest half - it names what no artifact answers and is not counted as a reading.
 */
const say = (label, value, from) => {
  lines.push(`${label.padEnd(34)} ${value}`);
  if (from === FROM_RESULT) readings.fromResult(label, value);
  else if (from === FROM_RUNNER_LOG) readings.fromLog(label, value);
  else readings.unsourced(label, value);
};

head("run", runDir);
head(
  "source",
  hasResult
    ? `result.json${log === null ? "" : `, and live-runner.log as a second source (${located.how}) - never added to the bundle's counts`}`
    : `live-runner.log - ${located.how}`,
);
if (partial)
  head(
    "partial",
    "this run has not ended, so every reading below is what it had done when its log was last written - not a verdict on the run",
  );
if (log !== null) head("log", describeRunnerLog(log));
say(
  "verdict",
  hasResult
    ? `${result.state ?? "unknown"}${result.failure?.reasonCode ? " / " + result.failure.reasonCode : ""}`
    : "not_measured:this run has published no result.json, so it has stated no state of its own",
  FROM_RESULT,
);

// --- 1. Work actually done, as a checklist not a pass/fail -----------------------------------------------------------------
const purposes = Array.isArray(result.taskPurposes) ? result.taskPurposes : [];
const days = purposes.length > 0 ? Math.max(...purposes.map((entry) => entry.day ?? 1)) : 0;
say(
  "days with a declared task",
  purposes.length === 0 && !hasResult
    ? "not_measured:this run has published no result.json, so it declares no task"
    : `${days} (${purposes.map((entry) => entry.taskId ?? "?").join(", ") || "none"})`,
  FROM_RESULT,
);
// WHICH OF THEM WERE ACHIEVED, read from the field the artifact publishes. This read
// `result.multiday?.assessment?.taskPurpose ?? result.taskPurposeVerdict`, and no runner has ever published either: a
// bundle carrying three judged tasks printed `not_measured` while `result.taskPurposes` held all three verdicts. The
// tally prints each entry's OWN state and reason code, so `not_achieved` is never rounded into `unproven`.
const achieved = purposes.filter((entry) => entry.state === "achieved");
const unachieved = purposes.filter((entry) => entry.state !== "achieved");
const reasonTally = (entries) => {
  const counts = new Map();
  for (const entry of entries) {
    const code = `${entry.state ?? "no_state"}:${entry.reasonCode ?? "no_reason_code"}`;
    counts.set(code, (counts.get(code) ?? 0) + 1);
  }
  return [...counts]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .map(([code, count]) => `${code}×${count}`);
};
say(
  "task checklist progress",
  purposes.length === 0
    ? hasResult
      ? "not_measured:bundle declares no taskPurposes"
      : "not_measured:this run has published no result.json, so it declares no taskPurposes"
    : `${purposes.length} tasks · achieved ${achieved.length} · unproven ${unachieved.length}${
        unachieved.length === 0 ? "" : ` (${reasonTally(unachieved).join(", ")})`
      }`,
  FROM_RESULT,
);

// --- 1b. WHAT THE DAY ASKED FOR, before any count of what she did ---------------------------------------------------
// Measured 2026-11-19 (`round79`): her day-one task was `furnish_and_arrange` and this scorecard read the run by the farm
// counts it did not have. The day's task comes from the bundle's `taskPurposes`, or from the run's session record when the
// run never published a bundle; a run with neither says so by name, and every row below that scores her work carries the
// day it was judged against - `productivityGate` at the end fails naming any row that does not.
const dayReading = await readDayTasks({ result: hasResult ? result : null, log, runDir });
const dayExecutions = log === null ? null : actionExecutions(log).counts;
const dayBlock = formatDayTasks(dayReading, {
  executionsByAction: dayExecutions,
  settlements: log === null ? null : settlementsByAction(log),
  perDay: executionsByDay(log, dayReading),
});
const dayAnchor = dayTaskAnchor(dayReading);
if (dayBlock.tasks.length === 0) head("day task", `${dayAnchor} - ${dayReading.why}`);
for (const text of dayBlock.tasks) head("day task", text);
for (const text of dayBlock.families) head("day family", text);
for (const text of dayBlock.siblings) head("day sibling", text);
for (const text of dayBlock.shape) head("day shape", text);

// --- 2. First mistake, and whether the run recovered ---------------------------------------------------------------
const outcomes = Array.isArray(result.programOutcomes) ? result.programOutcomes : [];
const work = log === null ? null : logWork(log);
let firstBad = null;
let goodBeforeBad = 0;
// A NODE'S IDENTITY IS ITS PROGRAM AND ITS NODE ID. `nodeId` is `n01`, `n02`, ... in EVERY program, so a map keyed on it
// alone kept whichever program was submitted last: on `round77` 594 submitted nodes collapsed into 39 keys, and 391 of
// the 527 outcome rows were attributed to an action their own program never ran. Half an identity is not an identity.
const identityOf = (programId, nodeId) => `${programId ?? "?"}\u0000${nodeId ?? "?"}`;
const actionOfNode = new Map();
const nodeIdOnly = new Set();
let submittedNodes = 0;
for (const submission of result.programSubmissions ?? []) {
  for (const node of submission.nodes ?? []) {
    submittedNodes += 1;
    nodeIdOnly.add(node.nodeId);
    actionOfNode.set(identityOf(submission.programId, node.nodeId), node.actionId);
  }
}
outcomes.forEach((outcome, index) => {
  for (const node of outcome.nodeOutcomes ?? []) {
    const state = node.state ?? "";
    const bad = state === "rejected" || state === "failed" || state === "recovery_required" || state === "abandoned";
    if (bad && firstBad === null) {
      firstBad = {
        index,
        nodeId: node.nodeId,
        actionId: actionOfNode.get(identityOf(outcome.programId, node.nodeId)) ?? "?",
        state,
        reason: node.rejectionCode ?? node.failureCode ?? null,
      };
    }
    if (!bad) goodBeforeBad += 1;
  }
});
// What the old key cost, measured on this bundle: every submitted node it collapsed into another node's identity.
// ON A RUN WITH NO BUNDLE THE LOG ANSWERS THIS ONE: the receipts name their programme and their node, and the nodes
// submitted are the count of the submissions' own node totals, so the same three numbers exist before the run ends.
say(
  "node identity",
  submittedNodes === 0 && work === null
    ? "not_measured:no program submissions in this bundle and no runner log to read them from"
    : submittedNodes > 0
      ? `${submittedNodes} submitted nodes · ${actionOfNode.size} (programId, nodeId) identities · ${nodeIdOnly.size} nodeId-only keys · duplicated ${submittedNodes - nodeIdOnly.size}`
      : `${log.counts.submittedNodes} submitted nodes · ${work.nodes.identities.size} (programId, nodeId) receipt identities · ${work.nodes.nodeIdOnly.size} nodeId-only keys · duplicated ${log.counts.submittedNodes - work.nodes.nodeIdOnly.size}`,
  submittedNodes > 0 ? FROM_RESULT : FROM_RUNNER_LOG,
);
if (firstBad === null && work?.firstBad !== null && work !== null) {
  say(
    "first mistake",
    `receipt#${work.firstBadIndex} ${work.firstBad.programId ?? "standalone"} node ${work.firstBad.nodeId ?? "-"} (${work.firstBad.actionId ?? "?"}) ${work.firstBad.state}` +
      `${work.firstBad.reasonCode ? " / " + work.firstBad.reasonCode : ""} ; later success on same action: ${work.laterSameAction ? "yes" : "no"}`,
    FROM_RUNNER_LOG,
  );
  say("completed nodes before it", String(work.succeededBefore), FROM_RUNNER_LOG);
} else if (firstBad === null) {
  say(
    "first mistake",
    outcomes.length === 0 && work === null
      ? "not_measured:no programs executed and no runner log to read"
      : "none recorded",
    work === null ? FROM_RESULT : FROM_RUNNER_LOG,
  );
} else {
  const laterSameAction = outcomes
    .slice(firstBad.index + 1)
    .some((outcome) =>
      (outcome.nodeOutcomes ?? []).some(
        (node) =>
          actionOfNode.get(identityOf(outcome.programId, node.nodeId)) === firstBad.actionId &&
          node.state === "succeeded",
      ),
    );
  say(
    "first mistake",
    `program#${firstBad.index} node ${firstBad.nodeId} (${firstBad.actionId}) ${firstBad.state}` +
      `${firstBad.reason ? " / " + firstBad.reason : ""} ; later success on same action: ${laterSameAction ? "yes" : "no"}`,
    FROM_RESULT,
  );
  say("completed nodes before it", String(goodBeforeBad), FROM_RESULT);
}

// --- 3. Redundancy: repeated asks for the same thing ---------------------------------------------------------------
const planCalls = calls.filter((call) => call.name.endsWith("plan_work"));
const observeCalls = calls.filter((call) => call.name.endsWith("observe"));
const lookUpCalls = calls.filter((call) => call.name.endsWith("look_up"));
const touched = new Set();
let planned = 0;
for (const call of planCalls) {
  const script = typeof call.args?.script === "string" ? call.args.script : "";
  for (const match of script.matchAll(/builder\.([a-z_]+)\(\{([^}]*)\}/g)) {
    planned += 1;
    const coordinates = match[2].match(/x:\s*(\d+),\s*y:\s*(\d+)/);
    touched.add(coordinates ? `${match[1]}@${coordinates[1]},${coordinates[2]}` : `${match[1]}@?`);
  }
}
say(
  "planned nodes / distinct targets",
  !sessionPresent
    ? SESSION_ABSENT
    : planned === 0
      ? "not_measured:no builder calls in the session"
      : `${planned} / ${touched.size}`,
  FROM_RESULT,
);
say(
  "tool use",
  sessionPresent
    ? `plan_work ${planCalls.length}, observe ${observeCalls.length}, look_up ${lookUpCalls.length}`
    : SESSION_ABSENT,
  FROM_RESULT,
);

// --- 4. Fabricated success: an answer that claims more than the world did ------------------------------------------
let claimedWithDrops = 0;
let truncatedDrops = 0;
for (const record of records) {
  const message = record?.message ?? record;
  const parts = Array.isArray(message?.content) ? message.content : [];
  for (const part of parts) {
    const text = typeof part === "string" ? part : part?.type === "text" ? part.text : "";
    if (typeof text !== "string" || !text.includes('"droppedCount"')) continue;
    const counts = text.match(/"droppedCount"\s*:\s*(\d+)/g) ?? [];
    for (const count of counts) {
      const value = Number(count.replace(/\D+/g, ""));
      if (value > 0) claimedWithDrops += 1;
    }
    if (/"droppedTruncated"\s*:\s*true/.test(text)) truncatedDrops += 1;
  }
}
say(
  "answers admitting dropped calls",
  !sessionPresent
    ? SESSION_ABSENT
    : claimedWithDrops === 0
      ? "0 (either none dropped or none said)"
      : String(claimedWithDrops),
  FROM_RESULT,
);
say("answers whose drop list was truncated", sessionPresent ? String(truncatedDrops) : SESSION_ABSENT, FROM_RESULT);

// --- 5. Legibility and redirectability (the autonomy axis, measured the right way) ---------------------------------
const speechEvents = [];
for (const record of records) {
  const message = record?.message ?? record;
  if (message?.role !== "assistant") continue;
  const parts = Array.isArray(message.content) ? message.content : [];
  const text = parts
    .filter((part) => part?.type === "text")
    .map((part) => part.text)
    .join("")
    .trim();
  if (text.length > 0 && record.timestamp) speechEvents.push({ text, at: Date.parse(record.timestamp) });
}
let announced = 0;
// Word boundaries do not exist between CJK characters, so the Chinese intent words are matched without \b - an
// English-only pattern reported 0 of 30 on a run whose first plan was literally preceded by "我先看看…".
const INTENT_EN = /\b(going to|i'll|i will|let me|first|then|next|plan to)\b/i;
const INTENT_ZH = /先|打算|准备|然后|接着|接下来|去看看|去把/;
for (const call of planCalls) {
  const before = speechEvents.filter((event) => call.at !== null && event.at <= call.at).pop();
  if (before && (INTENT_EN.test(before.text) || INTENT_ZH.test(before.text))) announced += 1;
}
say(
  "plans preceded by a stated intent",
  !sessionPresent
    ? SESSION_ABSENT
    : planCalls.length === 0
      ? "not_measured:no plans"
      : `${announced} of ${planCalls.length}`,
  FROM_RESULT,
);
let redirected = 0;
for (const input of inputs) {
  const after = planCalls.find((call) => input.at !== null && call.at !== null && call.at > input.at);
  if (after) redirected += 1;
}
say(
  "player inputs followed by a plan",
  !sessionPresent
    ? SESSION_ABSENT
    : inputs.length === 0
      ? "not_measured:no player input in this run"
      : `${redirected} of ${inputs.length}`,
  FROM_RESULT,
);
say("player inputs", sessionPresent ? String(inputs.length) : SESSION_ABSENT, FROM_RESULT);

// --- 6. Time to first visible thing ---------------------------------------------------------------------------------
const started = result.startedAtMs ?? (records[0]?.timestamp ? Date.parse(records[0].timestamp) : null);
const firstText = firstAssistantTextAt(records);
if (started === null || firstText === null) {
  say(
    "first visible text",
    sessionPresent
      ? "not_measured:no start time or no assistant text"
      : "not_measured:no session record, so no assistant text was timed",
    FROM_RESULT,
  );
} else {
  say("first visible text", `${Math.round((firstText - started) / 1000)} s after start`, FROM_RESULT);
}

// --- 7. Execution cadence --------------------------------------------------------------------------------------------
const cadence = result.actionCadence ?? {};
say(
  "executions timed",
  cadence.measured === undefined
    ? "not_measured:no actionCadence in this run"
    : `${cadence.measured} of ${cadence.actions ?? "?"} · ${dayAnchor}`,
  FROM_RESULT,
);
say(
  "median execution",
  cadence.execMs?.median === null || cadence.execMs?.median === undefined
    ? "not_measured:no actionCadence in this run"
    : `${cadence.execMs.median} ms`,
  FROM_RESULT,
);

// --- 8. Breadth, with both denominators ------------------------------------------------------------------------------
// The bundle publishes its own attempted list; a run that has not ended has none, and its receipts name every action the
// run dispatched - so the attempt count is available mid-flight and the addressable width is not (the census is the
// bundle's fact). This is the reading `action-breadth.mjs` measures in full; here it is the one-line answer a list of
// metrics needs.
const attemptedBundle = Array.isArray(result.attemptedActionIds) ? result.attemptedActionIds.length : null;
const attemptedLog = work === null ? null : attemptedActions(log).length;
const attempted = attemptedBundle ?? attemptedLog;
const addressable = result.capabilityAudit?.addressableActionIds?.length ?? result.actionBreadth?.addressable ?? null;
say(
  "breadth",
  attempted === null
    ? "not_measured:no attemptedActionIds and no runner log to read them from"
    : `${attempted} attempted of ${addressable ?? "not_measured (no snapshot census)"} addressable · ${dayAnchor}`,
  attemptedBundle === null ? FROM_RUNNER_LOG : FROM_RESULT,
);

// --- 9. The silence she was left in, and the gate that keeps a span honest --------------------------------------------
// `noWakeForMs` claims "how long she was not woken". The authority for being woken is the turn stream, and every turn in
// this run is not the harness's: the Host's fact pump opens turns too. On `round77` the artifact reported 712,856 ms of
// "no wake" while the session's own turns were never more than 175,201 ms apart, so the number measured the day loop's
// own withholding and was named for the whole run's silence.
const bound = boundSessionFiles(runDir, result);
const openings = bound.files.length === 0 ? null : turnOpenings(parseSessionLines(bound.files));
const measuredGapMs = openings === null ? null : longestGapMs(openings);
say(
  "longest stretch with no turn",
  measuredGapMs === null
    ? `${bound.reason ?? "not_measured:this run's session record holds fewer than two turn openings"}`
    : `${measuredGapMs} ms across ${openings.length} turn openings`,
  FROM_RESULT,
);

// THE GATE. A span field's NAME says which interval it claims, and the interval a `noWake<…>Ms` name claims is measured
// from the turn stream above. The population is derived from the published field names, never listed: a field added
// tomorrow whose name claims a silence is examined without editing this, and one whose derivation is not declared here
// fails as misnamed rather than passing because nobody wrote a rule for it. `dayLoopWithheldWakeMs` is NOT in the
// population and not exempted from anything: its name claims what the day loop did, and the day loop may withhold for
// longer than she was silent - the pump is what kept waking her.
const WAKE_SILENCE_SPAN = /^noWake[A-Za-z0-9]*Ms$/u;
const spanDerivations = new Map([
  [
    "noWakeForMs",
    {
      claims: "the longest stretch with no turn opened",
      measure: () => measuredGapMs,
      evidence: () =>
        openings === null ? bound.reason : `the ${openings.length} turn openings in this run's own session record`,
    },
  ],
]);
const wakes = result.multiday?.wakes ?? null;
const spanFields =
  wakes === null
    ? []
    : Object.keys(wakes)
        .filter((key) => WAKE_SILENCE_SPAN.test(key))
        .sort();
const misnamed = [];
const blocked = [];
let measuredWhatItNames = 0;
for (const field of spanFields) {
  const derivation = spanDerivations.get(field);
  const published = wakes[field];
  if (derivation === undefined) {
    misnamed.push({ name: field, detail: "its name claims a wake-silence span and no derivation here measures it" });
    continue;
  }
  const derived = derivation.measure();
  if (derived === null) {
    blocked.push({ name: field, detail: derivation.evidence() });
    continue;
  }
  if (published === derived) measuredWhatItNames += 1;
  else
    misnamed.push({
      name: field,
      detail: `${String(published)} ms published; ${derivation.claims} is ${String(derived)} ms, from ${derivation.evidence()}`,
    });
}
const gate = `fields examined ${spanFields.length} · measured-what-it-names ${measuredWhatItNames} · misnamed ${misnamed.length}`;
const gateLines = misnamed.map(
  (field) => `a_reported_span_is_the_span_its_name_claims:${field.name} - ${field.detail}`,
);
for (const field of blocked)
  gateLines.push(`a_reported_span_is_the_span_its_name_claims:blocked - ${field.name} - ${field.detail}`);
gateLines.push(
  spanFields.length === 0
    ? `a_reported_span_is_the_span_its_name_claims:blocked - ${gate} · this bundle publishes no wake-silence span${wakes === null ? " (no multiday.wakes)" : ""}`
    : `a_reported_span_is_the_span_its_name_claims ${gate}`,
);

// --- 10. Declared blind spots ----------------------------------------------------------------------------------------
say("second launch", "not_measured:the harness destroys the run; no returning player sample exists");
say("human rating", "not_measured:no raters; see .tmp/airp-evaluation-rubric.md for the blind-transcript protocol");

console.log(lines.join("\n"));

const missing = lines.filter((line) => line.includes("not_measured")).length;
console.log(`\nexamined ${lines.length} metrics, ${missing} not measured in this artifact`);
console.log(gateLines.join("\n"));
// THE PRODUCTIVITY GATE. Every row above that scores an action count names the day it judged, or says by name that no
// artifact answers which day that was. Measured 2026-11-19 (`round79`): the rows scored her executions and not one of them
// mentioned `furnish_and_arrange`, which is why a day spent on its own task was read as a day that did almost nothing.
const productGate = productivityGate(lines, { requireRows: false });
console.log(productGate.lines.join("\n"));
// THE SOURCE GATE. Every reading above names the file it was read from, and this counts how many there were and where
// they came from - so a scorecard taken before a run ended is readable as one, and a number printed with no file behind
// it fails here by name instead of being read as a fact.
for (const line of readings.lines()) console.log(line);
// A misnamed span fails this reading, so a bundle whose account says it left her alone for eleven minutes when it did not
// cannot exit clean. An unsourced reading fails it for the same reason: it is a number nobody can re-derive.
if (misnamed.length > 0 || readings.failed() || productGate.failed) process.exitCode = 1;
