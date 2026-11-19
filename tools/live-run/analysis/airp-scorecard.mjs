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

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
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
    ? "not_measured:bundle declares no taskPurposes"
    : `${purposes.length} tasks · achieved ${achieved.length} · unproven ${unachieved.length}${
        unachieved.length === 0 ? "" : ` (${reasonTally(unachieved).join(", ")})`
      }`,
);

// --- 2. First mistake, and whether the run recovered ---------------------------------------------------------------
const outcomes = Array.isArray(result.programOutcomes) ? result.programOutcomes : [];
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
say(
  "node identity",
  submittedNodes === 0
    ? "not_measured:no program submissions in this bundle"
    : `${submittedNodes} submitted nodes · ${actionOfNode.size} (programId, nodeId) identities · ${nodeIdOnly.size} nodeId-only keys · duplicated ${submittedNodes - nodeIdOnly.size}`,
);
if (firstBad === null) {
  say("first mistake", outcomes.length === 0 ? "not_measured:no programs executed" : "none recorded");
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
// A misnamed span fails this reading, so a bundle whose account says it left her alone for eleven minutes when it did not
// cannot exit clean.
if (misnamed.length > 0) process.exitCode = 1;
