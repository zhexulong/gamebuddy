#!/usr/bin/env node
import { spawn } from "node:child_process";
/**
 * Chat live audit run harness (design/tasks/active/chat-run-audit-and-release-verdict.md Task 2).
 *
 * It drives the Desktop composition bootstrap itself against a fresh
 * gate-owned root, talks to the composed chat-only surface over its
 * authenticated Reference Chat HTTP API, submits real turns, stops one through
 * the authenticated cancel route, reloads the client surface from the
 * authenticated durable `/state`, and writes a `chat_run_audit/v1` trace.
 *
 * The trace is the product: it carries only sanitized metadata, bounded codes
 * and aggregate counts. It never carries prompt text, M0/M1 text, message
 * bodies, credentials, raw provider payloads, Pi JSONL, or SQLite content, and
 * the harness validates its own output against the frozen schema before it
 * writes anything.
 *
 * Evidence classes are frozen and must not be mixed (task doc §3.3):
 *
 * - Class A (authoritative product facts): authenticated `/state`, HTTP
 *   responses, the SSE stream, child IPC. Turn submit/terminal state, state
 *   reads, SSE frames and resync, provider pre-send, `presentation.committed`,
 *   `memory.*`, `recovery.reload.*`.
 * - Class B (diagnostic markers only): fixed production stderr markers
 *   (`[DEBUG-chat-live-p4c] ...`). These cover `presentation.admitted` /
 *   `presentation.rejected` only.
 *
 * Therefore `presentation.committed` is derived exclusively from the
 * authoritative `/state` transcript projection, and the stderr marker
 * `commit_done` is deliberately never mapped to it: a Class B marker must never
 * assert an authoritative presentation fact. A missing Class B marker produces
 * `presentation.observability_gap` and is never a failure.
 *
 * Provider facts are equally constrained. `provider.request.sent` is the only
 * pre-send evidence and comes from the one-shot child IPC marker
 * (`gamebuddy-tavern-narrative-gate-marker/v1`); `provider.settled` /
 * `provider.error` are derived from the durable terminal state and never assert
 * a provider-internal result. The marker binding is one-shot per Pi session, so
 * a turn after the first has no pre-send evidence of its own; the harness
 * reports that run-level observability honestly through
 * `run.finished`'s `meta.providerObservability` instead of guessing.
 *
 * MAINTENANCE CONTRACT — read before changing this file:
 *
 * 1. Extend this harness; never fork a parallel Chat live runner. Chat
 *    capability growth (new audit kinds, new probe steps, the release verdict)
 *    layers onto this same file and its `.pi/workflows/chat-audit-*.js` probe
 *    loop, so every run stays comparable with `tools/compare-chat-live-runs.mjs`.
 * 2. A harness change is not done until it has produced a REAL run against the
 *    real embedded provider and the mounted surface. Unit tests on this file
 *    prove the harness, not the product.
 * 3. After each real run, audit the trace with the `auditing-runs` skill and
 *    dispatch a reviewer subagent over it (the same requirement is recorded in
 *    tools/live-run/game/run-stardew-native-local-agent-ab-live.mjs). Findings feed the next
 *    iteration of THIS file. A fluent reply is never evidence that persistence,
 *    source placement, privacy or surface isolation worked.
 * 4. Never upgrade `blocked`/`inconclusive` to `passed`, and never suppress an
 *    audit signal to make a run look clean.
 */
import { randomBytes } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { launchDesktopCompositionGateChild } from "../../desktop-composition-launch.mjs";
// A thrown error's own text is never a reason code. `classifyFailure` decides the closed class and keeps the
// message in `errorMessage` beside the class, stack and first frame - the ONE spelling the tree already uses
// (`tools/check-failure-reason-codes.mjs` gates every `tools/live-run` consumer on it).
import { classifyFailure } from "../../lib/failure-dump.mjs";
import {
  assertRenderedTranscript,
  findBrowserExecutable,
  openBrowserEvidenceSession,
  reserveFreePort,
} from "../core/browser-evidence.mjs";
import { openLiveRunCapture } from "../core/capture.mjs";
import { buildCompanionExperience, evaluateCompanionReply } from "../core/companion-experience.mjs";
import { buildChatRunVerdict, narrateRunVerdict } from "../core/run-verdict.mjs";
import { startLocalStubProvider } from "../core/stub-provider.mjs";
import {
  buildAuditTrace,
  createAuditDeploymentManifest,
  createAuditRecorder,
  writeAuditTrace,
} from "./audit-trace.mjs";
import {
  AUDIT_IDENTITY,
  AUDIT_SURFACE,
  GENERATION,
  HARNESS_OUTCOME_SCHEMA,
  OPERATION_HANDLE,
  SHA256_HEX,
} from "./chat-audit-contract.mjs";
import { delay, isPlainObject, safeReasonCode, sha256 } from "./chat-audit-values.mjs";
import { HOST_ROOT } from "./host-build-modules.mjs";
import {
  boundedReason,
  conversationTurnBoundaryReason,
  evaluateProbeReply,
  loadProbeManifest,
  probeTurnCommittedGate,
  probeVerdict,
} from "./probe-manifest.mjs";
import {
  admitChatRun,
  chatRunReadinessTargets,
  declareChatDeliveryPreference,
  declareChatModelProfile,
  refusalCode,
} from "./provider-admission.mjs";
import {
  classifyGateMarkerFailures,
  classifyPresentationMarkers,
  classifyProbeMaterializationMarkers,
  classifyStartupFailure,
  evaluateProviderPreSendMarker,
  evaluateProviderRuntimeMarker,
  parseSseFrame,
  providerFirstResponseMs,
} from "./stderr-markers.mjs";
import { narrateUsage, readRunUsage } from "./usage-reading.mjs";
import {
  admitWireCaptureRun,
  buildWireReading,
  loadWireContractAnchors,
  narrateWireReading,
  narrateWireTrade,
  WIRE_MODEL_ID,
  WIRE_STUB_REPLY,
  wireCaptureRequested,
} from "./wire-capture.mjs";
import { buildWireContractReading, narrateWireContract } from "./wire-contract.mjs";

// The runner's public surface did not move with the code. Consumers (the audit suite, the compare tools) import these
// names from this file, and the split is about which file a fact is defined in, not about renaming what they read.
export {
  buildAuditTrace,
  contentFree,
  createAuditDeploymentManifest,
  createAuditRecorder,
  validateAuditEvent,
  validateAuditTrace,
  writeAuditTrace,
} from "./audit-trace.mjs";
export {
  AUDIT_KINDS,
  AUDIT_META_KEYS,
  AUDIT_PROBE_DIMENSIONS,
  AUDIT_PROBE_DISTANCES,
  AUDIT_VOCABULARY,
} from "./chat-audit-contract.mjs";
export {
  conversationTurnBoundaryReason,
  evaluateProbeReply,
  loadProbeManifest,
  probeTurnCommittedGate,
  probeVerdict,
} from "./probe-manifest.mjs";
export {
  admitChatRun,
  declareChatDeliveryPreference,
  declareChatModelProfile,
  foreignMagicContextStore,
  probeChatProviderReadiness,
  providerReadinessRefusal,
  refusalCode,
} from "./provider-admission.mjs";
export {
  classifyGateMarkerFailures,
  classifyPresentationMarkers,
  classifyProbeMaterializationMarkers,
  classifyStartupFailure,
  classifyStartupStderr,
  evaluateProviderPreSendMarker,
  evaluateProviderRuntimeMarker,
  parseSseFrame,
  providerFirstResponseMs,
} from "./stderr-markers.mjs";
export { CHAT_USAGE_SCHEMA, narrateUsage, readRunUsage } from "./usage-reading.mjs";
export {
  admitWireCaptureRun,
  buildWireReading,
  narrateWireReading,
  narrateWireTrade,
  summariseWireRequest,
  WIRE_CAPTURE_ENV,
  WIRE_MODEL_ID,
  WIRE_PROVIDER_ID,
  WIRE_READING_SCHEMA,
  WIRE_STUB_REPLY,
  wireCaptureRequested,
} from "./wire-capture.mjs";

// The audited generation root. Production consumes the canonical `host/dist`
// pointer; local iteration may point this at a disposable generation built by
// host/scripts/build-desktop-launcher-test-generation.mjs, so a source change can
// be exercised before the protected Windows release CI republishes. The default
// is unchanged, and this only ever *reads* the pointer it is given.
const AUDIT_OUTPUT_ROOT = process.env.GAMEBUDDY_CHAT_AUDIT_OUTPUT_ROOT
  ? resolve(process.env.GAMEBUDDY_CHAT_AUDIT_OUTPUT_ROOT)
  : join(HOST_ROOT, "dist");
const START_TIMEOUT_MS = 60_000;
const REQUEST_TIMEOUT_MS = 12_000;
const TURN_TIMEOUT_MS = 180_000;
const POST_SUBMIT_STATE_POLLS = 6;
const POST_SUBMIT_STATE_POLL_MS = 400;
const CANCEL_ARM_POLLS = 40;
const CANCEL_ARM_POLL_MS = 250;
const STOP_TIMEOUT_MS = 5_000;
const MARKER_DRAIN_MS = 50;
/** Fixed non-content submit text; it never enters the trace. */
// The player's text. Overridable so a run can carry a REAL intent (something a player would actually
// ask for) instead of a content-free one: with a content-free prompt only "did it say something" is
// judgeable, never relevance, persona depth or consistency across a conversation.
const SUBMIT_PROMPT_TEXT = process.env.GAMEBUDDY_CHAT_PROMPT ?? "Please respond naturally.";
// How many COMPLETED conversation turns a default run drives. The cancel probe is separate and always
// last (see below), so this number is exactly how many durable companion replies the run can produce.
const CONVERSATION_TURNS = Math.max(1, Math.min(8, Number(process.env.GAMEBUDDY_CHAT_TURNS ?? 2)));
// Keep the disposable runtime root on request, so the agent conversation's actual input and output can be
// READ after the run instead of inferred from the reply's wording. Off by default: the root is throwaway
// state, and a run that keeps it must say so in its own evidence.
const KEEP_RUNTIME_ROOT = process.env.GAMEBUDDY_CHAT_KEEP_ROOT === "1";
// One prompt per conversation turn, when the run wants to ask different questions (the always-on entry and
// an ordinary entry are retrieved differently, so proving the world book is in context needs both). Fewer
// prompts than turns repeats the last one; absent, every turn uses SUBMIT_PROMPT_TEXT.
const CONVERSATION_PROMPTS = (process.env.GAMEBUDDY_CHAT_PROMPTS ?? "")
  .split("|")
  .map((prompt) => prompt.trim())
  .filter((prompt) => prompt.length > 0);

const TERMINAL_TURN_STATES = Object.freeze(new Set(["completed", "cancelled", "failed"]));

export function parseArguments(argv) {
  if (argv.length === 0) return Object.freeze({ reportPath: undefined });
  if ((argv.length !== 2 && argv.length !== 4) || argv[0] !== "--report")
    throw new Error(
      "usage: node tools/live-run/chat/run-chat-live-audit.mjs [--report <path>] [--probe-manifest <path>]",
    );
  if (argv[1].length === 0 || (argv.length === 4 && (argv[2] !== "--probe-manifest" || argv[3].length === 0)))
    throw new Error(
      "usage: node tools/live-run/chat/run-chat-live-audit.mjs [--report <path>] [--probe-manifest <path>]",
    );
  return argv.length === 2
    ? Object.freeze({ reportPath: resolve(argv[1]) })
    : Object.freeze({ reportPath: resolve(argv[1]), probeManifestPath: resolve(argv[3]) });
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

import {
  buildLiveRunTextSideFile,
  createLiveRunTextCollector,
  LIVE_RUN_TEXT_MAX_CHARS,
  LIVE_RUN_TEXT_MAX_ENTRIES,
  liveRunTextSideFilePath,
  redactLiveRunText,
} from "../core/capture-text.mjs";
/**
 * Side-file transcript capture (option B — independent of the frozen trace).
 *
 * The trace must stay content-free; the naturalness question needs the words. Keeping them in a
 * separate, bounded, redacted file satisfies both: an audit reader gets the reply text, and the trace
 * contract is untouched. Macro residue and obvious secret shapes are redacted rather than dropped, so a
 * reader can still see that the reply contained one.
 */
import { assertLiveRunPersonaMounted, provisionLiveRunPersona } from "../core/persona.mjs";

// The surface's own schema name; the POLICY (bounds, redaction, beside-not-inside) lives in core, so a
// change to it lands in one place instead of once per surface.
export const CHAT_TRANSCRIPT_SCHEMA = "chat_run_transcript/v1";
export const CHAT_TRANSCRIPT_MAX_ENTRIES = 40;
export const CHAT_TRANSCRIPT_MAX_CHARS = 600;
// Thin adapters over the one capture policy in core (tools/live-run/core/capture-text.mjs).
export const redactForTranscript = (value) => redactLiveRunText(value, { maxChars: LIVE_RUN_TEXT_MAX_CHARS });

export function buildTranscriptSideFile({ runId, entries }) {
  return buildLiveRunTextSideFile({
    schema: CHAT_TRANSCRIPT_SCHEMA,
    runId,
    entries: entries.map((entry) => ({ role: entry?.role, text: entry?.text })),
  });
}

/**
 * Where the side file goes: beside the report, sharing its stem. A run without a report path has no
 * durable location, so nothing is written (the trace still goes to stdout).
 */
/**
 * The words this run delivered. Module-level because the two collectors live in different scopes: the
 * player text is pushed inside `collectRun` and the committed reply inside the module-level
 * `awaitTerminal`. A run-scoped buffer cannot be seen by both — declaring one inside `collectRun` is
 * exactly what made a real run fail with `chat_audit_runner_internal_error`.
 */
const capturedTranscriptEntries = createLiveRunTextCollector({ maxEntries: LIVE_RUN_TEXT_MAX_ENTRIES });

export const transcriptSideFilePath = (reportTarget) => liveRunTextSideFilePath(reportTarget);

/**
 * Durable projection of one authenticated `/state` read. `chat.turn` is the
 * current turn ledger projection and `chat.transcript` is the durable
 * append-only transcript, which is the only authority for a committed
 * companion presentation.
 */
export function projectStateSnapshot(snapshot) {
  if (!(isPlainObject(snapshot) && isPlainObject(snapshot.chat))) return undefined;
  if (!Number.isSafeInteger(snapshot.selection?.generation)) return undefined;
  const turn = snapshot.chat.turn ?? null;
  const transcript = Array.isArray(snapshot.chat.transcript) ? snapshot.chat.transcript : [];
  const committedCompanion = transcript.filter((message) => message?.role === "companion");
  // Probe keyword matching sees ONLY the last committed companion message: that
  // is the probe turn's reply. Taking the last text-BEARING message instead would
  // fall back to an earlier turn when the newest message has no text, and joining
  // the whole transcript would let any earlier turn satisfy the match — either way
  // a `distractor.confused` would be a statement about the conversation rather
  // than about the probe turn.
  const lastCompanion = committedCompanion.at(-1);
  const committedCompanionText = typeof lastCompanion?.text === "string" ? lastCompanion.text : "";
  return Object.freeze({
    selectionGeneration: snapshot.selection.generation,
    draftRevision: Number.isSafeInteger(snapshot.chat.draft?.revision) ? snapshot.chat.draft.revision : undefined,
    turnHandle: typeof turn?.handle === "string" ? turn.handle : undefined,
    turnState: typeof turn?.state === "string" ? turn.state : undefined,
    problemCode: typeof turn?.problemCode === "string" ? boundedReason(turn.problemCode, undefined) : undefined,
    canCancel: turn?.canCancel === true,
    transcriptLength: transcript.length,
    committedCompanionMessages: committedCompanion.length,
    memoryReadAvailable: snapshot.memory?.readAvailable === true,
    // Probe keyword matching uses the durable committed companion TEXT (never a
    // trace field). It is present only when there is text to match, so the
    // projection shape remains unchanged for the common (probe-less) path.
    ...(committedCompanionText.length === 0 ? {} : { committedCompanionText }),
  });
}

/**
 * Reload comparison against the previously observed durable terminal state. The
 * transcript is append-only, so a shrinking transcript or a lost committed
 * companion message is a durable-continuity mismatch, never a rendering detail.
 */
export function compareReloadSnapshot(previous, reloaded) {
  if (previous.turnHandle !== reloaded.turnHandle)
    return Object.freeze({ consistent: false, reason: "turn_handle_changed" });
  if (previous.turnState !== reloaded.turnState)
    return Object.freeze({ consistent: false, reason: "turn_state_changed" });
  if (previous.transcriptLength > reloaded.transcriptLength)
    return Object.freeze({ consistent: false, reason: "transcript_truncated" });
  if (previous.committedCompanionMessages > reloaded.committedCompanionMessages)
    return Object.freeze({ consistent: false, reason: "committed_presentation_lost" });
  if (previous.selectionGeneration !== reloaded.selectionGeneration)
    return Object.freeze({ consistent: false, reason: "selection_generation_changed" });
  return Object.freeze({ consistent: true, reason: undefined });
}

function deadlineFetch(url, options = {}) {
  return fetch(url, { ...options, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
}

async function bootstrap(origin, token, sessionEntry) {
  // The surface that was mounted decides how a caller gets a session, and the acknowledgement publishes
  // it. Guessing the management route is how a truthful 404 became a day-long investigation.
  if (sessionEntry?.kind !== "http")
    throw new Error(
      `session_entry_unusable:${sessionEntry?.kind ?? "unpublished"}: the launched surface's session entry is not an HTTP token exchange`,
    );
  const response = await deadlineFetch(`${origin}${sessionEntry.route}`, {
    method: "POST",
    headers: { Origin: origin, "Content-Type": "application/json" },
    body: JSON.stringify({ apiVersion: 1, bootstrapToken: token }),
  });
  const body = await response.json().catch(() => undefined);
  const cookie = response.headers.get("set-cookie")?.split(";", 1)[0];
  if (!response.ok || typeof cookie !== "string" || typeof (body?.csrfToken ?? body?.chat?.csrfToken) !== "string") {
    process.stderr.write(
      `[bootstrap-diag] ${response.status} ${response.url ?? ""} body=${(() => {
        try {
          return JSON.stringify(body ?? null);
        } catch {
          return "unavailable";
        }
      })().slice(0, 300)}\n`,
    );
    throw new Error(`bootstrap_failed:${response.status}`);
  }
  return Object.freeze({ cookie, csrf: body.csrfToken ?? body.chat.csrfToken });
}

async function readStateSnapshot({ origin, client, recorder }) {
  let response;
  try {
    response = await deadlineFetch(`${origin}/api/tavern/v1/state`, {
      headers: { Cookie: client.cookie, Origin: origin },
    });
  } catch {
    return Object.freeze({ ok: false, reasonCode: "state_unreachable" });
  }
  const body = await response.json().catch(() => undefined);
  if (!response.ok) {
    recorder.record("http", "harness", "state.conflict", { status: response.status });
    return Object.freeze({ ok: false, reasonCode: `state_conflict:${response.status}` });
  }
  recorder.record("http", "harness", "state.read");
  const projection = projectStateSnapshot(body);
  if (projection === undefined) {
    recorder.record("http", "harness", "state.conflict", {
      status: response.status,
      reason: "state_snapshot_unusable",
    });
    return Object.freeze({ ok: false, reasonCode: "state_snapshot_unusable" });
  }
  return Object.freeze({ ok: true, projection });
}

async function submitTurn({ origin, client, projection, recorder, message = SUBMIT_PROMPT_TEXT }) {
  const response = await deadlineFetch(`${origin}/api/tavern/v1/messages`, {
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
      selectionGeneration: projection.selectionGeneration,
      text: message,
      locale: "en",
      ...(projection.draftRevision === undefined ? {} : { expectedDraftRevision: projection.draftRevision }),
    }),
  });
  if (response.status !== 202) throw new Error(`message_failed:${response.status}`);
  const body = await response.json().catch(() => undefined);
  const disposition =
    body?.disposition === "accepted" || body?.disposition === "duplicate" ? body.disposition : undefined;
  recorder.record("lifecycle", "harness", "turn.submitted", disposition === undefined ? undefined : { disposition });
  return Object.freeze({ disposition });
}

/**
 * The authenticated cancel route. It returns the durable race winner, so a fast
 * completion is reported as `completion_won` / `already_terminal` rather than as
 * a fabricated cancellation.
 *
 * This never emits `turn.terminal` itself. The 200 response can legitimately
 * carry a NON-terminal `turn.state` (the route projects `running` when the turn
 * advanced past the cancellable phase), and §3.1 requires `turn.terminal` to
 * carry one of the three durable terminal states. Synthesising `stopping` here
 * would both invent a state the reference projection never produces and assert a
 * terminal the harness did not observe; the `/state` read-back in `awaitTerminal`
 * is the only authority for that fact.
 */
async function cancelTurn({ origin, client, projection, turnHandle }) {
  if (typeof turnHandle !== "string" || !OPERATION_HANDLE.test(turnHandle))
    return Object.freeze({ ok: false, reasonCode: "cancel_turn_handle_invalid" });
  const response = await deadlineFetch(`${origin}/api/tavern/v1/turns/${encodeURIComponent(turnHandle)}/cancel`, {
    method: "POST",
    headers: { Origin: origin, Cookie: client.cookie, "X-CSRF-Token": client.csrf, "Content-Type": "application/json" },
    body: JSON.stringify({ apiVersion: 1, selectionGeneration: projection.selectionGeneration }),
  });
  if (!response.ok) return Object.freeze({ ok: false, reasonCode: `cancel_failed:${response.status}` });
  const body = await response.json().catch(() => undefined);
  const disposition =
    body?.disposition === "cancelled" ||
    body?.disposition === "completion_won" ||
    body?.disposition === "already_terminal"
      ? body.disposition
      : undefined;
  const state = typeof body?.turn?.state === "string" ? body.turn.state : undefined;
  // Nothing is recorded here. This route's 200 can carry a non-terminal
  // `turn.state`, and `turn.terminal` must carry one of the three durable
  // terminal states, so asserting a terminal from this response would fabricate
  // one. The observed disposition is attached to the real terminal by
  // `awaitTerminal` once `/state` has been read back.
  return Object.freeze({ ok: true, disposition, state });
}

/**
 * One SSE observation connection per turn. A missing stream is a harness
 * boundary degradation, not a fabricated observation: the durable `/state`
 * read-back stays authoritative either way.
 *
 * `cursor` is the last event id this reader actually received on this run's
 * earlier connections. The host serves a bounded replay window and treats a
 * request for a sequence it can no longer replay as `resync("gap")`, so a reader
 * that reconnects without its cursor from `sequence: 0` forces a gap as soon as
 * the window rolls — a gap the reader itself created, which then looked like a
 * host stream defect in the audit. The cursor is therefore carried forward.
 */
export async function openEventStream({ origin, client, recorder, cursor = undefined }) {
  const controller = new AbortController();
  const connectDeadline = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  const query = cursor === undefined ? "" : `&cursor=${encodeURIComponent(cursor)}`;
  let response;
  try {
    response = await fetch(`${origin}/api/tavern/v1/events?apiVersion=1${query}`, {
      headers: { Cookie: client.cookie, Origin: origin },
      signal: controller.signal,
    });
  } catch {
    clearTimeout(connectDeadline);
    return Object.freeze({ ok: false, reasonCode: "events_unreachable" });
  }
  clearTimeout(connectDeadline);
  if (!response.ok || response.body === null) {
    controller.abort();
    return Object.freeze({ ok: false, reasonCode: `events_failed:${response.status}` });
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let latestCursor = cursor;
  let settleTerminal;
  const terminal = new Promise((resolveTerminal) => {
    settleTerminal = resolveTerminal;
  });
  const pump = (async () => {
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let separator;
        while ((separator = buffer.indexOf("\n\n")) >= 0) {
          const raw = buffer.slice(0, separator);
          buffer = buffer.slice(separator + 2);
          if (raw.trim().length === 0) continue;
          const frame = parseSseFrame(raw);
          if (!frame.ok) {
            recorder.record("sse", "harness", "frame.invalid", { reason: frame.reason });
            continue;
          }
          recorder.record("sse", "host", "frame.received");
          // A paced reply reaches the surface as several pieces before the turn
          // settles. Recording the frame alone made the run trace identical
          // whether pacing was on or off, so the delivery preference was
          // unobservable from the product's own evidence. The piece's TEXT is
          // never recorded - only that one arrived and where in the turn it
          // landed, which is what "did the player see something this early" needs.
          if (frame.eventType === "companion.delta") {
            recorder.record("presentation", "host", "piece");
          }
          // The id carried on the frame is the reader's resume point; without
          // recording it the next connection would start from zero again.
          if (typeof frame.cursor === "string" && frame.cursor.length > 0) latestCursor = frame.cursor;
          if (frame.eventType === "stream.resync_required") {
            recorder.record("sse", "host", "stream.resync", {
              reason: boundedReason(frame.payload.payload?.reason, "unknown"),
            });
            // The host closes a resync response, so the observable truth for this
            // turn comes from the durable `/state` read-back. Resolving the
            // terminal wait here is what keeps an observer-side stream close from
            // being reported as a 180 s product idle stall.
            settleTerminal("resync");
            continue;
          }
          if (frame.eventType === "turn.state_changed") {
            const state = frame.payload.payload?.state;
            if (TERMINAL_TURN_STATES.has(state)) settleTerminal(state);
          }
        }
      }
    } catch {
      // A closed or aborted stream is normal; `/state` remains the authority.
    }
  })();
  return Object.freeze({
    ok: true,
    /** Last event id seen on this connection: the next connection resumes here. */
    cursor: () => latestCursor,
    waitForTerminal: (timeoutMs) => Promise.race([terminal, delay(timeoutMs).then(() => "timeout")]),
    async close() {
      controller.abort();
      await reader.cancel().catch(() => undefined);
      await pump.catch(() => undefined);
    },
  });
}

/**
 * Waits for the turn's terminal state and reconciles it through the
 * authenticated durable `/state` projection: an SSE terminal signal alone is
 * never promoted to a durable terminal fact.
 *
 * `projectionBefore` is the pre-submit snapshot used ONLY as the
 * committed-message baseline. It is deliberately not a candidate terminal: the
 * current turn projection at that moment is whatever the PREVIOUS turn settled
 * to, so starting from it would report the previous turn's terminal as this
 * turn's. A terminal is asserted only from a successful read taken after this
 * turn's submission, and only when that read is confirmed to describe a
 * different turn than the pre-submit snapshot.
 */
async function awaitTerminal({ origin, client, recorder, stream, projectionBefore, cancel, experience }) {
  if (stream !== undefined) await stream.waitForTerminal(TURN_TIMEOUT_MS);
  let projection;
  for (let attempt = 0; attempt < POST_SUBMIT_STATE_POLLS; attempt += 1) {
    const read = await readStateSnapshot({ origin, client, recorder });
    if (read.ok) {
      projection = read.projection;
      if (TERMINAL_TURN_STATES.has(projection.turnState)) break;
    }
    if (attempt + 1 < POST_SUBMIT_STATE_POLLS) await delay(POST_SUBMIT_STATE_POLL_MS);
  }
  // No successful post-submit read at all: nothing authoritative was observed, so
  // no terminal can be claimed. The caller counts this turn as unsettled.
  if (projection === undefined) return Object.freeze({ terminal: false, projection: undefined });
  if (!TERMINAL_TURN_STATES.has(projection.turnState)) {
    // A non-terminal read for THIS turn is also not a terminal. Do not fall back
    // to any earlier snapshot.
    return Object.freeze({ terminal: false, projection });
  }
  // Turn-identity guard: when both the pre-submit and post-submit projections
  // carry an opaque turn handle, a terminal claim for this turn requires them to
  // differ (this turn's handle is new) or the snapshot to be positively this
  // turn's. A matching handle means we are looking at the previous turn's
  // settled projection, which must never be attributed here.
  if (
    typeof projection.turnHandle === "string" &&
    typeof projectionBefore?.turnHandle === "string" &&
    projection.turnHandle === projectionBefore.turnHandle
  ) {
    return Object.freeze({ terminal: false, projection, reasonCode: "terminal_turn_identity_stale" });
  }
  recorder.record("lifecycle", "harness", "turn.terminal", {
    state: projection.turnState,
    ...(cancel === undefined || cancel.disposition === undefined ? {} : { disposition: cancel.disposition }),
    ...(projection.problemCode === undefined ? {} : { problemCode: projection.problemCode }),
  });
  // Derived facts come from the same authoritative read; emitting them after
  // this turn's `turn.terminal` event lets a reader attribute them positionally.
  if (projection.turnState === "completed") recorder.record("provider", "host", "settled", { state: "completed" });
  else if (projection.turnState === "failed" && projection.problemCode === "runtime_unavailable")
    recorder.record("provider", "host", "error", { problemCode: "runtime_unavailable" });
  if (projection.committedCompanionMessages > projectionBefore.committedCompanionMessages) {
    recorder.record("presentation", "host", "committed", {
      count: projection.committedCompanionMessages - projectionBefore.committedCompanionMessages,
    });
    // The committed reply, in the side-file transcript only. The trace keeps its content-free shape.
    if (typeof projection.committedCompanionText === "string" && projection.committedCompanionText.length > 0) {
      capturedTranscriptEntries.push("companion", projection.committedCompanionText);
      // The content gates run HERE, at the moment the reply lands, so a defect is
      // attributed to the turn that produced it instead of being reconstructed
      // from a file afterwards. The verdicts travel in the content sidecar; the
      // trace stays exactly as content-free as it was.
      experience?.record({
        turnIndex: experience.turnIndex,
        playerText: experience.playerText,
        companionText: projection.committedCompanionText,
        evaluation: evaluateCompanionReply({
          playerText: experience.playerText,
          companionText: projection.committedCompanionText,
          companionNames: experience.companionNames,
        }),
      });
    }
  }
  // The durable committed-presentation delta is returned so a caller that needs
  // "was there a durable reply for THIS turn" can use the transcript authority
  // instead of the Class B stderr marker count. A marker only reports that the
  // admission boundary was crossed; it can be `rejected`, and it is not the
  // durable fact.
  return Object.freeze({
    terminal: true,
    projection,
    committedCompanionDelta:
      projection.committedCompanionMessages - (projectionBefore?.committedCompanionMessages ?? 0),
  });
}

function emitNewPresentationMarkers({ stderr, recorder, seen }) {
  const markers = classifyPresentationMarkers(stderr);
  for (let index = seen.count; index < markers.length; index += 1) {
    const marker = markers[index];
    if (marker.code === "admitted") recorder.record("presentation", "harness", "admitted", { status: marker.status });
    else recorder.record("presentation", "harness", "rejected", { reason: marker.reason });
  }
  seen.count = markers.length;
  return markers.length > 0;
}

/**
 * The browser half of the session handshake.
 *
 * The `boot=<token>` fragment is a ONE-TIME exchange. The loop used to spend it with
 * its own `fetch`, which is exactly why a browser opened afterwards got 401 and why
 * every UI verdict so far had to come from a manual desktop run. So the browser
 * redeems it first and the loop attaches to the session the browser created: the
 * cookie is read over CDP (the launch URL is delivered by `Page.navigate`, so it is
 * not even in the browser's command line), and the CSRF token comes from the
 * authenticated `/state` body, which is a read and therefore needs no CSRF header.
 * `dialogue-web/src/main.tsx` documents the same path from the product side: a
 * reload re-selects the app through the session cookie.
 *
 * Failing here is never fatal: the caller falls back to exchanging the token
 * itself, and a browser that cannot run is recorded as a named skip.
 */
export async function openBrowserHalf({ launchUrl, origin, environment }) {
  const skip = (reason) => {
    environment.skippedPhases.push({ phase: "browser", reason });
    environment.browserEvidence = { state: "skipped", reason };
    return Object.freeze({ ok: false, reason });
  };
  if (process.env.GAMEBUDDY_CHAT_BROWSER === "0") return skip("browser_phase_disabled_by_configuration");
  const executable = await findBrowserExecutable({ env: process.env });
  if (executable === undefined) return skip("no_browser_executable_found");
  const port = await reserveFreePort().catch(() => undefined);
  if (port === undefined) return skip("free_cdp_port_unavailable");
  const profileDir = join(tmpdir(), `gamebuddy-chat-live-browser-${randomBytes(6).toString("hex")}`);
  const session = await openBrowserEvidenceSession({
    executable,
    origin,
    launchUrl,
    profileDir,
    port,
    headless: process.env.GAMEBUDDY_LIVE_RUN_BROWSER_HEADLESS !== "0",
  });
  if (!session.ok) return skip(`browser_launch_failed:${session.reason}`);
  environment.browserSession = session;
  const cookie = await session.waitForSessionCookie();
  if (!cookie.ok) return skip(cookie.reason);
  let body;
  try {
    const response = await deadlineFetch(`${origin}/api/tavern/v1/state`, {
      headers: { Cookie: cookie.cookie, Origin: origin },
    });
    body = await response.json().catch(() => undefined);
    if (!response.ok) return skip(`browser_session_state_read_failed:${response.status}`);
  } catch (error) {
    return skip(`browser_session_state_unreachable:${safeReasonCode(error)}`);
  }
  const csrf = body?.csrfToken ?? body?.chat?.csrfToken;
  if (typeof csrf !== "string" || csrf.length === 0) return skip("browser_session_csrf_absent");
  environment.browserEvidence = { state: "session_established", port, profileDir };
  return Object.freeze({ ok: true, client: Object.freeze({ cookie: cookie.cookie, csrf }), session });
}

/**
 * Screenshots and DOM assertions, into the run's own `shots/` directory, so one
 * directory answers protocol + content + rendering. The DOM is compared against the
 * SAME authenticated `/state` read the trace's durable facts come from, which is
 * the only way "the reply the API reports is the reply the DOM shows" stops being
 * an inference.
 */
async function captureBrowserEvidence({ session, origin, client, environment }) {
  if (session?.ok !== true) return;
  const shotsDir = join(environment.captureDir, "shots");
  let transcript = [];
  try {
    const response = await deadlineFetch(`${origin}/api/tavern/v1/state`, {
      headers: { Cookie: client.cookie, Origin: origin },
    });
    const body = await response.json().catch(() => undefined);
    if (response.ok && Array.isArray(body?.chat?.transcript)) transcript = body.chat.transcript;
  } catch {
    /* an unreadable transcript leaves the DOM comparison to report the gap */
  }
  // The browser applies the same SSE events the harness observed; give it a bounded
  // window to reach the same row count before calling a difference a defect.
  let dom;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    dom = await session.domSnapshot().catch(() => undefined);
    if (dom !== undefined && Array.isArray(dom.handles) && dom.handles.length >= transcript.length) break;
    await delay(500);
  }
  const assertions = assertRenderedTranscript(dom, transcript, {
    expectedPlayerTexts: environment.experienceReplies.map((reply) => reply.playerText),
  });
  const shots = [];
  for (const [name, label, fullPage] of [
    ["chat-transcript.png", "transcript", false],
    ["chat-transcript-fullpage.png", "fullpage", true],
  ]) {
    const shot = await session
      .screenshot(join(shotsDir, name), { fullPage })
      .catch((error) => ({ ok: false, reason: safeReasonCode(error) }));
    if (shot.ok === true) shots.push({ label, path: shot.path, fullPage });
  }
  environment.browserEvidence = Object.freeze({
    state: "captured",
    port: environment.browserEvidence?.port,
    profileDir: environment.browserEvidence?.profileDir,
    transcriptMessages: transcript.length,
    renderedHandles: Array.isArray(dom?.handles) ? dom.handles.length : null,
    assertions,
    shots: Object.freeze(shots),
  });
}

async function collectRun({ root, recorder, nonceSha256, environment, attachChild, probeManifest }) {
  const artifact = await productionArtifactIdentity();
  environment.artifact = artifact;
  // Mount the live-run persona BEFORE anything reads the runtime cwd: the product's convention is
  // <runtimeCwd>/card.json + worldbook.json, and a run without them has no persona at all — so this is
  // provisioned (byte for byte, no preprocessing) and then ASSERTED, never assumed.
  // The runtime reads the book from its RUNTIME CWD — <root>/contexts/<identityKey(identity)>
  // (runtime-identity.ts:107), which is also where the product writes it (new-companion-service.ts:202).
  // Writing it to the root put the book on disk while the runtime never read it, and the old assertion
  // passed anyway because it checked the file WE wrote rather than the path the runtime reads. Both now
  // target the same directory, so the assertion can only pass when the runtime would find the book.
  const { identityKey } = await import(pathToFileURL(join(HOST_ROOT, "dist-test", "runtime-identity.js")).href);
  const personaCwd = join(root, "contexts", identityKey(AUDIT_IDENTITY));
  await mkdir(personaCwd, { recursive: true });
  environment.personaCwd = personaCwd;
  environment.persona = await provisionLiveRunPersona(personaCwd, { identity: AUDIT_IDENTITY, root });
  // The name the companion must anchor to. Without it the first-person gate reports
  // `skipped` rather than inventing a pass - see core/companion-experience.mjs.
  environment.companionNames = environment.persona?.identity?.name ? [environment.persona.identity.name] : [];
  environment.personaMounted = await assertLiveRunPersonaMounted(personaCwd, { identity: AUDIT_IDENTITY, root });
  if (!environment.personaMounted.ok)
    throw new Error(`live_run_persona_not_mounted:${environment.personaMounted.problems.join(",")}`);
  const configPath = join(root, "chat-audit.json");
  await writeFile(
    configPath,
    JSON.stringify(
      createAuditDeploymentManifest(root, AUDIT_IDENTITY, `chat_audit_bootstrap_${randomBytes(12).toString("hex")}`),
    ),
    "utf8",
  );
  // The launcher spawns the child internally, so both the stderr evidence and
  // the child handle are taken through its own explicit `spawnImpl` seam. That
  // keeps the real bundled runtime and the one formal entry: this only observes
  // the child and owns its teardown, so a launch that dies before ready still
  // yields the child's bounded startup diagnostic and its process is stopped.
  let stderr = "";
  // finishRun reads this: the gate marker names its own failure on stderr, and that
  // line is the difference between "no marker" and "transport not connected".
  environment.childStderr = stderr;
  const launch = await launchDesktopCompositionGateChild({
    outputRoot: AUDIT_OUTPUT_ROOT,
    root,
    surface: AUDIT_SURFACE,
    nonceSha256,
    manifestPath: configPath,
    readyTimeoutMs: START_TIMEOUT_MS,
    spawnImpl: (command, args, options) => {
      const spawned = spawn(command, args, options);
      attachChild(spawned);
      spawned.stderr.setEncoding("utf8");
      spawned.stderr.on("data", (chunk) => {
        stderr += chunk;
      });
      return spawned;
    },
  }).catch((error) => {
    // The child is stopped by the caller's teardown even when the launcher
    // rejects before returning its handle; only the bounded startup diagnostic
    // is classified here.
    environment.boundaryReason ??= classifyStartupFailure(error, stderr);
    throw error;
  });
  attachChild(launch.child, launch);

  // Provider evidence: the runtime frame supplies the exact Pi session identity,
  // the pre-send marker supplies the one provider-boundary fact. Both are
  // Class A child IPC and both must be present and cross-consistent.
  let runtimeSessionId;
  let pendingPreSend;
  let preSendSettled = false;
  // Which turn was active when the provider boundary was actually crossed. The
  // pre-send marker fires once per Pi session, so §3.2 rule 3's conjunction
  // (this turn saw `request.sent` AND never terminalised) can only be asserted
  // for that one turn.
  let providerMarkerTurn;
  let activeTurnIndex = 0;
  const flushPreSend = () => {
    if (preSendSettled || pendingPreSend === undefined || runtimeSessionId === undefined) return;
    preSendSettled = true;
    const evaluation = evaluateProviderPreSendMarker(pendingPreSend, nonceSha256, runtimeSessionId);
    pendingPreSend = undefined;
    if (!evaluation.observed) {
      environment.boundaryReason ??= evaluation.reasonCode;
      return;
    }
    environment.providerObservability = "observed";
    providerMarkerTurn = activeTurnIndex;
    recorder.record("provider", "host", "request.sent");
  };
  launch.onMessage((value) => {
    if (value?.schema === "gamebuddy-tavern-narrative-gate-runtime/v1") {
      const evaluation = evaluateProviderRuntimeMarker(value);
      if (evaluation.observed) {
        runtimeSessionId = evaluation.piSessionId;
        flushPreSend();
      }
      return;
    }
    if (
      value?.schema === "gamebuddy-tavern-narrative-gate-marker/v1" &&
      !preSendSettled &&
      pendingPreSend === undefined
    ) {
      pendingPreSend = value;
      flushPreSend();
    }
  });

  let ready;
  try {
    ready = await launch.waitForReady();
  } catch (error) {
    throw new Error(classifyStartupFailure(error, stderr));
  }
  const url = new URL(ready);
  const origin = `${url.protocol}//${url.host}`;
  const bootstrapToken = new URLSearchParams(url.hash.slice(1)).get("boot");
  if (bootstrapToken === null) throw new Error("bootstrap_token_missing");
  // The browser redeems the one-time token when it can; only then does the harness
  // attach. Falling back keeps a machine with no browser able to run the audit.
  const browserHalf = await openBrowserHalf({ launchUrl: ready, origin, environment });
  const client = browserHalf.ok
    ? browserHalf.client
    : await bootstrap(origin, bootstrapToken, launch.ack?.sessionEntry);
  environment.sessionOrigin = origin;
  environment.started = true;
  recorder.record("lifecycle", "harness", "run.started", { status: "ready" });

  const seenPresentation = { count: 0 };
  environment.presentationMarkers = 0;
  // Magic Context's Class B fold/digest observations (D-1 approved: vendor
  // stderr). These are the ONLY producer of the fold distance's positioning
  // fact, so §3.3's rule is enforced here: a `fold` probe enters only after the
  // marker says the baseline actually folded; otherwise the probe is not scored
  // and reports `fold_not_observed` instead of guessing that the memory folded.
  const seenProbe = { foldCount: 0, digest: null, revision: null };
  const noteProbeMarkers = () => {
    for (const marker of classifyProbeMaterializationMarkers(stderr)) {
      if (marker.code === "fold_committed") seenProbe.foldCount += 1;
      // Last observation wins: the digest is compared against its own revision,
      // so the newest pair is the current baseline.
      else {
        seenProbe.digest = marker.digest;
        seenProbe.revision = marker.revision;
      }
    }
    environment.foldMarkers = seenProbe.foldCount;
  };
  let memoryReadEmitted = false;
  const noteMemoryProjection = (projection) => {
    if (memoryReadEmitted || !projection.memoryReadAvailable) return;
    memoryReadEmitted = true;
    recorder.record("memory", "host", "memory.read", { status: "available" });
  };
  const notePresentation = () => {
    emitNewPresentationMarkers({ stderr, recorder, seen: seenPresentation });
    environment.presentationMarkers = seenPresentation.count;
  };

  // Probe driving (independent opt-in mode; default behaviour unchanged). Each
  // probe scenario is a bounded, fixture-owned turn script: a probe turn that
  // must carry a committed presentation to count, with seed/filler turns that
  // only advance the conversation. Every emitted probe event must carry the
  // opaque probeId + manifestDigest (probeEventReason), and the keyword text
  // never enters a trace.
  const emitProbe = (probe, event, reason) => {
    // `reason` is a scalar (or undefined); the frozen meta allow-list has no
    // nested-object value, and `recorder.record` rejects any non-scalar meta.
    if (reason !== undefined && (typeof reason !== "string" || reason.length === 0))
      throw new Error("probe_event_reason_invalid");
    const meta = {
      probeId: probe.probeId,
      manifestDigest: probeManifest.manifestDigest,
      ...(probe.distance === undefined ? {} : { distance: probe.distance }),
      ...(probe.dimension === undefined ? {} : { dimension: probe.dimension }),
      ...(reason === undefined ? {} : { reason }),
    };
    recorder.record("probe", "harness", event, meta);
  };
  // Read the committed companion reply for the current turn from the durable
  // transcript. The transcript is append-only, so filtering by the companion
  // role and taking the LAST committed companion message is this turn's reply;
  // the text is used for keyword matching only and never recorded.
  const readCompanionKeywordMatches = async (step) => {
    const snapshot = await readStateSnapshot({ origin, client, recorder });
    if (!snapshot.ok || typeof snapshot.projection?.committedCompanionText !== "string") {
      return Object.freeze({ hit: false, forbiddenCount: 0 });
    }
    const companionText = snapshot.projection.committedCompanionText;
    return companionText.length === 0
      ? Object.freeze({ hit: false, forbiddenCount: 0 })
      : evaluateProbeReply({ transcriptText: companionText, step });
  };

  let unsettled = 0;
  const unsettledTurnIndexes = [];
  let durableTerminal;
  const runTurn = async ({ cancel, message = SUBMIT_PROMPT_TEXT }) => {
    activeTurnIndex += 1;
    const turnIndex = activeTurnIndex;
    capturedTranscriptEntries.push("player", typeof message === "string" ? message : "");
    const opened = await readStateSnapshot({ origin, client, recorder });
    if (!opened.ok) throw new Error(opened.reasonCode);
    noteMemoryProjection(opened.projection);
    const streamResult = await openEventStream({ origin, client, recorder, cursor: environment.streamCursor });
    if (!streamResult.ok) environment.boundaryReason ??= streamResult.reasonCode;
    const stream = streamResult.ok ? streamResult : undefined;
    try {
      await submitTurn({ origin, client, projection: opened.projection, recorder, message });
      let cancelResult;
      if (cancel) {
        let armed;
        for (let attempt = 0; attempt < CANCEL_ARM_POLLS; attempt += 1) {
          const poll = await readStateSnapshot({ origin, client, recorder });
          if (!poll.ok) break;
          if (TERMINAL_TURN_STATES.has(poll.projection.turnState)) break;
          if (poll.projection.canCancel) {
            armed = poll.projection;
            break;
          }
          await delay(CANCEL_ARM_POLL_MS);
        }
        if (armed === undefined) environment.collectionReason ??= "cancel_window_missed";
        else {
          cancelResult = await cancelTurn({
            origin,
            client,
            projection: opened.projection,
            turnHandle: armed.turnHandle,
          });
          if (!cancelResult.ok) {
            environment.boundaryReason ??= cancelResult.reasonCode;
            cancelResult = undefined;
          }
        }
      }
      const outcome = await awaitTerminal({
        origin,
        client,
        recorder,
        stream,
        projectionBefore: opened.projection,
        cancel: cancelResult,
        experience: {
          turnIndex,
          playerText: typeof message === "string" ? message : SUBMIT_PROMPT_TEXT,
          companionNames: environment.companionNames,
          record: (reply) => environment.experienceReplies.push(reply),
        },
      });
      if (!outcome.terminal) {
        unsettled += 1;
        unsettledTurnIndexes.push(turnIndex);
        return undefined;
      }
      durableTerminal = outcome.projection;
      // Return the full outcome (with `.terminal` and `.projection`) rather than
      // just the projection: a caller that asks "did this turn reach a durable
      // terminal AND what does the durable state look like" must see both. The
      // probe scenario checks `outcome.terminal`, and the reload comparison uses
      // `durableTerminal` captured above.
      return outcome;
    } finally {
      // Carry this connection's last event id forward so the next turn's
      // observation resumes instead of asking the host to replay from zero.
      if (stream?.cursor !== undefined && stream.cursor() !== undefined) environment.streamCursor = stream.cursor();
      await stream?.close();
      // The provider marker and the stderr markers are published at the provider
      // and presentation boundaries, so both are drained before the turn's
      // evidence is closed out.
      await delay(MARKER_DRAIN_MS);
      flushPreSend();
      notePresentation();
      noteProbeMarkers();
    }
  };

  const runProbeScenario = async ({ probe }) => {
    // Scenario steps run against the real pipeline and are bounded by the
    // turn timeout; without a progress mark a long scenario looks hung. Steps
    // are named by the manifest, never by content, and never enter a trace.
    for (let stepIndex = 0; stepIndex < probe.steps.length; stepIndex += 1) {
      const step = probe.steps[stepIndex];
      // Progress mark: one line per step so a long scenario is observable
      // instead of looking hung. The step kind is public; the step text is not.
      console.error(
        `[chat-live-audit] probe ${probe.probeId} step ${stepIndex + 1}/${probe.steps.length} (${step.kind})`,
      );
      if (step.kind === "probe") {
        // §3.3: a fold-distance probe is only scored once production itself has
        // folded the baseline. Otherwise the question is asked before the memory
        // folded, and a truthful "I don't know" would be recorded as a retention
        // miss — a fabricated regression. No marker is a gap, never a failure.
        if (probe.distance === "fold") {
          await delay(MARKER_DRAIN_MS);
          noteProbeMarkers();
          if (seenProbe.foldCount === 0) {
            emitProbe(probe, "observability_gap", "fold_not_observed");
            continue;
          }
        }
        const outcome = await runTurn({ message: step.text });
        const probeGate = probeTurnCommittedGate(outcome);
        // A failed gate must short-circuit BEFORE any keyword read, so a turn
        // with no durable commit is never scored against older text.
        const keywords = probeGate.ok ? await readCompanionKeywordMatches(step) : undefined;
        const verdict = probeVerdict({ gate: probeGate, keywords, dimension: probe.dimension });
        emitProbe(probe, verdict.event, verdict.reason);
        continue;
      }
      // seed/filler: advance the conversation only.
      await runTurn({ message: step.text });
    }
    return undefined;
  };
  if (probeManifest !== undefined && probeManifest.probes.length > 0) {
    for (let index = 0; index < probeManifest.probes.length; index += 1) {
      await runProbeScenario({ probe: probeManifest.probes[index] });
    }
  } else {
    // Default (no manifest). Previously exactly one conversation turn plus the cancel probe, which
    // capped a run at ONE companion utterance and made the naturalness question unanswerable no matter
    // how often it was asked. Now: `CONVERSATION_TURNS` completed turns (default 2), then the cancel
    // probe, which stays because the cancel route settling durably is a product fact of its own.
    for (let index = 0; index < CONVERSATION_TURNS; index += 1) {
      const message =
        CONVERSATION_PROMPTS.length === 0
          ? SUBMIT_PROMPT_TEXT
          : CONVERSATION_PROMPTS[Math.min(index, CONVERSATION_PROMPTS.length - 1)];
      const turn = await runTurn({ cancel: false, message });
      const boundary = conversationTurnBoundaryReason(turn);
      if (boundary !== undefined) environment.boundaryReason ??= boundary;
    }
    await runTurn({ cancel: true });
  }

  // Reload/recovery: the client surface drops its live stream and re-derives
  // everything from the authenticated durable `/state`, then compares that
  // read-back with the terminal state it already observed.
  recorder.record("recovery", "harness", "reload.started", { status: "surface_reloaded" });
  if (durableTerminal === undefined) environment.collectionReason ??= "no_durable_terminal_state";
  else {
    const reloaded = await readStateSnapshot({ origin, client, recorder });
    if (reloaded.ok) {
      const comparison = compareReloadSnapshot(durableTerminal, reloaded.projection);
      if (comparison.consistent)
        recorder.record("recovery", "harness", "reload.settled", {
          status: "consistent",
          generation: reloaded.projection.selectionGeneration,
        });
      else recorder.record("recovery", "harness", "reload.mismatch", { reason: comparison.reason });
    } else environment.boundaryReason ??= reloaded.reasonCode;
  }

  // Observation-gap reporting: a missing marker is announced, never silently
  // read as cleanliness, and never treated as a failure.
  await delay(MARKER_DRAIN_MS);
  flushPreSend();
  notePresentation();
  if (unsettled > 0) {
    environment.collectionReason ??= "turn_never_terminal";
    environment.unsettledTurns = unsettled;
    // Only an unsettled turn that actually crossed the provider boundary can
    // satisfy §3.2 rule 3; record the conjunction per turn rather than letting
    // `finishRun` assert it from run-level facts.
    environment.unsettledProviderTurns =
      providerMarkerTurn === undefined || !unsettledTurnIndexes.includes(providerMarkerTurn) ? 0 : 1;
  }

  // Rendering: the same authenticated session, observed through the product's own
  // browser surface, into the run's `shots/` directory.
  await captureBrowserEvidence({ session: browserHalf.session, origin, client, environment });

  // What the turns cost, read from this run's OWN session record while the runtime root still exists. Published
  // beside the trace and printed, because a reader of the log needs the number without opening the directory.
  environment.usage = readRunUsage({ personaCwd: environment.personaCwd });
  console.log(narrateUsage(environment.usage));
}

function finishRun({ recorder, environment }) {
  // The run's own observability limits are reported explicitly so a missing
  // marker reads as a gap instead of as cleanliness. A gap is informational: it
  // is neither an integrity failure nor evidence about the provider.
  if (environment.providerObservability !== "observed") {
    // `no_pre_send_marker` alone is satisfied by both "the transport was not
    // connected" and "the product never reached the provider" - different worlds
    // reported identically. The host names its own reason on stderr; carry it.
    const gateFailures = classifyGateMarkerFailures(environment.childStderr ?? "");
    const firstResponseMs = providerFirstResponseMs(environment.childStderr ?? "");
    recorder.record("provider", "harness", "observability_gap", {
      status: "unobserved",
      reason: "no_pre_send_marker",
      ...(gateFailures.length === 0 ? {} : { gateMarker: gateFailures[0].phase }),
      // The wait the provider itself imposed, split out from everything we control.
      ...(firstResponseMs === null ? {} : { firstResponseMs }),
    });
  }
  if (environment.presentationMarkers === 0)
    recorder.record("presentation", "harness", "observability_gap", {
      status: "unobserved",
      reason: "no_presentation_marker",
    });
  if (environment.unsettledProviderTurns > 0 && environment.providerObservability === "observed")
    // §3.2 rule 3 requires the conjunction to hold for THE TURN: it observed
    // `provider.request.sent` and never reached a terminal. The pre-send marker
    // fires once per Pi session, so the harness records which turn was active
    // when it fired; asserting this from run-level facts alone would claim a
    // per-turn integrity fact that turn has no evidence for.
    recorder.record("provider", "harness", "boundary_unsettled", {
      reason: "turn_never_terminal",
      count: environment.unsettledProviderTurns,
    });
  const boundaryFailed = environment.boundaryReason !== undefined;
  const reason = environment.boundaryReason ?? environment.collectionReason;
  recorder.record("lifecycle", "harness", "run.finished", {
    status: boundaryFailed ? "boundary_failed" : "collected",
    providerObservability: environment.providerObservability,
    ...(reason === undefined ? {} : { reason }),
  });
}

async function productionArtifactIdentity() {
  try {
    const pointer = JSON.parse(await readFile(join(AUDIT_OUTPUT_ROOT, "current.json"), "utf8"));
    if (typeof pointer.generation !== "string" || !GENERATION.test(pointer.generation)) throw new Error("invalid");
    if (typeof pointer.inventoryDigest !== "string" || !SHA256_HEX.test(pointer.inventoryDigest))
      throw new Error("invalid");
    return Object.freeze({ generation: pointer.generation, inventoryDigest: pointer.inventoryDigest });
  } catch {
    throw new Error("production_artifact_identity_unavailable");
  }
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

export async function main(argv = process.argv.slice(2)) {
  const parsed = parseArguments(argv);
  const reportTarget = await prepareReportTarget(parsed.reportPath);
  // Probe manifests are fixture-owned sidecars; loading one here keeps the
  // mechanism independent of the default two-turn sweep (whose shape stays
  // unchanged). A manifest that cannot be read or validated exits blocked, not
  // silently downgrading to the default sweep.
  let probeManifest;
  if (parsed.probeManifestPath !== undefined) {
    try {
      probeManifest = loadProbeManifest(await readFile(parsed.probeManifestPath, "utf8"));
    } catch (error) {
      console.error(JSON.stringify({ schema: HARNESS_OUTCOME_SCHEMA, state: "blocked", ...classifyFailure(error) }));
      return 2;
    }
  }
  const root = await mkdtemp(join(tmpdir(), "gamebuddy-chat-live-audit-"));
  const startedAtMs = Date.now();
  const startedAt = new Date(startedAtMs).toISOString();
  const runId = randomBytes(12).toString("hex");
  // One directory per run, addressed by the run's own opaque id, so protocol (the
  // trace), content (the companion-experience sidecar), rendering (shots/) and the
  // captured runtime root all live in ONE place a reviewer can open. The shared
  // capture core keeps it git-ignored, byte-budgeted and failure-tolerant.
  const capture = await openLiveRunCapture({ kind: "chat-audit", dirName: runId });
  // Run admission happens HERE: after the run's own directory exists (so the refusal can be written into the very
  // artifacts a reader opens) and before `collectRun` can launch a child. A refused run therefore costs seconds and
  // leaves a named cause on disk, instead of 192 s and a `runtime_unavailable` turn nobody can attribute.
  const admissionDirectory = capture.dir;
  // Wire capture, when asked for, is mounted BEFORE admission: admission's readiness fact is the product's own probe
  // answering THIS endpoint, so the endpoint has to exist first. Off unless `GAMEBUDDY_CHAT_WIRE_CAPTURE=1`.
  const wireCapture = wireCaptureRequested();
  // The anchors are read only when capture is on: a real-provider run never asks the contract question, and
  // loading a second Host build for it would slow every run down for an answer nothing reads.
  const wireAnchors = wireCapture ? await loadWireContractAnchors() : undefined;
  const stub = wireCapture
    ? await startLocalStubProvider({ modelId: WIRE_MODEL_ID, reply: WIRE_STUB_REPLY })
    : undefined;
  if (stub !== undefined) console.log(narrateWireTrade(stub));
  let admission;
  try {
    const targets = await chatRunReadinessTargets({ root });
    await declareChatModelProfile(root);
    await declareChatDeliveryPreference(root);
    admission =
      stub === undefined
        ? await admitChatRun({ runtimeRoot: root, agentDir: targets.agentDir, baseUrl: targets.baseUrl })
        : // The stub is mounted through the product's OWN connection writer: the Chat mount resolves its model from
          // the active connection, so admitting this path means recording that connection and letting the product's
          // own probe decide whether it may be activated.
          await admitWireCaptureRun({ runtimeRoot: root, agentDir: targets.agentDir, stub });
  } catch (error) {
    admission = Object.freeze({
      ok: false,
      stage: "admission_failed",
      refusal: safeReasonCode(error),
      readiness: null,
    });
  }
  // The readiness verdict travels into the run directory whether or not it refused: a passing probe is evidence about
  // the provider this run measured, and a reader comparing two runs needs it from both.
  await capture.record("run-admission.json", {
    schema: "chat_run_audit/run-admission/v1",
    stage: admission.stage,
    ok: admission.ok,
    refusal: admission.refusal,
    readiness: admission.readiness,
    runtimeRoot: root,
  });
  if (!admission.ok) {
    const outcome = Object.freeze({
      schema: HARNESS_OUTCOME_SCHEMA,
      state: "blocked",
      runId,
      startedAt,
      reasonCode: refusalCode(admission.refusal),
      stage: admission.stage,
      refusal: admission.refusal,
      runDirectory: admissionDirectory,
    });
    await capture.record("harness-outcome.json", outcome);
    await capture.close();
    console.log(JSON.stringify(outcome));
    await stub?.close().catch(() => undefined);
    await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }).catch(() => undefined);
    return 2;
  }
  const recorder = createAuditRecorder({ startedAtMs });
  const environment = {
    artifact: undefined,
    boundaryReason: undefined,
    collectionReason: undefined,
    providerObservability: "unobserved",
    presentationMarkers: 0,
    // Last SSE event id observed on any connection, carried across turns so a
    // reconnect resumes the bounded replay window instead of forcing a gap.
    streamCursor: undefined,
    unsettledTurns: 0,
    unsettledProviderTurns: 0,
    started: false,
    persona: undefined,
    personaCwd: undefined,
    personaMounted: undefined,
    // The name(s) the companion must anchor to, and the per-turn content verdicts.
    companionNames: [],
    experienceReplies: [],
    // Phases that could not run here, each with the reason, so "not observed" is
    // never read as "observed clean".
    skippedPhases: [],
    captureDir: capture.dir,
  };
  // `launchDesktopCompositionGateChild` builds its ready waiter before it can
  // fail, so a launch that dies before returning leaves that waiter's rejection
  // with no caller left to observe it. Node reports an unobserved rejection as a
  // fatal error and terminates the process before the harness could write a
  // truthful blocked trace, so a collector is installed for the whole process
  // lifetime. It never replaces the real reason: a run that started reports what
  // it observed, and this only supplies a boundary reason for a run that could
  // not start at all.
  process.on("unhandledRejection", (reason) => {
    environment.boundaryReason ??= safeReasonCode(reason);
  });
  let child;
  let launch;
  const attachChild = (spawned, handle) => {
    child = spawned;
    if (handle !== undefined) launch = handle;
  };
  try {
    await collectRun({
      root,
      recorder,
      nonceSha256: sha256(randomBytes(18).toString("hex")),
      environment,
      attachChild,
      probeManifest,
    });
  } catch (error) {
    environment.boundaryReason ??= safeReasonCode(error);
  } finally {
    await stop(child).catch(() => undefined);
    launch?.dispose();
    // The browser is a child of this harness; leaving it behind would leave a
    // profile directory and a CDP port in use for the next run.
    await environment.browserSession?.close().catch(() => undefined);
  }

  // The wire reading: what the product SENT to the provider this run mounted. Built after the last turn so every
  // request is in hand (the stub's log is in memory, so closing it below loses nothing), and published beside the
  // trace. `turnsDrove` comes from the turn events the recorder itself emitted, so a request that never arrived is
  // visible as a gap instead of a shorter conversation.
  const wireReading = buildWireReading({
    requested: wireCapture,
    provider: stub,
    turnsDrove: recorder.events().filter((event) => event.code === "turn.submitted").length,
  });
  // The CONTRACT half of the same capture: sizes and digests say how much went out, never whether the card's
  // direction arrived in the position its contract names, whether a Game tool name appeared on a surface that
  // mounts none, or whether the card's voice sits after the Host floor. Planted sentinels answer those three on
  // the same captured bodies, and the reading is `unobserved` rather than clean when nothing was captured.
  const wireContract = buildWireContractReading({
    requests: stub?.requests ?? [],
    gameToolNames: wireAnchors?.gameToolNames ?? [],
    houseFloor: wireAnchors?.houseFloor,
  });
  await stub?.close().catch(() => undefined);

  try {
    if (environment.artifact === undefined) {
      // Without the immutable artifact identity no schema-valid trace is
      // expressible, so the harness refuses to write one.
      const outcome = Object.freeze({
        schema: HARNESS_OUTCOME_SCHEMA,
        state: "blocked",
        runId,
        startedAt,
        reasonCode: environment.boundaryReason ?? "chat_audit_harness_blocked",
      });
      await capture.record("harness-outcome.json", outcome);
      await capture.close();
      console.log(JSON.stringify(outcome));
      return 2;
    }
    // A trace is evidence about a run that actually collected something. If the
    // child never reached ready+bootstrap, no turn was ever observed and the
    // trace would describe nothing — yet every turn detector is vacuously silent
    // on it, so it would audit as a clean, passed run. Refuse to write it and
    // report the boundary failure instead.
    if (environment.started !== true) {
      const outcome = Object.freeze({
        schema: HARNESS_OUTCOME_SCHEMA,
        state: "blocked",
        runId,
        startedAt,
        reasonCode: environment.boundaryReason ?? "chat_audit_harness_never_started",
      });
      await capture.record("harness-outcome.json", outcome);
      await capture.close();
      console.log(JSON.stringify(outcome));
      return 2;
    }
    finishRun({ recorder, environment });
    const trace = buildAuditTrace({
      runId,
      startedAt,
      completedAt: new Date().toISOString(),
      artifact: environment.artifact,
      providerObserved: environment.providerObservability === "observed",
      events: recorder.events(),
    });
    const serialized = await writeAuditTrace(reportTarget, trace);
    // Option B: the bounded transcript travels BESIDE the trace, never inside it.
    const transcriptPath = transcriptSideFilePath(reportTarget);
    if (transcriptPath !== undefined) {
      const side = Object.freeze({
        ...buildTranscriptSideFile({ runId, entries: capturedTranscriptEntries.entries() }),
        persona: environment.persona?.identity ?? null,
        personaCwd: environment.personaCwd ?? null,
        personaMounted: environment.personaMounted?.ok === true,
        // Where the agent conversation's input/output lives, when the caller asked to keep it.
        runtimeRoot: KEEP_RUNTIME_ROOT ? root : null,
      });
      await writeFile(transcriptPath, `${JSON.stringify(side, null, 2)}\n`, "utf8");
      console.log(JSON.stringify({ transcriptPath, entryCount: side.entryCount }));
    }
    // The content half. Kept OUT of the trace (which stays content-free by
    // construction) and written into the run directory that also holds the trace
    // copy, the runtime-root evidence and the browser shots.
    const experience = buildCompanionExperience({
      runId,
      artifact: environment.artifact,
      persona:
        environment.persona?.identity === undefined
          ? null
          : Object.freeze({
              name: environment.persona.identity.name ?? null,
              profileId: environment.persona.profile?.profileId ?? null,
              canonicalHash: environment.persona.profile?.canonicalHash ?? null,
              cardPath: environment.persona.cardPath ?? null,
              personaMounted: environment.personaMounted?.ok === true,
            }),
      replies: environment.experienceReplies,
      browser: environment.browserEvidence ?? {
        state: "skipped",
        reason: environment.skippedPhases.find((phase) => phase.phase === "browser")?.reason ?? "browser_phase_not_run",
      },
      skipped: environment.skippedPhases,
      transcriptSideFilePath: transcriptPath ?? null,
      captureDir: capture.dir,
    });
    await capture.record("companion-experience.json", experience);
    await capture.record("chat-run-audit.json", trace);
    // Beside the trace, so a reader comparing two runs sees what each TURN cost as well as what it did. `state` is
    // `verified` / `failed` / `unobserved` from the evidence vocabulary: a run whose session record could not be read
    // publishes the reason, never a zero that would look like a free run.
    if (environment.usage !== undefined) await capture.record("usage.json", environment.usage);
    // The run's own verdict in the vocabulary all three loops share (`core/run-verdict.mjs`). Derived from the
    // probe events this run actually produced - never from `run.finished`'s `collected`, which says the harness
    // observed what it could, not that the evidence held. A run with no probe manifest therefore publishes
    // `unobserved` / `no_probe_evidence` instead of a clean bill.
    const runVerdict = buildChatRunVerdict(recorder.events());
    await capture.record("run-verdict.json", runVerdict);
    console.log(narrateRunVerdict("chat", runVerdict));
    // What the model was TOLD. Printed on every wire-capture run beside the trade it makes, and written beside the
    // trace: sizes and digests only, because every field here may carry the player's own words. A run that ASKED for
    // capture and captured nothing prints its reason rather than staying silent, so an empty reading is never mistaken
    // for a clean one.
    if (wireCapture) {
      console.log(narrateWireReading(wireReading));
      console.log(narrateWireContract(wireContract));
      await capture.record("wire-reading.json", wireReading);
      await capture.record("wire-contract.json", wireContract);
    }
    await capture.record("capture-inputs.json", {
      schema: "chat_run_audit/capture-inputs/v1",
      runId,
      surface: AUDIT_SURFACE,
      reportTarget: reportTarget ?? null,
      transcriptSideFilePath: transcriptPath ?? null,
      runtimeRoot: root,
      keepRuntimeRoot: KEEP_RUNTIME_ROOT,
      companionNames: environment.companionNames,
      skippedPhases: environment.skippedPhases,
    });
    // The runtime root's own evidence (profile, world book, Magic Context db+log,
    // run manifest, session logs) travels into the same directory before the
    // throwaway root is deleted.
    await capture.captureRuntimeRoot(root);
    const captureSummary = await capture.close();
    console.log(
      JSON.stringify({
        runDirectory: captureSummary.dir,
        contentVerdict: experience.summary,
        browser: experience.browser?.state ?? "skipped",
        captureFailures: captureSummary.failures.length,
        captureSkipped: captureSummary.skipped.length,
      }),
    );
    if (reportTarget === undefined) console.log(serialized.trimEnd());
    else console.log(JSON.stringify(trace));
    return 0;
  } finally {
    if (KEEP_RUNTIME_ROOT) console.log(JSON.stringify({ keptRuntimeRoot: root }));
    else await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }).catch(() => undefined);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      console.error(JSON.stringify({ schema: HARNESS_OUTCOME_SCHEMA, state: "blocked", ...classifyFailure(error) }));
      process.exitCode = 2;
    });
}
