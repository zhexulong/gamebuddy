import assert from "node:assert/strict";
import test from "node:test";

import { type HostGameLifecycleSnapshot, projectGameStatus } from "./game-status.js";

const currentActive: HostGameLifecycleSnapshot = {
  availability: "available",
  surface: "active",
  freshness: "current",
  availableCapabilities: { category: "available", count: 3 },
  activeExecution: "none",
  latestAuthoritativeReceipt: "succeeded",
};

test("projects the complete closed player-safe status from a Host-owned lifecycle snapshot", () => {
  const status = projectGameStatus(currentActive);

  assert.deepEqual(status, {
    availability: "available",
    category: "ready",
    label: "Ready",
    surfaceStatus: "active",
    freshnessLabel: "Current game state",
    availableCapabilityCount: 3,
    availableCapabilityCategory: "available",
    activeExecutionCategory: "none",
    latestAuthoritativeReceiptOutcome: "succeeded",
  });
  assert.deepEqual(Object.keys(status).sort(), [
    "activeExecutionCategory",
    "availability",
    "availableCapabilityCategory",
    "availableCapabilityCount",
    "category",
    "freshnessLabel",
    "label",
    "latestAuthoritativeReceiptOutcome",
    "surfaceStatus",
  ]);
});

test("projects only safe categories and labels, never lifecycle source fields", () => {
  const status = projectGameStatus({
    ...currentActive,
    activeExecution: "active",
    latestAuthoritativeReceipt: "not_succeeded",
  });

  assert.deepEqual(status, {
    availability: "available",
    category: "busy",
    label: "Game action running",
    surfaceStatus: "active",
    freshnessLabel: "Current game state",
    availableCapabilityCount: 3,
    availableCapabilityCategory: "available",
    activeExecutionCategory: "active",
    latestAuthoritativeReceiptOutcome: "not_succeeded",
  });
  assert.equal(JSON.stringify(status).includes("request"), false);
  assert.equal(JSON.stringify(status).includes("revision"), false);
  assert.equal(JSON.stringify(status).includes("bridge"), false);
});

test("fails closed for absent, stale, and mismatched authoritative state", () => {
  for (const freshness of ["absent", "stale", "mismatch"] as const) {
    assert.deepEqual(
      projectGameStatus({
        ...currentActive,
        freshness,
        availableCapabilities: { category: "available", count: 3 },
        activeExecution: "active",
        latestAuthoritativeReceipt: "succeeded",
      }),
      {
        availability: "unavailable",
        category: "awaiting_state",
        label: "Awaiting current game state",
        surfaceStatus: "active",
        freshnessLabel:
          freshness === "absent"
            ? "Game state unavailable"
            : freshness === "stale"
              ? "Game state stale"
              : "Game state mismatch",
        availableCapabilityCount: 0,
        availableCapabilityCategory: "none",
        activeExecutionCategory: "none",
        latestAuthoritativeReceiptOutcome: "none",
      },
    );
  }
});

test("fails closed for unavailable and non-active lifecycle surfaces", () => {
  assert.deepEqual(projectGameStatus({ ...currentActive, availability: "unavailable" }), {
    availability: "unavailable",
    category: "unavailable",
    label: "Game unavailable",
    surfaceStatus: "active",
    freshnessLabel: "Current game state",
    availableCapabilityCount: 0,
    availableCapabilityCategory: "none",
    activeExecutionCategory: "none",
    latestAuthoritativeReceiptOutcome: "none",
  });
  assert.deepEqual(projectGameStatus({ ...currentActive, surface: "returning" }), {
    availability: "unavailable",
    category: "returning",
    label: "Returning from game",
    surfaceStatus: "returning",
    freshnessLabel: "Current game state",
    availableCapabilityCount: 0,
    availableCapabilityCategory: "none",
    activeExecutionCategory: "none",
    latestAuthoritativeReceiptOutcome: "none",
  });
  assert.deepEqual(projectGameStatus({ ...currentActive, surface: "recovery_required" }), {
    availability: "unavailable",
    category: "recovery_required",
    label: "Game recovery required",
    surfaceStatus: "recovery_required",
    freshnessLabel: "Current game state",
    availableCapabilityCount: 0,
    availableCapabilityCategory: "none",
    activeExecutionCategory: "none",
    latestAuthoritativeReceiptOutcome: "none",
  });
});

test("rejects malformed snapshots and unexpected raw lifecycle fields rather than projecting them", () => {
  for (const snapshot of [
    undefined,
    { ...currentActive, availableCapabilities: { category: "available", count: -1 } },
    { ...currentActive, requestId: "request_01" },
    { ...currentActive, snapshotRevision: 7 },
  ]) {
    assert.deepEqual(projectGameStatus(snapshot), {
      availability: "unavailable",
      category: "unavailable",
      label: "Game unavailable",
      surfaceStatus: "unavailable",
      freshnessLabel: "Game state unavailable",
      availableCapabilityCount: 0,
      availableCapabilityCategory: "none",
      activeExecutionCategory: "none",
      latestAuthoritativeReceiptOutcome: "none",
    });
  }
});
