import assert from "node:assert/strict";
import test from "node:test";

import { GameSurfaceLifecycleProducer } from "./game-surface-lifecycle.js";
import {
  createIntegrationActionCatalog,
  type GameIntegrationModule,
  type IntegrationStateView,
} from "../integration-module.js";
import type { IntegrationConnection } from "../integration-types.js";

function fixture(state: IntegrationStateView): { producer: GameSurfaceLifecycleProducer; state: IntegrationStateView } {
  const catalog = createIntegrationActionCatalog([
    {
      actionId: "move",
      familyId: "movement",
      actionClass: "primitive",
      lifecycle: "published",
      label: "Move",
      description: "Move.",
      targetKinds: ["tile"],
      requiredCapability: "move",
    },
    {
      actionId: "hidden",
      familyId: "hidden",
      actionClass: "primitive",
      lifecycle: "planned",
      label: "Hidden",
      description: "Hidden.",
      targetKinds: ["tile"],
      requiredCapability: "hidden",
    },
  ]);
  const module = {
    actionCatalog: catalog,
    readState: () => state,
  } as Pick<GameIntegrationModule, "actionCatalog" | "readState">;
  return {
    producer: new GameSurfaceLifecycleProducer(module as GameIntegrationModule, {} as IntegrationConnection),
    state,
  };
}

const current: IntegrationStateView = {
  connected: true,
  sessionId: "bridge_session",
  capabilities: ["move", "hidden"],
  snapshotRevision: 4,
  activeExecution: null,
  latestReceipt: null,
  latestReasonCode: null,
};

test("lifecycle producer reduces current adapter state to only published capability count and safe categories", () => {
  const { producer } = fixture(current);
  assert.deepEqual(producer.snapshot(), {
    availability: "available",
    surface: "active",
    freshness: "current",
    availableCapabilities: { category: "available", count: 1 },
    activeExecution: "none",
    latestAuthoritativeReceipt: "none",
  });
});

test("lifecycle producer categorizes active execution and receipt without identifiers or payload", () => {
  const { producer } = fixture({
    ...current,
    activeExecution: { requestId: "request_secret", executionId: "execution_secret", state: "running" },
    latestReceipt: {
      requestId: "receipt_request",
      executionId: "receipt_execution",
      state: "rejected",
      reasonCode: "no",
      revision: 5,
      evidence: { payload: "secret" },
    },
  });
  const snapshot = producer.snapshot();
  assert.deepEqual(snapshot, {
    availability: "available",
    surface: "active",
    freshness: "current",
    availableCapabilities: { category: "available", count: 1 },
    activeExecution: "active",
    latestAuthoritativeReceipt: "not_succeeded",
  });
  assert.equal(JSON.stringify(snapshot).includes("secret"), false);
  assert.equal(JSON.stringify(snapshot).includes("revision"), false);
});

test("lifecycle producer fails closed for unavailable transport, missing state, malformed state, and returning lifecycle", () => {
  for (const state of [
    { ...current, connected: false },
    { ...current, sessionId: null },
    { ...current, snapshotRevision: null },
    { ...current, capabilities: ["bad capability"] },
  ]) {
    const { producer } = fixture(state);
    assert.deepEqual(producer.snapshot().availability, "unavailable");
  }
  const { producer } = fixture(current);
  producer.markConnectionUnavailable();
  assert.deepEqual(producer.snapshot(), {
    availability: "unavailable",
    surface: "active",
    freshness: "absent",
    availableCapabilities: { category: "none", count: 0 },
    activeExecution: "none",
    latestAuthoritativeReceipt: "none",
  });
  const returning = fixture(current).producer;
  returning.markReturning();
  assert.deepEqual(returning.snapshot().surface, "returning");
  assert.equal(returning.snapshot().availability, "unavailable");
});
