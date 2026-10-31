/**
 * What one live run cost, and where it went.
 *
 * <p>
 * Every number here is DERIVED FROM A FILE and each line names that file, because the alternative is what this repository
 * spent a week doing: quoting a token count without saying which quantity it measured. `input` alone is not context -
 * `input + cacheRead` is - and a threshold that reads one while the discussion reads the other produces confident, wrong
 * conclusions. Measured 2026-10-31: the same run is 4.39M `input`, 12.48M `cacheRead`, and a 100,667-token peak.
 * </p>
 *
 * <h2>Four sections, and why each is separate</h2>
 *
 * <ul>
 *   <li><b>Context</b> - tokens the model was billed for, split by cache behaviour. A run whose cache hit rate collapses is
 *       paying full price for a prompt it already sent.</li>
 *   <li><b>Prompt composition</b> - tool definitions, system prompt, observations. Static bytes resent every turn are a
 *       per-turn tax independent of how much the companion does.</li>
 *   <li><b>Time</b> - tool round trips against the run's own wall clock. A tool that consumes a quarter of the run is a
 *       defect, not overhead.</li>
 *   <li><b>Attribution</b> - which tool and which category the time went to, so "slow" names an owner.</li>
 * </ul>
 *
 * <p>
 * Sources: `<run>/result.json` for what the harness recorded, and the bound session `.jsonl` for per-turn provider usage -
 * the latter is where `cacheRead`/`cacheWrite` live, because the harness narrows `usage` to four keys and drops them.
 * </p>
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

// The session-record parse lives in one module because a second reader now needs it: the Chat live loop publishes
// this same reading on its run, and two spellings of it would quote different numbers for one run.
import { cacheBreaks, peakContext, readUsages, sumOf } from "./run-cost-usage.mjs";

function parseArguments(argv) {
  const options = { run: null, json: false, limit: 1 };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--json") options.json = true;
    else if (argument === "--limit") options.limit = Number(argv[++index] ?? 1);
    else if (argument.startsWith("--run=")) options.run = argument.slice("--run=".length);
    else if (!argument.startsWith("--")) options.run = argument;
  }
  return options;
}

/** The newest run directories under the ladder, newest first. */
function newestRuns(root, limit) {
  const directory = resolve(root);
  if (!existsSync(directory)) return [];
  return readdirSync(directory)
    .map((name) => ({ name, path: join(directory, name), mtime: statSync(join(directory, name)).mtimeMs }))
    .sort((left, right) => right.mtime - left.mtime)
    .slice(0, limit);
}

/** The session file the harness bound to this run, from `toolTiming.record` - the harness's own word for it. */
function sessionFor(result, runDirectory) {
  const record = result.toolTiming?.record;
  if (typeof record !== "string") return null;
  const candidates = [
    join(runDirectory, "runtime-root", "contexts"),
    process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, "GameBuddy", "contexts") : null,
  ].filter((candidate) => candidate !== null);
  for (const candidate of candidates) for (const found of findByName(candidate, record)) return found;
  return null;
}

/** Depth-bounded search for a file by exact name. */
function findByName(directory, name, depth = 6) {
  if (depth < 0) return [];
  const found = [];
  let entries;
  try {
    entries = readdirSync(directory);
  } catch {
    return found;
  }
  for (const entry of entries) {
    const path = join(directory, entry);
    let stat;
    try {
      stat = statSync(path);
    } catch {
      continue;
    }
    if (stat.isDirectory()) found.push(...findByName(path, name, depth - 1));
    else if (entry === name) found.push(path);
  }
  return found;
}

/** Tool round-trip time, attributed by category and against the run's own wall clock. */
function toolTime(result) {
  const categories = result.toolTiming?.byCategory ?? {};
  const rows = Object.entries(categories)
    .map(([name, row]) => ({
      name,
      calls: Number(row.calls) || 0,
      sumMs: Number(row.sumMs) || 0,
      medianMs: row.medianMs ?? null,
      maxMs: row.maxMs ?? null,
    }))
    .filter((row) => row.calls > 0)
    .sort((left, right) => right.sumMs - left.sumMs);
  const totalMs = rows.reduce((total, row) => total + row.sumMs, 0);
  const runMs = Number(result.phaseTimings?.totalMs) || 0;
  return { rows, totalMs, runMs, share: runMs > 0 ? totalMs / runMs : null };
}

function report(runDirectory) {
  const resultPath = join(runDirectory, "result.json");
  const result = JSON.parse(readFileSync(resultPath, "utf8"));
  const sessionPath = sessionFor(result, runDirectory);
  const { usages, toolsAdded } = sessionPath === null ? { usages: [], toolsAdded: [] } : readUsages(sessionPath);

  const context = {
    source: sessionPath ?? "not found",
    turns: usages.length,
    input: sumOf(usages, "input"),
    cacheRead: sumOf(usages, "cacheRead"),
    cacheWrite: sumOf(usages, "cacheWrite"),
    output: sumOf(usages, "output"),
    reasoning: sumOf(usages, "reasoning"),
    totalTokens: sumOf(usages, "totalTokens"),
  };
  const billable = context.input + context.cacheRead;
  const hitRate = billable > 0 ? context.cacheRead / billable : null;
  const { peak, at } = peakContext(usages);

  const promptBytes = toolsAdded.map((tools) => ({
    tools: Array.isArray(tools) ? tools.length : null,
    bytes: JSON.stringify(tools).length,
  }));

  return {
    run: runDirectory,
    resultPath,
    context: { ...context, hitRate, peak, peakAt: at, cacheBreaks: cacheBreaks(usages) },
    prompt: { source: sessionPath ?? "not found", toolDefinitions: promptBytes },
    time: toolTime(result),
    harness: {
      // What the harness itself published, so a reader can see the gap this report fills rather than having to trust it.
      agentTurnOutcome: result.agentTurnOutcome ?? null,
      contextSummary: result.contextSummary ?? null,
    },
  };
}

function formatBytes(bytes) {
  return bytes >= 1024 ? `${(bytes / 1024).toFixed(1)}KB` : `${bytes}B`;
}

function percentage(value) {
  return value === null ? "n/a" : `${(value * 100).toFixed(1)}%`;
}

function writeText(document) {
  const out = [];
  out.push(`run            ${document.run}`);
  out.push(`result         ${document.resultPath}`);
  out.push(`session        ${document.context.source}`);
  out.push("");
  out.push(`CONTEXT  (source: session .jsonl - provider usage per turn)`);
  out.push(`  turns                 ${document.context.turns}`);
  out.push(`  input                 ${document.context.input}`);
  out.push(`  cacheRead             ${document.context.cacheRead}`);
  out.push(`  cacheWrite            ${document.context.cacheWrite}`);
  out.push(`  output                ${document.context.output}`);
  out.push(`  cache hit rate        ${percentage(document.context.hitRate)}  (cacheRead / (input + cacheRead))`);
  out.push(`  peak input+cacheRead  ${document.context.peak}  at ${document.context.peakAt ?? "?"}`);
  out.push(`  cache breaks          ${document.context.cacheBreaks.length}`);
  for (const item of document.context.cacheBreaks.slice(0, 5))
    out.push(`      turn ${item.turn} at ${item.at ?? "?"} (previous turn read ${item.previousCacheRead})`);
  out.push("");
  out.push(`PROMPT  (source: ${document.prompt.source})`);
  if (document.prompt.toolDefinitions.length === 0) out.push("  tool definitions      not recorded");
  for (const entry of document.prompt.toolDefinitions.slice(0, 3))
    out.push(`  toolsAdded            ${entry.tools ?? "?"} tools, ${formatBytes(entry.bytes)}`);
  out.push("");
  out.push(`TIME  (source: result.json toolTiming + phaseTimings)`);
  out.push(
    `  tool round trips      ${document.time.totalMs}ms of ${document.time.runMs}ms = ${percentage(document.time.share)}`,
  );
  out.push(
    `  ${"category".padEnd(20)} ${"calls".padStart(6)} ${"total".padStart(9)} ${"median".padStart(8)} ${"max".padStart(8)}`,
  );
  for (const row of document.time.rows.slice(0, 10))
    out.push(
      `  ${row.name.padEnd(20)} ${String(row.calls).padStart(6)} ${`${row.sumMs}ms`.padStart(9)} ` +
        `${String(row.medianMs ?? "-").padStart(8)} ${String(row.maxMs ?? "-").padStart(8)}`,
    );
  out.push("");
  out.push(`HARNESS  (what result.json publishes, for comparison)`);
  out.push(`  agentTurnOutcome      ${JSON.stringify(document.harness.agentTurnOutcome)}`);
  const summary = document.harness.contextSummary;
  out.push(
    `  contextSummary        ${summary === null ? "absent" : `activeTokens=${summary.activeTokens} droppedTokens=${summary.droppedTokens}`}`,
  );
  process.stdout.write(`${out.join("\n")}\n`);
}

const options = parseArguments(process.argv.slice(2));
const runs =
  options.run === null
    ? newestRuns(".live-runs/game-ladder", options.limit)
    : newestRuns(dirname(resolve(options.run)), 64).filter((run) => run.path === resolve(options.run));
if (runs.length === 0) {
  process.stderr.write(`no run found for ${options.run ?? ".live-runs/game-ladder"}\n`);
  process.exit(2);
}

const documents = runs.map((run) => report(run.path));
if (options.json)
  process.stdout.write(`${JSON.stringify(documents.length === 1 ? documents[0] : documents, null, 2)}\n`);
else for (const document of documents) writeText(document);
