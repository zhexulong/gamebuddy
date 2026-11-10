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

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join, resolve } from "node:path";

import { census, format, formatCensus, reading } from "../lib/reading.mjs";

const LADDER = ".live-runs/game-ladder";

/**
 * Every count below is taken over the run's own files, read whole: one window, said once.
 *
 * A criterion that read a file from its first line to its last is a whole-run reading, and the seam makes that
 * declaration mandatory so a point-in-time reading cannot be printed as if it covered the run.
 */
const RUN_FILES_WINDOW = Object.freeze({ wholeRun: true });

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
  const record = existsSync(resultPath) ? JSON.parse(readFileSync(resultPath, "utf8")).toolTiming?.record : null;
  if (typeof record === "string") {
    const found = newestUnder(join(runDir, "runtime-root", "contexts"), (entry) => entry === record);
    if (found !== null) return found;
  }
  // A run stopped by hand never publishes `result.json`, so nothing names its record - and its turns are still the only
  // account of what it cost. The session is there, under the runtime root it was mounted on, and the newest one is the
  // activation this launch wrote. Measured on `round43` (2026-11-10, stopped by hand at 22:10): the run directory holds
  // `launch.json` and nothing else, while `surface-sessions/game-<id>/sessions/*.jsonl` holds all 96 turns.
  return newestUnder(join(runDir, "runtime-root", "contexts"), (entry) => entry.endsWith(".jsonl"));
}

/** The newest descendant matching `wanted`, by mtime, or null - one walk for both the named and the unnamed record. */
function newestUnder(root, wanted) {
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
      else if (wanted(entry)) found.push({ path, mtime: stat.mtimeMs });
    }
  };
  walk(root, 6);
  found.sort((left, right) => right.mtime - left.mtime);
  return found[0]?.path ?? null;
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

/**
 * The lines of one text that mention one token, with the population they were counted out of.
 *
 * This replaces `text.split(token).length - 1`, which counted OCCURRENCES in a blob and printed the total as if it were
 * a count of events: a line that named the token twice counted twice, a file that was never read counted zero, and the
 * number never said how many lines it came out of. A missing file is `not measured` naming the file, because a zero
 * here decided a criterion ("nothing foraged") from an absence that only meant "wrong path".
 */
function mentionedLines({ text, token, source }) {
  const method = `line scan for ${JSON.stringify(token)}`;
  const lines = text === "" ? [] : text.split("\n");
  if (lines.length === 0)
    return reading({
      value: null,
      population: { unit: "lines", total: 0 },
      source,
      method,
      window: RUN_FILES_WINDOW,
      notMeasured: { reason: "the file was never readable, so no line was scanned", missingField: source },
    });
  return reading({
    value: lines.filter((line) => line.includes(token)).length,
    population: { unit: "lines", total: lines.length },
    source,
    method,
    window: RUN_FILES_WINDOW,
  });
}

// 7. EFFICIENCY: the floor this run could have cost, and where the wall clock actually went.
//
// The floor is NOT "this run, done faster". It is: given the work that reached a terminal state, and given that one plan
// may carry up to W nodes, the fewest model turns that could have produced that work - ceil(actions_done / W) dispatches
// plus one question per objective - and the native time the game itself owed. Every term is measured from the session
// this verdict already reads; a term the session does not carry prints `not_measured` and names its field, because a
// zero there would be indistinguishable from a run that did nothing.
const PLAN_ANSWER_TOOLS = new Set(["stardew_plan_work", "stardew_submit_action_program"]);
const PROGRAM_STATUS_TOOL = "stardew_action_program_status";
// A question is anything the companion asked the WORLD - observe, tiles, shape, look_up, scene, search, catalog - and it
// is derived as "every stardew tool that is not one of these", so a tool added tomorrow lands in `questions` (whose cost
// is a real conversation with the player) instead of landing nowhere.
const NOT_A_QUESTION_TOOLS = new Set([
  PROGRAM_STATUS_TOOL,
  "stardew_stop_action",
  "stardew_execution_status",
  "stardew_action_program_events",
  "ctx_reduce",
]);
// Walking to a target is how an objective is reached, not an objective of its own: counted as a family it would add one
// to every run's objective count whatever the companion was asked to do.
const NAVIGATION_ACTION_IDS = new Set(["move_to_tile"]);
// The declared ceiling on one plan, read from the authority that enforces it rather than copied here.
const PLAN_CAP_SOURCE = "host/src/body-program-script.ts";

function sessionEntries(sessionFile) {
  const entries = [];
  for (const line of readFileSync(sessionFile, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      entries.push(JSON.parse(line));
    } catch {
      // A half-written last line is what a killed run leaves; it is skipped, not repaired.
    }
  }
  return entries;
}

/**
 * The JSON a tool result carries.
 *
 * Measured on `round42`: two plan answers are a complete JSON object with a Magic Context `<system-reminder>` appended in
 * place of nothing - the reminder is a separate block after a blank line. Parsing the text whole therefore failed, and
 * those two calls read as "asked for a plan and received no answer", which was a refusal of the reader rather than a fact
 * about the run: 51 accepted and 7 refused answers, not 50 and 6. The reminder is stripped and nothing else is guessed.
 */
function toolPayload(message) {
  const text = stripSystemReminder(
    (message.content ?? []).map((part) => (typeof part?.text === "string" ? part.text : "")).join(""),
  );
  if (!text.startsWith("{")) return null;
  try {
    const value = JSON.parse(text);
    return typeof value === "object" && value !== null ? value : null;
  } catch {
    return null;
  }
}

function stripSystemReminder(text) {
  const at = text.indexOf("<system-reminder");
  return (at < 0 ? text : text.slice(0, at)).trim();
}

/**
 * One turn per assistant message, with the answer each of its calls received.
 *
 * An answer is matched by ITS OWN `toolCallId`, never by position: a turn that asks three `plan_shape` questions gets
 * three result entries, and the one that answers the third is not the one beside it. A call with no answer stays null -
 * that is a run that ended inside the call, and it is reported as unanswered rather than as a refusal.
 */
function sessionTurns(entries) {
  const answers = new Map();
  for (const entry of entries) {
    const message = entry?.message;
    if (message?.role !== "toolResult" || typeof message.toolCallId !== "string") continue;
    answers.set(message.toolCallId, {
      name: typeof message.toolName === "string" ? message.toolName : null,
      atMs: Date.parse(entry.timestamp),
      payload: toolPayload(message),
    });
  }
  const turns = [];
  let lastEventAtMs = null;
  for (const entry of entries) {
    const atMs = Date.parse(entry.timestamp);
    if (Number.isFinite(atMs)) lastEventAtMs = atMs;
    const message = entry?.message;
    if (message?.role !== "assistant") continue;
    turns.push({
      atMs,
      durationMs: typeof message.durationMs === "number" ? message.durationMs : null,
      calls: (message.content ?? [])
        .filter((part) => part?.type === "toolCall")
        .map((part) => ({
          name: typeof part.name === "string" ? part.name : "",
          answer: answers.get(part.id) ?? null,
        })),
    });
  }
  return { turns, lastEventAtMs };
}

function median(values) {
  const sorted = values.filter((value) => Number.isFinite(value)).sort((left, right) => left - right);
  if (sorted.length === 0) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

/** Accepted and refused plan answers, in the order the companion made them. */
function planAnswers(turns) {
  const accepted = [];
  const refused = [];
  let unanswered = 0;
  for (const turn of turns)
    for (const call of turn.calls) {
      if (!PLAN_ANSWER_TOOLS.has(call.name)) continue;
      const answer = call.answer?.payload ?? null;
      if (answer === null || typeof answer.accepted !== "boolean") {
        unanswered += 1;
        continue;
      }
      const entry = {
        programId: typeof answer.programId === "string" ? answer.programId : null,
        nodeCount: typeof answer.nodeCount === "number" ? answer.nodeCount : null,
        actionIds: (Array.isArray(answer.nodes) ? answer.nodes : []).map((node) => node?.actionId ?? null),
        reasonCode: typeof answer.reasonCode === "string" ? answer.reasonCode : null,
      };
      if (answer.accepted) accepted.push(entry);
      else refused.push(entry);
    }
  return { accepted, refused, unanswered };
}

/** The last snapshot each programme published, and the wall clock the status calls spent waiting on the game. */
function statusSnapshots(turns) {
  const byProgram = new Map();
  let waitMs = 0;
  for (const turn of turns)
    for (const call of turn.calls) {
      if (call.name !== PROGRAM_STATUS_TOOL || call.answer === null) continue;
      waitMs += Math.max(0, call.answer.atMs - turn.atMs);
      const snapshot = call.answer.payload?.snapshot ?? null;
      if (typeof snapshot?.programId === "string") byProgram.set(snapshot.programId, snapshot);
    }
  return { byProgram, waitMs };
}

function tallyNodes(states, families, nodes) {
  for (const node of nodes) {
    const state = typeof node?.state === "string" ? node.state : "unknown";
    states.set(state, (states.get(state) ?? 0) + 1);
    if (typeof node?.actionId === "string") families.add(node.actionId);
  }
}

/**
 * The work this run actually did, from the bundle when it published one and from its session when it did not.
 *
 * The bundle knows every programme (`programOutcomes`), including ones never polled; the session knows only what a
 * status call answered. Measured on `round41`: the bundle counted 289 nodes and 203 successes against the session's 273
 * and 188, because six accepted plans were never polled - so the nodes a session cannot account for are named as
 * unmeasured rather than counted as failures.
 */
function measureWork(result, turns) {
  const programmes = Array.isArray(result.programOutcomes) ? result.programOutcomes : null;
  const states = new Map();
  const families = new Set();
  let dispatched = 0;
  let largest = null;
  if (programmes !== null && programmes.length > 0) {
    for (const programme of programmes) {
      const nodes = programme?.nodeOutcomes ?? [];
      dispatched += nodes.length;
      largest = Math.max(largest ?? 0, nodes.length);
      tallyNodes(states, families, nodes);
    }
    return {
      source: "result.json programOutcomes[].nodeOutcomes",
      dispatched,
      states,
      families,
      largest,
      unmeasuredNodes: 0,
      unmeasuredPrograms: 0,
    };
  }

  const { accepted } = planAnswers(turns);
  const { byProgram } = statusSnapshots(turns);
  for (const plan of accepted) largest = Math.max(largest ?? 0, plan.nodeCount ?? 0);
  let unmeasuredPrograms = 0;
  let unmeasuredNodes = 0;
  for (const plan of accepted) {
    const snapshot = plan.programId === null ? null : (byProgram.get(plan.programId) ?? null);
    const nodes = snapshot?.nodes ?? null;
    if (nodes === null) {
      unmeasuredPrograms += 1;
      unmeasuredNodes += plan.nodeCount ?? 0;
      // Nothing answered for this plan: its scale is known from the plan itself, its per-node outcome is not. The
      // families it named ARE known - that is what was dispatched - so they are counted and the states are not.
      for (const actionId of plan.actionIds) if (typeof actionId === "string") families.add(actionId);
      continue;
    }
    dispatched += nodes.length;
    tallyNodes(states, families, nodes);
  }
  return {
    source: "session status snapshots",
    dispatched,
    states,
    families,
    largest,
    unmeasuredNodes,
    unmeasuredPrograms,
  };
}

/** The per-action durations the bundle recorded, with the cadence sum that must agree with them. */
function bundleNativeMs(result) {
  const programmes = Array.isArray(result.programOutcomes) ? result.programOutcomes : null;
  if (programmes === null) return null;
  let total = 0;
  let measured = 0;
  let unmeasured = 0;
  for (const programme of programmes)
    for (const execution of programme?.executions ?? []) {
      if (typeof execution?.atMs !== "number" || typeof execution?.settledAtMs !== "number") {
        unmeasured += 1;
        continue;
      }
      total += Math.max(0, execution.settledAtMs - execution.atMs);
      measured += 1;
    }
  if (measured === 0) return null;
  return { total, measured, unmeasured, cadenceSum: result.actionCadence?.execMs?.sum ?? null };
}

/**
 * What the player actually declared, deduped by TEXT.
 *
 * Not by event: measured on `round42`, 24 `player_input` events carry 8 distinct texts (the day's note, three nudges of
 * "keep going", three questions, a list request), because the same statement is re-published in later batches and the
 * runner repeats its nudge. Counting events made 24 objectives out of a day's task; counting texts counts what the
 * player actually asked for, which is the work the floor has to answer at least once.
 */
function declaredPlayerTasks(entries) {
  const texts = new Map();
  let events = 0;
  for (const entry of entries) {
    const message = entry?.message;
    if (message?.role !== "user") continue;
    const raw = (message.content ?? [])
      .map((part) => (typeof part?.text === "string" ? part.text : ""))
      .join("")
      .trim();
    if (!raw.startsWith("{")) continue;
    let batch;
    try {
      batch = JSON.parse(raw);
    } catch {
      continue;
    }
    for (const event of Array.isArray(batch?.events) ? batch.events : []) {
      if (event?.kind !== "player_input") continue;
      events += 1;
      const text = typeof event?.input?.text === "string" ? event.input.text.trim() : "";
      if (text.length === 0) continue;
      texts.set(text, (texts.get(text) ?? 0) + 1);
    }
  }
  return { events, texts };
}

/** The count of one tool from an independent parse of the same file, used to refuse a single-source reading. */
function countToolCallsByParse(sessionFile, name) {
  let count = 0;
  for (const line of readFileSync(sessionFile, "utf8").split("\n")) {
    if (!line.trim()) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    for (const part of Array.isArray(entry?.message?.content) ? entry.message.content : [])
      if (part?.type === "toolCall" && part.name === name) count += 1;
  }
  return count;
}

/** The count of answers TO that tool, from the other side of the exchange - what actually came back. */
function countToolAnswers(sessionFile, name) {
  let count = 0;
  for (const line of readFileSync(sessionFile, "utf8").split("\n")) {
    if (!line.trim()) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (entry?.message?.role === "toolResult" && entry.message.toolName === name) count += 1;
  }
  return count;
}

function declaredPlanCap(repoRoot) {
  const path = join(repoRoot, PLAN_CAP_SOURCE);
  if (!existsSync(path)) return null;
  const match = /^export const MAX_PLAN_NODES = (\d+);$/m.exec(readFileSync(path, "utf8"));
  return match === null ? null : Number(match[1]);
}

function percentOf(part, whole) {
  return Number.isFinite(part) && Number.isFinite(whole) && whole > 0
    ? `${Math.round((part / whole) * 100)}%`
    : "not_measured";
}

const seconds = (ms) => (Number.isFinite(ms) ? `${(ms / 1000).toFixed(1)}s` : "not_measured");
const ratio = (actual, floor) =>
  Number.isFinite(actual) && Number.isFinite(floor) && floor > 0 ? `${(actual / floor).toFixed(1)}x` : "not_measured";

/** Whether a long gap was the game owning the actor rather than nothing happening: the status call that opened it. */
function isWaitingOnTheGame(turn, gapMs) {
  const waited = turn.calls
    .filter((call) => call.name === PROGRAM_STATUS_TOOL && call.answer !== null)
    .map((call) => call.answer.atMs - turn.atMs);
  if (waited.length === 0) return false;
  return Math.max(...waited) * 2 >= gapMs;
}
/**
 * The measured efficiency of one session.
 *
 * BUCKETS SUM TO THE TURN COUNT BY CONSTRUCTION: each assistant turn is attributed once, by its first call (a turn that
 * dispatches and then polls is a dispatch turn - the poll is part of that dispatch's cost). Seconds are attributed one
 * turn per gap from it to the NEXT turn, so `sum(buckets) + silence = measured wall` holds exactly: a gap longer than
 * 3 x T_turn keeps T_turn for the turn itself and gives the remainder to `silence`, which is the stall class.
 */
function measureEfficiency({ sessionFile, result, repoRoot }) {
  if (sessionFile === null) return { missing: "no_session" };
  const entries = sessionEntries(sessionFile);
  const { turns, lastEventAtMs } = sessionTurns(entries);
  if (turns.length === 0) return { missing: "no_turns", sessionFile };

  const gaps = turns.map((turn, index) => {
    const nextAtMs = index + 1 < turns.length ? turns[index + 1].atMs : lastEventAtMs;
    return Number.isFinite(nextAtMs) ? Math.max(0, nextAtMs - turn.atMs) : null;
  });
  const tTurnMs = median(gaps.slice(0, -1)) ?? median(turns.map((turn) => turn.durationMs));
  const firstAtMs = turns[0].atMs;
  const wallMs =
    Number.isFinite(lastEventAtMs) && Number.isFinite(firstAtMs) ? Math.max(0, lastEventAtMs - firstAtMs) : null;

  const work = measureWork(result, turns);
  const succeeded = work.states.get("succeeded") ?? 0;
  const buckets = attributeTurns(turns, gaps, tTurnMs);
  const families = new Set([...work.families].filter((actionId) => !NAVIGATION_ACTION_IDS.has(actionId)));
  const playerTasks = declaredPlayerTasks(entries);
  const objectives = playerTasks.texts.size + families.size;
  const wCap = declaredPlanCap(repoRoot);
  const floorTurns =
    work.largest === null || work.largest === 0 ? null : Math.ceil(succeeded / work.largest) + objectives;
  const native = bundleNativeMs(result);
  const waitMs = statusSnapshots(turns).waitMs;
  const floorNativeMs = native === null ? (waitMs > 0 ? waitMs : null) : native.total;

  const statusCallsByTurnWalk = turns.reduce(
    (total, turn) => total + turn.calls.filter((call) => call.name === PROGRAM_STATUS_TOOL).length,
    0,
  );
  const statusCallsByParse = countToolCallsByParse(sessionFile, PROGRAM_STATUS_TOOL);
  const statusAnswers = countToolAnswers(sessionFile, PROGRAM_STATUS_TOOL);

  return {
    sessionFile,
    turns: turns.length,
    tTurnMs,
    providerMs: median(turns.map((turn) => turn.durationMs)),
    wallMs,
    work,
    succeeded,
    families: [...families].sort(),
    playerTasks: { events: playerTasks.events, distinct: playerTasks.texts.size },
    objectives,
    wCap,
    floorTurns,
    floorTurnsAtCap: wCap === null ? null : Math.ceil(succeeded / wCap) + objectives,
    native: floorNativeMs,
    nativeSource: native === null ? null : native,
    measuredWaitMs: waitMs,
    floorWallMs: floorTurns === null || floorNativeMs === null ? null : floorTurns * tTurnMs + floorNativeMs,
    ...buckets,
    crossCheck: { turnWalk: statusCallsByTurnWalk, parse: statusCallsByParse, answers: statusAnswers },
  };
}

/** Each turn once, by its first call; each gap once, split between its turn and the stall class. */
function attributeTurns(turns, gaps, tTurnMs) {
  const buckets = new Map([
    ["polls", { turns: 0, ms: 0 }],
    ["questions", { turns: 0, ms: 0 }],
    ["dispatches", { turns: 0, ms: 0 }],
    ["refused_dispatches", { turns: 0, ms: 0 }],
    ["other", { turns: 0, ms: 0 }],
  ]);
  const counts = { pollsBeforeDispatch: 0, unansweredTurns: 0, silenceMs: 0, silenceGaps: 0, silenceWaitingMs: 0 };
  let dispatchedSoFar = 0;
  for (let index = 0; index < turns.length; index += 1) {
    const turn = turns[index];
    const first = turn.calls[0] ?? null;
    const bucket = bucketOfTurn(first, () => dispatchedSoFar, counts);
    if (bucket === "dispatches") dispatchedSoFar += 1;

    const gapMs = gaps[index];
    const ownMs = gapMs === null ? 0 : Math.min(gapMs, gapMs > 3 * tTurnMs ? tTurnMs : gapMs);
    const overMs = gapMs === null ? 0 : Math.max(0, gapMs - ownMs);
    if (overMs > 0) {
      counts.silenceGaps += 1;
      counts.silenceMs += overMs;
      if (isWaitingOnTheGame(turn, gapMs)) counts.silenceWaitingMs += overMs;
    }
    buckets.get(bucket).turns += 1;
    buckets.get(bucket).ms += ownMs;
  }
  return {
    buckets: [...buckets.entries()].map(([name, bucket]) => ({ name, ...bucket })),
    ...counts,
  };
}

/**
 * Which bucket one turn belongs to.
 *
 * `polls` means polls AFTER a programme was already dispatched. A status call before the first dispatch learns nothing
 * about work in flight, so it lands in `other` and the block says how many.
 */
function bucketOfTurn(first, dispatchedSoFar, counts) {
  if (first === null) return "other";
  if (PLAN_ANSWER_TOOLS.has(first.name)) {
    const answer = first.answer?.payload ?? null;
    if (answer === null || typeof answer.accepted !== "boolean") {
      counts.unansweredTurns += 1;
      return "other";
    }
    return answer.accepted ? "dispatches" : "refused_dispatches";
  }
  if (first.name === PROGRAM_STATUS_TOOL) {
    if (dispatchedSoFar() > 0) return "polls";
    counts.pollsBeforeDispatch += 1;
    return "other";
  }
  if (NOT_A_QUESTION_TOOLS.has(first.name)) return "other";
  return first.name.startsWith("stardew_") ? "questions" : "other";
}

const notMeasured = (field) => `not_measured (${field})`;

function efficiencyLines(options) {
  const report = measureEfficiency(options);
  if (report.missing === "no_session")
    return [
      "efficiency          not_measured",
      "  field             result.json toolTiming.record, and runtime-root/contexts/**/sessions/*.jsonl - neither reached this run directory",
      "  why               a run whose bundle and session were never copied here has no turn record to price; this is not a zero",
    ];
  if (report.missing === "no_turns")
    return [
      `efficiency          not_measured (session ${report.sessionFile})`,
      "  field             session assistant messages - the record holds none, so there is no turn to price",
    ];
  return formatEfficiency(report);
}

function formatEfficiency(report) {
  const { work, succeeded, families, playerTasks, objectives } = report;
  const label = (name) => `${name.padEnd(19)}`;
  const statusLabel = (name) => `    ${name.padEnd(17)}`;
  const shares = (ms) => percentOf(ms, report.wallMs);
  const crossCheckAgrees =
    report.crossCheck.turnWalk === report.crossCheck.parse && report.crossCheck.parse === report.crossCheck.answers;
  const totalBucketTurns = report.buckets.reduce((total, bucket) => total + bucket.turns, 0);
  const totalBucketMs = report.buckets.reduce((total, bucket) => total + bucket.ms, 0);
  const measuredMs = totalBucketMs + report.silenceMs;
  const largest = [...report.buckets, { name: "silence", turns: 0, ms: report.silenceMs }].sort(
    (left, right) => right.ms - left.ms,
  )[0];

  const lines = [];
  const push = (line) => lines.push(line);
  push(`efficiency          session ${report.sessionFile}`);
  push(
    `  ${label("T_turn")} ${seconds(report.tTurnMs)}  median gap between ${report.turns} assistant turns (session message.timestamp; provider latency median ${seconds(report.providerMs)})`,
  );
  push(
    `  ${label("W")} measured ${work.largest === null ? notMeasured("no accepted plan carried a node count") : `${work.largest} nodes`} (largest plan this run accepted) | declared cap ${
      report.wCap === null
        ? `not_measured: ${PLAN_CAP_SOURCE} MAX_PLAN_NODES was not readable`
        : `${report.wCap} nodes (${PLAN_CAP_SOURCE})`
    }`,
  );
  const states = [...work.states.entries()].sort((left, right) => right[1] - left[1]);
  push(
    `  ${label("actions_done")} ${succeeded} nodes reached \`succeeded\` of ${work.dispatched} with a known state${
      states.length === 0 ? "" : ` (${states.map(([state, count]) => `${count} ${state}`).join(", ")})`
    }  <- ${work.source}`,
  );
  if (work.unmeasuredPrograms > 0)
    push(
      `  ${label("")} not_measured: ${work.unmeasuredPrograms} accepted plan(s) (${work.unmeasuredNodes} nodes) were never polled, so their node states are unknown - not zero`,
    );
  push(
    `  ${label("objectives_done")} ${objectives} = ${playerTasks.distinct} declared player task(s) (${playerTasks.events} player_input event(s), ${playerTasks.events - playerTasks.distinct} repeat(s) collapsed by text) + ${families.length} target families (${families.join(", ") || "none"})`,
  );
  push(
    `  ${label("")} navigation excluded from families: ${[...NAVIGATION_ACTION_IDS].join(", ")} (how a target is reached, not an objective)`,
  );
  push(
    `  ${label("floor_turns")} ${
      report.floorTurns === null
        ? notMeasured("no accepted plan carries a node count")
        : `${report.floorTurns} = ceil(${succeeded}/${work.largest}) + ${objectives}  | at the declared cap: ${report.floorTurnsAtCap}`
    }`,
  );
  push(`  ${label("floor_native")} ${seconds(report.native)}  <- ${nativeSourceText(report)}`);
  push(
    `  ${label("floor_wall")} ${seconds(report.floorWallMs)} = ${
      report.floorTurns === null
        ? notMeasured("no accepted plan carries a node count")
        : `${report.floorTurns} turns x ${seconds(report.tTurnMs)}`
    } + ${seconds(report.native)}`,
  );
  push(`  ${label("actual")} ${report.turns} turns, ${seconds(report.wallMs)} (first turn -> last recorded event)`);
  push(
    `  ${label("ratio")} turns ${ratio(report.turns, report.floorTurns)} | wall ${ratio(report.wallMs, report.floorWallMs)}`,
  );
  push(`  ${label("buckets")} turns   seconds   share`);
  for (const bucket of report.buckets)
    push(
      `${statusLabel(bucket.name)} ${String(bucket.turns).padStart(4)}  ${seconds(bucket.ms).padStart(8)}  ${shares(bucket.ms)}`,
    );
  push(
    `${statusLabel("silence")} ${String(0).padStart(4)}  ${seconds(report.silenceMs).padStart(8)}  ${shares(report.silenceMs)}${silenceNote(report)}`,
  );
  push(
    `  ${label("accounting")} ${totalBucketTurns} bucket turns ${totalBucketTurns === report.turns ? "=" : "!="} ${report.turns} measured | ${seconds(
      measuredMs,
    )} bucket seconds ${report.wallMs !== null && Math.abs(measuredMs - report.wallMs) < 1000 ? "=" : "!="} ${seconds(report.wallMs)} wall`,
  );
  if (report.unansweredTurns > 0 || report.crossCheck.parse !== report.crossCheck.answers)
    push(
      `  ${label("unanswered")} ${report.crossCheck.parse - report.crossCheck.answers} answered call(s) are missing and ${report.unansweredTurns} turn(s) received no answer at all - counted as other, not as refusals`,
    );
  if (report.pollsBeforeDispatch > 0)
    push(
      `  ${label("")} ${report.pollsBeforeDispatch} status call(s) came before any dispatch, so they are in other rather than polls`,
    );
  push(`  ${label("cross-check")} ${crossCheckText(report.crossCheck, crossCheckAgrees)}`);
  push(`  ${label("reading")} ${readingText(report, largest)}`);
  return lines;
}

function nativeSourceText(report) {
  if (report.nativeSource !== null) {
    const { measured, unmeasured, total, cadenceSum } = report.nativeSource;
    const extra = unmeasured > 0 ? `, ${unmeasured} without a duration` : "";
    const agreement =
      cadenceSum === null
        ? ""
        : cadenceSum === total
          ? ", agrees with actionCadence.execMs.sum"
          : `, DISAGREES with actionCadence.execMs.sum ${cadenceSum}`;
    return `result.json programOutcomes[].executions[] (${measured} actions${extra}${agreement})`;
  }
  if (report.measuredWaitMs > 0)
    return "status-call wait in this session (a LOWER BOUND: a poll that returned before the programme settled counts 0, and this run published no result.json programOutcomes[].executions[])";
  return "not_measured: neither result.json programOutcomes[].executions[].atMs/settledAtMs nor a status-call wait exists in this session";
}

function silenceNote(report) {
  if (report.silenceGaps === 0) return "";
  const waiting =
    report.silenceWaitingMs === 0
      ? ""
      : `, ${seconds(report.silenceWaitingMs)} of it inside a status call waiting on the game`;
  return `  (${report.silenceGaps} gap(s) > 3 x T_turn${waiting})`;
}

function crossCheckText({ turnWalk, parse, answers }, agrees) {
  const counts = `${PROGRAM_STATUS_TOOL}: ${turnWalk} by the turn walk, ${parse} by a second parse of the raw file, ${answers} answers`;
  if (agrees) return `${counts} -> agree`;
  const neverAnswered = parse === answers ? "" : ` (${parse - answers} call(s) never answered)`;
  return `${counts} -> DISAGREE${neverAnswered} - this verdict does not pick one`;
}

function readingText(report, largest) {
  const width = report.work.largest === null ? "?" : report.work.largest;
  const turns = report.floorTurns === null ? "not_measured turns" : `${report.floorTurns} turns`;
  const wall =
    report.floorWallMs === null
      ? " (wall not_measured: no native time reached this run)"
      : ` (${seconds(report.floorWallMs)})`;
  return `with the same work at ${width} nodes per plan and zero polls, this run would have cost ${turns}${wall}, ${ratio(
    report.wallMs,
    report.floorWallMs,
  )} less wall clock; the largest single bucket was ${largest.name} at ${seconds(largest.ms)} (${percentOf(largest.ms, report.wallMs)})`;
}

const rows = [];
const record = (name, verdict, detail, source) => rows.push({ name, verdict, detail, source });

const argv = process.argv.slice(2);
const optionValue = (name) => {
  const index = argv.indexOf(`--${name}`);
  return index >= 0 && argv[index + 1] !== undefined ? argv[index + 1] : null;
};
const explicitSession = optionValue("session");
const positionalRun = argv.find((argument) => !argument.startsWith("--") && argument !== explicitSession) ?? null;
const runDir = positionalRun === null ? newestRun() : resolve(positionalRun);
if (runDir === null || !existsSync(runDir)) {
  process.stderr.write("no run directory\n");
  process.exit(2);
}

const resultPath = join(runDir, "result.json");
const result = existsSync(resultPath) ? JSON.parse(readFileSync(resultPath, "utf8")) : {};
const smapiPath = join(process.env.APPDATA ?? "", "StardewValley", "ErrorLogs", "SMAPI-latest.txt");
const modLogPath = join(runDir, "mod-log.txt");
// `--session` exists because a hand-stopped run never copies its runtime root into the run directory: the session is
// still under the live runtime root it was mounted on, and pricing that run means reading it there. Read-only either way.
const boundSession = explicitSession === null ? sessionPath(runDir) : resolve(explicitSession);

// 1. Contract errors: the run is worthless as evidence if these are non-zero.
//
// Read BOTH files, because the two carry different halves and neither alone is the whole answer. Measured 2026-11-01 on
// `round20`, whose bridge died of `invalid_snapshot:rockSourceTargets`: `mod-log.txt` mentions it 0 times, `result.json` 3
// times (in `bridgeDisconnections`, `failure`, and the verdict's own `reasonCode`). The Mod does not log a bridge refusal -
// the Host closes the pipe and records why. A criterion that read only the Mod log therefore printed
// `invalid_snapshot=0 PASS` over a run whose bridge had been closed by exactly that code.
//
// The three codes are counted in the Mod log (the Mod refuses a frame it built) and in the Host's own disconnection records
// (the Host refuses a frame it received), and the two counts are reported separately so a reader can tell which side spoke.
const modLog = existsSync(modLogPath)
  ? readFileSync(modLogPath, "utf8")
  : existsSync(smapiPath)
    ? readFileSync(smapiPath, "utf8")
    : "";
const disconnections = Array.isArray(result.bridgeDisconnections) ? result.bridgeDisconnections : [];
const contractCodes = ["invalid_snapshot", "invalid_args", "invalid_observe_scene_result"];
const modLogLines = modLog === "" ? null : modLog.split("\n");
// The Mod side is a CENSUS: examined = every line of the log, counted = the lines naming one of the three codes, and the
// per-code split falls out of its keys. An unreadable log is `not measured` naming the file, never `0`.
const modContractCensus =
  modLogLines === null
    ? null
    : census(modLogLines, (line) => contractCodes.find((code) => line.includes(code)) ?? null, {
        unit: "mod-log lines",
        source: basename(modLogPath),
        method: `line scan for ${contractCodes.join("/")}`,
        window: RUN_FILES_WINDOW,
      });
// The Host side counts RECORDS, not the JSON text of them: a substring count over `JSON.stringify(...)` counted a code
// twice when one record named it twice. `0 of 0` is a real reading here (the run closed no bridge), which is why this is
// a reading and not a census - a census refuses an empty collection, and "no disconnections" is measured, not unknown.
const hostContractReading = reading({
  value: disconnections.filter((record) => contractCodes.some((code) => JSON.stringify(record).includes(code))).length,
  population: { unit: "bridgeDisconnection records", total: disconnections.length },
  source: "result.json bridgeDisconnections",
  method: `record scan for ${contractCodes.join("/")}`,
  window: RUN_FILES_WINDOW,
});
const contractTotal = (modContractCensus?.counted ?? 0) + hostContractReading.value;
record(
  "1 contract errors",
  // A clean Host side beside an unreadable Mod log is not a pass: the half nobody read is `not measured`, and a PASS
  // over it is the false zero this row exists to prevent (`round20` printed `invalid_snapshot=0 PASS` over a bridge
  // closed by exactly that code).
  contractTotal > 0 ? "FAIL" : modContractCensus === null ? "NOT EXERCISED" : "PASS",
  `mod ${
    modContractCensus === null
      ? `not measured: neither ${modLogPath} nor ${smapiPath} was readable`
      : formatCensus(modContractCensus)
  } | host ${format(hostContractReading)}`,
  `${modLogPath} (mod side) + result.json bridgeDisconnections (host side), whole run`,
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
//
// The count is a CENSUS of the assistant's toolCall parts, not occurrences of the names in the file: `grep`-style
// counting of the token said 97 calls on a run that dispatched 26, because the tool schema that lists the name is in the
// session text too. The population is every toolCall part the turn walk found, so the two plan tools are printed as what
// they are - some of the calls this run made - and a mention of the name cannot be mistaken for a call.
const sessionToolCalls =
  boundSession === null ? [] : sessionTurns(sessionEntries(boundSession)).turns.flatMap((turn) => turn.calls);
const planToolCensus =
  sessionToolCalls.length === 0
    ? null
    : census(sessionToolCalls, (call) => (PLAN_ANSWER_TOOLS.has(call.name) ? call.name : null), {
        unit: "assistant toolCall parts",
        source: basename(boundSession),
        method: "turn walk of message.content",
        window: RUN_FILES_WINDOW,
      });
const planCalls = planToolCensus?.counts.find(({ key }) => key === "stardew_plan_work")?.total ?? 0;
const submitCalls = planToolCensus?.counts.find(({ key }) => key === "stardew_submit_action_program")?.total ?? 0;
record(
  "3 submit_action_program share",
  planToolCensus === null
    ? "NOT EXERCISED"
    : submitCalls === 0
      ? "PASS"
      : submitCalls / (planCalls + submitCalls) < 0.16
        ? "PASS (reduced)"
        : "FAIL",
  planToolCensus === null
    ? `no assistant toolCall part in the session${
        boundSession === null ? " (no session bound to this run)" : ` (${basename(boundSession)})`
      }`
    : formatCensus(planToolCensus),
  boundSession ?? "no session",
);

// 4. Night attribution, from the harness's own assessment.
const assessment = result.multiday?.assessment ?? result.assessment ?? null;
const dayRecords = result.multiday?.dayRecords ?? result.dayRecords ?? [];
// A night that was never crossed has no mechanism to judge, so "no violation" is not a pass - it is the absence of
// evidence. Measured 2026-11-01 on `round20`: `crossed=0, nightsNull=1` reported PASS, which is a green tick over a run
// that never reached the thing this criterion exists to check. `nightsNull` is not the signal either: it counts days whose
// record carries no night, which is 1 on a single-day run for reasons that have nothing to do with attribution.
const nightsJudged = assessment === null ? 0 : (assessment.daysCrossed ?? 0);
record(
  "4 night mechanism",
  assessment === null || nightsJudged === 0
    ? "NOT EXERCISED"
    : (assessment.unobservedNights ?? 0) === 0
      ? "PASS"
      : "FAIL",
  assessment === null
    ? "no assessment in result.json"
    : nightsJudged === 0
      ? `no night was crossed, so there is no mechanism to judge (daysCrossed=0, days recorded=${dayRecords.length})`
      : `crossed=${assessment.daysCrossed} passOut=${assessment.passOutNights} unobserved=${assessment.unobservedNights ?? "n/a"}`,
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
const forageAttempts = mentionedLines({ text: modLog, token: "pickup_forage", source: basename(modLogPath) });
const foragePickups = mentionedLines({ text: modLog, token: "forage_picked_up", source: basename(modLogPath) });
record(
  "6 pickup_forage",
  forageAttempts.value === null || forageAttempts.value === 0
    ? "NOT EXERCISED"
    : foragePickups.value > 0
      ? "PASS"
      : "FAIL",
  `attempts ${format(forageAttempts)} · picked up ${format(foragePickups)}`,
  modLogPath,
);

// 7. Efficiency: the floor this run could have cost, and the buckets the difference went into.
//
// The whole point is that the floor is REFUTABLE from the session alone: it takes the work that settled, the widest plan
// this run itself accepted, and the turn cost this run actually paid, and asks what the fewest turns would have been.
const repoRoot = resolve(".");
const efficiency = efficiencyLines({ sessionFile: boundSession, result, repoRoot });

const width = Math.max(...rows.map((row) => row.name.length));
process.stdout.write(`run   ${runDir}\n`);
process.stdout.write(`state ${result.state ?? "?"}  verdict ${result.sessionVerdict ?? "?"}\n\n`);
for (const row of rows)
  process.stdout.write(`${row.name.padEnd(width)}  ${row.verdict.padEnd(14)} ${row.detail}\n    <- ${row.source}\n`);
process.stdout.write(`\n${efficiency.join("\n")}\n`);
