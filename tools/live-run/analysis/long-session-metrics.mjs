#!/usr/bin/env node
// Long-session product metrics for one run: the numbers a player would feel, not the count of things we dispatched.
//
// Every metric either has a number with its provenance or says NOT_EXERCISED with the reason. A zero is only ever
// printed as zero when something was actually counted; "we never looked" and "we looked and found none" are different
// results and this file keeps them apart.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const args = process.argv.slice(2);
const option = (name) => {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
};

const resultPath = option("--result");
const sessionPath = option("--session");
if (resultPath === undefined) {
  console.error(
    "usage: node tools/live-run/analysis/long-session-metrics.mjs --result <result.json> [--session <session.jsonl>]",
  );
  process.exit(2);
}

const readJson = (path) => {
  if (!existsSync(path)) {
    console.error(`REFUSED result_not_found: ${path}`);
    process.exit(2);
  }
  return JSON.parse(readFileSync(path, "utf8"));
};

const result = readJson(resultPath);

// A session is the only artifact that carries per-turn wall-clock, so its absence is a stated gap, not a zero.
const findSession = () => {
  if (sessionPath !== undefined) return existsSync(sessionPath) ? sessionPath : undefined;
  const root = join(process.env.LOCALAPPDATA ?? "", "GameBuddy", "contexts");
  if (!existsSync(root)) return undefined;
  const files = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith(".jsonl") && full.includes("surface-sessions")) files.push(full);
    }
  };
  walk(root);
  const startedAt = Number(result.startedAtMs ?? 0);
  const near = files
    .map((path) => ({ path, mtime: statSync(path).mtimeMs, birth: statSync(path).birthtimeMs }))
    .filter((entry) => startedAt === 0 || entry.birth >= startedAt - 60_000)
    .sort((a, b) => b.mtime - a.mtime);
  return near[0]?.path;
};

const session = findSession();
const records =
  session === undefined
    ? []
    : readFileSync(session, "utf8")
        .split("\n")
        .filter((line) => line.trim().length > 0)
        .flatMap((line) => {
          try {
            return [JSON.parse(line)];
          } catch {
            return [];
          }
        });

const messageOf = (record) => record.message ?? {};
const textOf = (record) =>
  record.type === "message" && Array.isArray(messageOf(record).content)
    ? messageOf(record)
        .content.map((part) => part.text ?? "")
        .join("")
    : "";

// A fact batch is the harness speaking; a player_input inside one is the player speaking. Counting both as "the
// player said something" was the mistake this file exists to avoid.
const factBatches = records.filter(
  (record) => messageOf(record).role === "user" && textOf(record).includes("gamebuddy_fact_batch"),
);
const playerInputs = factBatches.filter((record) => textOf(record).includes('"kind":"player_input"'));
const herLines = records.filter(
  (record) =>
    messageOf(record).role === "assistant" &&
    Array.isArray(messageOf(record).content) &&
    messageOf(record).content.some((part) => part.type === "text" && String(part.text ?? "").trim().length > 0),
);

const startedAt = Number(result.startedAtMs ?? 0);
const endedAt = Number(result.endedAtMs ?? 0);
const wallMinutes = startedAt > 0 && endedAt > startedAt ? (endedAt - startedAt) / 60_000 : null;

const line = (label, value, provenance) => console.log(`${label.padEnd(38)} ${value.padEnd(34)} ${provenance}`);

console.log(
  `run    ${result.scenario ?? "?"}  state=${result.state ?? "?"}  reason=${String(result.reasonCode ?? result.reason ?? "none")}`,
);
console.log(`result ${resultPath}`);
console.log(`session ${session ?? "none"}`);
console.log("");

// 1. Steers per goal: player inputs that were not pre-written gates, per day the run reached.
const days = Array.isArray(result.multiday?.dayRecords) ? result.multiday.dayRecords.length : null;
line(
  "1 steers per day",
  days === null || days === 0 ? "NOT_EXERCISED (no day record)" : (playerInputs.length / days).toFixed(2),
  `player_input ${playerInputs.length} / days ${days ?? "?"} (fact batches ${factBatches.length} excluded)`,
);

// 2. Input -> first effective result. The receipts now carry the Mod's own monotonic stamp of the moment it dispatched
//    each execution (`atMs`) and of the moment its action settled (`settledAtMs`), so the execution half is a real
//    number. The INPUT half needs the player's wall clock and the game's clock on ONE timeline, which a run does not
//    publish - so it is named as unmeasured rather than approximated from a tool return (a submission is accepted
//    instantly and executed later, and those are different moments).
const programExecutions = Array.isArray(result.programOutcomes)
  ? result.programOutcomes.flatMap((outcome) =>
      (outcome.executions ?? []).map((execution) => ({ ...execution, nodeOutcomes: outcome.nodeOutcomes ?? [] })),
    )
  : [];
const executions = programExecutions.length;
const timed = programExecutions.filter((entry) => Number.isFinite(entry.atMs));
const settled = timed.filter((entry) => Number.isFinite(entry.settledAtMs) && entry.settledAtMs >= entry.atMs);
const durations = settled.map((entry) => entry.settledAtMs - entry.atMs).sort((left, right) => left - right);
const stateOfNode = (entry) => entry.nodeOutcomes.find((node) => node?.nodeId === entry.nodeId)?.state ?? "unreported";
const succeededStamps = timed
  .filter((entry) => stateOfNode(entry) === "succeeded")
  .map((entry) => entry.atMs)
  .sort((left, right) => left - right);
const medianOf = (values) =>
  values.length === 0
    ? null
    : values.length % 2 === 1
      ? values[Math.floor(values.length / 2)]
      : Math.round((values[values.length / 2 - 1] + values[values.length / 2]) / 2);
const inputHalf =
  playerInputs.length === 0
    ? "input half NOT_EXERCISED (no player input)"
    : "input half UNMEASURED (game-clock stamps; the run publishes no wall-clock anchor to subtract)";
const executionHalf =
  timed.length === 0
    ? "NOT_EXERCISED (no receipt timestamps)"
    : succeededStamps.length > 0
      ? `first effective at ${succeededStamps[0]} ms (game clock)`
      : `first dispatch at ${Math.min(...timed.map((entry) => entry.atMs))} ms (game clock), nothing succeeded`;
line(
  "2 input -> first effective result",
  executionHalf,
  timed.length === 0
    ? `executions ${executions}, of which timed 0`
    : `executions ${executions}, timed ${timed.length}, settled ${settled.length}; exec ms p50 ${medianOf(durations) ?? "-"} max ${durations.at(-1) ?? "-"}; ${inputHalf}`,
);

// 3. Uncertain / recovery rate: only meaningful when a receipt actually reported that state.
const states = new Map();
for (const outcome of result.programOutcomes ?? [])
  for (const execution of outcome.executions ?? [])
    states.set(execution.state ?? "unreported", (states.get(execution.state ?? "unreported") ?? 0) + 1);
const uncertain = (states.get("uncertain") ?? 0) + (states.get("recovery_required") ?? 0);
line(
  "3 uncertain / recovery rate",
  executions === 0
    ? "NOT_EXERCISED (no executions)"
    : states.has("uncertain") || states.has("recovery_required")
      ? `${uncertain} of ${executions}`
      : "NOT_EXERCISED (state never reported)",
  `states ${[...states.entries()].map(([k, v]) => `${k}=${v}`).join(" ") || "none"}`,
);

// 4. Cross-day recovery: a crossing is only a recovery if the next day produced work.
const crossings = result.multiday?.crossings;
const dayRecords = result.multiday?.dayRecords ?? [];
const workByDay = dayRecords.map((day) =>
  Array.isArray(day.succeededActionIds) ? day.succeededActionIds.length : null,
);
line(
  "4 cross-day recovery",
  crossings === undefined
    ? "NOT_EXERCISED (no crossings field)"
    : `${crossings} crossed, next-day work ${workByDay.join(",") || "none"}`,
  "multiday.crossings + dayRecords[].succeededActionIds",
);

// 5. Second launch: this needs a second session for the same continuity, which a scripted run never produces.
line(
  "5 second launch",
  "NOT_EXERCISED (harness destroys the run)",
  "needs a player-started second session for the same continuity",
);

// 6. Presence: how long after a player input the first words of hers arrive.
if (playerInputs.length === 0 || session === undefined) {
  line(
    "6 input -> first words",
    "NOT_EXERCISED (no player input)",
    `session ${session === undefined ? "absent" : "present"}`,
  );
} else {
  const gaps = [];
  for (const input of playerInputs) {
    const start = Date.parse(input.timestamp ?? "");
    const after = herLines.find((record) => Date.parse(record.timestamp ?? "") >= start);
    if (Number.isFinite(start) && after !== undefined) gaps.push(Date.parse(after.timestamp ?? "") - start);
  }
  const sorted = gaps.sort((a, b) => a - b);
  line(
    "6 input -> first words",
    sorted.length === 0
      ? "NOT_EXERCISED (no reply followed)"
      : `p50 ${(sorted[Math.floor(sorted.length / 2)] / 1000).toFixed(1)}s max ${(sorted[sorted.length - 1] / 1000).toFixed(1)}s`,
    `n=${sorted.length} of ${playerInputs.length} inputs`,
  );
}

line(
  "7 her lines",
  String(herLines.length),
  `wall ${wallMinutes === null ? "unknown" : `${wallMinutes.toFixed(1)} min`}`,
);
