#!/usr/bin/env node
/**
 * What did the model ACTUALLY get?
 *
 * <p>
 * Every question this session kept coming back to - "why is the run slow", "why does the model write one step", "is the
 * fact batch too big", "did the conduct reach it" - is a question about ONE artifact: the assembled input of one turn.
 * The repository had readers for pieces of it (`session_meta` token counts, `context.db` tag sizes, the event pump's
 * batch bytes) but nothing that printed the whole thing, so every answer was reconstructed from a different partial view.
 * Three times in one session that reconstruction produced a wrong reading: `cursor` taken for a node count, a fact
 * batch's bytes taken for an observation's, `input` taken for the context size when it means the UNCACHED part.
 * </p>
 * <p>
 * This prints the real thing. It reads a Pi session jsonl - the record of what was sent and what came back - and reports
 * the input of a chosen turn in layered form: the surfaces a model could be looking at, each one's size in bytes and
 * estimated tokens, and the rendered text on demand.
 * </p>
 *
 * <h2>Usage</h2>
 * <pre>
 *   node tools/read-agent-input.mjs --run-dir .live-runs/game-ladder/RUN
 *   node tools/read-agent-input.mjs --session PATH-TO-session.jsonl
 *   node tools/read-agent-input.mjs --run-dir DIR --turn last --show system
 *   node tools/read-agent-input.mjs --run-dir DIR --turn 40 --show user --full
 *   node tools/read-agent-input.mjs --run-dir DIR --layers
 * </pre>
 *
 * Options:
 *   --session PATH   read this session file directly
 *   --run-dir DIR    find the run's session: any `.jsonl` under the run or its runtime root, newest first
 *   --turn N|last    which assistant turn to report (default: last)
 *   --show WHAT      system | user | tools | all (default: layers summary only)
 *   --full           do not truncate the rendered text
 *   --layers         print every layer of the chosen turn, sizes only (the default)
 *   --json           machine-readable
 *
 * Exit codes: 0 reported, 1 could not read (and says why).
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const OPTIONS = parseArgs(process.argv.slice(2));
const sessionPath = OPTIONS.session ?? findSession(OPTIONS["run-dir"]);
if (sessionPath === null || !existsSync(sessionPath)) {
  fail(
    OPTIONS.session
      ? `no session file at ${OPTIONS.session}`
      : `no session found for ${OPTIONS["run-dir"] ?? "(no --run-dir)"}: looked for */sessions/*.jsonl and the runtime root`,
  );
}

const entries = readFileSync(sessionPath, "utf8")
  .split("\n")
  .filter((line) => line.trim().length > 0)
  .flatMap((line) => {
    try {
      return [JSON.parse(line)];
    } catch {
      return [];
    }
  });

const turns = indexTurns(entries);
if (turns.length === 0) fail(`${sessionPath} has no assistant turns`);

const wanted = OPTIONS.turn === undefined || OPTIONS.turn === "last" ? turns.length - 1 : Number(OPTIONS.turn) - 1;
if (!Number.isInteger(wanted) || wanted < 0 || wanted >= turns.length)
  fail(`turn ${OPTIONS.turn} is not in 1..${turns.length}`);

const turn = turns[wanted];
const report = describeTurn(entries, turn);

if (OPTIONS.json) {
  process.stdout.write(`${JSON.stringify({ session: sessionPath, turns: turns.length, ...report }, null, 2)}\n`);
} else {
  render(report, sessionPath, turns.length);
}
process.exit(0);

function parseArgs(argv) {
  const parsed = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith("--")) continue;
    const name = token.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) parsed[name] = true;
    else {
      parsed[name] = next;
      i += 1;
    }
  }
  return parsed;
}

/** The run's session file. A capture copies the runtime root in, so both layouts are tried. */
function findSession(runDir) {
  if (runDir === undefined || runDir === true) return null;
  const roots = [runDir, join(runDir, "runtime-root")];
  for (const root of roots) {
    const found = newestJsonl(root, 6);
    if (found !== null) return found;
  }
  return null;
}

function newestJsonl(dir, depth) {
  if (depth < 0 || !existsSync(dir)) return null;
  let best = null;
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    let stat;
    try {
      stat = statSync(full);
    } catch {
      continue;
    }
    if (stat.isDirectory()) {
      const nested = newestJsonl(full, depth - 1);
      if (nested !== null && (best === null || stat.mtimeMs > best.at)) best = { path: nested, at: stat.mtimeMs };
      continue;
    }
    if (!name.endsWith(".jsonl")) continue;
    if (best === null || stat.mtimeMs > best.at) best = { path: full, at: stat.mtimeMs };
  }
  return best?.path ?? null;
}

/**
 * An ASSISTANT message is a turn. Its input is everything between the previous assistant message and this one: the system
 * prompt as the runtime assembled it, every user delivery since then, and any tool result the model has already read.
 */
function indexTurns(entries) {
  const turns = [];
  for (let i = 0; i < entries.length; i += 1) {
    if (entries[i]?.message?.role === "assistant") turns.push({ index: i, at: entries[i].timestamp ?? null });
  }
  return turns;
}

function describeTurn(entries, turn) {
  const previous = lastIndexBefore(entries, turn.index, (entry) => entry?.message?.role === "assistant");
  const start = previous === -1 ? 0 : previous + 1;

  const system = [];
  const user = [];
  const toolResults = [];
  for (let i = start; i < turn.index; i += 1) {
    const entry = entries[i];
    if (entry.type === "system") system.push(entry);
    else if (entry.message?.role === "user") user.push(entry);
    else if (entry.message?.role === "toolResult") toolResults.push(entry);
  }

  const assistant = entries[turn.index];
  const parts = assistant?.message?.content ?? [];
  const spoken = parts
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n");
  const called = parts.filter((part) => part.type === "toolCall").map((part) => part.name);

  return {
    turnAt: turn.at,
    stopReason: assistant?.message?.stopReason ?? null,
    layers: {
      system: system.map((entry) => measure(entry, textOf(entry))),
      user: user.map((entry) => measure(entry, textOf(entry))),
      toolResults: toolResults.map((entry) => measure(entry, textOf(entry))),
    },
    spoken: truncate(spoken, OPTIONS.full === true ? 1e9 : 600),
    calledTools: called,
  };
}

function lastIndexBefore(entries, bound, predicate) {
  for (let i = bound - 1; i >= 0; i -= 1) if (predicate(entries[i])) return i;
  return -1;
}

/** A Pi system entry carries its text in `message.content`; a user delivery may carry several text parts. */
function textOf(entry) {
  const content = entry?.message?.content ?? entry?.content ?? "";
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return JSON.stringify(content);
  return content
    .map((part) =>
      typeof part === "string"
        ? part
        : (part?.text ?? (part?.type === "toolResult" ? textOf({ message: part }) : JSON.stringify(part))),
    )
    .join("\n");
}

function measure(entry, text) {
  return {
    at: entry.timestamp ?? null,
    bytes: Buffer.byteLength(text, "utf8"),
    estimatedTokens: Math.ceil(Buffer.byteLength(text, "utf8") / 4),
    kind: classify(text),
    head: truncate(text.replace(/\s+/g, " "), OPTIONS.full === true ? 1e9 : 200),
  };
}

/**
 * WHICH layer a delivery belongs to. `HOST_SYNTHESIZED_DELIVERY_KINDS` names `gamebuddy_fact_batch`, so a machine
 * delivery is recognisable rather than being counted as a player speaking - the distinction two earlier defects turned
 * on.
 */
function classify(text) {
  if (text.startsWith("{") && text.includes("gamebuddy_fact_batch")) return "fact_batch";
  if (text.includes("<runtime-environment>")) return "environment";
  if (text.startsWith("<") && text.includes("</")) return "system_reminder";
  return "player_or_other";
}

function truncate(text, limit) {
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}… [${text.length - limit} more chars]`;
}

function render(report, session, turnCount) {
  const total = [...report.layers.system, ...report.layers.user, ...report.layers.toolResults].reduce(
    (sum, row) => sum + row.bytes,
    0,
  );
  process.stdout.write(`session ${session}\n`);
  process.stdout.write(
    `turn ${turnCount > 0 ? (report.turnAt ?? "(no timestamp)") : ""} of ${turnCount} · stop=${report.stopReason ?? "-"}\n`,
  );
  process.stdout.write(
    `input bytes ${total} (~${Math.ceil(total / 4)} tokens across ${report.layers.system.length + report.layers.user.length + report.layers.toolResults.length} entries)\n\n`,
  );

  for (const [name, rows] of Object.entries(report.layers)) {
    if (rows.length === 0) {
      process.stdout.write(`${name}: none\n`);
      continue;
    }
    const bytes = rows.reduce((sum, row) => sum + row.bytes, 0);
    process.stdout.write(
      `${name}: ${rows.length} entr${rows.length === 1 ? "y" : "ies"}, ${bytes} bytes (~${Math.ceil(bytes / 4)} tokens)\n`,
    );
    for (const row of rows) process.stdout.write(`  [${row.kind}] ${row.bytes}B  ${row.head}\n`);
    process.stdout.write("\n");
  }

  if (report.calledTools.length > 0) process.stdout.write(`called: ${report.calledTools.join(", ")}\n`);
  if (report.spoken.length > 0) process.stdout.write(`spoke: ${report.spoken}\n`);
}

function fail(message) {
  process.stderr.write(`read-agent-input: ${message}\n`);
  process.exit(1);
}
