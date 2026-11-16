import assert from "node:assert/strict";
import test from "node:test";
import { publishedActionRegistrations } from "./lib/stardew-native-smoke-harness-v1.mjs";

import {
  assertNameEntityPostconditions,
  runNameEntitySmoke,
} from "./run-stardew-native-local-player-name-entity-smoke.mjs";

/**
 * The name_entity live judgement, tested DIRECTLY (no transport fake).
 *
 * The judgement is pure, so each case below is one way the LIVE run could lie about the stored
 * name: the write never landed, the write landed twice, the receipt names a value the world does
 * not hold, the entity already had a name, the receipt reads the wrong fact, or the surface cannot
 * be read at all.
 */

const REQUESTED = "GameBuddyNamedHorse";

const EVIDENCE = {
  owner_id: "77",
  location: "Farm",
  actor_tile: "64,15",
  horse_tile: "65,15",
  horse_owner_id: "77",
  horse_name: "none",
  horse_id: "0123456789abcdef0123456789abcdef",
  name_before: "none",
  requested: REQUESTED,
  name_after: REQUESTED,
  name_matches_requested: "true",
  player_horse_name_updated: "true",
};

const advertised = (names) =>
  names.map((name, index) => ({ targetId: `horse_00000000000000${index}`, x: 65, y: 15, name }));

test("the honest happy path passes every check", () => {
  const checks = assertNameEntityPostconditions({
    requestedName: REQUESTED,
    evidence: EVIDENCE,
    horseTargets: advertised([REQUESTED]),
  });
  assert.deepEqual(checks, {
    receiptSaysNamed: true,
    storedNameReadBackFromEntity: true,
    advertisedNameAgreesWithReceipt: true,
    evidenceMatchesRequest: true,
  });
});

test("a name the world does not hold fails: the receipt is not the proof", () => {
  const checks = assertNameEntityPostconditions({
    requestedName: REQUESTED,
    evidence: EVIDENCE,
    horseTargets: advertised(["SomeOtherHorse"]),
  });
  assert.equal(checks.storedNameReadBackFromEntity, false);
});

test("the name landing on two entities fails: the write must land exactly once", () => {
  const checks = assertNameEntityPostconditions({
    requestedName: REQUESTED,
    evidence: EVIDENCE,
    horseTargets: advertised([REQUESTED, REQUESTED]),
  });
  assert.equal(checks.storedNameReadBackFromEntity, false);
});

test("a receipt naming a value the world does not report fails", () => {
  const checks = assertNameEntityPostconditions({
    requestedName: REQUESTED,
    evidence: { ...EVIDENCE, name_after: "SomethingElse" },
    horseTargets: advertised([REQUESTED]),
  });
  assert.equal(checks.advertisedNameAgreesWithReceipt, false);
});

test("naming an entity that already had a name fails: that is not a name write", () => {
  const checks = assertNameEntityPostconditions({
    requestedName: REQUESTED,
    evidence: { ...EVIDENCE, name_before: "OldName", horse_name: "OldName" },
    horseTargets: advertised([REQUESTED]),
  });
  assert.equal(checks.receiptSaysNamed, false);
});

test("the entity's own name field must be the fact the receipt claims", () => {
  const checks = assertNameEntityPostconditions({
    requestedName: REQUESTED,
    evidence: { ...EVIDENCE, name_matches_requested: "false" },
    horseTargets: advertised([REQUESTED]),
  });
  assert.equal(checks.evidenceMatchesRequest, false);
});

test("a surface with no horse projection reports not_checked, NEVER a pass", () => {
  // The distinction this test exists for: "I could not look" must not read as "the entity stores
  // the name" - and the runner treats `not_checked` as a failure, so a surface that cannot show
  // horses cannot silently bless a run.
  const checks = assertNameEntityPostconditions({ requestedName: REQUESTED, evidence: EVIDENCE, horseTargets: null });
  assert.equal(checks.storedNameReadBackFromEntity, "not_checked");
  assert.equal(checks.advertisedNameAgreesWithReceipt, "not_checked");
  assert.deepEqual(
    Object.entries(checks)
      .filter(([, ok]) => ok === false || ok === "not_checked")
      .map(([name]) => name),
    ["storedNameReadBackFromEntity", "advertisedNameAgreesWithReceipt"],
    "the run must fail, on exactly these two checks",
  );
});

/**
 * THE RUNNER ITSELF, driven end to end through the shared template.
 *
 * The judgement above is pure, so it cannot see the lifecycle: whether the fixture config is refused, whether the
 * request is sent at all, whether the terminal is matched to the request, and - the half the pure function never
 * judged - whether the STALE RE-SEND is refused and moves nothing. One fake client per case answers the same three
 * calls the harness makes (`observe`, `execute`, and the receipt buffer the terminal wait reads) and moves the world
 * the way the native call would.
 */
const RUNNER_CAPABILITIES = ["cancel_active_execution", "inspect_self", "name_entity"];

function validConfig() {
  return {
    DeniedActions: [],
    DeniedActionFamilies: [],
    ExperimentalActions: [],
    NativeLocalPlayerFixture: {
      Enable: true,
      Bootstrap: { Enable: false },
      FixtureScenario: "native_name_entity_v1",
    },
  };
}

function runnerEvidence(overrides = {}) {
  const fields = {
    location: "Farm",
    actor_tile: "64,15",
    horse_tile: "65,15",
    name_before: "none",
    requested: REQUESTED,
    name_after: REQUESTED,
    name_matches_requested: "true",
    ...overrides,
  };
  return {
    detail: Object.entries(fields)
      .map(([key, value]) => `${key}=${value}`)
      .join(";"),
  };
}

function snapshotNamed(...names) {
  return {
    revision: 1,
    location: "Farm",
    tile: { x: 64, y: 15 },
    actionable: true,
    activeExecution: null,
    capabilities: RUNNER_CAPABILITIES,
    // An UNNAMED horse is never advertised: the projection exists for `mount_transport`, which may only mount a named
    // horse, so the entry appearing at all is the change this action makes.
    horseTargets: advertised(names),
  };
}

/**
 * A fake Mod. The first `name_entity` request succeeds and moves the world to `after`; the second is the stale re-send,
 * answered by `negative`.
 */
function createFakeClient({
  after = snapshotNamed(REQUESTED),
  negative = { state: "rejected", reasonCode: "name_entity_target_already_named" },
  negativeWorld = null,
} = {}) {
  const receipts = [];
  let executions = 0;
  const client = {
    state: { catalogRegistrations: publishedActionRegistrations(), snapshot: snapshotNamed(), latestReceipt: null },
    observe: async () => client.state.snapshot,
    execute: async (request) => {
      executions += 1;
      const current = client.state.snapshot;
      const accepted = {
        requestId: request.requestId,
        executionId: `name-entity-execution-${executions}`,
        state: "accepted",
        reasonCode: "accepted",
        revision: current.revision,
      };
      if (executions === 1) {
        assert.deepEqual(request.args, { text: REQUESTED });
        client.state.snapshot = { ...after, revision: current.revision + 1 };
        receipts.push({
          ...accepted,
          state: "succeeded",
          reasonCode: "entity_named",
          revision: client.state.snapshot.revision,
          evidence: runnerEvidence(),
        });
        return accepted;
      }
      if (negative.state === "rejected") {
        if (negativeWorld !== null) client.state.snapshot = { ...negativeWorld, revision: current.revision + 1 };
        receipts.push({ ...accepted, ...negative, revision: current.revision });
        return accepted;
      }
      client.state.snapshot = { ...current, revision: current.revision + 1 };
      receipts.push({ ...accepted, ...negative, revision: client.state.snapshot.revision });
      return accepted;
    },
  };
  return { client, receipts };
}

test("name-entity runner: an empty config is ignored, exactly as the copy ignored it", async () => {
  const { client, receipts } = createFakeClient();
  const result = await runNameEntitySmoke(client, receipts, {}, { terminalTimeoutMs: 1_000 });
  assert.equal(result.state, "passed");
  assert.equal(result.reasonCode, "entity_named");
});

test("name-entity runner: the name written by the call is read back, and the stale re-send is refused", async () => {
  const { client, receipts } = createFakeClient();
  const result = await runNameEntitySmoke(client, receipts, validConfig(), { terminalTimeoutMs: 1_000 });
  assert.equal(result.state, "passed", result.reasonCode);
  assert.equal(result.reasonCode, "entity_named");
  assert.deepEqual(result.checks, {
    receiptSaysNamed: true,
    storedNameReadBackFromEntity: true,
    advertisedNameAgreesWithReceipt: true,
    evidenceMatchesRequest: true,
  });
  // The stale re-send happened, and its refusal is published rather than hidden in the trace.
  assert.equal(result.negative, "measured:name_entity_target_already_named");
});

test("name-entity runner: a stale re-send that SUCCEEDS fails the run", async () => {
  // THE FALSIFIER FOR THE NEGATIVE ARM. The world looks perfect, the first call is honest, and the second send - the
  // one the native prompt's own gate would have refused - reports success. A runner that only checked the positive
  // receipt would call this a pass.
  const { client, receipts } = createFakeClient({
    negative: { state: "succeeded", reasonCode: "entity_named" },
  });
  const result = await runNameEntitySmoke(client, receipts, validConfig(), { terminalTimeoutMs: 1_000 });
  assert.equal(result.state, "blocked");
  assert.equal(result.reasonCode, "name_entity_negative_not_refused:succeeded/entity_named");
});

test("name-entity runner: a refusal that moved the world fails the run", async () => {
  // "Refused" and "silently renamed" must not read the same: the settled world no longer advertises the stored name.
  const { client, receipts } = createFakeClient({ negativeWorld: snapshotNamed() });
  const result = await runNameEntitySmoke(client, receipts, validConfig(), { terminalTimeoutMs: 1_000 });
  assert.equal(result.state, "blocked");
  assert.equal(
    result.reasonCode,
    "name_entity_negative_moved_world:the name the first call stored is no longer advertised",
  );
});

test("name-entity runner: a world that never stores the name fails the run", async () => {
  const { client, receipts } = createFakeClient({ after: snapshotNamed("SomeOtherHorse") });
  const result = await runNameEntitySmoke(client, receipts, validConfig(), { terminalTimeoutMs: 1_000 });
  assert.equal(result.state, "blocked");
  assert.match(
    result.reasonCode,
    /^name_entity live contract failed: (storedNameReadBackFromEntity|advertisedNameAgreesWithReceipt)/u,
  );
});
