import assert from "node:assert";
import test from "node:test";

import { newEnvelope } from "../host/dist-test/protocol.js";
import {
  COMPLETION_REASON,
  NAVIGATION_ACTION,
  replayNavigationOperation,
} from "./replay-stardew-navigation-operation.mjs";

/**
 * Deterministic replay-style regression for the navigation receipt lineage.
 * Synthetic real-shaped frames are replayed through the real Host bridge
 * validator and the Mod-owned mounted completion predicate. This is not a
 * runner: it never launches Stardew, connects a pipe, writes saves, or mutates
 * game state.
 */

const scope = {
  integrationId: "stardew",
  saveId: "save_01",
  worldId: "world_01",
  playerId: "player_01",
  companionId: "companion_01",
};

const OPAQUE = (body) => body.repeat(4);
const completionDetail = () =>
  `destination=dr1_${"A".repeat(20)};location=lc1_${"B".repeat(20)};arrived=true;postcondition=true`;

function requestFrame({ now, requestId = "rq1_AAAAAAAAAAAAAAAAAAAAAAAAAA", selector } = {}) {
  return newEnvelope(
    "execution_request",
    scope,
    {
      requestId,
      idempotencyKey: "ik1_CCCCCCCCCCCCCCCCCCCCCCCC",
      action: NAVIGATION_ACTION,
      args: { destination: selector ?? { kind: "ref", ref: `dr1_${"D".repeat(22)}` } },
      expectedRevision: 7,
      deadlineMs: now + 30_000,
    },
    "corr_1",
    now,
  );
}

function receiptFrame(entry) {
  return newEnvelope("execution_receipt", scope, {
    executionId: entry.executionId ?? "ex1_EEEEEEEEEEEEEEEEEEEEEEEE",
    requestId: entry.requestId ?? "rq1_AAAAAAAAAAAAAAAAAAAAAAAAAA",
    actionId: entry.actionId ?? NAVIGATION_ACTION,
    state: entry.state,
    reasonCode: entry.reasonCode ?? "navigation_started",
    revision: entry.now ?? Date.now(),
    evidence: entry.evidence ?? null,
  }, "corr_1", entry.now ?? Date.now());
}

function completedFrames(overrides = {}) {
  const now = overrides.now ?? Date.now();
  return [
    requestFrame({ now, requestId: overrides.requestId }),
    receiptFrame({ state: "accepted", reasonCode: "navigation_accepted", now, requestId: overrides.requestId }),
    receiptFrame({ state: "running", reasonCode: "navigation_started", now, requestId: overrides.requestId }),
    receiptFrame({
      state: "succeeded",
      reasonCode: COMPLETION_REASON,
      evidence: { detail: completionDetail() },
      now,
      requestId: overrides.requestId,
    }),
  ];
}

test("replay: a completed navigation lineage is valid, one terminal, and green", () => {
  const report = replayNavigationOperation(completedFrames(), { scope });
  assert.equal(report.ok, true);
  assert.equal(report.valid, true);
  assert.equal(report.success, true);
  assert.equal(report.state, "navigation_replay_completed");
  assert.equal(report.blocker, null);
  assert.equal(report.validation.mutationCount, 0);
  assert.equal(report.validation.executionReceiptCount, 3);
  assert.equal(report.terminal.reasonCode, COMPLETION_REASON);
  assert.equal(report.terminal.state, "succeeded");
});

test("replay: a label selector variant is admissible (both typed selector forms)", () => {
  const frames = completedFrames();
  frames[0] = requestFrame({ now: Date.now(), requestId: "rq1_AAAAAAAAAAAAAAAAAAAAAAAAAA", selector: { kind: "label", label: "Mines" } });
  const report = replayNavigationOperation(frames, { scope });
  assert.equal(report.ok, true);
});

test("replay: a receipt-only sequence cannot produce success", () => {
  const frames = completedFrames().slice(1);
  const report = replayNavigationOperation(frames, { scope });
  assert.equal(report.ok, false);
  assert.equal(report.blocker.code, "single_request_violation");
});

test("replay: multiple request identities cannot produce success", () => {
  const now = Date.now();
  const frames = completedFrames({ now });
  frames.splice(1, 0, requestFrame({ now, requestId: "rq2_BBBBBBBBBBBBBBBBBBBBBBBBBB" }));
  const report = replayNavigationOperation(frames, { scope });
  assert.equal(report.ok, false);
  assert.equal(report.blocker.code, "single_request_violation");
});

test("replay: a lineage without a terminal is never a success", () => {
  const now = Date.now();
  const frameResults = [
    requestFrame({ now }),
    receiptFrame({ state: "accepted", reasonCode: "navigation_accepted", now }),
    receiptFrame({ state: "running", reasonCode: "navigation_started", now }),
  ];
  const report = replayNavigationOperation(frameResults, { scope });
  assert.equal(report.ok, false);
  assert.equal(report.blocker.code, "single_terminal_violation");
  assert.equal(report.terminal, null);
});

test("replay: multiple terminals are rejected", () => {
  const frames = completedFrames();
  frames.push(
    receiptFrame({
      state: "failed",
      reasonCode: "native_transition_uncertain",
      evidence: null,
      now: Date.now(),
      executionId: "ex1_EEEEEEEEEEEEEEEEEEEEEEEE",
    }),
  );
  const report = replayNavigationOperation(frames, { scope });
  assert.equal(report.ok, false);
  assert.equal(report.blocker.code, "single_terminal_violation");
});

test("replay: an uncorrelated/mismatched receipt is rejected", () => {
  const now = Date.now();
  const frames = completedFrames({ now });
  frames.push(
    receiptFrame({
      state: "running",
      reasonCode: "navigation_started",
      now,
      executionId: "ex1_OTHER_EXECUTION_ID_0000000000",
    }),
  );
  const report = replayNavigationOperation(frames, { scope });
  assert.equal(report.blocker.code, "correlation_mismatch");
});

test("replay: a non-terminal receipt from another action cannot join the navigation lineage", () => {
  const now = Date.now();
  const frames = completedFrames({ now });
  frames[1] = receiptFrame({
    actionId: "enter_mine",
    state: "accepted",
    reasonCode: "navigation_accepted",
    now,
  });
  const report = replayNavigationOperation(frames, { scope });
  assert.equal(report.ok, false);
  assert.equal(report.blocker.code, "receipt_not_navigation_action");
});

test("replay: a running/accepted receipt leaking a route/tile/warp primitive is blocked", () => {
  const now = Date.now();
  const frames = completedFrames({ now });
  frames[1] = receiptFrame({
    state: "accepted",
    reasonCode: "navigation_accepted",
    now,
    evidence: { detail: "tile=30,40;destination=dr1_XXXXXXXXXXXXXXXXXXXXXX" },
  });
  const report = replayNavigationOperation(frames, { scope });
  assert.equal(report.blocker.code, "forbidden_primitive_leak");
});

test("replay: success evidence that is not the strict bounded navigation evidence is rejected", () => {
  const now = Date.now();
  const frames = completedFrames({ now });
  // Extra non-completion evidence field breaks the exact-key predicate.
  frames[3] = receiptFrame({
    state: "succeeded",
    reasonCode: COMPLETION_REASON,
    now,
    evidence: { detail: "destination=dr1_XXXX;location=lc1_YYYY;arrived=true;postcondition=true;extra=1" },
  });
  const report = replayNavigationOperation(frames, { scope });
  assert.equal(report.blocker.code, "completion_evidence_rejected");
});

test("replay: a terminal that is not navigation_completed is a valid lineage but not a success", () => {
  const now = Date.now();
  const frames = completedFrames({ now });
  frames[frames.length - 1] = receiptFrame({
    state: "cancelled",
    reasonCode: "player_cancelled",
    now,
  });
  const report = replayNavigationOperation(frames, { scope });
  assert.equal(report.valid, true);
  assert.equal(report.blocker.code, "terminal_not_succeeded");
});

test("replay: a non-succeeded terminal with navigation_completed evidence is never success", () => {
  const now = Date.now();
  const frames = completedFrames({ now });
  frames[frames.length - 1] = receiptFrame({
    state: "failed",
    reasonCode: COMPLETION_REASON,
    evidence: { detail: completionDetail() },
    now,
  });
  const report = replayNavigationOperation(frames, { scope });
  assert.equal(report.valid, true);
  assert.equal(report.ok, false);
  assert.equal(report.blocker.code, "terminal_not_succeeded");
});

test("replay: a terminal from another action is never navigation success", () => {
  const now = Date.now();
  const frames = completedFrames({ now });
  frames[frames.length - 1] = receiptFrame({
    actionId: "enter_mine",
    state: "succeeded",
    reasonCode: COMPLETION_REASON,
    evidence: { detail: completionDetail() },
    now,
  });
  const report = replayNavigationOperation(frames, { scope });
  assert.equal(report.valid, false);
  assert.equal(report.ok, false);
  assert.equal(report.blocker.code, "receipt_not_navigation_action");
});

test("replay: a non-navigation execution_request is rejected", () => {
  const now = Date.now();
  const frames = completedFrames({ now });
  frames[0] = newEnvelope(
    "execution_request",
    scope,
    {
      requestId: "rq1_AAAAAAAAAAAAAAAAAAAAAAAAAA",
      idempotencyKey: "ik1_CCCCCCCCCCCCCCCCCCCCCCCC",
      action: "travel",
      args: { x: 0, y: 0 },
      expectedRevision: 7,
      deadlineMs: now + 30_000,
    },
    "corr_1",
    now,
  );
  const report = replayNavigationOperation(frames, { scope });
  assert.equal(report.blocker.code, "request_not_navigation");
});

test("replay: an invalid receipt frame is rejected at the bridge boundary", () => {
  const now = Date.now();
  const frames = completedFrames({ now });
  frames[1] = receiptFrame({ state: "accepted", now, reasonCode: "navigation_accepted" });
  frames[1].payload = { ...frames[1].payload, extra: true };
  const report = replayNavigationOperation(frames, { scope });
  assert.equal(report.ok, false);
  assert.match(report.blocker.code, /^invalid_frame|invalid_receipt_identity$/);
});

// --- multi-hop mode tests ---

function multiHopFrames(overrides = {}) {
  const now = overrides.now ?? Date.now();
  return [
    requestFrame({ now, requestId: overrides.requestId }),
    receiptFrame({ state: "accepted", reasonCode: "navigation_accepted", now, requestId: overrides.requestId }),
    receiptFrame({ state: "running", reasonCode: "navigation_started", now, requestId: overrides.requestId }),
    receiptFrame({ state: "running", reasonCode: "navigation_started", now, requestId: overrides.requestId }),
    receiptFrame({
      state: "succeeded",
      reasonCode: COMPLETION_REASON,
      evidence: { detail: completionDetail() },
      now,
      requestId: overrides.requestId,
    }),
  ];
}

test("multi-hop: a receipt-safe two-hop-shaped lineage passes multi-hop replay", () => {
  const frames = multiHopFrames();
  const report = replayNavigationOperation(frames, { scope, mode: "multi_hop_ordinary_warp" });
  assert.equal(report.ok, true);
  assert.equal(report.valid, true);
  assert.equal(report.success, true);
  assert.equal(report.state, "navigation_replay_completed");
  assert.equal(report.blocker, null);
  assert.equal(report.validation.executionReceiptCount, 4);
  // `mode` is an internal scope attestation for preflight composition, not a
  // receipt-derived projection. The receipt-derived report fields carry no
  // route or per-hop facts.
  assert.equal(report.mode, "multi_hop_ordinary_warp");
  const { mode: _mode, ...publicReport } = report;
  assert.equal(JSON.stringify(publicReport).includes("route"), false);
  assert.equal(JSON.stringify(publicReport).includes("hop"), false);
});

test("multi-hop: one running receipt is rejected", () => {
  const now = Date.now();
  const frames = [
    requestFrame({ now }),
    receiptFrame({ state: "accepted", reasonCode: "navigation_accepted", now }),
    receiptFrame({ state: "running", reasonCode: "navigation_started", now }),
    receiptFrame({
      state: "succeeded",
      reasonCode: COMPLETION_REASON,
      evidence: { detail: completionDetail() },
      now,
    }),
  ];
  const report = replayNavigationOperation(frames, { scope, mode: "multi_hop_ordinary_warp" });
  assert.equal(report.ok, false);
  assert.equal(report.blocker.code, "multi_hop_running_count");
});

test("multi-hop: duplicate accepted receipts are rejected", () => {
  const now = Date.now();
  const frames = [
    requestFrame({ now }),
    receiptFrame({ state: "accepted", reasonCode: "navigation_accepted", now }),
    receiptFrame({ state: "accepted", reasonCode: "navigation_accepted", now }),
    receiptFrame({ state: "running", reasonCode: "navigation_started", now }),
    receiptFrame({ state: "running", reasonCode: "navigation_started", now }),
    receiptFrame({
      state: "succeeded",
      reasonCode: COMPLETION_REASON,
      evidence: { detail: completionDetail() },
      now,
    }),
  ];
  const report = replayNavigationOperation(frames, { scope, mode: "multi_hop_ordinary_warp" });
  assert.equal(report.ok, false);
  assert.equal(report.blocker.code, "multi_hop_accepted_count");
});

test("multi-hop: terminal before running receipts is rejected", () => {
  const now = Date.now();
  const frames = [
    requestFrame({ now }),
    receiptFrame({ state: "accepted", reasonCode: "navigation_accepted", now }),
    receiptFrame({
      state: "succeeded",
      reasonCode: COMPLETION_REASON,
      evidence: { detail: completionDetail() },
      now,
    }),
    receiptFrame({ state: "running", reasonCode: "navigation_started", now }),
    receiptFrame({ state: "running", reasonCode: "navigation_started", now }),
  ];
  const report = replayNavigationOperation(frames, { scope, mode: "multi_hop_ordinary_warp" });
  assert.equal(report.ok, false);
  assert.equal(report.blocker.code, "multi_hop_ordering");
});

test("multi-hop: a non-final terminal (e.g. failed) among lifecycle receipts is rejected", () => {
  const now = Date.now();
  const frames = [
    requestFrame({ now }),
    receiptFrame({ state: "accepted", reasonCode: "navigation_accepted", now }),
    receiptFrame({ state: "running", reasonCode: "navigation_started", now }),
    receiptFrame({ state: "running", reasonCode: "navigation_started", now }),
    receiptFrame({ state: "failed", reasonCode: "native_transition_uncertain", now }),
  ];
  const report = replayNavigationOperation(frames, { scope, mode: "multi_hop_ordinary_warp" });
  assert.equal(report.ok, false);
  // The failed state is a single terminal that fails the succeeded check
  assert.equal(report.blocker.code, "terminal_not_succeeded");
});

test("multi-hop: a forbidden primitive in a string evidence detail is rejected", () => {
  const now = Date.now();
  const frames = multiHopFrames({ now });
  frames[1] = receiptFrame({
    state: "accepted",
    reasonCode: "navigation_accepted",
    now,
    evidence: { detail: "route=some_path;destination=dr1_XXXXXXXXXXXXXXXXXXXXXX" },
  });
  const report = replayNavigationOperation(frames, { scope, mode: "multi_hop_ordinary_warp" });
  assert.equal(report.ok, false);
  assert.equal(report.blocker.code, "forbidden_primitive_leak");
});

test("multi-hop: a forbidden primitive in a nested object evidence is rejected", () => {
  const now = Date.now();
  const frames = multiHopFrames({ now });
  frames[1] = receiptFrame({
    state: "accepted",
    reasonCode: "navigation_accepted",
    now,
    evidence: { detail: "destination=dr1_XXXX", nested: { route: { from: "Farm", to: "Mountain" } } },
  });
  const report = replayNavigationOperation(frames, { scope, mode: "multi_hop_ordinary_warp" });
  assert.equal(report.ok, false);
  assert.equal(report.blocker.code, "forbidden_primitive_leak");
});

test("multi-hop: a foreign action identity in a receipt cannot pass multi-hop", () => {
  const now = Date.now();
  const frames = multiHopFrames({ now });
  frames[3] = receiptFrame({
    actionId: "enter_mine",
    state: "running",
    reasonCode: "navigation_started",
    now,
  });
  const report = replayNavigationOperation(frames, { scope, mode: "multi_hop_ordinary_warp" });
  assert.equal(report.ok, false);
  assert.equal(report.blocker.code, "receipt_not_navigation_action");
});

test("multi-hop: direct replay mode (no mode) with multi-hop-shaped frames still works", () => {
  const frames = multiHopFrames();
  const report = replayNavigationOperation(frames, { scope });
  // Direct mode has no multi-hop constraints, so 2 running receipts are fine.
  assert.equal(report.ok, true);
  assert.equal(report.state, "navigation_replay_completed");
});

test("multi-hop: running before accepted ordering is rejected", () => {
  const now = Date.now();
  const frames = [
    requestFrame({ now }),
    receiptFrame({ state: "running", reasonCode: "navigation_started", now }),
    receiptFrame({ state: "accepted", reasonCode: "navigation_accepted", now }),
    receiptFrame({ state: "running", reasonCode: "navigation_started", now }),
    receiptFrame({
      state: "succeeded",
      reasonCode: COMPLETION_REASON,
      evidence: { detail: completionDetail() },
      now,
    }),
  ];
  const report = replayNavigationOperation(frames, { scope, mode: "multi_hop_ordinary_warp" });
  assert.equal(report.ok, false);
  assert.equal(report.blocker.code, "multi_hop_ordering");
});

test("multi-hop: meaningful progress cannot precede the accepted receipt", () => {
  const now = Date.now();
  const frames = multiHopFrames({ now });
  frames.splice(1, 0, receiptFrame({ state: "meaningful_progress", reasonCode: "navigation_progress", now }));
  const report = replayNavigationOperation(frames, { scope, mode: "multi_hop_ordinary_warp" });
  assert.equal(report.ok, false);
  assert.equal(report.blocker.code, "multi_hop_ordering");
  assert.equal(report.blocker.detail, "accepted_not_first_receipt");
});

test("replay: string evidence primitive is rejected independently of wire evidence shape", () => {
  const now = Date.now();
  const frames = completedFrames({ now });
  frames[1].payload = { ...frames[1].payload, evidence: "route=private" };
  const report = replayNavigationOperation(frames, { scope, validate: () => null });
  assert.equal(report.ok, false);
  assert.equal(report.blocker.code, "forbidden_primitive_leak");
});