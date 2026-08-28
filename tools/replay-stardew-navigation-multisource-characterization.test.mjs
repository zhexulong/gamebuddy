import assert from "node:assert";
import test from "node:test";

import { newEnvelope } from "../host/dist-test/protocol.js";
import { COMPLETION_REASON, NAVIGATION_ACTION, replayNavigationOperation } from "./replay-stardew-navigation-operation.mjs";

/**
 * Combined multi-hop replay + multi-source characterization integration tests.
 *
 * These tests verify that a multi-hop replay that passes with a valid
 * multi-source characterization artifact is correctly accepted, while a
 * multi-hop replay that would fail its own constraints is blocked regardless
 * of any characterization artifact. Characterization artifact validation is
 * the responsibility of the topology preflight; this test ensures the replay
 * module's multi-hop mode is correctly wired to the broader composition.
 *
 * No Stardew/SMAPI is launched, no pipes are connected, no fixtures written.
 */

const scope = {
  integrationId: "stardew",
  saveId: "save_01",
  worldId: "world_01",
  playerId: "player_01",
  companionId: "companion_01",
};

const completionDetail = () =>
  `destination=dr1_${"A".repeat(20)};location=lc1_${"B".repeat(20)};arrived=true;postcondition=true`;

function requestFrame({ now, requestId = "rq1_AAAAAAAAAAAAAAAAAAAAAAAAAA" } = {}) {
  return newEnvelope(
    "execution_request",
    scope,
    {
      requestId,
      idempotencyKey: "ik1_CCCCCCCCCCCCCCCCCCCCCCCC",
      action: NAVIGATION_ACTION,
      args: { destination: { kind: "ref", ref: `dr1_${"D".repeat(22)}` } },
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

// ====== Multi-hop replay acceptance ======

test("multisource-replay: a valid multi-hop-shaped lineage passes multi-hop replay", () => {
  const frames = multiHopFrames();
  const report = replayNavigationOperation(frames, { scope, mode: "multi_hop_ordinary_warp" });
  assert.equal(report.ok, true);
  assert.equal(report.valid, true);
  assert.equal(report.success, true);
  assert.equal(report.state, "navigation_replay_completed");
  assert.equal(report.blocker, null);
  assert.equal(report.mode, "multi_hop_ordinary_warp");
});

test("multisource-replay: a multi-hop replay with valid characterization does not expose route/hop facts", () => {
  const frames = multiHopFrames();
  const report = replayNavigationOperation(frames, { scope, mode: "multi_hop_ordinary_warp" });
  const { mode: _mode, ...publicReport } = report;
  const serialized = JSON.stringify(publicReport);
  assert.equal(serialized.includes("route"), false);
  assert.equal(serialized.includes("hop"), false);
  assert.equal(serialized.includes("tile"), false);
  assert.equal(serialized.includes("warp"), false);
  assert.equal(serialized.includes("leg"), false);
  assert.equal(serialized.includes("source"), false);
});

// ====== Multi-hop replay rejection ======

test("multisource-replay: one-running receipt is rejected in multi-hop mode", () => {
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

test("multisource-replay: duplicate accepted receipts are rejected in multi-hop mode", () => {
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

test("multisource-replay: terminal before running receipts is rejected in multi-hop mode", () => {
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

test("multisource-replay: a non-final terminal (failed) among lifecycle receipts is rejected in multi-hop mode", () => {
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
  assert.equal(report.blocker.code, "terminal_not_succeeded");
});

test("multisource-replay: a forbidden primitive in a running receipt is rejected in multi-hop mode", () => {
  const now = Date.now();
  const frames = multiHopFrames({ now });
  frames[2] = receiptFrame({
    state: "running",
    reasonCode: "navigation_started",
    now,
    evidence: { detail: "route=Farm_to_Mountain;destination=dr1_XXXXXXXXXXXXXXXXXXXXXX" },
  });
  const report = replayNavigationOperation(frames, { scope, mode: "multi_hop_ordinary_warp" });
  assert.equal(report.ok, false);
  assert.equal(report.blocker.code, "forbidden_primitive_leak");
});

test("multisource-replay: a forbidden primitive in nested object evidence is rejected in multi-hop mode", () => {
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

// ====== Direct mode compatibility ======

test("multisource-replay: direct replay mode with multi-hop-shaped frames still works", () => {
  const frames = multiHopFrames();
  const report = replayNavigationOperation(frames, { scope });
  assert.equal(report.ok, true);
  assert.equal(report.state, "navigation_replay_completed");
  assert.equal(report.mode, "direct");
});

test("multisource-replay: direct replay mode does not require multi-hop receipt count", () => {
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
  const report = replayNavigationOperation(frames, { scope });
  assert.equal(report.ok, true);
  assert.equal(report.state, "navigation_replay_completed");
});

// ====== International action identity ======

test("multisource-replay: a non-navigation action is rejected even with multi-hop frames", () => {
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

// ====== Lifecycle ordering violations ======

test("multisource-replay: running before accepted is rejected in multi-hop mode", () => {
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

test("multisource-replay: meaningful_progress before accepted is rejected in multi-hop mode", () => {
  const now = Date.now();
  const frames = multiHopFrames({ now });
  frames.splice(1, 0, receiptFrame({ state: "meaningful_progress", reasonCode: "navigation_progress", now }));
  const report = replayNavigationOperation(frames, { scope, mode: "multi_hop_ordinary_warp" });
  assert.equal(report.ok, false);
  assert.equal(report.blocker.code, "multi_hop_ordering");
  assert.equal(report.blocker.detail, "accepted_not_first_receipt");
});

test("multisource-replay: correlation mismatch is rejected in multi-hop mode", () => {
  const now = Date.now();
  const frames = multiHopFrames({ now });
  frames.push(
    receiptFrame({
      state: "running",
      reasonCode: "navigation_started",
      now,
      executionId: "ex1_OTHER_EXECUTION_ID_0000000000",
    }),
  );
  const report = replayNavigationOperation(frames, { scope, mode: "multi_hop_ordinary_warp" });
  assert.equal(report.ok, false);
  assert.equal(report.blocker.code, "correlation_mismatch");
});