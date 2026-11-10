#!/usr/bin/env node
/**
 * One reader for the questions a finished run is read with, one subcommand per question.
 *
 * WHY. Twelve ad-hoc `.tmp/*.mjs` scripts answered these questions one session at a time, and every one of them threw
 * its population away: `think42.mjs` printed the passages that matched a phrase and never said how many it examined;
 * `codes42.mjs` counted codes by matching a regex against the RAW JSONL TEXT, where a code that appears in a schema or
 * in the prompt counted as a failure; `progress42.mjs` matched `"total":N,"settled":N` in that same text and reported
 * the last match as "the newest programme". Each was written to answer a question and each answered a slightly
 * different one, so two of them could disagree about the same run and neither could be checked. The defect class is
 * `tools/audit-run-reading-shape.mjs`'s: a count of a token in a text blob, reported as a count of events.
 *
 * WHAT THIS DOES INSTEAD. Every number is counted from PARSED RECORDS - `message.content[]` parts, JSON payloads inside
 * a text part, and the bundle's own fields - and printed beside the four facts that make it a measurement: the value,
 * its population (`N of M <unit>`), its source (file and field), and the window it covers. A question whose input is
 * absent prints `not measured` naming the field it needed, and exits 2; it never prints 0, because "we never looked"
 * and "we looked and found none" are different findings and only one of them is about the run.
 *
 * THE SEAM NOTE. `tools/lib/reading.mjs` is the shared seam for exactly these four facts (`reading`, `census`,
 * `format`, `crossCheck`). This file prints them by hand instead of importing it: the switch is the NAMED FOLLOW-UP in
 * this folder's README, a two-line change, so that moving four readers into one folder and changing how their numbers
 * are built stay two reviewable units. It must happen before `tools/audit-run-reading-shape.mjs` is wired into
 * `tools/prelive.mjs`'s L0 rung - that gate populations every `.mjs` under `tools/live-run/`, this file included, and
 * the routing is what makes the four facts structural instead of a convention this header asks a reader to trust.
 *
 * Usage:
 *   node tools/live-run/analysis/session-reading.mjs --run <dir> [--session <path>] --question tools
 *   node tools/live-run/analysis/session-reading.mjs --run <dir> --question turns
 *   node tools/live-run/analysis/session-reading.mjs --run <dir> --question codes
 *   node tools/live-run/analysis/session-reading.mjs --run <dir> --question nodes
 *   node tools/live-run/analysis/session-reading.mjs --run <dir> --question thinking <phrase>
 *   node tools/live-run/analysis/session-reading.mjs --run <dir> --question progress
 *   node tools/live-run/analysis/session-reading.mjs --run <dir> --question shape <action>
 *
 * It reads `.live-runs/**` and a session file. It starts no game, builds nothing, and writes nothing.
 *
 * Exit: 0 when every number on screen was measured, 2 when one of them is `not measured` or the arguments are wrong.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** A node state that is an ending: after it, nothing else happens to that node. */
const ENDED_STATES = Object.freeze(
  new Set(["succeeded", "failed", "rejected", "cancelled", "abandoned", "recovery_required", "uncertain"]),
);

/** The endings a reader asks `why` about: an ending that is not success, and so should carry a code. */
const NON_SUCCESS_STATES = Object.freeze(
  new Set(["failed", "rejected", "cancelled", "abandoned", "recovery_required", "uncertain"]),
);

/** A gap longer than this is read as silence rather than as one turn following another. */
const SILENCE_MS = 60_000;

const QUESTIONS = Object.freeze(["tools", "turns", "codes", "nodes", "thinking", "progress", "shape"]);

/** The questions whose input is the run's bundle rather than its session. */
const BUNDLE_QUESTIONS = Object.freeze(new Set(["nodes", "progress"]));

function out(line) {
  process.stdout.write(`${line}\n`);
}

// ---------------------------------------------------------------------------------------------------------------
// The four facts, printed by hand. One line shape per question, so a reader never has to guess which population a
// number came out of: `<label>  <value> of <total> <unit>`, under a block that names the source, the method and the
// window ONCE for every row below it.
// ---------------------------------------------------------------------------------------------------------------

/** A duration, a median, a share: a number whose unit is not a count of the population it was taken over. */
function magnitude(value, of, unit) {
  return `${value} over ${of.count} of ${of.total} ${unit}`;
}

/** A count of members of a population: `26 of 281 toolCall parts`. */
function count(value, total, unit) {
  return `${value} of ${total} ${unit}`;
}

/** The sentence a question prints when its input is absent. Never a zero. */
function notMeasured(unit, { reason, missingField }) {
  return `not measured: ${unit} - ${reason}; needs ${missingField}`;
}

/** The source/method/window block, printed once per question. */
function facts({ source, method, window }) {
  out(`  source              ${source}`);
  out(`  method              ${method}`);
  out(`  window              ${window}`);
}

function row(label, reading) {
  out(`  ${label.padEnd(20)} ${reading}`);
}

// ---------------------------------------------------------------------------------------------------------------
// Records. Every reader below walks these; nothing counts a token in a line of text.
// ---------------------------------------------------------------------------------------------------------------

/** Every JSONL record of one file, with its 0-based line index, so a finding can name where it was seen. */
function readJsonl(path) {
  const entries = [];
  let index = 0;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (line.trim() !== "") {
      let record;
      try {
        record = JSON.parse(line);
      } catch {
        record = null;
      }
      if (record !== null) entries.push({ index, record });
    }
    index += 1;
  }
  return entries;
}

/** The newest file named `wanted` (or any `.jsonl`) under one directory tree, by mtime. */
function newestUnder(root, wanted) {
  if (!existsSync(root)) return null;
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

function readResult(runDir) {
  const path = join(runDir, "result.json");
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

/**
 * The session file this run wrote, from the three places one can be named.
 *
 * `--session` wins because a reader checking an OLD run has to be able to point at that run's record. Otherwise the
 * bundle's own `toolTiming.record` names the file the harness bound, and a run stopped by hand published no bundle at
 * all - so the newest `.jsonl` under its runtime root is the activation the launch wrote.
 */
function resolveSession({ runDir, result, explicit }) {
  if (typeof explicit === "string") {
    return existsSync(explicit)
      ? { path: resolve(explicit), why: "named by --session" }
      : { path: null, missing: `--session ${explicit}`, reason: "the file named by --session does not exist" };
  }
  if (runDir === null) return { path: null, missing: "--session", reason: "no --run directory and no --session" };
  const contexts = join(runDir, "runtime-root", "contexts");
  const record = result?.toolTiming?.record;
  if (typeof record === "string") {
    const found = newestUnder(contexts, (entry) => entry === record);
    if (found !== null) return { path: found, why: "result.json toolTiming.record" };
  }
  const newest = newestUnder(contexts, (entry) => entry.endsWith(".jsonl"));
  return newest === null
    ? {
        path: null,
        missing: "runtime-root/contexts/**/sessions/*.jsonl (or result.json toolTiming.record)",
        reason: "this run directory holds no session record",
      }
    : { path: newest, why: "newest .jsonl under runtime-root/contexts (the run published no toolTiming.record)" };
}

/** The window a reading covers: the run's own bounds when the bundle has them, else the session's own span. */
function runWindow({ result, entries }) {
  const start = Number(result?.startedAtMs);
  const end = Number(result?.endedAtMs);
  if (Number.isFinite(start) && Number.isFinite(end) && end > start)
    return { text: `this run's window ${clock(start)}-${clock(end)} (result.json startedAtMs..endedAtMs)`, start, end };
  const stamps = entries
    .map(({ record }) => Date.parse(record?.message?.timestamp ?? record?.timestamp ?? ""))
    .filter((value) => Number.isFinite(value));
  if (stamps.length > 0)
    return {
      text: `the session's own span ${clock(Math.min(...stamps))}-${clock(Math.max(...stamps))} (first..last record timestamp)`,
      start: Math.min(...stamps),
      end: Math.max(...stamps),
    };
  return { text: "no window: neither result.json nor a session record carried a timestamp", start: null, end: null };
}

function clock(ms) {
  return new Date(ms).toISOString().slice(11, 16);
}

/** Every `toolCall` part in the session, by name. A structured part, never a mention of the name in any text. */
function toolCallParts(entries) {
  const parts = [];
  for (const { index, record } of entries) {
    const content = record?.message?.content;
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      if (part?.type === "toolCall" && typeof part.name === "string") parts.push({ index, name: part.name });
    }
  }
  return parts;
}

/** Every assistant message, with the wall clock it arrived at and the wall clock the provider took to make it. */
function assistantTurns(entries) {
  const turns = [];
  for (const { index, record } of entries) {
    const message = record?.message;
    if (message?.role !== "assistant") continue;
    const atMs = Number.isFinite(message.timestamp) ? message.timestamp : Date.parse(record.timestamp ?? "");
    const content = Array.isArray(message.content) ? message.content : [];
    turns.push({
      index,
      atMs,
      durationMs: Number.isFinite(message.durationMs) ? message.durationMs : null,
      calls: content.filter((part) => part?.type === "toolCall").length,
    });
  }
  return turns;
}

/** Every structured JSON payload carried inside a `text` part, with the record index and the role that carried it. */
function structuredParts(entries) {
  const parts = [];
  for (const { index, record } of entries) {
    const content = record?.message?.content;
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      if (part?.type !== "text" || typeof part.text !== "string") continue;
      const text = part.text.trim();
      if (!(text.startsWith("{") || text.startsWith("["))) continue;
      let value;
      try {
        value = JSON.parse(text);
      } catch {
        continue;
      }
      parts.push({ index, role: record?.message?.role ?? "?", value });
    }
  }
  return parts;
}

/**
 * Every node row the session published, whichever shape carried it.
 *
 * A programme's rows arrive as `{actionId, state, ...}` - a plan answer's `nodes`, a settled batch's payload - with the
 * coordinates under `tile` or under `x`/`y`, and the reason under `failureCode`, `reasonCode` or `rejectionCode`. The
 * shapes were measured on the 2026-11-09 `multiday_routine` session: seven distinct key sets, 837 rows.
 */
/** The tile a node row named, under either shape the journal uses: `tile{x,y}` or bare `x`/`y`. */
function tileOf(value) {
  const tile = value.tile !== null && typeof value.tile === "object" ? value.tile : {};
  const x = Number.isFinite(tile.x) ? tile.x : value.x;
  const y = Number.isFinite(tile.y) ? tile.y : value.y;
  return Number.isFinite(x) && Number.isFinite(y) ? { x: Number(x), y: Number(y) } : null;
}

/** The code a node row carried, from whichever field its ending used. */
function codeOf(value) {
  for (const field of ["failureCode", "reasonCode", "rejectionCode"])
    if (typeof value[field] === "string" && value[field] !== "") return value[field];
  return null;
}

const isNodeRow = (value) => typeof value.actionId === "string" && typeof value.state === "string";

/**
 * Every node row the session published, whichever shape carried it.
 *
 * A programme's rows arrive as `{actionId, state, ...}` - a plan answer's `nodes`, a settled batch's payload - with the
 * coordinates under `tile` or under `x`/`y`, and the reason under `failureCode`, `reasonCode` or `rejectionCode`. The
 * shapes were measured on the 2026-11-09 `multiday_routine` session: seven distinct key sets, 955 rows.
 *
 * THE SAME PAYLOAD IS REACHABLE TWICE in one record (measured on that session: record 78 carries four programmes' node
 * lists, and each list appears twice in the JSON tree), so a row is deduped by its own serialised content WITHIN its
 * record. `index` alone is not an identity: the same `index: 0` in one record names four different actions, because a
 * node's index is its position in ITS programme, and a record can carry several.
 */
function nodeRows(entries) {
  const rows = [];
  const seen = new Set();
  const walk = (value, index, role, depth) => {
    if (depth > 8 || value === null || typeof value !== "object") return;
    if (Array.isArray(value)) {
      for (const item of value) walk(item, index, role, depth + 1);
      return;
    }
    if (isNodeRow(value)) {
      const dedupe = `${index}\u0000${JSON.stringify(value)}`;
      if (!seen.has(dedupe)) {
        seen.add(dedupe);
        rows.push({
          index,
          role,
          actionId: value.actionId,
          state: value.state,
          nodeId: typeof value.nodeId === "string" ? value.nodeId : null,
          code: codeOf(value),
          hint: typeof value.hint === "string" ? value.hint : null,
          tile: tileOf(value),
        });
      }
    }
    for (const item of Object.values(value)) walk(item, index, role, depth + 1);
  };
  for (const part of structuredParts(entries)) walk(part.value, part.index, part.role, 0);
  return rows;
}

function tally(values) {
  const counts = new Map();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return [...counts.entries()].sort(
    (left, right) => right[1] - left[1] || String(left[0]).localeCompare(String(right[0])),
  );
}

function median(values) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle] : Math.round((sorted[middle - 1] + sorted[middle]) / 2);
}

const seconds = (ms) => (Number.isFinite(ms) ? `${(ms / 1000).toFixed(1)}s` : "not measured");

// ---------------------------------------------------------------------------------------------------------------
// The questions.
// ---------------------------------------------------------------------------------------------------------------

function questionTools({ context }) {
  const { entries, sessionName, window } = context;
  const parts = toolCallParts(entries);
  facts({
    source: `${sessionName}, message.content[] parts of type toolCall (field: name)`,
    method:
      "structured parse of every assistant message's parts; a name mentioned in any text or thinking part is not counted",
    window: window.text,
  });
  if (parts.length === 0) {
    row(
      "tool calls",
      notMeasured("toolCall parts", {
        reason: "the session holds no toolCall part",
        missingField: "message.content[].type=toolCall",
      }),
    );
    return 2;
  }
  out("");
  row("tool calls", count(parts.length, parts.length, "toolCall parts"));
  for (const [name, total] of tally(parts.map((part) => part.name)))
    row(`  ${name}`, count(total, parts.length, "toolCall parts"));
  return 0;
}

function questionTurns({ context }) {
  const { entries, sessionName, window } = context;
  const turns = assistantTurns(entries).filter((turn) => Number.isFinite(turn.atMs));
  const messages = entries.filter(({ record }) => record?.message !== undefined).length;
  facts({
    source: `${sessionName}, message.role=assistant (fields: timestamp, durationMs, content[])`,
    method:
      "structured parse; a turn is one assistant message, and a gap is the wall clock between two consecutive ones",
    window: window.text,
  });
  if (turns.length === 0) {
    row(
      "assistant turns",
      notMeasured("assistant messages", {
        reason: "the session holds no assistant message with a timestamp",
        missingField: "message.timestamp",
      }),
    );
    return 2;
  }
  const gaps = [];
  for (let index = 1; index < turns.length; index += 1) {
    const gap = turns[index].atMs - turns[index - 1].atMs;
    if (Number.isFinite(gap) && gap >= 0) gaps.push({ gap, after: turns[index - 1] });
  }
  const timed = turns.filter((turn) => turn.durationMs !== null);
  const toolOwned = gaps
    .filter((entry) => entry.after.calls > 0 && entry.after.durationMs !== null)
    .map((entry) => Math.max(0, entry.gap - entry.after.durationMs));
  const silences = gaps.filter((entry) => entry.gap >= SILENCE_MS).map((entry) => entry.gap);
  out("");
  row("assistant turns", count(turns.length, messages, "message records"));
  row(
    "turn gap p50",
    magnitude(
      seconds(median(gaps.map((entry) => entry.gap))),
      { count: gaps.length, total: gaps.length },
      "inter-turn gaps",
    ),
  );
  row(
    "turn gap max",
    magnitude(
      seconds(Math.max(...gaps.map((entry) => entry.gap))),
      { count: gaps.length, total: gaps.length },
      "inter-turn gaps",
    ),
  );
  row(
    "model time",
    magnitude(
      seconds(timed.reduce((sum, turn) => sum + turn.durationMs, 0)),
      { count: timed.length, total: turns.length },
      "assistant turns carrying durationMs",
    ),
  );
  row(
    "tool time",
    toolOwned.length === 0
      ? notMeasured("tool seconds", {
          reason: "no turn that followed a tool call carried both a timestamp and a duration",
          missingField: "message.durationMs on a tool-calling turn",
        })
      : magnitude(
          seconds(toolOwned.reduce((sum, value) => sum + value, 0)),
          { count: toolOwned.length, total: gaps.length },
          "gaps after a tool-calling turn, each minus its model time",
        ),
  );
  row(
    `silence >= ${SILENCE_MS / 1000}s`,
    silences.length === 0
      ? count(0, gaps.length, `gaps (none reached ${SILENCE_MS / 1000}s)`)
      : magnitude(
          `${silences.length} gap(s), longest ${seconds(Math.max(...silences))}`,
          { count: silences.length, total: gaps.length },
          "inter-turn gaps",
        ),
  );
  row(
    "wall clock",
    `${seconds(window.end === null ? null : window.end - window.start)} (the span of the window named above)`,
  );
  return toolOwned.length === 0 ? 2 : 0;
}

function questionCodes({ context }) {
  const { entries, sessionName, window } = context;
  const rows = nodeRows(entries);
  const terminal = rows.filter((entry) => NON_SUCCESS_STATES.has(entry.state));
  facts({
    source: `${sessionName}, JSON payloads inside text parts, node rows (fields: actionId, state, failureCode/reasonCode/rejectionCode)`,
    method:
      "structured parse of each text part as JSON, walking every node row; a code inside a schema, a prompt or an unparsed line is not counted",
    window: window.text,
  });
  out(`  examined            ${rows.length} node rows, of which ${terminal.length} carry a terminal state`);
  if (rows.length === 0) {
    row(
      "terminal codes",
      notMeasured("coded terminal nodes", {
        reason: "the session holds no parsed node row",
        missingField: "a text part whose JSON carries {actionId, state}",
      }),
    );
    return 2;
  }
  const coded = terminal.filter((entry) => entry.code !== null);
  if (coded.length === 0) {
    row(
      "terminal codes",
      notMeasured("coded terminal nodes", {
        reason: `${terminal.length} terminal node row(s) carried no code`,
        missingField: "failureCode/reasonCode/rejectionCode on a terminal node row",
      }),
    );
    return 2;
  }
  out("");
  row("coded terminals", count(coded.length, terminal.length, "terminal node rows"));
  for (const [code, total] of tally(coded.map((entry) => entry.code))) {
    const carriers = coded.filter((entry) => entry.code === code);
    const actions = [...new Set(carriers.map((entry) => entry.actionId))];
    out(`  ${code}`);
    out(
      `    ${count(total, coded.length, "coded terminal node rows")}; ${actions.length} action(s): ${actions.slice(0, 6).join(", ")}`,
    );
    const example = carriers.find((entry) => entry.hint !== null) ?? carriers[0];
    out(
      `    e.g. ${example.actionId}${example.nodeId === null ? "" : `/${example.nodeId}`} state=${example.state}${example.hint === null ? "" : ` hint=${example.hint.slice(0, 120)}`} (record ${example.index})`,
    );
  }
  return 0;
}

function questionNodes({ context, runDir }) {
  const { result, window } = context;
  facts({
    source: `${basename(runDir)}/result.json, programSubmissions[].nodes[] and programOutcomes[].nodeOutcomes[]`,
    method: "structured parse of the bundle's own fields: planned nodes against the settled state of the same node id",
    window: window.text,
  });
  if (result === null) {
    row(
      "nodes",
      notMeasured("planned and settled nodes", {
        reason: "this run directory holds no readable result.json",
        missingField: "result.json programSubmissions[].nodes[] / programOutcomes[].nodeOutcomes[]",
      }),
    );
    return 2;
  }
  const planned = (result.programSubmissions ?? []).flatMap((programme) => programme.nodes ?? []);
  const settled = (result.programOutcomes ?? []).flatMap((programme) => programme.nodeOutcomes ?? []);
  if (planned.length === 0 && settled.length === 0) {
    row(
      "nodes",
      notMeasured("planned and settled nodes", {
        reason: "the bundle published no programme",
        missingField: "result.json programSubmissions / programOutcomes",
      }),
    );
    return 2;
  }
  const succeeded = settled.filter((node) => node.state === "succeeded");
  out("");
  row("planned", count(planned.length, planned.length, "submitted nodes"));
  row("settled", count(settled.length, planned.length, "submitted nodes"));
  row("succeeded", count(succeeded.length, settled.length, "settled nodes"));
  out("");
  const plannedByAction = new Map(tally(planned.map((node) => node.actionId)));
  const succeededByAction = new Map(tally(succeeded.map((node) => node.actionId)));
  out(`  per action          planned / succeeded`);
  for (const [action, total] of tally(settled.map((node) => node.actionId)))
    row(
      `  ${action}`,
      `${count(total, settled.length, "settled nodes")}; planned ${plannedByAction.get(action) ?? 0} / succeeded ${succeededByAction.get(action) ?? 0}`,
    );
  const states = tally(settled.map((node) => node.state ?? "unreported"));
  out("");
  for (const [state, total] of states) row(`  state ${state}`, count(total, settled.length, "settled nodes"));
  return 0;
}

function questionThinking({ context, argument }) {
  const { entries, sessionName, window } = context;
  if (typeof argument !== "string" || argument.trim() === "") {
    row(
      "thinking",
      notMeasured("matching passages", {
        reason: "--question thinking needs a phrase",
        missingField: "--question thinking <phrase>",
      }),
    );
    return 2;
  }
  const needle = argument.toLowerCase();
  const passages = [];
  for (const { index, record } of entries) {
    const content = record?.message?.content;
    if (!Array.isArray(content)) continue;
    for (const part of content)
      if (part?.type === "thinking" && typeof part.thinking === "string") passages.push({ index, text: part.thinking });
  }
  facts({
    source: `${sessionName}, message.content[] parts of type thinking (field: thinking)`,
    method: `case-insensitive substring test inside each thinking part, never against the raw line; the phrase is ${JSON.stringify(needle)}`,
    window: window.text,
  });
  if (passages.length === 0) {
    row(
      "matches",
      notMeasured("matching passages", {
        reason: "the session holds no thinking part",
        missingField: "message.content[].type=thinking",
      }),
    );
    return 2;
  }
  const matching = passages.filter((passage) => passage.text.toLowerCase().includes(needle));
  out("");
  row("matches", count(matching.length, passages.length, "thinking parts"));
  for (const passage of matching) {
    const at = passage.text.toLowerCase().indexOf(needle);
    const snippet = passage.text.slice(Math.max(0, at - 200), Math.min(passage.text.length, at + 200));
    out(`  record ${passage.index}  …${snippet.replace(/\s+/gu, " ").trim()}…`);
  }
  return 0;
}

function questionProgress({ context }) {
  const { result, window, runDir } = context;
  facts({
    source: `${basename(runDir)}/result.json, programSubmissions[] joined to programOutcomes[] by programId`,
    method:
      "structured parse of the bundle: total is the nodes the programme planned, settled is the same programId's nodeOutcomes in an ended state, and a programme is superseded when it still held a node and a later submission was accepted",
    window: window.text,
  });
  if (result === null) {
    row(
      "programmes",
      notMeasured("programmes", {
        reason: "this run directory holds no readable result.json, and a session cannot answer this question",
        missingField: "result.json programSubmissions[] / programOutcomes[]",
      }),
    );
    return 2;
  }
  // THE SESSION IS NOT THE SOURCE HERE, and that was measured rather than assumed: a status answer carries `total`,
  // `settled` and `remaining` but NO `programId`, so the only session payload attributable to a programme is its submit
  // answer - always `remaining = nodeCount, settled = false`. Reading this question out of the session reported every
  // one of this run's 98 programmes as "left open, superseded by the next", while the bundle's own nodeOutcomes settle
  // them all. The number was arithmetic on the wrong population, which is why the bundle owns it.
  const planned = Array.isArray(result.programSubmissions) ? result.programSubmissions : [];
  const outcomes = new Map((result.programOutcomes ?? []).map((entry) => [entry.programId, entry]));
  if (planned.length === 0) {
    row(
      "programmes",
      notMeasured("programmes", {
        reason: "the bundle published no programme submission",
        missingField: "result.json programSubmissions[]",
      }),
    );
    return 2;
  }
  const programmes = planned.map((submission) => {
    const total = (submission.nodes ?? []).length;
    const settled = (outcomes.get(submission.programId)?.nodeOutcomes ?? []).filter((node) =>
      ENDED_STATES.has(node.state),
    ).length;
    return { programId: submission.programId, total, settled, remaining: total - settled };
  });
  const superseded = programmes.filter((programme, index) => programme.remaining > 0 && index < programmes.length - 1);
  out("");
  row("programmes", count(programmes.length, programmes.length, "submitted programmes"));
  row(
    "nodes settled",
    count(
      programmes.reduce((sum, entry) => sum + entry.settled, 0),
      programmes.reduce((sum, entry) => sum + entry.total, 0),
      "planned nodes",
    ),
  );
  out("");
  out("  the last programmes (submission order)");
  for (let index = Math.max(0, programmes.length - 5); index < programmes.length; index += 1) {
    const programme = programmes[index];
    const successor = index < programmes.length - 1 ? programmes[index + 1].programId : null;
    row(
      `  ${programme.programId}`,
      `total ${programme.total} · settled ${programme.settled} · remaining ${programme.remaining}` +
        (programme.remaining > 0 && successor !== null ? ` · next submission ${successor}` : ""),
    );
  }
  out("");
  if (superseded.length === 0) {
    row("superseded", count(0, programmes.length, "programmes (every programme settled every node it planned)"));
  } else {
    row("superseded", count(superseded.length, programmes.length, "programmes"));
    for (const programme of superseded.slice(0, 10))
      out(`  ${programme.programId} left ${programme.remaining} node(s) open, then a later programme was submitted`);
    if (superseded.length > 10) out(`  … ${superseded.length - 10} more`);
  }
  return 0;
}

function questionShape({ context, argument }) {
  const { entries, sessionName, window } = context;
  if (typeof argument !== "string" || argument.trim() === "") {
    row(
      "shape",
      notMeasured("tiles", {
        reason: "--question shape needs an action id",
        missingField: "--question shape <action>",
      }),
    );
    return 2;
  }
  const rows = nodeRows(entries);
  const carriers = rows.filter((entry) => entry.actionId === argument);
  facts({
    source: `${sessionName}, node rows for actionId ${argument} (field: tile / x,y)`,
    method:
      "structured parse of every node row carrying this action; the bounding box spans every tile it named and the density is distinct tiles over that box",
    window: window.text,
  });
  out(`  examined            ${rows.length} node rows, of which ${carriers.length} name ${argument}`);
  if (carriers.length === 0) {
    row(
      "tiles",
      notMeasured("tiles", {
        reason: `no node row in this session names ${argument}`,
        missingField: `a node row with actionId ${argument}`,
      }),
    );
    return 2;
  }
  const withTile = carriers.filter(
    (entry) => entry.tile !== null && Number.isFinite(entry.tile.x) && Number.isFinite(entry.tile.y),
  );
  if (withTile.length === 0) {
    row(
      "tiles",
      notMeasured("tiles", {
        reason: `${carriers.length} row(s) named ${argument} but none carried coordinates`,
        missingField: "tile{x,y} or x/y on the node row",
      }),
    );
    return 2;
  }
  const distinct = [...new Map(withTile.map((entry) => [`${entry.tile.x},${entry.tile.y}`, entry.tile])).values()];
  const xs = distinct.map((tile) => tile.x);
  const ys = distinct.map((tile) => tile.y);
  const width = Math.max(...xs) - Math.min(...xs) + 1;
  const height = Math.max(...ys) - Math.min(...ys) + 1;
  out("");
  row("tiles reached", count(distinct.length, carriers.length, `node rows naming ${argument}`));
  row(
    "bounding box",
    `${width}x${height} at (${Math.min(...xs)},${Math.min(...ys)})-(${Math.max(...xs)},${Math.max(...ys)})`,
  );
  row(
    "density",
    `${distinct.length} of ${width * height} bbox tiles (${((distinct.length / (width * height)) * 100).toFixed(0)}%)`,
  );
  row(
    "tile list",
    distinct
      .slice(0, 24)
      .map((tile) => `${tile.x},${tile.y}`)
      .join(" ") + (distinct.length > 24 ? ` … ${distinct.length - 24} more` : ""),
  );
  const states = tally(carriers.map((entry) => entry.state));
  out("");
  for (const [state, total] of states)
    row(`  state ${state}`, count(total, carriers.length, `node rows naming ${argument}`));
  return 0;
}

// ---------------------------------------------------------------------------------------------------------------
// The command line.
// ---------------------------------------------------------------------------------------------------------------

function parseArgs(argv) {
  const options = { run: null, session: null, question: null, argument: null };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--run") options.run = argv[(index += 1)] ?? null;
    else if (token === "--session") options.session = argv[(index += 1)] ?? null;
    else if (token === "--question") {
      options.question = argv[(index += 1)] ?? null;
      if (options.question === "thinking" || options.question === "shape")
        options.argument = argv[(index += 1)] ?? null;
    } else options.argument = options.argument ?? token;
  }
  return options;
}

function usage() {
  out(
    "session_reading_usage: node tools/live-run/analysis/session-reading.mjs --run <dir> [--session <path>] --question <kind> [argument]",
  );
  out(`  kinds: ${QUESTIONS.join(", ")}`);
  out("  thinking and shape take one argument: a phrase, and an action id");
  return 2;
}

function main(argv) {
  const options = parseArgs(argv);
  if (options.question === null || !QUESTIONS.includes(options.question)) return usage();
  if (options.run === null && options.session === null) return usage();
  const runDir = options.run === null ? null : resolve(options.run);
  if (runDir !== null && !existsSync(runDir)) {
    out(`session_reading_refused: --run ${options.run} does not exist`);
    return 2;
  }
  const result = runDir === null ? null : readResult(runDir);
  const session = resolveSession({ runDir, result, explicit: options.session });
  out(`run      ${runDir === null ? "(none)" : basename(runDir)}`);
  out(`session  ${session.path ?? "(absent)"}${session.why === undefined ? "" : `  [${session.why}]`}`);
  // `nodes` and `progress` are questions about the BUNDLE. A run whose session was never copied beside it can still
  // answer them, and refusing them for the missing session would be the reader claiming its own limitation as the run's.
  const fromSession = !BUNDLE_QUESTIONS.has(options.question);
  if (session.path === null && fromSession) {
    out("");
    out(
      `  session             ${notMeasured("session-derived readings", { reason: session.reason, missingField: session.missing })}`,
    );
    return 2;
  }
  const entries = session.path === null ? [] : readJsonl(session.path);
  const context = {
    entries,
    result,
    runDir,
    sessionName: session.path === null ? "(no session)" : basename(session.path),
    window: runWindow({ result, entries }),
  };
  out(`window   ${context.window.text}`);
  out("");
  out(`question ${options.question}${options.argument === null ? "" : ` ${options.argument}`}`);
  const handlers = {
    tools: () => questionTools({ context }),
    turns: () => questionTurns({ context }),
    codes: () => questionCodes({ context }),
    nodes: () => questionNodes({ context, runDir }),
    thinking: () => questionThinking({ context, argument: options.argument }),
    progress: () => questionProgress({ context }),
    shape: () => questionShape({ context, argument: options.argument }),
  };
  return handlers[options.question]();
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  process.exitCode = main(process.argv.slice(2));
