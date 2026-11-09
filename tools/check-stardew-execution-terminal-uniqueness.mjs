#!/usr/bin/env node
/**
 * ONE EXECUTION HAS ONE TERMINAL.
 *
 * The Mod reaches a consumer through two channels for the same receipt: the fact it PUSHES when a receipt is minted
 * (`ExecutionManager.AddTrace` -> `ModEntry.PublishReceipt` -> `BridgeSession.TryCreateReceiptEvent`, correlated to the
 * receipt's own requestId), and the ANSWER to the `execution_request`/`cancel_request` that asked for it (correlated to
 * that envelope). Both frames are byte-identical. Until 2026-11-09 the client fed both to its fact listeners, so a
 * consumer counting terminals counted one execution TWICE: measured in two live slices, one `feed_animal` execution
 * publishing `succeeded/hay_placed_in_trough` twice and one `pet_farm_animal` execution publishing
 * `rejected/farm_animal_already_petted_today` twice, while a `collect_animal_product` execution published one.
 *
 * THE ARTIFACT IS A CONSUMER'S READING OF ONE RUN, not a pipe capture. It says which frames reached the fact listeners
 * and which answers the caller received:
 *
 *   { "facts": [ <receipt frames the fact listeners emitted> ], "answers": [ <receipt frames received as answers> ] }
 *
 * A bare array, or an object carrying `receipts` / `terminals` / `frames`, is a FACT stream - which is what
 * `client.onFact` records - so a runner's `terminals` block and a smoke harness receipt buffer are read as they are.
 *
 * WHAT IS A VIOLATION, per channel. A re-answer to a replayed request is legitimate: one answer per request.
 *   answers - at most ONE terminal per requestId. Two is `duplicate_answer:<requestId>`.
 *   facts   - at most ONE terminal per executionId. Two is `duplicate_fact:<executionId>:<reasonCode>`.
 *   unsolicited - a terminal fact whose requestId nothing answered is that execution's only delivery. It is counted
 *                 (and held to the same one-per-execution rule) rather than treated as a separate class, because the
 *                 rule that matters is "one terminal per execution", not "who asked for it".
 *
 * The answer channel is counted by requestId and the fact channel by executionId because they are different identities:
 * a request names one ask, an execution names one piece of native work, and a replay answers the same execution again
 * under a new ask.
 *
 * WHY THE FACT RULE IS NOT "no fact for an answered request": the push is the fact channel's delivery for EVERY
 * execution the ledger publishes, and it is the SAME receipt the answer carries, so a fact whose requestId was also
 * answered is the normal shape. What is never normal is that execution reaching the fact listeners TWICE - by a second
 * mint, or by the answer being counted as a fact - and both of those are `duplicate_fact` on one executionId.
 *
 * THE POPULATION IS THE ARTIFACT, and the verdict prints how many receipt frames it examined: `answers N, facts M,
 * unsolicited K`. An artifact with no receipt frame at all is `not_measured`, never green.
 *
 * USAGE:
 *   node tools/check-stardew-execution-terminal-uniqueness.mjs --artifact <path> [--artifact <path> ...]
 *   node tools/check-stardew-execution-terminal-uniqueness.mjs <path> [<path> ...]         # positional form
 *
 * Exit 1 on any finding, 0 with a `*_skipped:` line when there is nothing to measure.
 *
 * red-proof: inject  one request's terminal duplicated on the answer channel of a two-channel artifact ->
 *   `duplicate_answer:request_feed_01` with `"duplicated":1` and exit 1, while the same artifact unduplicated
 *   passes (tools/check-stardew-execution-terminal-uniqueness.test.mjs)
 * red-proof: inject  the same terminal reaching the fact listeners twice -> `duplicate_fact:execution_feed_01:` +
 *   `hay_placed_in_trough,hay_placed_in_trough`, `"duplicated":1`, exit 1
 *   (tools/check-stardew-execution-terminal-uniqueness.test.mjs)
 */
import { readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { TERMINAL_STATES } from "./lib/stardew-native-smoke-harness-v1.mjs";

const GATE_ID = "stardew-execution-terminal-uniqueness";
/** The skip marker is read by `tools/check-ci-coverage.mjs` as `^[a-z][a-z0-9_]*_skipped:`, so it carries no hyphen. */
const GATE_SKIP_MARKER = `${GATE_ID.replace(/-/gu, "_")}_skipped:`;

/** A raw pipe frame (`{type, correlationId, payload}`) and a receipt record are read through one shape. */
export function normalizeReceiptFrame(entry) {
  if (entry === null || typeof entry !== "object") return null;
  const payload =
    entry.type === "execution_receipt" && entry.payload && typeof entry.payload === "object" ? entry.payload : entry;
  if (typeof payload.executionId !== "string" || typeof payload.state !== "string") return null;
  return {
    requestId: typeof payload.requestId === "string" ? payload.requestId : undefined,
    executionId: payload.executionId,
    state: payload.state,
    reasonCode: typeof payload.reasonCode === "string" ? payload.reasonCode : "",
  };
}

function terminalsOf(entries) {
  const terminals = [];
  for (const entry of entries) {
    const receipt = normalizeReceiptFrame(entry);
    if (receipt !== null && TERMINAL_STATES.has(receipt.state)) terminals.push(receipt);
  }
  return terminals;
}

/**
 * The two channels an artifact carries. Three fact-stream shapes exist in this tree - a live-action block
 * (`terminals`), a smoke harness receipt buffer (`receipts`), and a bare array - and one two-channel shape, which is
 * the reading this gate checks. Nothing is invented for a shape that is absent: an artifact that names no `answers`
 * has no answer population, and the verdict says so instead of calling it clean.
 */
export function readChannels(artifact) {
  if (Array.isArray(artifact)) return { facts: terminalsOf(artifact), answers: [], answerChannelPresent: false };
  if (artifact === null || typeof artifact !== "object") return { facts: [], answers: [], answerChannelPresent: false };
  if (Array.isArray(artifact.facts) || Array.isArray(artifact.answers))
    return {
      facts: terminalsOf(Array.isArray(artifact.facts) ? artifact.facts : []),
      answers: terminalsOf(Array.isArray(artifact.answers) ? artifact.answers : []),
      answerChannelPresent: true,
    };
  for (const field of ["receipts", "terminals", "frames"]) {
    if (Array.isArray(artifact[field]))
      return { facts: terminalsOf(artifact[field]), answers: [], answerChannelPresent: false };
  }
  const single = normalizeReceiptFrame(artifact);
  return { facts: single === null ? [] : terminalsOf([artifact]), answers: [], answerChannelPresent: false };
}

/**
 * The one measurement. `examined` is the population the verdict rests on; a zero there refuses to pass.
 */
export function classifyTerminals(channels) {
  const answeredRequestIds = new Set(channels.answers.map((receipt) => receipt.requestId).filter(Boolean));
  const unsolicited = channels.facts.filter((receipt) => !answeredRequestIds.has(receipt?.requestId));
  const answeredFacts = [];
  const findings = [];

  const terminalsByRequest = new Map();
  for (const receipt of channels.answers) {
    if (typeof receipt.requestId !== "string") continue;
    terminalsByRequest.set(receipt.requestId, [...(terminalsByRequest.get(receipt.requestId) ?? []), receipt]);
  }
  for (const [requestId, terminals] of terminalsByRequest) {
    if (terminals.length > 1)
      findings.push({
        code: `duplicate_answer:${requestId}`,
        detail: `${terminals.length} answers for one request (${terminals.map((t) => `${t.reasonCode}:${t.state}`).join(",")})`,
      });
  }

  for (const receipt of channels.facts) {
    if (answeredRequestIds.has(receipt?.requestId)) answeredFacts.push(receipt);
  }

  const factsByExecution = new Map();
  for (const receipt of channels.facts) {
    factsByExecution.set(receipt.executionId, [...(factsByExecution.get(receipt.executionId) ?? []), receipt]);
  }
  for (const [executionId, terminals] of factsByExecution) {
    if (terminals.length > 1)
      findings.push({
        code: `duplicate_fact:${executionId}:${terminals.map((t) => t.reasonCode).join(",")}`,
        detail: `${terminals.length} terminals reached the fact listeners for one execution (${terminals.map((t) => `${t.reasonCode}:${t.state}`).join(",")})`,
      });
  }

  return {
    examined: channels.facts.length + channels.answers.length,
    answers: channels.answers.length,
    answerRequests: terminalsByRequest.size,
    answerChannelPresent: channels.answerChannelPresent,
    facts: channels.facts.length,
    unsolicited: unsolicited.length,
    answeredFacts: answeredFacts.length,
    findings,
  };
}

function artifactEntries(path) {
  const text = readFileSync(path, "utf8").trim();
  if (text === "") return [];
  if (path.endsWith(".jsonl") || path.endsWith(".ndjson"))
    return text.split(/\r\n|\r|\n/u).flatMap((line) => (line.trim() === "" ? [] : [JSON.parse(line)]));
  return [JSON.parse(text)];
}

function pathsFromArgv(argv) {
  const paths = [];
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    if (argument === "--artifact") {
      if (argv[index + 1] === undefined) throw new Error("artifact_path_missing");
      paths.push(argv[++index]);
    } else if (!argument.startsWith("--")) {
      paths.push(argument);
    }
  }
  return paths;
}

function main(argv) {
  let paths;
  try {
    paths = pathsFromArgv(argv);
  } catch (error) {
    process.stderr.write(`${GATE_ID}_findings:${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
  if (paths.length === 0) {
    process.stdout.write(`${GATE_SKIP_MARKER} needs --artifact <path> to one run's receipt reading\n`);
    return 0;
  }
  const facts = [];
  const answers = [];
  let answerChannelPresent = false;
  for (const path of paths) {
    const resolved = resolve(path);
    try {
      statSync(resolved);
    } catch {
      process.stderr.write(`${GATE_ID}_findings:artifact_missing:${path}\n`);
      return 1;
    }
    for (const artifact of artifactEntries(resolved)) {
      const channels = readChannels(artifact);
      facts.push(...channels.facts);
      answers.push(...channels.answers);
      answerChannelPresent ||= channels.answerChannelPresent;
    }
  }
  const reading = classifyTerminals({ facts, answers, answerChannelPresent });
  if (reading.examined === 0) {
    process.stdout.write(
      `${GATE_SKIP_MARKER} examined 0 receipt frames in ${paths.length} artifact(s), so no terminal was compared\n`,
    );
    return 0;
  }
  for (const finding of reading.findings) process.stderr.write(`${finding.code} ${finding.detail}\n`);
  process.stdout.write(
    `{"gate":"${GATE_ID}","status":"${reading.findings.length === 0 ? "passed" : "failed"}",` +
      `"population":${reading.examined},"answers":${reading.answers},"answerRequests":${reading.answerRequests},` +
      `"facts":${reading.facts},"unsolicited":${reading.unsolicited},"duplicated":${reading.findings.length}}\n`,
  );
  if (!reading.answerChannelPresent)
    process.stdout.write("# answer channel not recorded by this artifact: answer rules were not compared\n");
  return reading.findings.length === 0 ? 0 : 1;
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  process.exit(main(process.argv.slice(2)));
