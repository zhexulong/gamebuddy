import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  readM3ForageGiven,
  runM3ForagePreflight,
  verifyM3ForageFixture,
  verifyM3ForageWhen,
} from "./run-stardew-portfolio-m3-forage-preflight.mjs";

const scope = Object.freeze({
  integrationId: "portfolio",
  topology: "single_player_native_companion",
  saveId: "save",
  worldId: "world",
  localPlayerId: "player",
  companionId: "companion",
  bindingGeneration: 1,
  bindingHash: "hash",
});
const target = Object.freeze({
  targetId: "forage_target",
  selectorId: "selector",
  observationId: "observation",
  kind: "spawned_forage_object",
  source: "fresh_native_observation",
  observedRevision: 7,
});
const request = Object.freeze({
  action: "pickup_forage",
  requestId: "req",
  traceId: "trace",
  idempotencyKey: "idem",
  expectedRevision: 7,
  deadlineMs: Date.now() + 60_000,
  cancellationToken: "cancel",
  scope,
  target,
});
const given = () => ({
  source: "target_version_native_spawned_forage_reader",
  fresh: true,
  readOnly: true,
  saveMutationObserved: false,
  gameplayMutationObserved: false,
  terminalOutcomePresent: false,
  topology: scope.topology,
  scope,
  requestId: "req",
  traceId: "trace",
  revision: 7,
  target,
  inRange: true,
  inventoryCapacityAvailable: true,
  spawnedForagePresent: true,
});
const receipt = () => ({
  requestId: "req",
  traceId: "trace",
  executionId: "exec",
  state: "blocked",
  revision: 7,
  reasonCode: "forage_source_semantic_edge_unestablished",
  phaseTrace: [{ phase: "fresh_observed" }, { phase: "terminal" }],
  scope,
  targetId: target.targetId,
  targetRemovedObserved: false,
  inventoryDelta: 0,
});

test("M3 fixture is non-mutating and cannot supply a target, Debris substitution, or result", async () => {
  const fixture = JSON.parse(
    await readFile(new URL("./stardew-portfolio-m3-forage-fixture.json", import.meta.url), "utf8"),
  );
  assert.equal(verifyM3ForageFixture(fixture), true);
  assert.equal(
    verifyM3ForageFixture({ ...fixture, forbids: fixture.forbids.filter((value) => value !== "inventory_delivery") }),
    false,
  );
});

test("M3 Given accepts only a current spawned-forage native read and rejects Debris or mutation facts", async () => {
  assert.equal((await readM3ForageGiven({ expectedScope: scope, observeNative: async () => given() })).state, "READY");
  assert.equal(
    (
      await readM3ForageGiven({
        expectedScope: scope,
        observeNative: async () => ({ ...given(), target: { ...target, kind: "debris" } }),
      })
    ).state,
    "BLOCKED",
  );
  assert.equal(
    (
      await readM3ForageGiven({
        expectedScope: scope,
        observeNative: async () => ({ ...given(), gameplayMutationObserved: true }),
      })
    ).state,
    "BLOCKED",
  );
});

test("M3 When binds the exact selector target and rejects stale or capacity-invalid requests", async () => {
  const observed = await readM3ForageGiven({ expectedScope: scope, observeNative: async () => given() });
  assert.equal(verifyM3ForageWhen({ request, given: observed, expectedScope: scope }).state, "READY");
  assert.equal(
    verifyM3ForageWhen({
      request: { ...request, target: { ...target, selectorId: "other" } },
      given: observed,
      expectedScope: scope,
    }).state,
    "BLOCKED",
  );
  assert.equal(
    verifyM3ForageWhen({
      request: { ...request, expectedRevision: 8, target: { ...target, observedRevision: 8 } },
      given: observed,
      expectedScope: scope,
    }).state,
    "BLOCKED",
  );
});

test("M3 Then is a precise fail-closed producer-consumer-verifier handoff, not closure", async () => {
  const result = await runM3ForagePreflight({
    expectedScope: scope,
    observeNative: async () => given(),
    request,
    receipt: receipt(),
  });
  assert.equal(result.state, "BLOCKED");
  assert.equal(result.code, "m3_forage_source_semantic_edge_unestablished");
  assert.equal(result.then.state, "READY");
  const malformed = await runM3ForagePreflight({
    expectedScope: scope,
    observeNative: async () => given(),
    request,
    receipt: { ...receipt(), inventoryDelta: 1 },
  });
  assert.equal(malformed.then.state, "BLOCKED");
});
