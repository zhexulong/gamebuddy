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

import { worldDayStartsFromFacts } from "../lib/multiday-baseline.mjs";
import { crossingsFromEvidence } from "../lib/multiday-loop.mjs";
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

/**
 * Every row of the run's own timeline, or `null` with the reason it could not be read.
 *
 * The timeline is the run's record of every fact it received, and it is the one file where both halves of a crossing
 * live: the Mod's `execution_receipt` for the night that ended, and the world's own `day_started` fact for the day it
 * opened. A single unparsable line refuses the whole file rather than half-reading it, and `null` is "not measured" -
 * never zero nights, which is a fact about a run that crossed nothing.
 */
function readTimeline(runDir) {
  const path = join(runDir, "timeline.jsonl");
  if (!existsSync(path))
    return {
      path: null,
      rows: null,
      why: "this run has no timeline.jsonl, so neither its receipts nor its facts were read",
    };
  const rows = [];
  for (const line of readFileSync(path, "utf8").split(/\r?\n/u)) {
    if (line.trim().length === 0) continue;
    try {
      rows.push(JSON.parse(line));
    } catch {
      return {
        path,
        rows: null,
        why: "timeline.jsonl holds a line that is not JSON, so it was refused rather than half-read",
      };
    }
  }
  return { path, rows, why: null };
}

/**
 * The run's crossings from its own evidence, beside the four numbers that produced them.
 *
 * The rule itself lives in `multiday-loop.mjs` (`crossingsFromEvidence`), beside the loop whose closed night it counts:
 * this function only reads the files and renders what came back. A reader must be able to see WHY the number is not the
 * one the artifact published, so every source prints with its own file and the disagreement prints with all of them.
 */
function crossingsBlock(runDir, result) {
  const timeline = readTimeline(runDir);
  const multiday = result.multiday ?? null;
  const derivation = crossingsFromEvidence({
    sleepReceipts: timeline.rows === null ? null : timeline.rows.filter((row) => row?.type === "execution_receipt"),
    dayStartedDays: timeline.rows === null ? null : worldDayStartsFromFacts(timeline.rows),
    dayRecords: Array.isArray(multiday?.dayRecords) ? multiday.dayRecords : null,
    recorded: typeof multiday?.crossings === "number" ? multiday.crossings : null,
  });
  return { timelinePath: timeline.path, timelineWhy: timeline.why, derivation };
}

function crossingsLines({ timelineWhy, derivation }) {
  const label = (name) => `${name.padEnd(19)}`;
  const statusLabel = (name) => `    ${name.padEnd(18)}`;
  const lines = [];
  const push = (line) => lines.push(line);
  push(
    derivation.crossings === null
      ? `${label("nights")} crossings not_decided: the evidence sources disagree, so this verdict states all of them rather than picking one`
      : `${label("nights")} crossings ${String(derivation.crossings)} by the run's own evidence: ${String(derivation.watched)} watched, ${String(derivation.postWatch)} post_watch  (witness ${String(derivation.witness)})`,
  );
  for (const entry of derivation.sources)
    push(
      `${statusLabel(entry.name)} ${
        entry.crossings === null ? "not_measured" : String(entry.crossings)
      }  <- ${entry.source}`,
    );
  if (derivation.observed.length > 0)
    push(
      `${statusLabel("observed")} ${derivation.observed.join(", ")}  (a post_watch night was crossed after the watcher stopped, so it was not watched)`,
    );
  if (timelineWhy !== null) push(`${statusLabel("timeline")} ${timelineWhy}`);
  if (derivation.disagreement !== null)
    push(
      `${statusLabel("DISAGREEMENT")} ${derivation.disagreement}  <- the loop counted the nights it watched and this artifact published that count as the nights it lived`,
    );
  return lines;
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
// A question is anything the companion asked the WORLD - observe, tiles, shape, look_up, scene, search, catalog.
//
// TWO BUCKETS, AND WHY `other` IS GONE. Measured 2026-11-10 (round44): `other` was 117 assistant messages and 919.6 s -
// 45 % of the wall clock - and it described nothing: 107 of those messages made NO tool call at all and 10 were
// `ctx_reduce`. A bucket that is 45 % of a run is not a residual, it is the answer with its name left out. A TURN with no
// tool call is the model speaking only (and is where the recoverable cost of a fact batch that starts a turn for one line
// actually lives); a turn that called a bookkeeping tool priced the run's management, not its work. Everything else falls
// into `questions` (a real conversation with the player), an accepted or refused dispatch, or a poll - so a tool added
// tomorrow still lands in a named bucket instead of landing nowhere.
//
// The same run is why the buckets count prompt turns: those 107 messages were 31 turns (241.8 s, 11.9 % of the wall), and
// the other 76 sat inside turns that had dispatched or polled.
const HOUSEKEEPING_TOOLS = new Set([
  PROGRAM_STATUS_TOOL,
  "stardew_stop_action",
  "stardew_execution_status",
  "stardew_action_program_events",
  "ctx_reduce",
  "ctx_search",
  "my_work",
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
 * One PROMPT TURN per delivered user message, with every assistant message that answered it.
 *
 * A turn is the span from one delivered user message to the next: a fact batch was handed over, and everything the
 * companion did about it belongs to that one turn. It is not an assistant message. Measured on `round44`
 * (2026-11-10): 109 delivered batches produced 257 assistant messages, so pricing each message as a turn reported
 * `speech_only` as 107 turns and 42.6 % of the wall, where the turns that spoke and did nothing were 31 and 11.9 % - the
 * other 76 were messages inside turns that had dispatched or polled, and a turn that dispatched is a dispatch turn.
 *
 * `startMs` is one first-message duration BEFORE that message's own timestamp, because the session writes a message when
 * the provider returns it: `timestamp` is the END and `durationMs` the provider's time. Without the shift the first
 * message's provider time sits before the wall clock opens, which reads as message durations overlapping each other
 * instead of as a span that contains them. Measured over 1528 turns in the 55 sessions of that run directory: with the
 * shift, no turn's span is shorter than the model time inside it.
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
  const messages = [];
  let open = null;
  let deliveries = 0;
  let lastEventAtMs = null;
  for (const entry of entries) {
    const atMs = Date.parse(entry.timestamp);
    if (Number.isFinite(atMs)) lastEventAtMs = atMs;
    const message = entry?.message;
    // A delivered batch OPENS a turn; the assistant messages that follow it are that turn's messages until the next one.
    if (message?.role === "user") {
      open = null;
      deliveries += 1;
      continue;
    }
    if (message?.role !== "assistant") continue;
    if (open === null) {
      open = {
        startMs: null,
        endMs: null,
        durationMs: 0,
        priced: true,
        answeredDelivery: deliveries > 0,
        messages: [],
        calls: [],
        chars: 0,
      };
      turns.push(open);
    }
    const durationMs = typeof message.durationMs === "number" ? message.durationMs : null;
    const content = Array.isArray(message.content) ? message.content : [];
    const calls = content
      .filter((part) => part?.type === "toolCall")
      .map((part) => ({
        name: typeof part.name === "string" ? part.name : "",
        atMs,
        answer: answers.get(part.id) ?? null,
      }));
    const chars = content.reduce(
      (total, part) => total + (part?.type === "text" && typeof part.text === "string" ? part.text.length : 0),
      0,
    );
    const record = { atMs, durationMs, hasTool: calls.length > 0, chars };
    open.messages.push(record);
    messages.push(record);
    open.calls.push(...calls);
    open.chars += chars;
    if (open.startMs === null && Number.isFinite(atMs)) open.startMs = atMs - (durationMs ?? 0);
    if (durationMs === null) open.priced = false;
    else open.durationMs += durationMs;
  }
  for (const [index, turn] of turns.entries())
    turn.endMs = index + 1 < turns.length ? turns[index + 1].startMs : lastEventAtMs;
  return { turns, messages, deliveries, lastEventAtMs };
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
      // From the message that ISSUED the call, not from the turn's first message: a turn can hold several messages, and
      // measuring the wait from the turn's opening would count the work before the call as part of the wait.
      waitMs += Math.max(0, call.answer.atMs - call.atMs);
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

/**
 * A PLAN'S LEAST AUTHORED NODE: WHAT BECAME OF THE STEP THE COMPILER WROTE AND NOBODY ASKED FOR.
 *
 * <p>
 * The compiler writes a node into a plan for one reason - the step before it took the body and the step after it needs that
 * body back (`body-program-script.ts` `BODY_YIELDING_PLAN_ACTION_IDS`) - and a body-yielding step can leave its modal GONE
 * by the time the dismissal is dispatched, because the engine, the pager or the night lifecycle closed it. A node the
 * author never wrote must not then arrive as a failure she has to read and answer with a turn.
 * </p>
 * <p>
 * The population is the set of node ids the COMPILER reported (`insertedNodeIds` on the plan answer), never a node-id
 * prefix and never a substring count: `round44` was summarised as "11 `no_modal_present`" when the truth was two receipts
 * on author-written `n01` nodes and a compiler-inserted node that never ran once - the attribution this field exists to
 * make impossible. A plan that inserted nothing contributes nothing, and a node whose outcome was never recorded is
 * `unmeasured`, not zero.
 * </p>
 * <p>
 * THE READING: an inserted node that did not settle `succeeded` is printed by name
 * (`inserted_node_failed:<nodeId>:<actionId>:<code>`) and fails the run, because a step whose whole purpose is to give the
 * body back is not a step whose failure can be absorbed silently. No population at all is `blocked` with its reason rather
 * than green: a run whose plans inserted nothing has checked nothing.
 * </p>
 */
function measureInsertedNodes(result, turns) {
  const programmes = Array.isArray(result.programOutcomes) ? result.programOutcomes : [];
  const outcomes = new Map(
    programmes
      .filter((programme) => typeof programme?.programId === "string")
      .map((programme) => [programme.programId, programme]),
  );
  let plans = 0;
  let nodes = 0;
  let unmeasuredNodes = 0;
  const refusals = [];
  const turnsWithRefusal = new Set();
  for (const [index, turn] of turns.entries())
    for (const call of turn.calls) {
      if (!PLAN_ANSWER_TOOLS.has(call.name)) continue;
      const answer = call.answer?.payload ?? null;
      const insertedNodeIds = Array.isArray(answer?.insertedNodeIds) ? answer.insertedNodeIds : [];
      if (insertedNodeIds.length === 0) continue;
      plans += 1;
      const programme = typeof answer.programId === "string" ? (outcomes.get(answer.programId) ?? null) : null;
      const byNode = new Map((programme?.nodeOutcomes ?? []).map((node) => [node?.nodeId, node ?? null]));
      for (const nodeId of insertedNodeIds) {
        nodes += 1;
        const settled = byNode.get(nodeId) ?? null;
        if (settled === null) {
          unmeasuredNodes += 1;
          continue;
        }
        if (settled.state === "succeeded") continue;
        refusals.push({
          nodeId,
          actionId: typeof settled.actionId === "string" ? settled.actionId : null,
          code: typeof settled.reasonCode === "string" ? settled.reasonCode : (settled.state ?? "unknown"),
        });
        turnsWithRefusal.add(index);
      }
    }
  return { plans, nodes, unmeasuredNodes, refusals, turnsSpentExplaining: turnsWithRefusal.size };
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

/** The share a reader compares ACROSS runs, to a tenth: a whole percent hides the difference between 42.6 and 43.4. */
function shareToATenth(part, whole) {
  return Number.isFinite(part) && Number.isFinite(whole) && whole > 0
    ? `${((part / whole) * 100).toFixed(1)}%`
    : "not_measured";
}

const seconds = (ms) => (Number.isFinite(ms) ? `${(ms / 1000).toFixed(1)}s` : "not_measured");
const ratio = (actual, floor) =>
  Number.isFinite(actual) && Number.isFinite(floor) && floor > 0 ? `${(actual / floor).toFixed(1)}x` : "not_measured";

/**
 * Whether a long turn was the game owning the actor rather than nothing happening: the status call inside it.
 *
 * The wait is measured from the message that issued the call to the answer's own timestamp, so a turn that spoke first
 * and then polled attributes the wait to the poll rather than to the speaking.
 */
function isWaitingOnTheGame(turn, restMs) {
  const waited = turn.calls
    .filter((call) => call.name === PROGRAM_STATUS_TOOL && call.answer !== null)
    .map((call) => call.answer.atMs - call.atMs);
  if (waited.length === 0) return false;
  return Math.max(...waited) * 2 >= restMs;
}
/**
 * The measured efficiency of one session, priced on PROMPT TURNS.
 *
 * BUCKETS SUM TO THE TURN COUNT BY CONSTRUCTION: each prompt turn is attributed once, by its first call (a turn that
 * dispatches and then polls is a dispatch turn - the poll is part of that dispatch's cost).
 *
 * Seconds are the MODEL time of the turn - the provider latency of the assistant messages it holds. Each turn owns the
 * wall from its own start to the next turn's start, so `sum(turn seconds) + outside_messages = measured wall` holds
 * exactly: what the model spent outside a message in that span is the tool execution and the wait for the next batch.
 * The time that can reach no bucket is a turn whose timestamp cannot be read or whose messages carry no duration, and
 * that is printed as MISSING rather than absorbed.
 */
function measureEfficiency({ sessionFile, result, repoRoot }) {
  if (sessionFile === null) return { missing: "no_session" };
  const entries = sessionEntries(sessionFile);
  const { turns, messages, deliveries, lastEventAtMs } = sessionTurns(entries);
  if (turns.length === 0) return { missing: "no_turns", sessionFile };

  const spans = turns.map((turn) => turnSpanMs(turn));
  const tTurnMs = median(spans.slice(0, -1)) ?? median(messages.map((message) => message.durationMs));
  const wallMs =
    Number.isFinite(lastEventAtMs) && Number.isFinite(turns[0].startMs)
      ? Math.max(0, lastEventAtMs - turns[0].startMs)
      : null;

  const work = measureWork(result, turns);
  const inserted = measureInsertedNodes(result, turns);
  const succeeded = work.states.get("succeeded") ?? 0;
  const buckets = attributeTurns(turns, tTurnMs);
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
  const answeredDeliveries = turns.filter((turn) => turn.answeredDelivery).length;

  return {
    sessionFile,
    turns: turns.length,
    deliveries,
    undeliveredTurns: turns.length - answeredDeliveries,
    unansweredDeliveries: Math.max(0, deliveries - answeredDeliveries),
    messageAxis: messageAxisOf(messages),
    tTurnMs,
    providerMs: median(messages.map((message) => message.durationMs)),
    wallMs,
    work,
    inserted,
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

/**
 * Each prompt turn once, by its first call; each turn's span split into model time and the rest.
 *
 * `outsideMs` is the wall time inside the turns that the model spent outside a message: tool execution and the wait for
 * the next batch. `overlapMs` is the other direction - a turn whose messages claim more time than its own span holds -
 * and it is named rather than netted off, because it means two recorded fields disagree about the same seconds.
 */
function attributeTurns(turns, tTurnMs) {
  const buckets = new Map([
    ["polls", { turns: 0, ms: 0 }],
    ["questions", { turns: 0, ms: 0 }],
    ["dispatches", { turns: 0, ms: 0 }],
    ["refused_dispatches", { turns: 0, ms: 0 }],
    ["housekeeping", { turns: 0, ms: 0 }],
    ["speech_only", { turns: 0, ms: 0 }],
  ]);
  const counts = {
    pollsBeforeDispatch: 0,
    unansweredTurns: 0,
    outsideMs: 0,
    overlapMs: 0,
    overlapTurns: 0,
    unmeasuredTurns: 0,
    unpricedTurns: 0,
    longTurns: 0,
    longOutsideMs: 0,
    longWaitingMs: 0,
  };
  // The speech-only turns' own durations and text sizes, kept so the bucket can print the MEDIAN turn and the MEDIAN text
  // rather than only its total: a share says where the wall went, a median says what one such turn costs - and seven
  // seconds spent on forty characters is a different finding from seven seconds spent on a paragraph.
  const speechDurations = [];
  const speechChars = [];
  let dispatchedSoFar = 0;
  for (const turn of turns) {
    const bucket = bucketOfTurn(turn.calls[0] ?? null, () => dispatchedSoFar, counts);
    if (bucket === "dispatches") dispatchedSoFar += 1;
    if (bucket === "speech_only") {
      speechChars.push(turn.chars);
      if (turn.priced) speechDurations.push(turn.durationMs);
    }
    buckets.get(bucket).turns += 1;
    if (!turn.priced) {
      counts.unpricedTurns += 1;
      continue;
    }
    buckets.get(bucket).ms += turn.durationMs;
    const spanMs = turnSpanMs(turn);
    if (spanMs === null) {
      counts.unmeasuredTurns += 1;
      continue;
    }
    const restMs = spanMs - turn.durationMs;
    if (restMs < 0) {
      counts.overlapTurns += 1;
      counts.overlapMs -= restMs;
      continue;
    }
    counts.outsideMs += restMs;
    if (spanMs > 3 * tTurnMs) {
      counts.longTurns += 1;
      counts.longOutsideMs += restMs;
      if (isWaitingOnTheGame(turn, restMs)) counts.longWaitingMs += restMs;
    }
  }
  return {
    buckets: [...buckets.entries()].map(([name, bucket]) => ({ name, ...bucket })),
    speechOnlyTurnMs: median(speechDurations),
    speechOnlyChars: median(speechChars),
    speechOnlyCharsLargest: speechChars.length === 0 ? null : Math.max(...speechChars),
    ...counts,
  };
}

/** A turn's own share of the wall: from its start to the next turn's start, or to the last recorded event. */
function turnSpanMs(turn) {
  return Number.isFinite(turn.startMs) && Number.isFinite(turn.endMs) ? turn.endMs - turn.startMs : null;
}

/**
 * The same assistant messages, grouped the other way: what the message axis says about the same seconds.
 *
 * Both axes sum the SAME field - one provider latency per assistant message - so their totals are comparable and only the
 * grouping differs; a message inside a dispatching turn is not a second turn.
 */
function messageAxisOf(messages) {
  const axis = {
    count: messages.length,
    total: 0,
    withTool: 0,
    withToolCount: 0,
    withoutTool: 0,
    withoutToolCount: 0,
    withoutDuration: 0,
  };
  for (const message of messages) {
    if (message.hasTool) axis.withToolCount += 1;
    else axis.withoutToolCount += 1;
    if (message.durationMs === null) {
      axis.withoutDuration += 1;
      continue;
    }
    axis.total += message.durationMs;
    if (message.hasTool) axis.withTool += message.durationMs;
    else axis.withoutTool += message.durationMs;
  }
  return axis;
}

/**
 * Which bucket one turn belongs to.
 *
 * `polls` means polls AFTER a programme was already dispatched: a status call before the first dispatch learns nothing
 * about work in flight, so it is a check on the machine (housekeeping) and the block says how many.
 *
 * A dispatch whose ANSWER never arrived stays a dispatch: the turn issued one, so its cost is a dispatch's cost, and the
 * `unanswered` line names it so it is never read as a refusal.
 */
function bucketOfTurn(first, dispatchedSoFar, counts) {
  if (first === null) return "speech_only";
  if (PLAN_ANSWER_TOOLS.has(first.name)) {
    const answer = first.answer?.payload ?? null;
    if (answer === null || typeof answer.accepted !== "boolean") {
      counts.unansweredTurns += 1;
      return "dispatches";
    }
    return answer.accepted ? "dispatches" : "refused_dispatches";
  }
  if (first.name === PROGRAM_STATUS_TOOL) {
    if (dispatchedSoFar() > 0) return "polls";
    counts.pollsBeforeDispatch += 1;
    return "housekeeping";
  }
  if (HOUSEKEEPING_TOOLS.has(first.name)) return "housekeeping";
  return first.name.startsWith("stardew_") ? "questions" : "housekeeping";
}

const notMeasured = (field) => `not_measured (${field})`;

/** The wall clock that reached no bucket at all: positive when seconds are missing, negative on the impossible side. */
function accountingMissingMs(report) {
  if (report.wallMs === null) return 0;
  const measured = report.buckets.reduce((total, bucket) => total + bucket.ms, 0) + report.outsideMs - report.overlapMs;
  return report.wallMs - measured;
}

/** Below this the two sides of the accounting are the same number read twice; above it, one of them is wrong. */
const ACCOUNTING_TOLERANCE_MS = 1000;

/**
 * Why the turn axis does not add up, or null when it does.
 *
 * The turns' own spans partition the wall exactly, so the accounting has two shapes to fail on and neither is an
 * identity: seconds that reached no bucket at all (a turn whose timestamp or message duration cannot be read), and a
 * turn whose declared message durations claim more time than its own span holds (two recorded fields disagreeing about
 * the same seconds). A run where either happens prints no shares, because a share of a wall that did not add up prices
 * nothing.
 */
function accountingFailure(report) {
  if (report.wallMs === null) return null;
  const missingMs = accountingMissingMs(report);
  if (Math.abs(missingMs) >= ACCOUNTING_TOLERANCE_MS)
    return {
      missingMs,
      text: `${seconds(Math.abs(missingMs))} of the ${seconds(report.wallMs)} wall reaches no bucket (${String(
        report.unmeasuredTurns,
      )} turn(s) with no readable timestamp, ${String(report.unpricedTurns)} with no message duration)`,
    };
  if (report.overlapMs >= ACCOUNTING_TOLERANCE_MS)
    return {
      missingMs,
      text: `${seconds(report.overlapMs)} of declared message duration in ${String(
        report.overlapTurns,
      )} turn(s) claims more time than those turns' spans hold`,
    };
  return null;
}

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
      "  field             session assistant messages - the record holds none, so there is no prompt turn to price",
    ];
  // A BLOCK WHOSE BUCKETS DO NOT ADD UP MUST FAIL, not print shares that are fractions of different wholes. The
  // verdict's job here is arithmetic, so a wall clock with seconds in no bucket is a defect in this report rather than a
  // reading of the run, and it exits non-zero after printing the seconds it could not place.
  if (accountingFailure(report) !== null) process.exitCode = 1;
  // A STEP THE COMPILER WROTE IS NOT A STEP WHOSE FAILURE CAN BE ABSORBED: it exists to give the body back to the step after
  // it, so a run in which one did not succeed is a run whose next node was at risk - named by node, action and code.
  if (report.inserted.refusals.length > 0) process.exitCode = 1;
  return formatEfficiency(report);
}

function formatEfficiency(report) {
  const { work, succeeded, families, playerTasks, objectives } = report;
  const label = (name) => `${name.padEnd(19)}`;
  const statusLabel = (name) => `    ${name.padEnd(18)}`;
  const shares = (ms) => percentOf(ms, report.wallMs);
  const crossCheckAgrees =
    report.crossCheck.turnWalk === report.crossCheck.parse && report.crossCheck.parse === report.crossCheck.answers;
  const totalBucketTurns = report.buckets.reduce((total, bucket) => total + bucket.turns, 0);
  const turnMs = report.buckets.reduce((total, bucket) => total + bucket.ms, 0);
  const measuredMs = turnMs + report.outsideMs - report.overlapMs;
  const largest = [...report.buckets, { name: "outside_messages", turns: 0, ms: report.outsideMs }].sort(
    (left, right) => right.ms - left.ms,
  )[0];
  const axis = report.messageAxis;
  const perTurn = axis.count / report.turns;
  const failure = accountingFailure(report);
  const missingMs = accountingMissingMs(report);
  const bucket = (name) => report.buckets.find((entry) => entry.name === name) ?? { turns: 0, ms: 0 };
  const speech = bucket("speech_only");
  const chars = (value) => (value === null ? "not_measured" : `${value} chars`);

  const lines = [];
  const push = (line) => lines.push(line);
  push(`efficiency          session ${report.sessionFile}`);
  push(
    `  ${label("prompt_turns")} ${String(report.turns)} - one turn per delivered user message, running to the next one${deliveryNote(report)}`,
  );
  push(
    `  ${label("assistant_messages")} ${String(axis.count)} (${perTurn.toFixed(1)} per prompt turn) - the unit the buckets below do NOT count: a turn that dispatched keeps every message it took to dispatch`,
  );
  push(
    `  ${label("T_turn")} ${seconds(report.tTurnMs)}  median span from one prompt turn to the next (provider latency median ${seconds(report.providerMs)} over ${String(axis.count)} assistant messages)`,
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
  if (report.inserted.plans === 0)
    push(
      `  ${label("inserted_nodes")} blocked: this run's plans inserted nothing, so the gate examined 0 inserted node(s) - not green, nothing to check`,
    );
  else {
    push(
      `  ${label("inserted_nodes")} ${report.inserted.nodes} node(s) the compiler wrote across ${report.inserted.plans} plan(s), ${
        report.inserted.refusals.length
      } not succeeded${report.inserted.unmeasuredNodes > 0 ? `, ${report.inserted.unmeasuredNodes} with no recorded outcome (unmeasured, not zero)` : ""}${report.inserted.turnsSpentExplaining > 0 ? `, ${report.inserted.turnsSpentExplaining} turn(s) carried one` : ""}  <- plan answers' insertedNodeIds joined to result.json programOutcomes[].nodeOutcomes`,
    );
    for (const refusal of report.inserted.refusals)
      push(
        `  ${label("")} inserted_node_failed:${refusal.nodeId}:${refusal.actionId ?? "unknown"}:${refusal.code} - the compiler wrote this node to give the body back, and the world answered it as a failure`,
      );
  }
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
  push(
    `  model_seconds_per_completed_action  ${
      succeeded === 0
        ? notMeasured("no node reached `succeeded`, so there is no action to divide by")
        : `${seconds(turnMs)} / ${succeeded} actions = ${(turnMs / succeeded / 1000).toFixed(1)}s per action (assistant time / actions_done)`
    }`,
  );
  push(
    `  ${label("actual")} ${report.turns} prompt turns (${axis.count} assistant messages), ${seconds(report.wallMs)} (first turn -> last recorded event)`,
  );
  push(
    `  ${label("ratio")} turns ${ratio(report.turns, report.floorTurns)} | wall ${ratio(report.wallMs, report.floorWallMs)}`,
  );
  push(`  ${label("buckets")} turns   seconds   share   (a turn = one prompt turn)`);
  for (const bucketRow of report.buckets)
    push(
      `${statusLabel(bucketRow.name)} ${String(bucketRow.turns).padStart(4)}  ${seconds(bucketRow.ms).padStart(8)}  ${shares(bucketRow.ms)}`,
    );
  push(
    `${statusLabel("outside_messages")} ${String(0).padStart(4)}  ${seconds(report.outsideMs).padStart(8)}  ${shares(report.outsideMs)}${outsideNote(report)}`,
  );
  const tail =
    report.wallMs === null
      ? " wall not_measured (no readable span from the first prompt turn to the last event)"
      : failure === null
        ? ` of the ${seconds(report.wallMs)} wall, nothing unaccounted`
        : Math.abs(missingMs) >= ACCOUNTING_TOLERANCE_MS
          ? ` against the ${seconds(report.wallMs)} wall, ${missingMs > 0 ? "MISSING" : "SURPLUS"} ${seconds(Math.abs(missingMs))} in no bucket`
          : ` against the ${seconds(report.wallMs)} wall, ${seconds(report.overlapMs)} of message duration beyond the spans those turns hold`;
  push(
    `  ${label("accounting")} ${totalBucketTurns} bucket turns ${totalBucketTurns === report.turns ? "=" : "!="} ${report.turns} prompt turns | ${seconds(
      turnMs,
    )} turn seconds + ${seconds(report.outsideMs)} outside_messages${
      report.overlapMs > 0 ? ` - ${seconds(report.overlapMs)} overlapping message duration` : ""
    } = ${seconds(measuredMs)}${tail}`,
  );
  if (failure !== null)
    push(`  ${label("ACCOUNTING FAILURE")} ${failure.text}: the buckets do not add up, so no share here can be read`);
  push(
    `  ${label("accounting_messages")} ${seconds(axis.total)} of assistant time over ${String(axis.count)} messages = ${seconds(
      axis.withoutTool,
    )} in ${String(axis.withoutToolCount)} with no tool call + ${seconds(axis.withTool)} in ${String(
      axis.withToolCount,
    )} with one - the same field the turn axis sums, grouped the other way${
      axis.withoutDuration === 0
        ? ""
        : `; ${String(axis.withoutDuration)} message(s) carry no duration, so their seconds are in neither sum`
    }`,
  );
  push(
    `  ${label("speech_only")} ${String(speech.turns)} of ${report.turns} prompt turns made no tool call: ${seconds(
      speech.ms,
    )} (${shareToATenth(speech.ms, report.wallMs)} of the wall), median turn ${seconds(
      report.speechOnlyTurnMs,
    )}, median text ${chars(report.speechOnlyChars)}, largest ${chars(report.speechOnlyCharsLargest)}`,
  );
  push(
    `  ${label("speech_only_messages")} ${String(axis.withoutToolCount)} messages · ${seconds(axis.withoutTool)} - the same turns read by message, where a turn's extra messages are not extra turns`,
  );
  if (report.unansweredTurns > 0 || report.crossCheck.parse !== report.crossCheck.answers)
    push(
      `  ${label("unanswered")} ${report.crossCheck.parse - report.crossCheck.answers} answered call(s) are missing and ${report.unansweredTurns} turn(s) received no answer at all - priced as dispatches, not as refusals`,
    );
  if (report.pollsBeforeDispatch > 0)
    push(
      `  ${label("")} ${report.pollsBeforeDispatch} status call(s) came before any dispatch, so they are in housekeeping rather than polls`,
    );
  push(`  ${label("cross-check")} ${crossCheckText(report.crossCheck, crossCheckAgrees)}`);
  push(`  ${label("reading")} ${readingText(report, largest)}`);
  return lines;
}

/** The deliveries that produced nothing, said out loud rather than folded into a turn that did work. */
function deliveryNote(report) {
  const parts = [];
  if (report.undeliveredTurns > 0)
    parts.push(`${String(report.undeliveredTurns)} turn(s) ran before the first delivered message`);
  if (report.unansweredDeliveries > 0)
    parts.push(`${String(report.unansweredDeliveries)} delivered message(s) produced no assistant message`);
  return parts.length === 0 ? "" : ` (${parts.join("; ")})`;
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

/**
 * What the wall spent inside the turns without the model inside a message, and the long turns that held it.
 *
 * A long turn is one whose span exceeds 3 x T_turn: that is the stall class - a batch handed over and then nothing
 * happening - and splitting it out keeps a single stuck turn from being read as turns that did work.
 */
function outsideNote(report) {
  const held =
    report.longTurns === 0
      ? ""
      : `; ${String(report.longTurns)} long turn(s) held ${seconds(report.longOutsideMs)} of it${
          report.longWaitingMs === 0
            ? ""
            : `, ${seconds(report.longWaitingMs)} inside a status call waiting on the game`
        }`;
  return `  (time the wall spent inside those turns with the model not inside a message: tool execution and the wait for the next batch${held})`;
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
  const bucket = (name) => report.buckets.find((entry) => entry.name === name) ?? { turns: 0, ms: 0 };
  const speech = bucket("speech_only");
  const polls = bucket("polls");
  // SPEECH-ONLY AGAINST POLLING, as a comparison rather than a fixed story: which of the two is the larger recoverable
  // cost is a fact about the run, and stating it as a number keeps the reading honest on a run where polling wins.
  const recoverable =
    speech.turns === 0
      ? ""
      : `; speech_only is ${shareToATenth(speech.ms, report.wallMs)} of the wall in ${String(speech.turns)} prompt turn(s) that made no tool call (${seconds(speech.ms)}), against ${seconds(polls.ms)} in ${String(polls.turns)} poll turn(s)`;
  return `with the same work at ${width} nodes per plan and zero polls, this run would have cost ${turns}${wall}, ${ratio(
    report.wallMs,
    report.floorWallMs,
  )} less wall clock; the largest single bucket was ${largest.name} at ${seconds(largest.ms)} (${percentOf(largest.ms, report.wallMs)})${recoverable}`;
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
// THE CROSSINGS, FROM THE EVIDENCE RATHER THAN FROM THE NIGHTS THAT WERE WATCHED.
//
// Measured 2026-11-10 (round44): three `sleep` receipts reached `day_advanced`, the world published three
// `day_started` facts, and the artifact said `crossings: 2` because the third night was crossed inside the CLOSING
// day's turn, after which no watcher runs. The count was named for the nights that happened and counted the nights
// somebody watched, so this row and the block below it state both, and name the crossing nobody watched.
const crossings = crossingsBlock(runDir, result);
const crossingsText =
  crossings.derivation.crossings === null
    ? "crossed=not_decided (the evidence sources disagree: see the nights block)"
    : `crossed=${String(crossings.derivation.crossings)} (evidence: ${String(crossings.derivation.watched)} watched, ${String(crossings.derivation.postWatch)} post_watch)`;
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
      : `${crossingsText} passOut=${assessment.passOutNights} unobserved=${assessment.unobservedNights ?? "n/a"}`,
  crossings.timelinePath === null ? resultPath : `${resultPath} + ${crossings.timelinePath}`,
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
process.stdout.write(`\n${crossingsLines(crossings).join("\n")}\n`);
process.stdout.write(`\n${efficiency.join("\n")}\n`);
