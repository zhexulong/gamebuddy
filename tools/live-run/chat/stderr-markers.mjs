/**
 * Class B: the diagnostic stderr markers a run may quote, and what each one is allowed to mean.
 *
 * These are observations of the runtime's own log, never product facts. `presentation.committed` in particular is
 * derived from the authoritative `/state` transcript elsewhere and is deliberately never mapped from a marker here;
 * a missing marker is reported as an observability gap, never as a failure.
 */
import {
  CODE_PATTERN,
  PI_SESSION_ID,
  SHA256_HEX,
  STARTUP_STDERR_CODE,
  STARTUP_STDERR_REASON_PREFIX,
} from "./chat-audit-contract.mjs";
import { isPlainObject, safeReasonCode } from "./chat-audit-values.mjs";
export function parseSseFrame(frame) {
  const lines = frame.split("\n");
  let cursor;
  let eventType;
  let data;
  for (const line of lines) {
    if (line.length === 0) continue;
    if (line.startsWith("id: ")) cursor = line.slice(4);
    else if (line.startsWith("event: ")) eventType = line.slice(7);
    else if (line.startsWith("data: ")) data = data === undefined ? line.slice(6) : `${data}\n${line.slice(6)}`;
    else return Object.freeze({ ok: false, reason: "malformed_line" });
  }
  if (eventType === undefined || data === undefined) return Object.freeze({ ok: false, reason: "incomplete_frame" });
  let payload;
  try {
    payload = JSON.parse(data);
  } catch {
    return Object.freeze({ ok: false, reason: "invalid_json" });
  }
  if (!isPlainObject(payload)) return Object.freeze({ ok: false, reason: "invalid_payload" });
  if (payload.eventType !== eventType) return Object.freeze({ ok: false, reason: "event_type_mismatch" });
  return Object.freeze({ ok: true, cursor, eventType, payload });
}

export function classifyStartupStderr(stderr) {
  if (typeof stderr !== "string" || stderr.length === 0) return undefined;
  for (const line of stderr.split(/\r?\n/).map((value) => value.trim())) {
    if (line.length === 0) continue;
    const code = line.replace(/^Error:\s*/i, "");
    if (!STARTUP_STDERR_CODE.test(code)) continue;
    const reason = `${STARTUP_STDERR_REASON_PREFIX}${code.toLowerCase()}`;
    if (CODE_PATTERN.test(reason)) return reason;
  }
  return undefined;
}

export function classifyStartupFailure(error, stderr) {
  const reason = safeReasonCode(error);
  if (!reason.startsWith("dialogue_exited_before_ready:") && reason !== "dialogue_start_timeout") return reason;
  return classifyStartupStderr(stderr) ?? reason;
}

/**
 * Class A child IPC: the pre-send marker proves only that Pi serialized a
 * request immediately before the provider call. It is scoped to the exact
 * session identity reported by the separate runtime frame.
 */
export function evaluateProviderRuntimeMarker(value) {
  if (
    value?.schema !== "gamebuddy-tavern-narrative-gate-runtime/v1" ||
    typeof value.piSessionId !== "string" ||
    !PI_SESSION_ID.test(value.piSessionId)
  )
    return Object.freeze({ observed: false, reasonCode: "provider_runtime_session_unavailable" });
  return Object.freeze({ observed: true, piSessionId: value.piSessionId });
}

export function evaluateProviderPreSendMarker(value, expectedDigest, expectedSessionId) {
  if (value === undefined) return Object.freeze({ observed: false, reasonCode: "provider_marker_unavailable" });
  if (
    value?.schema !== "gamebuddy-tavern-narrative-gate-marker/v1" ||
    typeof value.sessionId !== "string" ||
    typeof value.nonceSha256 !== "string" ||
    !PI_SESSION_ID.test(value.sessionId) ||
    !SHA256_HEX.test(value.nonceSha256)
  )
    return Object.freeze({ observed: false, reasonCode: "provider_marker_schema_invalid" });
  if (value.sessionId !== expectedSessionId || value.nonceSha256 !== expectedDigest)
    return Object.freeze({ observed: false, reasonCode: "provider_marker_digest_mismatch" });
  return Object.freeze({ observed: true, preSendSerialized: true });
}

/**
 * Class B diagnostic markers. Only admission and rejection are expressible; the
 * `commit_done` marker is intentionally absent because the authoritative
 * presentation fact may only come from `/state`.
 */
const PRESENTATION_MARKER =
  /\[DEBUG-chat-live-p4c\] (admission_ok|commit_rejected|commit_error|native_rejected_[a-z_]+)/g;

/**
 * The gate marker's own failure line, produced by the Host when it cannot
 * announce the runtime. Matching the whole line (not a presence flag) is
 * deliberate: the point is to carry WHICH condition failed, so the run can say
 * "the transport was not connected" instead of "no marker", which reads as a
 * product that never called the provider.
 */
const FIRST_RESPONSE_MS = /\[provider-start\] first_response_ms=(\d+)/;

/** The provider-boundary wait this turn actually paid, when the host measured it. */
export function providerFirstResponseMs(stderr) {
  if (typeof stderr !== "string" || stderr.length === 0) return null;
  // The LAST match is the turn being reported: one line is written per turn.
  let value = null;
  for (const match of stderr.matchAll(FIRST_RESPONSE_MS)) {
    const parsed = Number(match[1]);
    if (Number.isSafeInteger(parsed) && parsed >= 0) value = parsed;
  }
  return value;
}

const GATE_MARKER_FAILURE = /\[tavern-gate\] runtime marker (unavailable|rejected): ([^\n]*)/g;

/**
 * Class B probe materialization markers emitted by Magic Context on vendor
 * stderr after a durable fold COMMIT (D-1 approved: vendor stderr). They are
 * consumed internally by the probe driver for P-fold positioning and m[0]
 * bit-stability; they NEVER become frozen audit event codes.
 *   `[probe:m0_digest] <sha256-of-persisted-m0-bytes>`
 *   `[probe:fold_committed] <opaque-materialization-revision>`
 */
// The value alternative is ordered: a `rev_`-prefixed revision can never be a
// 64-char lowercase hex digest (the `r` is not a hex digit), so a bound value is
// unambiguous and there is no backtracking ambiguity between the two kinds. The
// digest marker carries its materialization revision as a third token because
// §5.4's bit-stability check is "same revision, same digest" — without the pair a
// legitimate re-render is indistinguishable from drift.
const PROBE_MATERIALIZATION_MARKER =
  /\[probe:(m0_digest|fold_committed)\] (rev_[A-Za-z0-9_-]{1,120}|[a-f0-9]{64})(?: (rev_[A-Za-z0-9_-]{1,120}))?/g;

export function classifyProbeMaterializationMarkers(stderr) {
  if (typeof stderr !== "string" || stderr.length === 0) return Object.freeze([]);
  const markers = [];
  for (const match of stderr.matchAll(PROBE_MATERIALIZATION_MARKER)) {
    const kind = match[1];
    const value = match[2];
    if (kind === "fold_committed") {
      markers.push(Object.freeze({ code: "fold_committed", revision: value }));
      continue;
    }
    // A digest without its revision cannot be compared, so a digest marker that
    // is missing the paired token is not evidence and is not reported as one.
    const revision = match[3];
    if (revision === undefined) continue;
    markers.push(Object.freeze({ code: "m0_digest", digest: value, revision }));
  }
  return Object.freeze(markers);
}

export function classifyPresentationMarkers(stderr) {
  if (typeof stderr !== "string" || stderr.length === 0) return Object.freeze([]);
  const markers = [];
  for (const match of stderr.matchAll(PRESENTATION_MARKER)) {
    const token = match[1];
    markers.push(
      token === "admission_ok"
        ? Object.freeze({ code: "admitted", status: "admission_ok" })
        : Object.freeze({ code: "rejected", reason: token.slice(0, 160) }),
    );
  }
  return Object.freeze(markers);
}

/**
 * Why the runtime never announced itself, when it could not.
 *
 * The runtime marker is the ONLY producer of the Pi session identity the pre-send
 * marker is cross-checked against, so without it no `provider.request.sent` can
 * exist and the run reports `no_pre_send_marker`. That reason is indistinguishable
 * from "the product never reached the provider" - the exact collapse that made
 * provider timing unmeasurable. The host names the cause on one bounded stderr
 * line; this reads it, so the run's evidence can say which world it was in.
 */
export function classifyGateMarkerFailures(stderr) {
  if (typeof stderr !== "string" || stderr.length === 0) return Object.freeze([]);
  const failures = [];
  for (const match of stderr.matchAll(GATE_MARKER_FAILURE)) {
    failures.push(Object.freeze({ phase: match[1], detail: match[2].trim().slice(0, 200) }));
  }
  return Object.freeze(failures);
}
