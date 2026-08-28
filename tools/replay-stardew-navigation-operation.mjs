#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { validateBridgeMessage } from "../host/dist-test/protocol.js";
import { STARDEW_INTEGRATION_MODULE } from "../host/dist-test/stardew-integration-module.js";

export const NAVIGATION_ACTION = "navigate_to_destination";
export const COMPLETION_REASON = "navigation_completed";
const NON_TERMINAL_STATES = new Set(["accepted", "running", "meaningful_progress"]);
export const FORBIDDEN_EVIDENCE_PRIMITIVES = Object.freeze([ "route", "tile", "warp", "leg", "source" ]);

function isRecord(v) { return v !== null && typeof v === "object" && !Array.isArray(v); }
function isOpaqueId(v) { return typeof v === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(v); }
const defaultCompletionEvidence = (p) =>
  STARDEW_INTEGRATION_MODULE.actionCatalog.hasCompletionEvidence(NAVIGATION_ACTION, p);
function forbiddenEvidencePrimitives(payload) {
  const evidence = payload?.evidence;
  // Privacy is a replay invariant independent of the current wire schema:
  // support a string evidence form as well as nested object evidence so an
  // alternate validator cannot silently bypass primitive filtering.
  const bodies = typeof evidence === "string"
    ? [evidence]
    : isRecord(evidence)
      ? [JSON.stringify(evidence)]
      : [];
  const haystack = bodies.join(" ").toLowerCase();
  return FORBIDDEN_EVIDENCE_PRIMITIVES.filter((p) => haystack.includes(p));
}

function blocked(code, detail, items = []) {
  return Object.freeze({
    ok: false, valid: false, success: false,
    state: "navigation_replay_blocked",
    blocker: Object.freeze({ code, detail }),
    items: Object.freeze(items),
    validation: Object.freeze({ valid: false, mutationCount: 0, executionReceiptCount: 0 }),
    terminal: null,
  });
}
function notSuccess(blocker, tp, receipts, raw) {
  return Object.freeze({
    ok: false, valid: true, success: false,
    state: "navigation_replay_blocked",
    blocker,
    items: Object.freeze(raw),
    validation: Object.freeze({ valid: true, mutationCount: 0, executionReceiptCount: receipts.length }),
    terminal: Object.freeze({ requestId: tp.requestId, executionId: tp.executionId, reasonCode: tp.reasonCode, state: tp.state }),
  });
}

function checkMultiHop(receipts) {
  // multi_hop_ordinary_warp replay requires exactly one accepted, at least two
  // running, correct lifecycle ordering, and a single strict completion.
  const accepted = receipts.filter((r) => r.payload.state === "accepted");
  const running = receipts.filter((r) => r.payload.state === "running");
  if (accepted.length !== 1)
    return { ok: false, code: "multi_hop_accepted_count", detail: { count: accepted.length } };
  if (running.length < 2)
    return { ok: false, code: "multi_hop_running_count", detail: { count: running.length } };
  // Ordering: accepted must appear before any running, and every running
  // before the single terminal.
  const acceptedIdx = receipts.indexOf(accepted[0]);
  const runningIndices = running.map((r) => receipts.indexOf(r));
  const terminalIdx = Math.max(...receipts.map((r, i) =>
    !NON_TERMINAL_STATES.has(r.payload.state) ? i : -1));
  if (acceptedIdx !== 0)
    return { ok: false, code: "multi_hop_ordering", detail: "accepted_not_first_receipt" };
  if (runningIndices.some((idx) => idx < acceptedIdx))
    return { ok: false, code: "multi_hop_ordering", detail: "running_before_accepted" };
  if (terminalIdx <= Math.max(...runningIndices))
    return { ok: false, code: "multi_hop_ordering", detail: "terminal_not_after_running" };
  // No non-terminal receipt after the terminal.
  const allNonTerminals = receipts.filter((r) => NON_TERMINAL_STATES.has(r.payload.state));
  const lastNonTerminalIdx = allNonTerminals.length > 0
    ? Math.max(...allNonTerminals.map((r) => receipts.indexOf(r)))
    : -1;
  if (lastNonTerminalIdx > terminalIdx)
    return { ok: false, code: "multi_hop_ordering", detail: "nonterminal_after_terminal" };
  return { ok: true };
}

export function replayNavigationOperation(frames, options = {}) {
  const validate = options.validate ?? validateBridgeMessage;
  const completionEvidence = options.completionEvidence ?? defaultCompletionEvidence;
  const expectedScope = options.scope;
  const mode = options.mode;
  if (!Array.isArray(frames) || frames.length === 0) return blocked("no_frames", {});
  const discoveredScope = expectedScope ?? frames.find((f) => isRecord(f) && isRecord(f.scope))?.scope;
  if (!isRecord(discoveredScope)) return blocked("no_scope", { frames: frames.length });
  const nowMs = Math.max(0, ...frames.map((f) => (Number.isSafeInteger(f?.timestampMs) ? f.timestampMs : 0)));
  const items = [];
  const receipts = [];
  const requests = [];
  for (let i = 0; i < frames.length; i += 1) {
    const frame = frames[i];
    const envelopeError = validate(frame, discoveredScope, nowMs);
    if (envelopeError !== null) return blocked("invalid_frame", { index: i, envelopeError }, items);
    const kind = frame.type;
    if (kind === "execution_receipt") {
      const leaked = forbiddenEvidencePrimitives(frame.payload);
      if (leaked.length > 0) return blocked("forbidden_primitive_leak", { index: i, primitives: leaked }, items);
      receipts.push({ index: i, payload: frame.payload });
      items.push({ index: i, type: kind, state: frame.payload.state });
    } else if (kind === "execution_request") {
      if (frame.payload?.action !== NAVIGATION_ACTION) return blocked("request_not_navigation", { index: i }, items);
      requests.push({ index: i, payload: frame.payload });
      items.push({ index: i, type: kind });
    } else {
      items.push({ index: i, type: kind });
    }
  }
  if (requests.length !== 1) return blocked("single_request_violation", { requestCount: requests.length }, items);
  if (receipts.length === 0) return blocked("no_receipts", { requests: requests.length }, items);
  const pairSet = new Set();
  for (const { index, payload } of receipts) {
    if (!isOpaqueId(payload.requestId) || !isOpaqueId(payload.executionId) || !isOpaqueId(payload.actionId))
      return blocked("invalid_receipt_identity", { index }, items);
    if (payload.actionId !== NAVIGATION_ACTION)
      return blocked("receipt_not_navigation_action", { index, actionId: payload.actionId }, items);
    pairSet.add(payload.requestId + "|" + payload.executionId);
  }
  if (pairSet.size !== 1) return blocked("correlation_mismatch", { distinctPairs: pairSet.size }, items);
  const firstPayload = receipts[0].payload;
  if (requests[0].payload.requestId !== firstPayload.requestId)
    return blocked("request_receipt_mismatch", {}, items);
  const terminals = receipts.filter(({ payload }) => !NON_TERMINAL_STATES.has(payload.state));
  if (terminals.length !== 1) return blocked("single_terminal_violation", { terminalCount: terminals.length }, items);
  const terminal = terminals[0].payload;
  if (terminal.actionId !== NAVIGATION_ACTION)
    return notSuccess(Object.freeze({ code: "terminal_not_navigation_action", detail: { actionId: terminal.actionId } }), terminal, receipts, items);
  if (terminal.state !== "succeeded")
    return notSuccess(Object.freeze({ code: "terminal_not_succeeded", detail: { state: terminal.state } }), terminal, receipts, items);
  if (terminal.reasonCode !== COMPLETION_REASON)
    return notSuccess(Object.freeze({ code: "terminal_not_navigation_completed", detail: { state: terminal.state } }), terminal, receipts, items);
  if (!completionEvidence(terminal))
    return notSuccess(Object.freeze({ code: "completion_evidence_rejected", detail: { state: terminal.state } }), terminal, receipts, items);
  // --- multi-hop mode check ---
  if (mode === "multi_hop_ordinary_warp") {
    const hopResult = checkMultiHop(receipts);
    if (!hopResult.ok) {
      return blocked(hopResult.code, hopResult.detail, items);
    }
  }
  return Object.freeze({
    ok: true, valid: true, success: true,
    state: "navigation_replay_completed",
    blocker: null,
    items,
    validation: Object.freeze({ valid: true, mutationCount: 0, executionReceiptCount: receipts.length }),
    terminal: Object.freeze({ requestId: firstPayload.requestId, executionId: firstPayload.executionId, reasonCode: terminal.reasonCode, state: terminal.state }),
    mode: mode === "multi_hop_ordinary_warp" ? "multi_hop_ordinary_warp" : "direct",
  });
}
async function cliMain() {
  const fileArgs = process.argv.slice(2);
  if (fileArgs.length === 0) throw new Error("usage: node tools/replay-stardew-navigation-operation.mjs <frames.json> ...");
  const frames = [];
  for (const file of fileArgs) {
    const value = JSON.parse(await readFile(file, "utf8"));
    if (Array.isArray(value)) frames.push(...value); else frames.push(value);
  }
  const report = replayNavigationOperation(frames);
  console.log(JSON.stringify({ state: report.state, blocker: report.blocker?.code ?? null, validation: report.validation, terminal: report.terminal }));
  process.exitCode = report.ok ? 0 : 1;
}
if (process.argv[1] && new URL("file:" + process.argv[1]).href === import.meta.url) {
  cliMain().catch((error) => { console.error(String(error?.message || error)); process.exitCode = 1; });
}
