#!/usr/bin/env node
/**
 * Automated, content-free Tavern narrative gate.
 *
 * The runner drives the Desktop composition bootstrap itself: it installs the
 * selected production generation into a fresh gate-owned root, spawns the
 * bundled runtime through the single formal Host entry, serves the private
 * guardian-session hello, validates the bootstrap acknowledgement, and then
 * talks to the composed chat-only surface through its authenticated Reference
 * Chat HTTP API to submit one real Dialogue turn. It never opens SQLite,
 * invokes a fake provider, or drives UI. Player Memory CRUD belongs to the
 * separate Management profile and has its own mounted gate.
 *
 * Prompt materialization is intentionally not inferred from the model's answer.
 * A one-shot provider-boundary marker is received over child IPC; it proves
 * only pre-send serialization. The real turn outcome remains a separate gate.
 */
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { lstat, mkdtemp, open, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { launchDesktopCompositionGateChild } from "./desktop-composition-launch.mjs";

const HOST_ROOT = resolve(fileURLToPath(new URL("../host/", import.meta.url)));
// The audited generation root. Production consumes the canonical `host/dist`
// pointer; local iteration may point this at a disposable generation built by
// host/scripts/build-desktop-launcher-test-generation.mjs, so a source change
// can be exercised before the protected Windows release CI republishes. The
// default is unchanged and this only ever *reads* the pointer it is given.
const OUTPUT_ROOT = process.env.GAMEBUDDY_TAVERN_GATE_OUTPUT_ROOT
  ? resolve(process.env.GAMEBUDDY_TAVERN_GATE_OUTPUT_ROOT)
  : join(HOST_ROOT, "dist");
const RUNNER_SCHEMA = "gamebuddy-tavern-narrative-gate/v1";
const RUNNER_ID = "tavern-narrative-gate";
const START_TIMEOUT_MS = 60_000;
const REQUEST_TIMEOUT_MS = 12_000;
const TURN_TIMEOUT_MS = 180_000;
const POST_SUBMIT_STATE_POLLS = 6;
const POST_SUBMIT_STATE_POLL_MS = 400;
const STOP_TIMEOUT_MS = 5_000;
const GRACEFUL_CLOSE_TIMEOUT_MS = 30_000;
const STDERR_LIMIT = 65_536;
const USAGE =
  "usage: node tools/run-tavern-narrative-gate.mjs [--report <path>] [--kind main|failure|recovery]";
/**
 * Cooperative close request the composed child already accepts on the gate's own
 * IPC channel (`desktop-runtime-bootstrap` `waitForTermination`). A SIGTERM on
 * Windows is TerminateProcess, so it is the ONLY way to make the child run its
 * own `composition.close()` and commit the durable Chat runtime teardown - which
 * is exactly what a `known` re-mount requires. Same schema string the memory
 * live loop uses; it is a request, not a capability.
 */
const COMPOSED_SHUTDOWN_REQUEST_SCHEMA = "gamebuddy-desktop-shutdown-request/v1";

/**
 * The bounded attempt kinds this runner can be asked to run. Each kind drives a
 * DIFFERENT product path, never the same happy path under another label:
 *
 * - `main`     - a fresh root, a fresh Chat, one turn that must complete.
 * - `failure`  - a fresh root whose provider genuinely rejects the request (the
 *                credential the product resolves is one the real endpoint
 *                refuses), so the turn must reach the durable `failed` terminal
 *                the runner observes through `/state`, carrying one of
 *                NARRATIVE_RUN_FAILURE_CODES as its problem code and having
 *                crossed the provider boundary first.
 * - `recovery` - one completed turn on a fresh root, then a cooperative close
 *                (the connection is dropped), then a `known` re-mount of the
 *                SAME root which must resume that exact authenticated Chat and
 *                complete a further turn in it.
 */
export const NARRATIVE_RUN_KINDS = Object.freeze(["main", "failure", "recovery"]);
/**
 * The one terminal position each kind must actually reach to report a pass. The
 * value is derived from observations the runner made (see the attempt builders),
 * never assigned by the caller, so asking for a kind cannot manufacture it.
 */
export const NARRATIVE_RUN_POSITIONS = Object.freeze({
  main: "fresh_chat_completed_turn",
  failure: "provider_rejected_turn_failed",
  recovery: "resumed_existing_chat_completed_turn",
});
/**
 * The bounded product problem codes an acceptable `failure` attempt may carry.
 *
 * The two COMPLETING kinds report a position derived from the turn they
 * completed. A designed failure completes nothing, so it has no completed
 * position to report - and that is exactly what the failing kind is required to
 * reach instead: the durable `failed` terminal the product's own `/state`
 * reports, with one of these codes, after the provider boundary was crossed.
 *
 * The codes are named here, beside the kinds, rather than left implicit, so the
 * requirement can be as strict as the other two: the product mints exactly
 * `runtime_unavailable` when Pi's prompt settlement rejects AFTER the request
 * crossed the provider boundary (`host/src/tavern/provider-invocation.ts` and
 * `host/src/tavern/p4-provider-start-execution.ts` both fail the turn with that
 * reasonCode), which is what a credential the real endpoint refuses produces. A
 * durable failure carrying any OTHER code - or a failure that never reached the
 * provider - is a different, incidental failure and must block. "Some failure
 * happened" is never the failing position this attempt is supposed to reach.
 */
export const NARRATIVE_RUN_FAILURE_CODES = Object.freeze(["runtime_unavailable"]);

/**
 * The credential override the `failure` attempt gives its child. The value is a
 * syntactically plausible key the real CPA endpoint rejects with 401, so the
 * provider genuinely fails inside the product's own provider path: no fake
 * provider, no stubbed transport, no product change. It is generated per run and
 * is never written into any report, log, or evidence field.
 */
function rejectedProviderCredential() {
  return `sk-gate-rejected-${randomBytes(24).toString("hex")}`;
}

export function parseArguments(argv) {
  let reportPath;
  let kind = "main";
  const seen = new Set();
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if ((flag !== "--report" && flag !== "--kind") || typeof value !== "string" || value.length === 0)
      throw new Error(USAGE);
    if (seen.has(flag)) throw new Error(`duplicate_${flag.slice(2)}`);
    seen.add(flag);
    if (flag === "--report") reportPath = resolve(value);
    else {
      if (!NARRATIVE_RUN_KINDS.includes(value)) throw new Error(USAGE);
      kind = value;
    }
  }
  return Object.freeze({ reportPath, kind });
}

export async function prepareReportTarget(path) {
  if (path === undefined) return undefined;
  if (!isAbsolute(path) || relative(path, dirname(path)) === "") throw new Error("invalid_report_path");
  try {
    await lstat(path);
    throw new Error("report_target_already_exists");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  const parent = dirname(path);
  let canonicalParent;
  try {
    canonicalParent = await realpath(parent);
  } catch {
    throw new Error("report_parent_missing_or_unresolvable");
  }
  const state = await lstat(canonicalParent);
  if (!state.isDirectory() || state.isSymbolicLink()) throw new Error("report_parent_not_real_directory");
  return join(canonicalParent, basename(path));
}

function contentFree(serialized) {
  return !/(?:The player prefers|private dialogue|private prompt|csrf|cookie|stateToken|bootstrap|raw provider output|prompt text)/i.test(
    serialized,
  );
}

export async function writeReport(path, report) {
  if (path === undefined) return;
  const serialized = `${JSON.stringify(report, null, 2)}\n`;
  if (!contentFree(serialized)) throw new Error("evidence_report_content_guard_rejected");
  const handle = await open(path, "wx", 0o600);
  try {
    await handle.writeFile(serialized, "utf8");
  } finally {
    await handle.close();
  }
}

function safeReasonCode(error) {
  const value = error instanceof Error ? error.message : String(error);
  return /^[a-z0-9_:.-]{1,160}$/i.test(value) ? value : "live_runner_internal_error";
}

/**
 * Neutral projection of fixed system failure codes so blocked evidence can be
 * written. Reason and runtime codes are fixed product/system identifiers, never
 * runtime content; a guard-word-bearing fragment would otherwise make the
 * evidence report un-writable by the content guard. Only these fixed-code
 * fragments are rewritten (and only after the safeReasonCode charset
 * validation); prompt text, transcripts, credentials, and raw provider output
 * never enter a report. The generic "bootstrap" fragment keeps the whole wire
 * launch family covered; add any future fixed-code fragment here, not in the
 * report body.
 */
const GUARD_SAFE_FAILURE_CODE_FRAGMENTS = Object.freeze([
  ["desktop_runtime_bootstrap_unavailable", "desktop_runtime_host_launch_unavailable"],
  ["desktop_compose_bootstrap_ack_invalid", "desktop_compose_host_launch_ack_invalid"],
  ["bootstrap_failed", "host_launch_failed"],
  ["bootstrap", "host_launch"],
]);

export function projectGuardSafeFailureCode(value) {
  const code = safeReasonCode(value);
  let projected = code;
  for (const [fragment, replacement] of GUARD_SAFE_FAILURE_CODE_FRAGMENTS) {
    projected = projected.split(fragment).join(replacement);
  }
  return projected;
}

const STARTUP_STDERR_CODE = /^[a-z][a-z0-9_.:-]{2,159}$/i;
const STARTUP_STDERR_REASON_PREFIX = "dialogue_start_stderr:";

export function classifyNarrativeStartupStderr(stderr) {
  if (typeof stderr !== "string" || stderr.length === 0) return undefined;
  for (const line of stderr.split(/\r?\n/).map((value) => value.trim())) {
    if (line.length === 0) continue;
    const code = line.replace(/^Error:\s*/i, "");
    if (!STARTUP_STDERR_CODE.test(code)) continue;
    const reason = `${STARTUP_STDERR_REASON_PREFIX}${code.toLowerCase()}`;
    if (/^[a-z0-9_:.-]{1,160}$/i.test(reason)) return reason;
  }
  return undefined;
}

export function classifyNarrativeStartupFailure(error, stderr) {
  const reason = safeReasonCode(error);
  if (!reason.startsWith("dialogue_exited_before_ready:") && reason !== "dialogue_start_timeout") return reason;
  return classifyNarrativeStartupStderr(stderr) ?? reason;
}

function sha256(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/**
 * The marker is an intentionally narrow provider-boundary contract. It proves
 * only that Pi serialized a request before the provider call; it does not
 * prove provider acceptance or a semantic response.
 */
export function evaluateNarrativeGateRuntime(value) {
  if (
    value?.schema !== "gamebuddy-tavern-narrative-gate-runtime/v1" ||
    typeof value.piSessionId !== "string" ||
    !/^[A-Za-z0-9_-]{1,256}$/.test(value.piSessionId)
  )
    return { observed: false, reasonCode: "provider_runtime_session_unavailable" };
  return { observed: true, piSessionId: value.piSessionId };
}

export function evaluateNarrativeGateMarker(value, expectedDigest, expectedSessionId) {
  if (value === undefined) return { observed: false, reasonCode: "provider_marker_unavailable" };
  if (
    value?.schema !== "gamebuddy-tavern-narrative-gate-marker/v1" ||
    typeof value.sessionId !== "string" ||
    typeof value.nonceSha256 !== "string" ||
    !/^[A-Za-z0-9_-]{1,256}$/.test(value.sessionId) ||
    !/^[a-f0-9]{64}$/.test(value.nonceSha256)
  )
    return { observed: false, reasonCode: "provider_marker_schema_invalid" };
  if (value.sessionId !== expectedSessionId || value.nonceSha256 !== expectedDigest)
    return { observed: false, reasonCode: "provider_marker_digest_mismatch" };
  return { observed: true, preSendSerialized: true };
}

/**
 * Schema-v2 deployment input for the immutable dialogue artifact. Initial
 * Tavern content is deliberately absent: Host production composition derives
 * and durably bootstraps it from this manifest before runtime construction.
 */
export function createNarrativeGateDeploymentManifest(runtimeRoot, principal, bootstrapOperationId) {
  return Object.freeze({
    schemaVersion: 2,
    topology: "independent_chat_and_game_surfaces",
    runtimeRoot,
    principal: Object.freeze({ ...principal }),
    bootstrapOperationId,
    authorityGeneration: 1,
  });
}

function deadlineFetch(url, options = {}) {
  return fetch(url, { ...options, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
}

async function bootstrap(origin, token) {
  const response = await deadlineFetch(`${origin}/api/tavern/v1/bootstrap`, {
    method: "POST",
    headers: { Origin: origin, "Content-Type": "application/json" },
    body: JSON.stringify({ apiVersion: 1, bootstrapToken: token }),
  });
  const body = await response.json();
  const cookie = response.headers.get("set-cookie")?.split(";", 1)[0];
  if (!response.ok || typeof cookie !== "string" || typeof body.csrfToken !== "string")
    throw new Error(`bootstrap_failed:${response.status}`);
  return Object.freeze({ cookie, csrf: body.csrfToken });
}

function sanitizeProblemCode(value) {
  return typeof value === "string" && /^[a-z0-9_.:-]{1,160}$/i.test(value) ? value : "unavailable";
}

function debugP4Stages(stderr) {
  // The `[DEBUG-chat-live-p4(4c)]` label is a historical name carried by the
  // current production Chat pipeline emitters (tavern/chat-pipeline-service.ts
  // and tavern/p4-provider-start-execution.ts). It is a live log-parse pattern
  // over production stderr, not a reference to the retired chat-live machine or
  // its entry; the emitters are not E3 deletion targets, so this pattern stays.
  if (typeof stderr !== "string") return [];
  const allowed = new Set(["claim_begin", "claim_done", "start_done", "continuation_error", "admission_ok", "arm_done", "preinvoke_begin", "plan_done", "context_begin", "context_done", "text_done", "prompt_begin", "native_final", "native_rejected_aborted", "native_rejected_error", "native_rejected_empty", "native_rejected_empty_text", "native_rejected_tool_only", "native_rejected_unsupported_content", "native_rejected_identity_mismatch", "commit_begin", "commit_reserved", "commit_rejected", "commit_done", "commit_error"]);
  return [...stderr.matchAll(/\[DEBUG-chat-live-p(?:4|4c)\] ([a-z_]+)/g)]
    .map((match) => match[1])
    .filter((stage) => allowed.has(stage));
}

function debugRuntimeCodes(stderr) {
  if (typeof stderr !== "string") return [];
  const codes = new Set();
  for (const line of stderr.split(/\r?\n/)) {
    const match = line.trim().match(/^(?:Error:\s*)?([a-z][a-z0-9_.:-]{2,159})$/i);
    if (match) codes.add(match[1].toLowerCase());
  }
  return [...codes].slice(0, 8).map((code) => projectGuardSafeFailureCode(code));
}

async function stop(child) {
  if (child === undefined || child.exitCode !== null) return "not_running";
  child.kill("SIGTERM");
  const exited = await Promise.race([
    new Promise((resolveStop) => child.once("exit", () => resolveStop(true))),
    new Promise((resolveStop) => setTimeout(() => resolveStop(false), STOP_TIMEOUT_MS)),
  ]);
  if (exited) return "terminated";
  child.kill("SIGKILL");
  await Promise.race([
    new Promise((resolveStop) => child.once("exit", () => resolveStop(undefined))),
    new Promise((resolveStop) => setTimeout(resolveStop, 1_000)),
  ]);
  return "killed_after_stop_timeout";
}

export function classifyNarrativeTurnOutcome(outcome, lifecycle) {
  if (outcome !== "timeout") return undefined;
  // The marker fires directly at Pi's provider boundary. Seeing it without a
  // terminal lifecycle event distinguishes a live provider wait from an SSE,
  // controller, or presentation terminal-signal loss.
  return lifecycle.includes("turn.state_changed")
    ? "dialogue_terminal_signal_unobserved"
    : "provider_request_pending";
}

/** The bounded terminal state one turn observation reached (a string for the
 * plain outcomes, the structured kind for a refusal or an observed failure). */
export function narrativeTurnTerminalState(outcome) {
  return typeof outcome === "object" && outcome !== null ? outcome.kind : outcome;
}

/**
 * The durable `chat.turn.state` a turn observation reached.
 *
 * `narrativeTurnTerminalState` returns the runner's observation KIND, and for a
 * failed turn that kind is `turn_failed` - while the durable state the product
 * reports through `/state` is `failed`. Deriving the failing kind's position from
 * the kind name compared `turn_failed` against `failed`, so a genuinely failed
 * live turn could never reach its position. One mapping, used for every attempt,
 * keeps the position evidence in the product's own durable vocabulary.
 */
export function narrativeTurnDurableState(outcome) {
  const kind = narrativeTurnTerminalState(outcome);
  return kind === "turn_failed" ? "failed" : kind;
}

/**
 * The bounded failure facts of a turn observation, or undefined when the turn did
 * not reach the durable `failed` terminal. `problemCode` is the product's own
 * bounded identifier (`/state`'s `chat.turn.problemCode`), never free text; a
 * failure that carried no usable code is projected as `unavailable`, which is not
 * an accepted failure code and therefore cannot satisfy the failing position.
 */
export function observedTurnFailure(outcome) {
  if (narrativeTurnTerminalState(outcome) !== "turn_failed") return undefined;
  const problemCode =
    typeof outcome === "object" && outcome !== null ? sanitizeProblemCode(outcome.problemCode) : "unavailable";
  return Object.freeze({ turnTerminalState: "failed", problemCode });
}

/** The bounded reason code for a turn that did NOT reach a completed terminal. */
export function classifyNarrativeTurnBlock(outcome) {
  if (typeof outcome !== "object" || outcome === null) return undefined;
  if (outcome.kind === "turn_failed") return `turn_failed:${sanitizeProblemCode(outcome.problemCode)}`;
  if (outcome.kind === "state_unavailable") return `state_failed:${outcome.status}`;
  if (outcome.kind === "submission_refused")
    return `message_failed:${outcome.status}:${sanitizeProblemCode(outcome.problemCode)}`;
  return undefined;
}

/** Bounded problem code from an authenticated refusal body; never its text. */
async function readProblemCode(response) {
  const body = await response.text().catch(() => "");
  return /"code"\s*:\s*"([a-z0-9_]+)"/u.exec(body)?.[1];
}

/**
 * The transcript projected to its structural facts only: role and order, never
 * the text. This is what the recovery attempt compares between the predecessor
 * Chat and the re-mounted one, and it is the only form the runner ever keeps.
 */
export function projectTranscriptShape(transcript) {
  if (!Array.isArray(transcript)) return Object.freeze([]);
  return Object.freeze(
    transcript.map((message) =>
      Object.freeze({
        role: typeof message?.role === "string" ? message.role : "unknown",
        order: Number.isSafeInteger(message?.order) ? message.order : -1,
      }),
    ),
  );
}

/** One authenticated `/state` read projected to bounded facts, or undefined. */
export async function readStateSnapshot(origin, client) {
  const response = await deadlineFetch(`${origin}/api/tavern/v1/state`, {
    headers: { Cookie: client.cookie, Origin: origin },
  }).catch(() => undefined);
  if (response === undefined) return undefined;
  const snapshot = await response.json().catch(() => undefined);
  if (!response.ok || snapshot === undefined) return undefined;
  return Object.freeze({
    transcript: projectTranscriptShape(snapshot.chat?.transcript),
    turnState: typeof snapshot.chat?.turn?.state === "string" ? snapshot.chat.turn.state : undefined,
    problemCode:
      typeof snapshot.chat?.turn?.problemCode === "string" ? snapshot.chat.turn.problemCode : undefined,
    chatPresent: snapshot.chat !== null && snapshot.chat !== undefined,
  });
}

/**
 * One player turn over the authenticated Reference Chat API.
 *
 * Every authenticated operation this makes is OBSERVED and reported; a refusal
 * or an unusable state snapshot is a returned observation, not an exception, so
 * `authenticatedReferenceChatApi` is derived from what actually happened rather
 * than asserted as a constant. The transcript is kept as structure only.
 */
export async function sendTurn(origin, client) {
  const events = [];
  const abort = new AbortController();
  const response = await fetch(`${origin}/api/tavern/v1/events?apiVersion=1`, { headers: { Cookie: client.cookie, Origin: origin }, signal: abort.signal });
  if (!response.ok || response.body === null) throw new Error(`events_failed:${response.status}`);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let outcome;
  let lastState;
  let lastProblemCode;
  const observations = { stateSnapshotObserved: false, submissionStatus: 0, submissionAccepted: false };
  const observed = new Promise((resolveOutcome) => {
    const timer = setTimeout(() => resolveOutcome("timeout"), TURN_TIMEOUT_MS);
    (async () => {
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let separator;
          while ((separator = buffer.indexOf("\n\n")) >= 0) {
            const frame = buffer.slice(0, separator);
            buffer = buffer.slice(separator + 2);
            const match = /^event: ([^\n]+)\ndata: (.+)$/m.exec(frame);
            if (!match) continue;
            const payload = JSON.parse(match[2]);
            if (payload.eventType === "turn.state_changed") {
              const state = payload.payload?.state;
              events.push("turn.state_changed");
              if (state === "completed") return resolveOutcome("completed");
              if (state === "failed") return resolveOutcome("turn_failed");
              if (state === "cancelled") return resolveOutcome("cancelled");
            }
          }
        }
      } catch {
        resolveOutcome("events_error");
      } finally {
        clearTimeout(timer);
      }
    })();
  });
  const state = await deadlineFetch(`${origin}/api/tavern/v1/state`, {
    headers: { Cookie: client.cookie, Origin: origin },
  });
  const snapshot = await state.json().catch(() => undefined);
  if (
    !state.ok ||
    !Number.isSafeInteger(snapshot?.selection?.generation) ||
    !Number.isSafeInteger(snapshot?.chat?.draft?.revision)
  ) {
    abort.abort();
    await reader.cancel().catch(() => undefined);
    return Object.freeze({
      outcome: Object.freeze({ kind: "state_unavailable", status: state.status }),
      lifecycle: events,
      lastState: undefined,
      lastProblemCode: undefined,
      observations: Object.freeze({ ...observations }),
    });
  }
  observations.stateSnapshotObserved = true;
  const message = await fetch(`${origin}/api/tavern/v1/messages`, {
    method: "POST",
    headers: {
      Origin: origin,
      Cookie: client.cookie,
      "X-CSRF-Token": client.csrf,
      "Idempotency-Key": randomBytes(16).toString("base64url"),
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      apiVersion: 1,
      selectionGeneration: snapshot.selection.generation,
      text: "Please respond naturally.",
      locale: "en",
      expectedDraftRevision: snapshot.chat.draft.revision,
    }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  observations.submissionStatus = message.status;
  if (message.status !== 202) {
    const problemCode = await readProblemCode(message);
    abort.abort();
    await reader.cancel().catch(() => undefined);
    return Object.freeze({
      outcome: Object.freeze({
        kind: "submission_refused",
        status: message.status,
        problemCode: sanitizeProblemCode(problemCode),
      }),
      lifecycle: events,
      lastState: undefined,
      lastProblemCode: problemCode,
      observations: Object.freeze({ ...observations }),
    });
  }
  observations.submissionAccepted = true;
  outcome = await observed;
  abort.abort();
  await reader.cancel().catch(() => undefined);
  // The stream is a notification channel. Reconcile its observation through
  // the authenticated durable `/state` projection so an SSE state is never
  // treated as a terminal provider result by itself.
  for (let attempt = 0; attempt < POST_SUBMIT_STATE_POLLS; attempt += 1) {
    const terminal = await deadlineFetch(`${origin}/api/tavern/v1/state`, {
      headers: { Cookie: client.cookie, Origin: origin },
    });
    const terminalSnapshot = await terminal.json().catch(() => undefined);
    const state = terminalSnapshot?.chat?.turn?.state;
    lastState = typeof state === "string" ? state : undefined;
    lastProblemCode = typeof terminalSnapshot?.chat?.turn?.problemCode === "string" ? terminalSnapshot.chat.turn.problemCode : undefined;
    if (terminal.ok && state === "completed") {
      outcome = "completed";
      break;
    }
    if (terminal.ok && state === "failed") {
      outcome = Object.freeze({ kind: "turn_failed", problemCode: sanitizeProblemCode(terminalSnapshot?.chat?.turn?.problemCode) });
      break;
    }
    if (terminal.ok && state === "cancelled") {
      outcome = "cancelled";
      break;
    }
    if (attempt + 1 < POST_SUBMIT_STATE_POLLS) await new Promise((resolvePoll) => setTimeout(resolvePoll, POST_SUBMIT_STATE_POLL_MS));
  }
  return Object.freeze({ outcome, lifecycle: events, lastState, lastProblemCode, observations: Object.freeze({ ...observations }) });
}

async function productionArtifactIdentity() {
  try {
    const pointer = JSON.parse(await readFile(join(OUTPUT_ROOT, "current.json"), "utf8"));
    if (
      typeof pointer.generation !== "string" ||
      !/^[A-Za-z0-9_-]{1,160}$/.test(pointer.generation) ||
      typeof pointer.inventoryDigest !== "string" ||
      !/^[a-f0-9]{64}$/.test(pointer.inventoryDigest)
    )
      throw new Error("invalid");
    return Object.freeze({ generation: pointer.generation, inventoryDigest: pointer.inventoryDigest });
  } catch {
    throw new Error("production_artifact_identity_unavailable");
  }
}

export function reportBase(runId, startedAt, artifact) {
  return {
    schema: RUNNER_SCHEMA,
    runner: { id: RUNNER_ID, version: 1 },
    runId,
    startedAt,
    completedAt: new Date().toISOString(),
    artifact,
    scope: "authenticated_reference_chat_api_and_real_provider",
    composedSurface: "chat-only",
    providerInvocation: false,
    // The note is gate metadata: it must never trip the evidence content guard
    // (The player prefers | private dialogue | private prompt | csrf | cookie |
    // stateToken | bootstrap | raw provider output | prompt text), so it stays
    // a neutral description of report scope rather than runtime content.
    note: "Desktop composition admission on a fresh gate-owned root; this report retains only gate metadata, run identity, and evidence outcome, never runtime content.",
  };
}

/**
 * One composed chat-only launch over the exact gate-owned root, plus the
 * authenticated Reference Chat session the runner then drives.
 *
 * `environment` overrides single child variables and nothing else: the
 * `failure` attempt uses it to hand the child a credential the real provider
 * endpoint rejects, so the provider fails inside the product's own provider path
 * with no fake provider and no product change.
 */
async function openComposedAttempt({ root, configPath, nonceSha256, gameSessionMode, environment }) {
  const spawnImpl =
    environment === undefined
      ? undefined
      : (command, args, options) => spawn(command, args, { ...options, env: { ...options.env, ...environment } });
  const launch = await launchDesktopCompositionGateChild({
    outputRoot: OUTPUT_ROOT,
    root,
    surface: "chat-only",
    nonceSha256,
    manifestPath: configPath,
    readyTimeoutMs: START_TIMEOUT_MS,
    gameSessionMode,
    ...(spawnImpl === undefined ? {} : { spawnImpl }),
  });
  const child = launch.child;
  const opened = { launch, child };
  let stderr = "";
  let marker;
  let runtimeMarker;
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    if (stderr.length < STDERR_LIMIT) stderr = `${stderr}${chunk}`;
  });
  launch.onMessage((value) => {
    if (value?.schema === "gamebuddy-tavern-narrative-gate-runtime/v1" && runtimeMarker === undefined)
      runtimeMarker = value;
    else if (value?.schema === "gamebuddy-tavern-narrative-gate-marker/v1" && marker === undefined) marker = value;
  });
  let ready;
  try {
    ready = await launch.waitForReady();
  } catch (error) {
    await closeComposedAttempt(opened, { graceful: false }).catch(() => undefined);
    throw new Error(classifyNarrativeStartupFailure(error, stderr));
  }
  const url = new URL(ready);
  const origin = `${url.protocol}//${url.host}`;
  const bootstrapToken = new URLSearchParams(url.hash.slice(1)).get("boot");
  try {
    if (bootstrapToken === null) throw new Error("bootstrap_token_missing");
    const client = await bootstrap(origin, bootstrapToken);
    return Object.freeze({
      launch,
      child,
      origin,
      client,
      stderr: () => stderr,
      marker: () => marker,
      runtimeSession: () => evaluateNarrativeGateRuntime(runtimeMarker),
    });
  } catch (error) {
    await closeComposedAttempt(opened, { graceful: false }).catch(() => undefined);
    throw error;
  }
}

/**
 * Close one composed attempt. `graceful` asks the child over the gate's own IPC
 * channel to run its own close path (which is what commits the durable Chat
 * runtime teardown a `known` re-mount requires); anything else is escalation to
 * the ordinary stop, so an ungrateful child still exits.
 */
async function closeComposedAttempt(attempt, { graceful }) {
  if (attempt === undefined) return;
  try {
    if (graceful) await requestComposedShutdown(attempt.child);
    else await stop(attempt.child);
  } finally {
    attempt.launch.dispose();
  }
}

/**
 * Ask a composed child to close itself and wait for it to actually exit.
 *
 * On Windows `child.kill("SIGTERM")` is TerminateProcess, so the child's own
 * close path never runs and the durable chat runtime teardown is never
 * committed - which the product then reports as a refused `known` re-mount. The
 * request is a request, not a capability: the parent could always terminate the
 * process. It always escalates to `stop()` so an unresponsive child cannot hang
 * the gate.
 */
export async function requestComposedShutdown(child, timeoutMs = GRACEFUL_CLOSE_TIMEOUT_MS) {
  if (child === undefined || child === null || child.exitCode !== null) return "not_running";
  const exited = new Promise((resolveExit) => child.once("exit", () => resolveExit(true)));
  if (typeof child.send === "function" && child.connected === true) {
    try {
      child.send(Object.freeze({ schema: COMPOSED_SHUTDOWN_REQUEST_SCHEMA, protocolVersion: 1 }));
    } catch {
      // The escalation below still guarantees an exit.
    }
  }
  const closed = await Promise.race([
    exited,
    new Promise((resolveTimeout) => setTimeout(() => resolveTimeout(false), timeoutMs)),
  ]);
  if (closed === true) return "closed";
  return await stop(child);
}

/** Marker callbacks fire over IPC at the provider boundary; let them drain. */
async function drainMarkers() {
  await new Promise((resolveDrain) => setTimeout(resolveDrain, 50));
}

/**
 * The one-shot provider-boundary marker evaluated against this attempt's own
 * runtime session identity. It proves only pre-send serialization: the marker
 * fires at Pi's `before_provider_request`, so it can be observed for a request
 * the provider afterwards rejects.
 */
function evaluateComposedAttemptPrompt(marker, nonceSha256, runtimeSession) {
  return evaluateNarrativeGateMarker(
      marker,
      nonceSha256,
      runtimeSession.observed ? runtimeSession.piSessionId : undefined,
  );
}

/**
 * `authenticatedReferenceChatApi` as an OBSERVATION: the authenticated state
 * read the product answered and the authenticated submission it accepted. It is
 * no longer a literal, so a run whose authenticated operations did not both
 * succeed reports false instead of true (see the focused unit test).
 */
export function deriveAuthenticatedReferenceChatApi(observations) {
  return observations?.stateSnapshotObserved === true && observations?.submissionAccepted === true;
}

/**
 * The one derivation of a kind's terminal position from the attempt's OBSERVED
 * facts. A pass requires the derived position to equal the kind's declared
 * position, so asking for a kind cannot manufacture its evidence: a happy path
 * labelled `failure` derives `undefined` and blocks.
 */
export function deriveAttemptPosition(kind, evidence) {
  if (kind === "main")
    return evidence?.freshChat === true &&
      evidence?.turnTerminalState === "completed" &&
      evidence?.providerBoundaryCrossed === true
      ? NARRATIVE_RUN_POSITIONS.main
      : undefined;
  if (kind === "failure")
    // A designed failure has no completed position, so its requirement is the
    // durable `failed` terminal itself: the provider boundary was crossed (Pi
    // serialized the request) and the durable problem code is one this plan
    // accepts. A failure with any other code, and a failure that never reached
    // the provider, derives nothing.
    return evidence?.turnTerminalState === "failed" &&
      evidence?.providerBoundaryCrossed === true &&
      NARRATIVE_RUN_FAILURE_CODES.includes(evidence?.problemCode)
      ? NARRATIVE_RUN_POSITIONS.failure
      : undefined;
  if (kind === "recovery") {
    const predecessor = evidence?.predecessorTranscriptLength;
    const resumed = evidence?.resumedTranscriptLength;
    const after = evidence?.postResumeTranscriptLength;
    return evidence?.freshChat === true &&
      evidence?.predecessorTurnTerminalState === "completed" &&
      evidence?.postResumeTurnTerminalState === "completed" &&
      evidence?.resumedTranscriptKeepsPredecessor === true &&
      Number.isSafeInteger(predecessor) &&
      predecessor >= 1 &&
      Number.isSafeInteger(resumed) &&
      resumed >= predecessor &&
      Number.isSafeInteger(after) &&
      after > resumed
      ? NARRATIVE_RUN_POSITIONS.recovery
      : undefined;
  }
  return undefined;
}

/**
 * The common attempt projection. `passed` and the position come only from
 * observed facts; every kind adds its own position evidence, and the reported
 * assertions stay the same five plus the honest disclosure.
 */
function composeAttempt({
  kind,
  turn,
  runtimeSession,
  prompt,
  stderr,
  requiredTerminalState,
  extraEvidence = {},
  extraStatuses = {},
  realTurnOutcomeObserved,
}) {
  const observations = turn.observations ?? {};
  // One vocabulary for the whole projection: the durable terminal state the
  // product reports (`failed`), not the runner's observation kind for the same
  // event (`turn_failed`).
  const turnTerminalState = narrativeTurnDurableState(turn.outcome);
  const failure = observedTurnFailure(turn.outcome);
  const statuses = {
    turn: turnTerminalState,
    lastState: turn.lastState,
    lastProblemCode: turn.lastProblemCode,
    p4Stages: debugP4Stages(stderr),
    runtimeCodes: debugRuntimeCodes(stderr),
    authenticatedApiOperations: Object.freeze({
      stateSnapshotObserved: observations.stateSnapshotObserved === true,
      submissionStatus: Number.isSafeInteger(observations.submissionStatus) ? observations.submissionStatus : 0,
      submissionAccepted: observations.submissionAccepted === true,
    }),
    ...extraStatuses,
  };
  const evidence = Object.freeze({
    freshChat: true,
    turnTerminalState,
    providerBoundaryCrossed: prompt.preSendSerialized === true,
    // A turn that reached the durable failure carries the product's own bounded
    // problem code. The gate checks it against the codes this plan accepts, so a
    // failure with any other code cannot be filed as the designed failing
    // position and the no-code case is reported as `unavailable`, never as a
    // pass.
    ...(failure === undefined ? {} : { problemCode: failure.problemCode }),
    ...extraEvidence,
  });
  const position = deriveAttemptPosition(kind, evidence);
  const passed =
    runtimeSession.observed === true &&
    prompt.observed === true &&
    turnTerminalState === requiredTerminalState &&
    position === NARRATIVE_RUN_POSITIONS[kind];
  return Object.freeze({
    state: passed ? "passed" : "blocked",
    providerInvocation: prompt.observed === true,
    position,
    positionEvidence: evidence,
    statuses: Object.freeze(statuses),
    assertions: Object.freeze({
      authenticatedReferenceChatApi: deriveAuthenticatedReferenceChatApi(observations),
      realDialogueTurnAttempted: turn.outcome !== "events_error",
      providerRuntimeSessionBound: runtimeSession.observed === true,
      providerPreSendSerialized: prompt.preSendSerialized === true,
      realTurnOutcomeObserved:
        realTurnOutcomeObserved ?? turnTerminalState === requiredTerminalState,
      providerAcceptedOrSemanticAnswer: false,
    }),
    reasonCode: passed
      ? undefined
      : runtimeSession.reasonCode ??
        prompt.reasonCode ??
        classifyNarrativeTurnBlock(turn.outcome) ??
        classifyNarrativeTurnOutcome(turn.outcome, turn.lifecycle) ??
        `narrative_gate_${kind}_position_not_reached`,
  });
}

async function withComposedAttempt({
  root,
  configPath,
  nonceSha256,
  gameSessionMode,
  environment,
  graceful = false,
  run,
}) {
  const attempt = await openComposedAttempt({ root, configPath, nonceSha256, gameSessionMode, environment });
  try {
    return await run(attempt);
  } finally {
    await closeComposedAttempt(attempt, { graceful }).catch(() => undefined);
  }
}

/** A fresh root, a fresh Chat, one turn that must complete. */
async function runMainAttempt({ root, configPath, nonceSha256 }) {
  return await withComposedAttempt({
    root,
    configPath,
    nonceSha256,
    gameSessionMode: "fresh",
    run: async (attempt) => {
      const turn = await sendTurn(attempt.origin, attempt.client);
      await drainMarkers();
      const runtimeSession = attempt.runtimeSession();
      const prompt = evaluateComposedAttemptPrompt(attempt.marker(), nonceSha256, runtimeSession);
      return composeAttempt({
        kind: "main",
        turn,
        runtimeSession,
        prompt,
        stderr: attempt.stderr(),
        requiredTerminalState: "completed",
      });
    },
  });
}

/**
 * A fresh root whose provider genuinely rejects the request: the child resolves a
 * credential the real endpoint answers with 401, so the turn must reach the
 * durable `failed` terminal the runner observes through `/state`, carrying one of
 * NARRATIVE_RUN_FAILURE_CODES as its bounded problem code and having crossed the
 * provider boundary first. The boundary marker proves Pi serialized the request
 * before the rejection, so the observed failure position is the provider's
 * rejection and not the product's admission.
 *
 * That expectation is stated here because it IS the requirement: a turn that
 * failed before the provider boundary, or failed with a code this plan does not
 * accept, is an incidental failure and leaves the attempt blocked - no failure is
 * not the same as the designed one.
 */
async function runFailureAttempt({ root, configPath, nonceSha256 }) {
  return await withComposedAttempt({
    root,
    configPath,
    nonceSha256,
    gameSessionMode: "fresh",
    environment: { CPA_OAI_API_KEY: rejectedProviderCredential() },
    run: async (attempt) => {
      const turn = await sendTurn(attempt.origin, attempt.client);
      await drainMarkers();
      const runtimeSession = attempt.runtimeSession();
      const prompt = evaluateComposedAttemptPrompt(attempt.marker(), nonceSha256, runtimeSession);
      // composeAttempt derives the failing position's evidence - durable state,
      // boundary, bounded product code - from this very observation.
      return composeAttempt({
        kind: "failure",
        turn,
        runtimeSession,
        prompt,
        stderr: attempt.stderr(),
        requiredTerminalState: "failed",
      });
    },
  });
}

/**
 * One completed turn on a fresh mount, the connection dropped (cooperative
 * close, so the product commits its own durable teardown), then a `known`
 * re-mount of the SAME root which must resume that exact authenticated Chat and
 * complete a further turn in it. This is the product's own restart/reconnect
 * path, not a second fresh start.
 */
async function runRecoveryAttempt({ root, configPath, nonceSha256 }) {
  const predecessor = await withComposedAttempt({
    root,
    configPath,
    nonceSha256,
    gameSessionMode: "fresh",
    graceful: true,
    run: async (attempt) => {
      const turn = await sendTurn(attempt.origin, attempt.client);
      const snapshot = await readStateSnapshot(attempt.origin, attempt.client);
      await drainMarkers();
      const runtimeSession = attempt.runtimeSession();
      const prompt = evaluateComposedAttemptPrompt(attempt.marker(), nonceSha256, runtimeSession);
      return Object.freeze({
        turn,
        runtimeSession,
        prompt,
        stderr: attempt.stderr(),
        transcript: snapshot?.transcript ?? Object.freeze([]),
      });
    },
  });
  const resumed = await withComposedAttempt({
    root,
    configPath,
    nonceSha256,
    gameSessionMode: "known",
    run: async (attempt) => {
      const before = await readStateSnapshot(attempt.origin, attempt.client);
      let turn;
      try {
        turn = await sendTurn(attempt.origin, attempt.client);
      } catch (error) {
        // A refused event stream is recorded as the resumed attempt's own
        // blocked observation; only that exact transport failure is tolerated.
        if (!(error instanceof Error) || !error.message.startsWith("events_failed:")) throw error;
      }
      const after = await readStateSnapshot(attempt.origin, attempt.client);
      await drainMarkers();
      const runtimeSession = attempt.runtimeSession();
      const prompt = evaluateComposedAttemptPrompt(attempt.marker(), nonceSha256, runtimeSession);
      return Object.freeze({ before, after, turn, runtimeSession, prompt, stderr: attempt.stderr() });
    },
  });
  const predecessorTranscript = predecessor.transcript;
  const resumedTranscript = resumed.before?.transcript ?? Object.freeze([]);
  const postResumeTranscript = resumed.after?.transcript ?? Object.freeze([]);
  const predecessorTurnTerminalState = narrativeTurnDurableState(predecessor.turn.outcome);
  const postResumeTurnTerminalState =
    resumed.turn === undefined ? "unavailable" : narrativeTurnDurableState(resumed.turn.outcome);
  // The resumed Chat keeps the predecessor's exact messages, in order. A fresh
  // second Chat cannot satisfy this: its transcript would not begin with the
  // predecessor's own player/companion entries.
  const resumedTranscriptKeepsPredecessor =
    resumed.before?.chatPresent === true &&
    predecessorTranscript.length >= 1 &&
    resumedTranscript.length >= predecessorTranscript.length &&
    predecessorTranscript.every(
      (message, index) =>
        resumedTranscript[index]?.role === message.role && resumedTranscript[index]?.order === message.order,
    );
  const mergedRuntimeSession = Object.freeze({
    observed: predecessor.runtimeSession.observed === true && resumed.runtimeSession.observed === true,
    piSessionId: resumed.runtimeSession.piSessionId,
    reasonCode: predecessor.runtimeSession.reasonCode ?? resumed.runtimeSession.reasonCode,
  });
  const mergedPrompt = Object.freeze({
    observed: predecessor.prompt.observed === true && resumed.prompt.observed === true,
    preSendSerialized:
      predecessor.prompt.preSendSerialized === true && resumed.prompt.preSendSerialized === true,
    reasonCode: predecessor.prompt.reasonCode ?? resumed.prompt.reasonCode,
  });
  const turn = resumed.turn ?? Object.freeze({
    outcome: "unavailable",
    lifecycle: Object.freeze([]),
    observations: Object.freeze({ stateSnapshotObserved: false, submissionStatus: 0, submissionAccepted: false }),
  });
  return composeAttempt({
    kind: "recovery",
    turn,
    runtimeSession: mergedRuntimeSession,
    prompt: mergedPrompt,
    stderr: `${predecessor.stderr}${resumed.stderr}`.slice(0, STDERR_LIMIT),
    requiredTerminalState: "completed",
    realTurnOutcomeObserved:
      predecessorTurnTerminalState === "completed" && postResumeTurnTerminalState === "completed",
    extraStatuses: {
      predecessorTurn: predecessorTurnTerminalState,
      resumedChatPresent: resumed.before?.chatPresent === true,
    },
    extraEvidence: {
      predecessorTurnTerminalState,
      predecessorTranscriptLength: predecessorTranscript.length,
      resumedTranscriptLength: resumedTranscript.length,
      postResumeTranscriptLength: postResumeTranscript.length,
      resumedTranscriptKeepsPredecessor,
      postResumeTurnTerminalState,
    },
  });
}

function buildAttemptReport({ runId, startedAt, artifact, kind, attempt }) {
  return {
    ...reportBase(runId, startedAt, artifact),
    kind,
    ...(attempt.position === undefined ? {} : { position: attempt.position }),
    state: attempt.state,
    providerInvocation: attempt.providerInvocation,
    assertions: attempt.assertions,
    positionEvidence: attempt.positionEvidence,
    statuses: attempt.statuses,
    ...(attempt.state === "passed"
      ? {}
      : {
          reasonCode: projectGuardSafeFailureCode(
            attempt.reasonCode ?? "narrative_gate_assertion_failed",
          ),
        }),
  };
}

export async function main(argv = process.argv.slice(2)) {
  const arguments_ = parseArguments(argv);
  const reportTarget = await prepareReportTarget(arguments_.reportPath);
  const root = await mkdtemp(join(tmpdir(), "gamebuddy-tavern-narrative-gate-"));
  const runId = randomBytes(12).toString("hex");
  const startedAt = new Date().toISOString();
  const nonce = randomBytes(18).toString("hex");
  const nonceSha256 = sha256(nonce);
  const identity = Object.freeze({
    playerId: "tavern_gate_player",
    companionId: "tavern_gate_companion",
    continuityId: "tavern_gate_continuity",
  });
  const bootstrapOperationId = `tavern_gate_bootstrap_${randomBytes(12).toString("hex")}`;
  const kind = arguments_.kind;
  let artifact;
  let report;
  try {
    artifact = await productionArtifactIdentity();
    const configPath = join(root, "dialogue.json");
    await writeFile(
      configPath,
      JSON.stringify(createNarrativeGateDeploymentManifest(root, identity, bootstrapOperationId)),
      "utf8",
    );
    const attempt =
      kind === "failure"
        ? await runFailureAttempt({ root, configPath, nonceSha256 })
        : kind === "recovery"
          ? await runRecoveryAttempt({ root, configPath, nonceSha256 })
          : await runMainAttempt({ root, configPath, nonceSha256 });
    report = buildAttemptReport({ runId, startedAt, artifact, kind, attempt });
  } catch (error) {
    report = {
      ...reportBase(runId, startedAt, artifact ?? null),
      kind,
      state: "blocked",
      reasonCode: projectGuardSafeFailureCode(error),
    };
  } finally {
    try {
      // Requested evidence is part of the gate contract. Never report a passed
      // live run when the create-only, content-free report could not be written.
      await writeReport(reportTarget, report);
    } finally {
      await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }).catch(() => undefined);
    }
  }
  console.log(JSON.stringify(report));
  return report.state === "passed" ? 0 : 2;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      console.error(JSON.stringify({ schema: RUNNER_SCHEMA, state: "blocked", reasonCode: safeReasonCode(error) }));
      process.exitCode = 2;
    });
}
