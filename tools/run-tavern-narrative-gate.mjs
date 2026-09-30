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

export function parseArguments(argv) {
  if (argv.length === 0) return Object.freeze({ reportPath: undefined });
  if (argv.length !== 2 || argv[0] !== "--report" || argv[1].length === 0)
    throw new Error("usage: node tools/run-tavern-narrative-gate.mjs [--report <path>]");
  return Object.freeze({ reportPath: resolve(argv[1]) });
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
  const snapshot = await state.json();
  if (
    !state.ok ||
    !Number.isSafeInteger(snapshot?.selection?.generation) ||
    !Number.isSafeInteger(snapshot?.chat?.draft?.revision)
  )
    throw new Error(`state_failed:${state.status}`);
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
  if (message.status !== 202) throw new Error(`message_failed:${message.status}`);
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
  return Object.freeze({ outcome, lifecycle: events, lastState, lastProblemCode });
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
  let child;
  let launch;
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
    launch = await launchDesktopCompositionGateChild({
      outputRoot: OUTPUT_ROOT,
      root,
      surface: "chat-only",
      nonceSha256,
      manifestPath: configPath,
      readyTimeoutMs: START_TIMEOUT_MS,
    });
    child = launch.child;
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    let marker;
    let runtimeMarker;
    launch.onMessage((value) => {
      if (value?.schema === "gamebuddy-tavern-narrative-gate-runtime/v1" && runtimeMarker === undefined)
        runtimeMarker = value;
      else if (value?.schema === "gamebuddy-tavern-narrative-gate-marker/v1" && marker === undefined) marker = value;
    });
    let ready;
    try {
      ready = await launch.waitForReady();
    } catch (error) {
      throw new Error(classifyNarrativeStartupFailure(error, stderr));
    }
    const url = new URL(ready);
    const origin = `${url.protocol}//${url.host}`;
    const bootstrapToken = new URLSearchParams(url.hash.slice(1)).get("boot");
    if (bootstrapToken === null) throw new Error("bootstrap_token_missing");
    const client = await bootstrap(origin, bootstrapToken);
    const turn = await sendTurn(origin, client);
    // Allow process IPC callbacks fired at the provider boundary to drain
    // before severing the child connection during teardown.
    await new Promise((resolveMarkerDrain) => setTimeout(resolveMarkerDrain, 50));
    await stop(child);
    child = undefined;
    const runtimeSession = evaluateNarrativeGateRuntime(runtimeMarker);
    const prompt = evaluateNarrativeGateMarker(
      marker,
      nonceSha256,
      runtimeSession.observed ? runtimeSession.piSessionId : undefined,
    );
    const turnFailed = typeof turn.outcome === "object" && turn.outcome?.kind === "turn_failed";
    const realTurn = turn.outcome === "completed";
    const turnBlockedReason = turnFailed
      ? `turn_failed:${turn.outcome.problemCode}`
      : classifyNarrativeTurnOutcome(turn.outcome, turn.lifecycle);
    const passed = runtimeSession.observed && prompt.observed && realTurn;
    report = {
      ...reportBase(runId, startedAt, artifact),
      state: passed ? "passed" : "blocked",
      providerInvocation: prompt.observed,
      assertions: {
        authenticatedReferenceChatApi: true,
        realDialogueTurnAttempted: turn.outcome !== "events_error",
        providerRuntimeSessionBound: runtimeSession.observed,
        providerPreSendSerialized: prompt.preSendSerialized === true,
        realTurnOutcomeObserved: realTurn,
        providerAcceptedOrSemanticAnswer: false,
      },
      statuses: {
        turn: typeof turn.outcome === "object" ? turn.outcome.kind : turn.outcome,
        lastState: turn.lastState,
        lastProblemCode: turn.lastProblemCode,
        p4Stages: debugP4Stages(stderr),
    runtimeCodes: debugRuntimeCodes(stderr),
      },
      ...(passed
        ? {}
        : {
            reasonCode: projectGuardSafeFailureCode(
              runtimeSession.reasonCode ?? prompt.reasonCode ?? turnBlockedReason ?? "narrative_gate_assertion_failed",
            ),
          }),
    };
  } catch (error) {
    report = { ...reportBase(runId, startedAt, artifact ?? null), state: "blocked", reasonCode: projectGuardSafeFailureCode(error) };
  } finally {
    await stop(child).catch(() => undefined);
    launch?.dispose();
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
