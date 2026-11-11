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
 * WHERE THE RECORDS ARE. Three things made the first version point at the wrong place, each fixed at the layer that
 * decides it rather than worked around in the question:
 *
 *   - A run's session is not only under its own `runtime-root`. A run stopped by hand never captures one, so its session
 *     is still in the runtime root the launcher was given - the same one `tools/live-run/game/launch-ladder-live.mjs`
 *     passes as `GAMEBUDDY_RUNTIME_ROOT`, defaulting to `%LOCALAPPDATA%/GameBuddy`. Every root tried is printed with
 *     what was found under it, and a live root is narrowed to the record created seconds after this run started, never
 *     to whichever record happens to be newest.
 *   - The session no longer carries node ENDINGS: the model-visible batches are prose now, so no node JSON reaches a
 *     text part. `codes`, `nodes` and `shape` read the run's bundle first (`result.json` -> `programSubmissions` /
 *     `programOutcomes`, written at teardown), print what the session says beside it, and name which one answered.
 *   - A node row appears once per status snapshot. A node's identity is `programId/nodeId`, so every question prints
 *     `distinct node ids` beside `node rows` and `without_node_id` and no row is read as a piece of work.
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
 * It reads `.live-runs/**`, a session record and, for the bundle questions, a run's own `result.json`. It starts no
 * game, builds nothing, and writes nothing.
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

/**
 * How soon after a run starts its session record is created.
 *
 * Measured over 47 ladder runs on 2026-11-10: the record named by `toolTiming.record` was created 1.3-3.2 s after
 * `startedAtMs` in every one of the 27 runs that published a name, and the next-nearest candidate under the live root
 * was never closer than 181 s. Sixty seconds therefore separates this run's record from every other run's.
 */
const SESSION_BIRTH_WINDOW_MS = 60_000;

/**
 * The question kinds this reader declares.
 *
 * `session-reading.test.mjs` populations its `reading_without_a_source_is_silent` gate from this list, so a kind added
 * here that prints no source, no population, or a bare number is caught by the suite rather than by the next reader who
 * trusts it.
 */
export const QUESTIONS = Object.freeze([
  "tools",
  "turns",
  "bubbles",
  "codes",
  "nodes",
  "thinking",
  "progress",
  "shape",
]);

/**
 * The questions only a session can answer. The rest read the bundle first and fall back to the session, so a run whose
 * session was never captured still answers them - refusing them for the missing session would be the reader claiming
 * its own limitation as the run's.
 */
const SESSION_ONLY_QUESTIONS = Object.freeze(new Set(["tools", "turns", "bubbles", "thinking"]));

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

/**
 * Every `.jsonl` record under one runtime root, with the two clocks a resolution needs.
 *
 * `birth` is when the file was created and `mtime` when it was last written. A root that collected every run's
 * sessions has to be narrowed by birth; a root copied at one run's teardown can be read by mtime alone.
 */
function sessionFiles(root) {
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
      else if (entry.endsWith(".jsonl"))
        found.push({ path, name: entry, mtime: stat.mtimeMs, birth: stat.birthtimeMs });
    }
  };
  walk(root, 6);
  return found;
}

/**
 * The runtime roots a run's session can be under, in the order they are trusted.
 *
 * The launcher resolves this one way - `GAMEBUDDY_RUNTIME_ROOT`, defaulting to `%LOCALAPPDATA%/GameBuddy`
 * (`tools/live-run/game/launch-ladder-live.mjs` passes exactly that) - so this is that resolution, not a second guess
 * at it. The run's own `runtime-root/contexts` comes first because it is the copy taken at THAT run's teardown, and a
 * copy taken at teardown cannot hold a later run's session.
 */
function sessionRoots(runDir) {
  const roots = [];
  if (runDir !== null)
    roots.push({
      path: join(runDir, "runtime-root", "contexts"),
      copiedAtTeardown: true,
      why: "runtime-root/contexts, this run's own capture",
    });
  const configured = process.env.GAMEBUDDY_RUNTIME_ROOT;
  if (typeof configured === "string" && configured.trim() !== "")
    roots.push({
      path: join(configured, "contexts"),
      copiedAtTeardown: false,
      why: "GAMEBUDDY_RUNTIME_ROOT/contexts, the root the launcher was given",
    });
  const local = process.env.LOCALAPPDATA;
  if (typeof local === "string" && local.trim() !== "")
    roots.push({
      path: join(local, "GameBuddy", "contexts"),
      copiedAtTeardown: false,
      why: "%LOCALAPPDATA%/GameBuddy/contexts, the launcher's default root",
    });
  const seen = new Set();
  return roots.filter((root) => {
    // Two of the three roots can name the same directory; the key is case-folded only where the filesystem is.
    const key = process.platform === "win32" ? resolve(root.path).toLowerCase() : resolve(root.path);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** When this run started: the bundle's own bound, else the launch record written before anything else runs. */
function runStart({ runDir, result }) {
  const fromBundle = Number(result?.startedAtMs);
  if (Number.isFinite(fromBundle)) return { at: fromBundle, source: "result.json startedAtMs" };
  const launch = runDir === null ? null : readJson(join(runDir, "launch.json"));
  const fromLaunch = Number(launch?.startedAtMs);
  if (Number.isFinite(fromLaunch)) return { at: fromLaunch, source: "launch.json startedAtMs" };
  return { at: null, source: null };
}

/**
 * A file's creation in ms: its birth when the filesystem records one, else its last write.
 *
 * `birthtimeMs` is 0 where the filesystem has no birth time (some Linux mounts), and 0 is "unknown", not 1970. The
 * mtime of a record written by a launch is that same launch, so the fallback keeps the tie that matters and the
 * reader still refuses to tie a record to a run it cannot place.
 */
function birthOf(file) {
  if (Number.isFinite(file.birth) && file.birth > 0) return file.birth;
  return Number.isFinite(file.mtime) && file.mtime > 0 ? file.mtime : null;
}

/**
 * The record a live root holds for this run: the one created seconds after the launch that created it.
 *
 * A live root holds every run's sessions, so its newest file is whichever run finished last - reading that one would
 * answer a different run's question under this run's name. Birth is the only clock that ties a record to a launch, and
 * the window is the measured one (see `SESSION_BIRTH_WINDOW_MS`).
 */
function bornWithRun(files, start) {
  if (start.at === null)
    return {
      pick: null,
      reason: `this run's start time is unknown (no result.json startedAtMs and no launch.json), so no record can be tied to it`,
    };
  const inside = files
    .map((file) => ({ file, birth: birthOf(file) }))
    .filter((entry) => entry.birth !== null && Math.abs(entry.birth - start.at) <= SESSION_BIRTH_WINDOW_MS)
    .sort((left, right) => right.birth - left.birth);
  if (inside.length === 0)
    return {
      pick: null,
      reason: `none of its ${files.length} record(s) was created within ${SESSION_BIRTH_WINDOW_MS / 1000}s of ${clock(start.at)} (${start.source})`,
    };
  return {
    pick: inside[0].file,
    reason: `created ${seconds(Math.abs(inside[0].birth - start.at))} from this run's start (${start.source}), ${inside.length} of ${files.length} record(s) that close`,
  };
}

function readJson(path) {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

function readResult(runDir) {
  return runDir === null ? null : readJson(join(runDir, "result.json"));
}

/**
 * The session file this run wrote, and every root that was asked for it.
 *
 * `--session` wins because a reader checking an OLD run has to be able to point at that run's record. Otherwise each
 * root the launcher could have used is tried in turn: the file the bundle's `toolTiming.record` names wins in any root,
 * a root copied at teardown is read by its newest record, and a live root only by the record created with this run.
 * `roots` is returned whole so the caller can print which root answered and what the others held.
 */
function resolveSession({ runDir, result, explicit }) {
  if (typeof explicit === "string") {
    return existsSync(explicit)
      ? { path: resolve(explicit), why: "named by --session", roots: [] }
      : {
          path: null,
          roots: [],
          missing: `--session ${explicit}`,
          reason: "the file named by --session does not exist",
        };
  }
  if (runDir === null)
    return { path: null, roots: [], missing: "--session", reason: "no --run directory and no --session" };
  const roots = sessionRoots(runDir);
  const start = runStart({ runDir, result });
  const record = typeof result?.toolTiming?.record === "string" ? result.toolTiming.record : null;
  const tried = [];
  for (const root of roots) {
    const files = sessionFiles(root.path);
    if (files === null) {
      tried.push({ path: root.path, why: root.why, outcome: "no such directory" });
      continue;
    }
    if (files.length === 0) {
      tried.push({ path: root.path, why: root.why, outcome: "no .jsonl under it" });
      continue;
    }
    if (record !== null) {
      const named = files.find((file) => file.name === record);
      if (named !== undefined) {
        tried.push({
          path: root.path,
          why: root.why,
          outcome: "read from: the record result.json toolTiming.record names",
        });
        return { path: named.path, why: root.why, roots: tried };
      }
    }
    if (root.copiedAtTeardown) {
      const newest = [...files].sort((left, right) => right.mtime - left.mtime)[0];
      tried.push({
        path: root.path,
        why: root.why,
        outcome: `read from: its newest of ${files.length} record(s), and a capture taken at teardown holds nothing later`,
      });
      return { path: newest.path, why: root.why, roots: tried };
    }
    const withRun = bornWithRun(files, start);
    if (withRun.pick !== null) {
      tried.push({ path: root.path, why: root.why, outcome: `read from: the record ${withRun.reason}` });
      return { path: withRun.pick.path, why: root.why, roots: tried };
    }
    tried.push({ path: root.path, why: root.why, outcome: `not used: ${withRun.reason}` });
  }
  return {
    path: null,
    roots: tried,
    missing:
      "runtime-root/contexts/**/sessions/*.jsonl, GAMEBUDDY_RUNTIME_ROOT/contexts or %LOCALAPPDATA%/GameBuddy/contexts (every root tried is printed above with what it held), or the file result.json toolTiming.record names",
    reason: "no record this run wrote was found in any root tried",
  };
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
 * Every node row the session published, with the programme that owns it and the node id it was published under.
 *
 * A programme's rows arrive as `{actionId, state, ...}` - a plan answer's `nodes`, a status snapshot's
 * `snapshot.nodes`, a settled batch's payload - with the coordinates under `tile` or under `x`/`y`, and the reason under
 * `failureCode`, `reasonCode` or `rejectionCode`. The programme is on the payload that carries them (`programId`).
 *
 * THE SAME PAYLOAD IS REACHABLE TWICE in one record (measured on the 2026-11-09 `multiday_routine` session: a fact
 * batch carries the same 191 action rows under `worldFacts[].payload.nodes` and under `events[].payload.nodes`), so a
 * row is deduped by its own serialised content WITHIN its record.
 */
function nodeRows(entries) {
  const rows = [];
  const seen = new Set();
  const walk = (value, context, depth) => {
    if (depth > 8 || value === null || typeof value !== "object") return;
    if (Array.isArray(value)) {
      for (const item of value) walk(item, context, depth + 1);
      return;
    }
    const programme = typeof value.programId === "string" ? value.programId : context.programme;
    if (isNodeRow(value)) {
      const dedupe = `${context.index}\u0000${JSON.stringify(value)}`;
      if (!seen.has(dedupe)) {
        seen.add(dedupe);
        rows.push({
          index: context.index,
          role: context.role,
          programId: programme,
          actionId: value.actionId,
          state: value.state,
          nodeId: typeof value.nodeId === "string" ? value.nodeId : null,
          code: codeOf(value),
          hint: typeof value.hint === "string" ? value.hint : null,
          tile: tileOf(value),
        });
      }
    }
    for (const item of Object.values(value)) walk(item, { ...context, programme }, depth + 1);
  };
  for (const part of structuredParts(entries))
    walk(part.value, { index: part.index, role: part.role, programme: null }, 0);
  return rows;
}

/**
 * One row per node, because a node appears once per status snapshot.
 *
 * The identity is `programId/nodeId`, and the LAST row wins because a node's state progresses. A node id alone is NOT
 * an identity: measured on the 2026-11-09 `multiday_routine` session, 754 node rows carry 283 nodes whose ids are only
 * 20 distinct names - the same `n01` is the first node of every one of 98 programmes, so a node id alone would merge 98
 * different nodes into one.
 *
 * A row with no nodeId has nothing to be counted by, so it is not folded into anything: `without_node_id` reports how
 * many there were, and a question that needs a node says what it was missing instead of counting rows as work.
 */
function nodesByIdentity(rows) {
  const nodes = new Map();
  let withoutNodeId = 0;
  for (const row of rows) {
    if (row.nodeId === null) {
      withoutNodeId += 1;
      continue;
    }
    const key = `${row.programId ?? "(no programme)"}/${row.nodeId}`;
    const prior = nodes.get(key);
    if (prior === undefined || row.index >= prior.index) nodes.set(key, { ...row, key });
  }
  return { rows: rows.length, nodes: [...nodes.values()], withoutNodeId };
}

/** The census every question taken over node rows prints first, so no row is read as a piece of work. */
function printCensus(census, unit) {
  out(`  node rows           ${count(census.rows, census.rows, unit)}`);
  out(
    `  distinct node ids   ${count(census.nodes.length, census.rows, `${unit} (identity programId/nodeId, one row per node)`)}`,
  );
  out(
    `  without_node_id     ${count(census.withoutNodeId, census.rows, `${unit} (no nodeId, so no node to count them as)`)}`,
  );
}

/**
 * The bundle's own node records: what each programme planned, and how each of its nodes ended.
 *
 * This is the authority for endings, and the session is not a substitute for it any more. Measured on the 2026-11-10
 * `round45` run: 33 node rows, not one terminal state, because the model-visible batches are prose now and no node
 * JSON reaches a text part. The bundle is assembled at teardown from the journal, so it carries the states, the codes
 * and the tiles the session no longer does.
 */
function bundleNodes(result) {
  if (result === null) return null;
  const submissions = Array.isArray(result.programSubmissions) ? result.programSubmissions : [];
  const outcomes = Array.isArray(result.programOutcomes) ? result.programOutcomes : [];
  if (submissions.length === 0 && outcomes.length === 0) return null;
  const planned = submissions.flatMap((programme) =>
    (Array.isArray(programme.nodes) ? programme.nodes : []).map((node) => ({
      programId: programme.programId ?? null,
      nodeId: typeof node.nodeId === "string" ? node.nodeId : null,
      actionId: typeof node.actionId === "string" ? node.actionId : null,
    })),
  );
  const settled = outcomes.flatMap((programme) =>
    (Array.isArray(programme.nodeOutcomes) ? programme.nodeOutcomes : []).map((node) => ({
      programId: programme.programId ?? null,
      nodeId: typeof node.nodeId === "string" ? node.nodeId : null,
      actionId: typeof node.actionId === "string" ? node.actionId : null,
      state: typeof node.state === "string" ? node.state : null,
      code: codeOf(node),
      hint: typeof node.hint === "string" ? node.hint : null,
      tile: tileOf(node),
    })),
  );
  return { planned, settled, programmes: Math.max(submissions.length, outcomes.length) };
}

/** The shape a tile list reaches, printed by `shape`: the box it spans and how much of that box it fills. */
function tileShape(tiles) {
  const xs = tiles.map((tile) => tile.x);
  const ys = tiles.map((tile) => tile.y);
  const width = Math.max(...xs) - Math.min(...xs) + 1;
  const height = Math.max(...ys) - Math.min(...ys) + 1;
  return { width, height, minX: Math.min(...xs), minY: Math.min(...ys), maxX: Math.max(...xs), maxY: Math.max(...ys) };
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

/** A quotient rounded to the precision a reader can compare, never fifteen digits of float noise. */
function round2(value) {
  return Number.isFinite(value) ? Math.round(value * 100) / 100 : value;
}

function speechOf(message) {
  const content = Array.isArray(message?.content) ? message.content : [];
  return content
    .filter((part) => part?.type === "text")
    .map((part) => (typeof part.text === "string" ? part.text : ""))
    .join("")
    .trim();
}

/**
 * How many bubbles the player was spoken at, per prompt turn and per tool call.
 *
 * <p>
 * THE QUESTION EXISTS BECAUSE THE FLOOR AND THE RUNTIME DISAGREE ABOUT `reply`. `identity-profile.ts` asks for one
 * spoken line per reply and a remark before every action; the runtime makes a reply out of every assistant message,
 * and one prompt turn produces several (speak, call a tool, hear the result, speak again). Measured `round46b`:
 * 27 batches, 55 messages, 49 of them carrying speech, 1.63 per tool call - one bubble every 13 seconds.
 * </p>
 *
 * <p>
 * A MID-RUN READ IS A WINDOW, NOT A VERDICT: a live session file grows while it is read, and a count taken at
 * minute four called the same file's later batches invisible. So the last record this reading saw is printed beside
 * the numbers, and the denominator is the batches that existed at that record - not the run.
 * </p>
 */
function questionBubbles({ context }) {
  const { entries, sessionName, window } = context;
  let batches = 0;
  let messages = 0;
  let bubbles = 0;
  let speechWithTool = 0;
  let speechOnly = 0;
  let toolOnly = 0;
  let toolCalls = 0;
  let current = null;
  let lastAt = null;
  for (const { record } of entries) {
    const message = record?.message;
    if (!message) continue;
    const content = Array.isArray(message.content) ? message.content : [];
    if (message.role === "user") {
      const carriedResults = content.some((part) => part?.type === "toolResult");
      if (speechOf(message).length > 0 && !carriedResults) {
        batches += 1;
        current = { bubbles: 0 };
      }
      continue;
    }
    if (message.role !== "assistant") continue;
    messages += 1;
    if (typeof record.timestamp === "string") lastAt = record.timestamp;
    const calls = content.filter((part) => part?.type === "toolCall").length;
    toolCalls += calls;
    if (speechOf(message).length > 0) {
      bubbles += 1;
      if (current !== null) current.bubbles += 1;
      if (calls > 0) speechWithTool += 1;
      else speechOnly += 1;
    } else if (calls > 0) toolOnly += 1;
  }
  facts({
    source: `${sessionName}, message.role + message.content[] part types (fields: text, toolCall, toolResult)`,
    method:
      "structured parse; a prompt turn is a user message carrying text and no toolResult (that is what opens a turn), a bubble is an assistant message carrying non-empty text, and the population is the batches that existed at the last record this read saw",
    window: `${window.text}; last record ${lastAt ?? "(untimed)"}`,
  });
  out("");
  if (batches === 0 || messages === 0) {
    row(
      "bubbles",
      notMeasured("assistant messages carrying text", {
        reason: "the session holds no prompt turn or no assistant message",
        missingField: "message.role=user|assistant with content[]",
      }),
    );
    return 2;
  }
  row("prompt turns", count(batches, batches, "user batches carrying text"));
  row("assistant messages", count(messages, messages, "assistant messages"));
  row("bubbles", count(bubbles, messages, "assistant messages carrying speech"));
  row("bubbles per turn", magnitude(round2(bubbles / batches), { count: batches, total: batches }, "prompt turns"));
  row("messages per turn", magnitude(round2(messages / batches), { count: batches, total: batches }, "prompt turns"));
  row(
    "bubbles per tool call",
    magnitude(round2(bubbles / Math.max(toolCalls, 1)), { count: toolCalls, total: toolCalls }, "toolCall parts"),
  );
  row("  speech with a tool call", count(speechWithTool, bubbles, "bubbles"));
  row("  speech only", count(speechOnly, bubbles, "bubbles"));
  row("  tool only, no speech", count(toolOnly, messages, "assistant messages"));
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

/**
 * What the session's node rows amount to, as one clause.
 *
 * The three counts `printCensus` prints, in a sentence, so a question answered from the bundle can still say what the
 * session held - including "it held 33 rows and none of them carried a node id", which is the case for every run since
 * the model-visible batches became prose.
 */
function censusClause(census, sessionName) {
  if (census.rows === 0) return `${sessionName} holds no parsed node row`;
  if (census.nodes.length === 0)
    return `${sessionName}: ${count(census.withoutNodeId, census.rows, "node rows carry no nodeId")}`;
  return `${sessionName}: ${count(census.nodes.length, census.rows, `node rows are distinct nodes, ${census.withoutNodeId} of them without a nodeId`)}`;
}

/** What the other source says about the same question, so two sources cannot disagree in silence. */
function crossCheck(line) {
  out(`  cross-check         ${line}`);
}

/** Why the bundle could not be asked: the difference between "no file" and "a file that published no programme". */
function bundleGap(result) {
  return result === null ? "this run directory holds no readable result.json" : "result.json published no programme";
}

/**
 * The sentence a question prints when NEITHER source had anything.
 *
 * A run with no session and no bundle has nothing to count, and `0 of 0 node rows` would be "we never looked" wearing a
 * number - the one thing this reader exists to refuse.
 */
function noSource(unit, { bundleWhy, missingField }) {
  return notMeasured(unit, {
    reason: `${bundleWhy}, and no session record was found for this run`,
    missingField,
  });
}

/**
 * What the session says beside the bundle's answer to `codes`.
 *
 * The two cannot be merged and must not be left to disagree in silence: the bundle is assembled from the journal at
 * teardown, while the session's last status snapshot can miss a node's final ending. Measured on the 2026-11-09
 * `multiday_routine` run: 283 nodes, 85 of them terminal, the same twelve codes in the same counts - plus
 * `crop_target_changed`, which only the bundle carried. So this line carries the comparison and the bundle decides.
 */
function codesCrossCheck({ census, bundleTerminal, bundleCoded, sessionName }) {
  const what = censusClause(census, sessionName);
  if (census.nodes.length === 0) return `${what}  [silent: the session named no node it could report an ending for]`;
  const terminal = census.nodes.filter((node) => NON_SUCCESS_STATES.has(node.state));
  const coded = terminal.filter((node) => node.code !== null);
  if (terminal.length === 0)
    return `${what}, ${count(0, census.nodes.length, "nodes ending in a non-success state")}  [silent: the session recorded no ending at all, so the bundle's reading stands alone]`;
  const bundleCodes = new Map(tally(bundleCoded.map((node) => node.code)));
  const sessionCodes = new Map(tally(coded.map((node) => node.code)));
  const onlyBundle = [...bundleCodes.keys()].filter((code) => !sessionCodes.has(code));
  const onlySession = [...sessionCodes.keys()].filter((code) => !bundleCodes.has(code));
  const sameCounts = [...bundleCodes].every(([code, total]) => sessionCodes.get(code) === total);
  const tally_ = `${what}, ${count(terminal.length, census.nodes.length, "nodes ending in a non-success state")}, ${coded.length} with a code`;
  if (onlyBundle.length === 0 && onlySession.length === 0 && sameCounts && bundleTerminal.length === terminal.length)
    return `${tally_}  [agrees with the bundle]`;
  const sides =
    (onlyBundle.length === 0
      ? "the bundle carries nothing the session does not"
      : `only the bundle carries ${onlyBundle.join(", ")}`) +
    "; " +
    (onlySession.length === 0
      ? "the session carries nothing the bundle does not"
      : `only the session carries ${onlySession.join(", ")}`);
  return `${tally_}  [differs, and the bundle decided: ${sides}; a status snapshot is taken before the ending it would show]`;
}

/** `codes` answered from the session: the endings the status snapshots recorded, one row per node. */
function codesFromSession({ census, sessionName, window, result, hasSession }) {
  if (!hasSession) {
    row(
      "terminal codes",
      noSource("coded terminal nodes", {
        bundleWhy: bundleGap(result),
        missingField: "result.json programOutcomes[].nodeOutcomes[] or a session node row with a nodeId",
      }),
    );
    return 2;
  }
  facts({
    source: `${sessionName}, node rows inside text parts (fields: nodeId, state, failureCode/reasonCode/rejectionCode)  [answered: the session - ${bundleGap(result)}]`,
    method:
      "structured parse of every text part as JSON, walking every node row and folding a node's snapshots into the last state it was published in; a code inside a schema, a prompt or an unparsed line is not counted",
    window: window.text,
  });
  printCensus(census, "node rows");
  const terminal = census.nodes.filter((node) => NON_SUCCESS_STATES.has(node.state));
  out(
    `  examined            ${count(census.nodes.length, census.rows, "node rows are distinct nodes")}, of which ${terminal.length} ended in a non-success state`,
  );
  if (census.nodes.length === 0) {
    row(
      "terminal codes",
      notMeasured("coded terminal nodes", {
        reason:
          census.rows === 0
            ? "the session holds no parsed node row"
            : `all ${census.rows} node row(s) were published without a nodeId`,
        missingField: "message.content[] text part whose JSON carries {nodeId, actionId, state}",
      }),
    );
    return 2;
  }
  const coded = terminal.filter((node) => node.code !== null);
  if (coded.length === 0) {
    row(
      "terminal codes",
      notMeasured("coded terminal nodes", {
        reason: `${terminal.length} node(s) ended in a non-success state and none carried a code`,
        missingField: "failureCode/reasonCode/rejectionCode on a terminal node row",
      }),
    );
    return 2;
  }
  out("");
  row("coded terminals", count(coded.length, terminal.length, "non-success nodes"));
  for (const [code, total] of tally(coded.map((node) => node.code))) {
    const carriers = coded.filter((node) => node.code === code);
    const actions = [...new Set(carriers.map((node) => node.actionId))];
    out(
      `  ${code}  ${count(total, coded.length, "coded non-success nodes")}; ${actions.length} action(s): ${actions.slice(0, 6).join(", ")}`,
    );
    const example = carriers.find((node) => node.hint !== null) ?? carriers[0];
    out(
      `    e.g. ${example.programId ?? "(no programme)"}/${example.nodeId} ${example.actionId} state=${example.state}${example.hint === null ? "" : ` hint=${example.hint.slice(0, 120)}`} (record ${example.index})`,
    );
  }
  return 0;
}

/**
 * `codes`: the endings of the run's nodes and why they ended that way.
 *
 * The bundle answers it and the session cannot: the model-visible batches are prose, so no node JSON reaches a text
 * part and the session's node rows are the plans a programme was submitted with (`state: pending`). Measured on the
 * 2026-11-10 `round45` run, that reading was `0 terminal node rows` while the bundle held 17 - not an empty run, a
 * question asked of the file that stopped carrying the answer.
 */
function questionCodes({ context }) {
  const { entries, sessionName, window, result } = context;
  const census = nodesByIdentity(nodeRows(entries));
  const bundle = bundleNodes(result);
  if (bundle === null) return codesFromSession({ census, sessionName, window, result, hasSession: context.hasSession });

  const terminal = bundle.settled.filter((node) => NON_SUCCESS_STATES.has(node.state));
  const coded = terminal.filter((node) => node.code !== null);
  facts({
    source: `${basename(context.runDir)}/result.json programOutcomes[].nodeOutcomes[] (fields: state, reasonCode/failureCode/rejectionCode)  [answered: the bundle]`,
    method:
      "structured parse of the bundle's own outcome rows, one row per settled node; the session's node rows are printed beside it as a cross-check and never decide",
    window: window.text,
  });
  out(
    `  examined            ${bundle.settled.length} settled node(s) over ${bundle.programmes} programme(s), of which ${terminal.length} ended in a non-success state`,
  );
  crossCheck(codesCrossCheck({ census, bundleTerminal: terminal, bundleCoded: coded, sessionName }));
  if (bundle.settled.length === 0) {
    row(
      "terminal codes",
      notMeasured("coded terminal nodes", {
        reason: "the bundle published no settled node",
        missingField: "result.json programOutcomes[].nodeOutcomes[]",
      }),
    );
    return 2;
  }
  if (coded.length === 0) {
    row(
      "terminal codes",
      notMeasured("coded terminal nodes", {
        reason: `${terminal.length} settled node(s) ended in a non-success state and none carried a code`,
        missingField: "reasonCode/failureCode/rejectionCode on a non-success nodeOutcome",
      }),
    );
    return 2;
  }
  out("");
  row("coded terminals", count(coded.length, terminal.length, "non-success nodes"));
  for (const [code, total] of tally(coded.map((node) => node.code))) {
    const carriers = coded.filter((node) => node.code === code);
    const actions = [...new Set(carriers.map((node) => node.actionId))];
    out(
      `  ${code}  ${count(total, coded.length, "coded non-success nodes")}; ${actions.length} action(s): ${actions.slice(0, 6).join(", ")}`,
    );
    const example = carriers.find((node) => node.hint !== null) ?? carriers[0];
    const tile = example.tile === null ? "" : ` tile=(${example.tile.x},${example.tile.y})`;
    out(
      `    e.g. ${example.programId ?? "(no programme)"}/${example.nodeId ?? "(no node id)"} ${example.actionId} state=${example.state}${tile}${example.hint === null ? "" : ` hint=${example.hint.slice(0, 120)}`}`,
    );
  }
  return 0;
}

/**
 * `nodes`: what the run planned and how much of it settled.
 *
 * The bundle is the only source: a plan's node list reaches the session as `{index, actionId, state: pending}`, which
 * says what was submitted and never what became of it. The session is printed beside it as a cross-check on the
 * population, so "33 planned, 33 settled" can be read against "33 plan rows in the session".
 */
function questionNodes({ context, runDir }) {
  const { result, window, entries, sessionName } = context;
  const bundle = bundleNodes(result);
  facts({
    source: `${basename(runDir)}/result.json programSubmissions[].nodes[] joined to programOutcomes[].nodeOutcomes[] by programId  [${bundle === null ? `no answer: ${bundleGap(result)}` : "answered: the bundle"}]`,
    method:
      "structured parse of the bundle's own fields: each planned node against the settled state of the node id its own programme lists",
    window: window.text,
  });
  if (bundle === null) {
    row(
      "nodes",
      notMeasured("planned and settled nodes", {
        reason: bundleGap(result),
        missingField: "result.json programSubmissions[].nodes[] / programOutcomes[].nodeOutcomes[]",
      }),
    );
    return 2;
  }
  const planned = bundle.planned;
  const settled = bundle.settled;
  const succeeded = settled.filter((node) => node.state === "succeeded");
  const census = nodesByIdentity(nodeRows(entries));
  crossCheck(`${censusClause(census, sessionName)}  [the session plans; the bundle settles]`);
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
  const submissions = Array.isArray(result?.programSubmissions) ? result.programSubmissions : [];
  facts({
    source: `${basename(runDir)}/result.json programSubmissions[] joined to programOutcomes[] by programId  [${submissions.length === 0 ? `no answer: ${bundleGap(result)}` : "answered: the bundle"}]`,
    method:
      "structured parse of the bundle: total is the nodes the programme planned, settled is the same programId's nodeOutcomes in an ended state, and a programme is superseded when it still held a node and a later submission was accepted",
    window: window.text,
  });
  if (submissions.length === 0) {
    row(
      "programmes",
      notMeasured("programmes", {
        reason: `${bundleGap(result)}, and a session cannot answer this question`,
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

/**
 * `shape`: where one action actually worked.
 *
 * The bundle answers it, because a tile belongs to a node that SETTLED there: `nodeOutcomes[].tile`. The session's rows
 * are the plans a programme was submitted with, so reading this out of the session measured intent and called it work -
 * and counted the same plan once per status snapshot while it was at it (measured on the 2026-11-09 run: 9 node rows
 * for `plant_seed`, 3 tiles).
 */
function questionShape({ context, argument }) {
  const { entries, sessionName, window, result } = context;
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
  const census = nodesByIdentity(nodeRows(entries));
  const bundle = bundleNodes(result);
  const carriers = bundle === null ? [] : bundle.settled.filter((node) => node.actionId === argument);
  if (bundle === null || carriers.length === 0)
    return shapeFromSession({ census, sessionName, window, argument, result, hasSession: context.hasSession });

  facts({
    source: `${basename(context.runDir)}/result.json programOutcomes[].nodeOutcomes[] (field: tile, filtered on actionId ${argument})  [answered: the bundle]`,
    method:
      "structured parse of the bundle's settled nodes for this action, one row per node; the box spans every tile one of them reached and the density is the distinct tiles over that box",
    window: window.text,
  });
  const distinctNodes = new Set(
    carriers.map((node) => `${node.programId ?? "(no programme)"}/${node.nodeId ?? "(no node id)"}`),
  );
  const withoutNodeId = carriers.filter((node) => node.nodeId === null).length;
  out(`  node rows           ${count(carriers.length, bundle.settled.length, `settled nodes naming ${argument}`)}`);
  out(
    `  distinct node ids   ${count(distinctNodes.size, carriers.length, `settled nodes naming ${argument} (identity programId/nodeId)`)}`,
  );
  out(
    `  without_node_id     ${count(withoutNodeId, carriers.length, `settled nodes naming ${argument} (no nodeId to count them by)`)}`,
  );
  crossCheck(`${censusClause(census, sessionName)}  [the session plans; the bundle settles]`);
  const located = carriers.filter((node) => node.tile !== null);
  if (located.length === 0) {
    row(
      "tiles",
      notMeasured("tiles", {
        reason: `${carriers.length} settled node(s) named ${argument} but none carried coordinates`,
        missingField: "tile{x,y} on a nodeOutcome",
      }),
    );
    return 2;
  }
  const distinct = [...new Map(located.map((node) => [`${node.tile.x},${node.tile.y}`, node.tile])).values()];
  printTileShape({ distinct, population: located.length, unit: `settled nodes naming ${argument}` });
  const states = tally(carriers.map((node) => node.state ?? "unreported"));
  out("");
  for (const [state, total] of states)
    row(`  state ${state}`, count(total, carriers.length, `settled nodes naming ${argument}`));
  return 0;
}

/** The box, the density and the tile list of a set of tiles, printed the same way whichever source produced them. */
function printTileShape({ distinct, population, unit }) {
  const shape = tileShape(distinct);
  out("");
  row("tiles reached", count(distinct.length, population, unit));
  row("bounding box", `${shape.width}x${shape.height} at (${shape.minX},${shape.minY})-(${shape.maxX},${shape.maxY})`);
  row(
    "density",
    `${distinct.length} of ${shape.width * shape.height} bbox tiles (${((distinct.length / (shape.width * shape.height)) * 100).toFixed(0)}%)`,
  );
  row(
    "tile list",
    distinct
      .slice(0, 24)
      .map((tile) => `${tile.x},${tile.y}`)
      .join(" ") + (distinct.length > 24 ? ` … ${distinct.length - 24} more` : ""),
  );
}

/** `shape` answered from the session, for a run that published no bundle or no node for this action in it. */
function shapeFromSession({ census, sessionName, window, argument, result, hasSession }) {
  if (!hasSession) {
    row(
      "tiles",
      notMeasured("tiles", {
        reason: `${bundleGap(result)}, and no session record was found for this run`,
        missingField: `result.json programOutcomes[].nodeOutcomes[] or a session node with actionId ${argument}`,
      }),
    );
    return 2;
  }
  facts({
    source: `${sessionName}, node rows for actionId ${argument} (field: tile / x,y)  [answered: the session]`,
    method:
      "structured parse of every node row carrying this action, folded to one row per programId/nodeId; the box spans every tile it named and the density is the distinct tiles over that box",
    window: window.text,
  });
  printCensus(census, "node rows");
  const carriers = census.nodes.filter((node) => node.actionId === argument);
  out(`  examined            ${count(carriers.length, census.rows, `node rows name ${argument}`)}`);
  if (carriers.length === 0) {
    row(
      "tiles",
      notMeasured("tiles", {
        reason: `no node in this session names ${argument}, and the bundle did not answer either`,
        missingField: `a node row or nodeOutcome with actionId ${argument}`,
      }),
    );
    return 2;
  }
  const located = carriers.filter(
    (node) => node.tile !== null && Number.isFinite(node.tile.x) && Number.isFinite(node.tile.y),
  );
  if (located.length === 0) {
    row(
      "tiles",
      notMeasured("tiles", {
        reason: `${carriers.length} node(s) named ${argument} but none carried coordinates`,
        missingField: "tile{x,y} or x/y on the node row",
      }),
    );
    return 2;
  }
  const distinct = [...new Map(located.map((node) => [`${node.tile.x},${node.tile.y}`, node.tile])).values()];
  printTileShape({ distinct, population: located.length, unit: `nodes naming ${argument}` });
  const states = tally(carriers.map((node) => node.state));
  out("");
  for (const [state, total] of states)
    row(`  state ${state}`, count(total, carriers.length, `nodes naming ${argument}`));
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
  // WHICH ROOT ANSWERED, and what the others held. A run stopped by hand never captures its own session, so a reader
  // that looked only under `runtime-root/contexts` reported `session (absent)` for a session sitting in the live root.
  for (const root of session.roots) out(`root     ${root.path}  [${root.outcome}]`);
  out(`session  ${session.path ?? "(absent)"}${session.why === undefined ? "" : `  [${session.why}]`}`);
  const entries = session.path === null ? [] : readJsonl(session.path);
  const context = {
    entries,
    result,
    runDir,
    hasSession: session.path !== null,
    sessionName: session.path === null ? "(no session)" : basename(session.path),
    window: runWindow({ result, entries }),
  };
  out(`window   ${context.window.text}`);
  out("");
  // The question is named BEFORE it is refused, so a refusal is still readable as this question's refusal.
  out(`question ${options.question}${options.argument === null ? "" : ` ${options.argument}`}`);
  if (!context.hasSession && SESSION_ONLY_QUESTIONS.has(options.question)) {
    out(
      `  session             ${notMeasured("session-derived readings", { reason: session.reason, missingField: session.missing })}`,
    );
    return 2;
  }
  const handlers = {
    tools: () => questionTools({ context }),
    turns: () => questionTurns({ context }),
    bubbles: () => questionBubbles({ context }),
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
