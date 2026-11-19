/**
 * THE RUNNER'S OWN LOG, read by value: what a run had done at the moment it was last written.
 *
 * WHY. Every reading in `analysis/` used to start from `result.json`, which a run writes at its END. A run killed
 * mid-flight therefore published nothing, and the only record left was the runner's log - which carries every
 * `BRIDGE_FACT` and every `AGENT_PROGRAM_SUBMIT` as they happen. Measured 2026-11-19: `round78` was stopped eleven
 * minutes in, `action-breadth.mjs` printed `result_unreadable`, `airp-scorecard.mjs` printed `not_measured:no_bundle`,
 * and the run's ten action families and seventy-four executions - all of them in the log - were counted by hand.
 *
 * THE IDENTITY IS THE PRODUCER'S, NEVER THE LINE. One receipt's `detail` is written twice in a line
 * (`evidence.detail` and `worldFactPayload.evidence.detail`), so counting occurrences of a token doubles every number -
 * the mistake `round78`'s own audit made (16 instead of 8). Counting LINES is the same defect one level up: the log is
 * appended to by one process, but a re-submitted program appears twice and a receipt is the only thing that names one
 * execution. So every row here is keyed on the identity the producer gave it - `executionId` for a receipt,
 * `programId` for a submission - and the count of identities is printed beside the count of lines, because the
 * difference between them is a fact about the log rather than noise to be reconciled.
 *
 * THE LOG IS PARSED, NEVER SEARCHED. Only `BRIDGE_FACT` and `AGENT_PROGRAM_SUBMIT` lines are read, each one
 * JSON-parsed, and an account line that merely names an action (`GAME_TURN_ACCOUNT` prints every trace kind with a
 * count) can never be mistaken for one. A line the parser cannot read is counted and named, never skipped silently.
 */

import { closeSync, existsSync, openSync, readdirSync, readFileSync, readSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** How a captured log is named inside a run directory, and the suffix the launcher writes it under in `tools/`. */
export const RUNNER_LOG_NAME = "live-runner.log";
export const RUNNER_LOG_SUFFIX = "-live-runner.log";

/** Where the launcher puts a run's log, relative to the checkout. */
export const RUNNER_LOG_DIR = "tools";

/**
 * How far a log's own first instant may sit from the run's launch receipt and still be that run's log.
 *
 * The launcher arms the run directory about 1.5 s before it writes its first phase (measured: 1 427 ms on `round77`,
 * 1 654 ms on `round78`), so the bound has to clear that gap; a minute is far below the gap between two ladder runs,
 * which is what makes the match discriminating rather than decorative.
 */
export const LAUNCH_MATCH_MS = 60_000;

const FACT_PREFIX = "BRIDGE_FACT ";
const SUBMIT_PREFIX = "AGENT_PROGRAM_SUBMIT ";
const AT_MS = /"atMs":(\d+)/u;
const HEAD_BYTES = 8192;

const repositoryRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)));

function instantOf(line) {
  const match = AT_MS.exec(line);
  return match === null ? null : Number(match[1]);
}

/** The first instant a log carries, read from its head: the run's own statement of when it started writing. */
export function firstInstantOf(path) {
  let handle;
  try {
    handle = openSync(path, "r");
  } catch {
    return null;
  }
  try {
    const buffer = Buffer.alloc(HEAD_BYTES);
    const read = readSync(handle, buffer, 0, HEAD_BYTES, 0);
    for (const line of buffer.subarray(0, read).toString("utf8").split(/\r?\n/u)) {
      const at = instantOf(line);
      if (at !== null) return at;
    }
    return null;
  } finally {
    closeSync(handle);
  }
}

/**
 * The log belonging to one run directory, and the fact that bound it.
 *
 * THREE WAYS, in the order a reader can trust them: the caller named it; the run's capture copied it in; or - the only
 * automatic one - a log in `tools/` whose first line carries an instant within `LAUNCH_MATCH_MS` of this run's launch
 * receipt. The binding is the log's CONTENT, not its filename and not "the newest one", because the newest log belongs
 * to whichever run was started last and a reading of a neighbour's run is the defect this module exists to end.
 * Two logs matching the same instant is refused rather than resolved: picking one would be a coin toss over which run
 * was read.
 */
export function locateRunnerLog({
  runDir = null,
  logPath = null,
  logDir = null,
  startedAtMs = null,
  root = repositoryRoot,
} = {}) {
  if (typeof logPath === "string" && logPath.length > 0) {
    const absolute = resolve(logPath);
    return existsSync(absolute)
      ? { path: absolute, how: "named by --log", why: null }
      : { path: null, how: null, why: `--log ${logPath} does not exist` };
  }
  if (typeof runDir === "string" && runDir.length > 0) {
    const captured = join(runDir, RUNNER_LOG_NAME);
    if (existsSync(captured)) return { path: captured, how: "captured into the run directory", why: null };
  }
  if (!Number.isFinite(startedAtMs))
    return {
      path: null,
      how: null,
      why: "nothing binds this run to a log: its launch receipt carries no start instant, so no log can be identified as its own",
    };
  const directory = logDir === null ? join(root, RUNNER_LOG_DIR) : resolve(logDir);
  if (!existsSync(directory)) return { path: null, how: null, why: `${directory} does not exist` };
  const matching = [];
  for (const name of readdirSync(directory).sort())
    if (name.endsWith(RUNNER_LOG_SUFFIX)) {
      const candidate = join(directory, name);
      const first = firstInstantOf(candidate);
      if (first !== null && Math.abs(first - startedAtMs) <= LAUNCH_MATCH_MS)
        matching.push({ path: candidate, firstAtMs: first });
    }
  if (matching.length === 0)
    return {
      path: null,
      how: null,
      why: `no ${RUNNER_LOG_SUFFIX} under ${directory} starts within ${String(LAUNCH_MATCH_MS)} ms of this run's launch receipt`,
    };
  if (matching.length > 1)
    return {
      path: null,
      how: null,
      why: `ambiguous: ${matching.map((entry) => basename(entry.path)).join(", ")} all start within ${String(LAUNCH_MATCH_MS)} ms of this run's launch receipt, so which one this run wrote is not decidable here`,
    };
  return {
    path: matching[0].path,
    how: `its first line carries ${String(matching[0].firstAtMs)} ms, ${String(Math.abs(matching[0].firstAtMs - startedAtMs))} ms from this run's launch receipt`,
    why: null,
  };
}

/**
 * One receipt, keyed on the execution identity its producer gave it.
 *
 * `detail` is read ONCE, from the payload when the payload carries one: the same string sits in `evidence.detail` and
 * `worldFactPayload.evidence.detail`, so reading both and joining them would double every token it holds. `detailInBoth`
 * counts how many receipts carry it twice, which is the measurement behind that rule rather than a recollection of it.
 */
function receiptRow(fact) {
  const payload = fact.worldFactPayload ?? {};
  const origin = payload.origin ?? {};
  const executionId = typeof fact.executionId === "string" ? fact.executionId : null;
  const requestId = typeof fact.requestId === "string" ? fact.requestId : null;
  const payloadDetail = payload.evidence?.detail;
  const topDetail = fact.evidence?.detail;
  return {
    identity: executionId ?? requestId,
    identityField: executionId === null ? (requestId === null ? null : "requestId") : "executionId",
    requestId,
    executionId,
    actionId: typeof payload.actionId === "string" ? payload.actionId : null,
    state: typeof payload.state === "string" ? payload.state : null,
    reasonCode: typeof payload.reasonCode === "string" ? payload.reasonCode : null,
    programId: typeof origin.programId === "string" ? origin.programId : null,
    nodeId: typeof origin.nodeId === "string" ? origin.nodeId : null,
    detail: typeof payloadDetail === "string" ? payloadDetail : typeof topDetail === "string" ? topDetail : null,
    detailInBoth: typeof payloadDetail === "string" && typeof topDetail === "string",
    atMs: Number.isFinite(fact.atMs) ? fact.atMs : null,
  };
}

/**
 * The runner log, parsed and keyed: the receipts and the submissions it holds, with the counts that say what was
 * collapsed to key them.
 *
 * `counts.collapsedReceipts` / `counts.collapsedSubmissions` are the difference between the lines and the identities -
 * printed by every caller, because a log where they differ is a log where a count of lines would have been wrong.
 */
export function readRunnerLog(path) {
  const absolute = resolve(path);
  const text = readFileSync(absolute, "utf8");
  const lines = text.split(/\r?\n/u);
  const receipts = new Map();
  const submissions = new Map();
  const unreadable = [];
  let receiptLines = 0;
  let submissionLines = 0;
  let otherFacts = 0;
  let detailInBoth = 0;
  let firstAtMs = null;
  let lastAtMs = null;
  for (const [index, raw] of lines.entries()) {
    const line = raw.trim();
    if (line.length === 0) continue;
    const at = instantOf(line);
    if (at !== null) {
      if (firstAtMs === null) firstAtMs = at;
      lastAtMs = at;
    }
    const isFact = line.startsWith(FACT_PREFIX);
    const isSubmission = line.startsWith(SUBMIT_PREFIX);
    if (!(isFact || isSubmission)) continue;
    let parsed;
    try {
      parsed = JSON.parse(line.slice((isFact ? FACT_PREFIX : SUBMIT_PREFIX).length));
    } catch {
      unreadable.push(index + 1);
      continue;
    }
    if (isSubmission) {
      submissionLines += 1;
      if (typeof parsed?.programId !== "string") continue;
      if (!submissions.has(parsed.programId))
        submissions.set(parsed.programId, {
          programId: parsed.programId,
          code: typeof parsed.code === "string" ? parsed.code : null,
          nodes: Number.isInteger(parsed.nodes) ? parsed.nodes : null,
        });
      continue;
    }
    if (parsed?.type !== "execution_receipt") {
      otherFacts += 1;
      continue;
    }
    receiptLines += 1;
    const row = receiptRow(parsed);
    if (row.detailInBoth) detailInBoth += 1;
    // A receipt with neither identity cannot be keyed by its producer: it keeps its line number so that the reading
    // still counts it and says how many such rows there were, rather than dropping them.
    const identity = row.identity ?? `line:${String(index + 1)}`;
    if (receipts.has(identity)) continue;
    receipts.set(identity, Object.freeze({ ...row, identity }));
  }
  const resolvedReceipts = Object.freeze([...receipts.values()]);
  const resolvedSubmissions = Object.freeze([...submissions.values()]);
  return Object.freeze({
    path: absolute,
    bytes: Buffer.byteLength(text),
    lines: lines.length,
    firstAtMs,
    lastAtMs,
    receipts: resolvedReceipts,
    submissions: resolvedSubmissions,
    counts: Object.freeze({
      receiptLines,
      receipts: resolvedReceipts.length,
      collapsedReceipts: receiptLines - resolvedReceipts.length,
      submissionLines,
      submissions: resolvedSubmissions.length,
      collapsedSubmissions: submissionLines - resolvedSubmissions.length,
      submittedNodes: resolvedSubmissions.reduce((total, entry) => total + (entry.nodes ?? 0), 0),
      unkeyedReceipts: resolvedReceipts.filter((row) => row.identityField === null).length,
      detailInBoth,
      otherFacts,
      unreadable: Object.freeze(unreadable),
    }),
  });
}

/** Executions per action, counted once per receipt identity, with the receipts that name no action kept visible. */
export function actionExecutions(log) {
  const counts = new Map();
  let unnamed = 0;
  for (const receipt of log.receipts) {
    if (receipt.actionId === null) {
      unnamed += 1;
      continue;
    }
    counts.set(receipt.actionId, (counts.get(receipt.actionId) ?? 0) + 1);
  }
  return { counts, unnamed };
}

/** Settled states, counted once per receipt identity. */
export function actionStates(log) {
  const states = new Map();
  for (const receipt of log.receipts) {
    const state = receipt.state ?? "no_state";
    states.set(state, (states.get(state) ?? 0) + 1);
  }
  return states;
}

/** Every action the log shows more than a refusal for, sorted: the population the run's attempt list is read from. */
export function attemptedActions(log) {
  return Object.freeze([...actionExecutions(log).counts.keys()].sort());
}

/** Every action one of whose executions settled `succeeded`. */
export function succeededActions(log) {
  return Object.freeze(
    [...new Set(log.receipts.filter((receipt) => receipt.state === "succeeded").map((receipt) => receipt.actionId))]
      .filter((actionId) => actionId !== null)
      .sort(),
  );
}

/**
 * The programme nodes the log names, keyed by `(programId, nodeId)`.
 *
 * `nodeIdOnly` is printed beside it: `n01` exists in every programme, so the size of that set against the size of the
 * keyed one is exactly what a reading keyed on `nodeId` alone would have collapsed.
 */
export function programmeNodes(log) {
  const identities = new Map();
  const nodeIdOnly = new Set();
  for (const receipt of log.receipts) {
    if (receipt.programId === null || receipt.nodeId === null) continue;
    nodeIdOnly.add(receipt.nodeId);
    const key = `${receipt.programId}\u0000${receipt.nodeId}`;
    if (!identities.has(key)) identities.set(key, receipt.actionId);
  }
  return { identities, nodeIdOnly };
}

/** One line naming what the log holds, so a reader can see the population a reading came out of. */
export function describeRunnerLog(log) {
  const counts = log.counts;
  return (
    `${basename(log.path)}: ${String(log.lines)} lines · ${String(counts.receipts)} execution_receipt identities from ` +
    `${String(counts.receiptLines)} receipt lines` +
    `${counts.collapsedReceipts === 0 ? "" : ` (${String(counts.collapsedReceipts)} collapsed)`}` +
    `${counts.unkeyedReceipts === 0 ? "" : ` · ${String(counts.unkeyedReceipts)} carried no execution id`}` +
    ` · ${String(counts.submissions)} programme identities from ${String(counts.submissionLines)} submissions` +
    `${counts.collapsedSubmissions === 0 ? "" : ` (${String(counts.collapsedSubmissions)} re-submitted)`}` +
    ` · ${String(counts.otherFacts)} other facts (not executions)` +
    `${counts.unreadable.length === 0 ? "" : ` · ${String(counts.unreadable.length)} unreadable line(s): ${counts.unreadable.join(",")}`}`
  );
}
