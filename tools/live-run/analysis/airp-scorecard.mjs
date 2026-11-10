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
// Usage: node tools/live-run/analysis/airp-scorecard.mjs [runDir]

import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";

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

function readSessions(runDir, result) {
  const records = [];
  const files = findSessionFiles(runDir, result);
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

const runDir = process.argv[2] ?? latestRun();
if (runDir === null) {
  console.log("airp scorecard: no run directory under " + RUNS_ROOT);
  process.exit(2);
}

const resultPaths = readJsonFiles(runDir, "result.json");
if (resultPaths.length === 0) {
  console.log(`airp scorecard: not_measured:no_bundle in ${runDir}`);
  process.exit(2);
}
const result = JSON.parse(readFileSync(resultPaths[0], "utf8"));
const records = readSessions(runDir, result);
const calls = toolCalls(records);
const inputs = playerInputs(records);

const lines = [];
const say = (label, value) => lines.push(`${label.padEnd(34)} ${value}`);

say("run", runDir);
say("verdict", `${result.state ?? "unknown"}${result.failure?.reasonCode ? " / " + result.failure.reasonCode : ""}`);

// --- 1. Work actually done, as a checklist not a pass/fail -----------------------------------------------------------------
const purposes = Array.isArray(result.taskPurposes) ? result.taskPurposes : [];
const days = purposes.length > 0 ? Math.max(...purposes.map((entry) => entry.day ?? 1)) : 0;
say("days with a declared task", `${days} (${purposes.map((entry) => entry.taskId ?? "?").join(", ") || "none"})`);
const taskVerdict = result.multiday?.assessment?.taskPurpose ?? result.taskPurposeVerdict ?? null;
say(
  "task checklist progress",
  taskVerdict === null
    ? "not_measured:bundle carries no task-purpose verdict"
    : `${taskVerdict.state ?? "?"}${taskVerdict.reasonCode ? " / " + taskVerdict.reasonCode : ""}`,
);

// --- 2. First mistake, and whether the run recovered ---------------------------------------------------------------
const outcomes = Array.isArray(result.programOutcomes) ? result.programOutcomes : [];
let firstBad = null;
let goodBeforeBad = 0;
const actionOfNode = new Map();
for (const submission of result.programSubmissions ?? []) {
  for (const node of submission.nodes ?? []) actionOfNode.set(node.nodeId, node.actionId);
}
outcomes.forEach((outcome, index) => {
  for (const node of outcome.nodeOutcomes ?? []) {
    const state = node.state ?? "";
    const bad = state === "rejected" || state === "failed" || state === "recovery_required" || state === "abandoned";
    if (bad && firstBad === null) {
      firstBad = {
        index,
        nodeId: node.nodeId,
        actionId: actionOfNode.get(node.nodeId) ?? "?",
        state,
        reason: node.rejectionCode ?? node.failureCode ?? null,
      };
    }
    if (!bad) goodBeforeBad += 1;
  }
});
if (firstBad === null) {
  say("first mistake", outcomes.length === 0 ? "not_measured:no programs executed" : "none recorded");
} else {
  const laterSameAction = outcomes
    .slice(firstBad.index + 1)
    .some((outcome) =>
      (outcome.nodeOutcomes ?? []).some(
        (node) => actionOfNode.get(node.nodeId) === firstBad.actionId && node.state === "succeeded",
      ),
    );
  say(
    "first mistake",
    `program#${firstBad.index} node ${firstBad.nodeId} (${firstBad.actionId}) ${firstBad.state}` +
      `${firstBad.reason ? " / " + firstBad.reason : ""} ; later success on same action: ${laterSameAction ? "yes" : "no"}`,
  );
  say("completed nodes before it", String(goodBeforeBad));
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
  planned === 0 ? "not_measured:no builder calls in the session" : `${planned} / ${touched.size}`,
);
say("tool use", `plan_work ${planCalls.length}, observe ${observeCalls.length}, look_up ${lookUpCalls.length}`);

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
  claimedWithDrops === 0 ? "0 (either none dropped or none said)" : String(claimedWithDrops),
);
say("answers whose drop list was truncated", String(truncatedDrops));

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
  planCalls.length === 0 ? "not_measured:no plans" : `${announced} of ${planCalls.length}`,
);
let redirected = 0;
for (const input of inputs) {
  const after = planCalls.find((call) => input.at !== null && call.at !== null && call.at > input.at);
  if (after) redirected += 1;
}
say(
  "player inputs followed by a plan",
  inputs.length === 0 ? "not_measured:no player input in this run" : `${redirected} of ${inputs.length}`,
);
say("player inputs", String(inputs.length));

// --- 6. Time to first visible thing ---------------------------------------------------------------------------------
const started = result.startedAtMs ?? (records[0]?.timestamp ? Date.parse(records[0].timestamp) : null);
const firstText = firstAssistantTextAt(records);
if (started === null || firstText === null) {
  say("first visible text", "not_measured:no start time or no assistant text");
} else {
  say("first visible text", `${Math.round((firstText - started) / 1000)} s after start`);
}

// --- 7. Execution cadence --------------------------------------------------------------------------------------------
const cadence = result.actionCadence ?? {};
say(
  "executions timed",
  cadence.measured === undefined ? "not_measured:no actionCadence" : `${cadence.measured} of ${cadence.actions ?? "?"}`,
);
say(
  "median execution",
  cadence.execMs?.median === null || cadence.execMs?.median === undefined
    ? "not_measured"
    : `${cadence.execMs.median} ms`,
);

// --- 8. Breadth, with both denominators ------------------------------------------------------------------------------
const attempted = Array.isArray(result.attemptedActionIds) ? result.attemptedActionIds.length : null;
const addressable = result.capabilityAudit?.addressableActionIds?.length ?? result.actionBreadth?.addressable ?? null;
say(
  "breadth",
  attempted === null
    ? "not_measured:no attemptedActionIds"
    : `${attempted} attempted of ${addressable ?? "not_measured (no snapshot census)"} addressable`,
);

// --- 9. Declared blind spots -----------------------------------------------------------------------------------------
say("second launch", "not_measured:the harness destroys the run; no returning player sample exists");
say("human rating", "not_measured:no raters; see .tmp/airp-evaluation-rubric.md for the blind-transcript protocol");

console.log(lines.join("\n"));

const missing = lines.filter((line) => line.includes("not_measured")).length;
console.log(`\nexamined ${lines.length} metrics, ${missing} not measured in this artifact`);
process.exit(0);
