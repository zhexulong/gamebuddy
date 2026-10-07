import assert from "node:assert/strict";
import test from "node:test";
import { parseEvidence, runDismountTransportSmoke } from "./run-stardew-native-local-player-dismount-transport-smoke.mjs";

const ACTION = "dismount_transport";
const CAPABILITIES = ["cancel_active_execution", "inspect_self", ACTION];
const HORSE_ID = "6f1a0f4e-9d1e-4a5f-8a3f-42b25b0c4a11";
const DISMOUNTED_EVIDENCE =
  `horse_id=${HORSE_ID};location=Farm;tile=30,21;riding_before=true;mounting_before=false;riding_after=false;mount_after=false`;

/**
 * The runner is the thing under test, so the fake client is a real one in shape: it answers the
 * same calls the harness makes, and it models the one rule that matters here — the terminal is
 * `void`, so the only authority on "the actor is no longer riding" is the NEXT game-thread read,
 * which is exactly what the repeat submission makes.
 */
function makeClient({ hooks = {} } = {}) {
  const receipts = [];
  const client = {
    state: {
      snapshot: {
        revision: 1,
        location: "Farm",
        tile: { x: 30, y: 21 },
        actionable: true,
        activeExecution: null,
        capabilities: [...CAPABILITIES],
        horseTargets: [],
      },
    },
    observe: async () => client.state.snapshot,
    execute: async (request) => {
      assert.equal(request.action, ACTION);
      assert.deepEqual(request.args, {}, "dismount_transport carries no arguments at all");
      const riding = client.state.snapshot.mount !== false;
      let receipt;
      if (riding && !hooks.firstCallRefuses) {
        receipt = {
          state: "succeeded",
          reasonCode: "transport_dismounted",
          revision: client.state.snapshot.revision + 1,
          evidence: { detail: hooks.successEvidence ?? DISMOUNTED_EVIDENCE },
        };
        client.state.snapshot = {
          ...client.state.snapshot,
          revision: receipt.revision,
          mount: false,
          activeExecution: hooks.busyAfterSuccess ? { executionId: "exec_ghost", state: "accepted" } : null,
        };
      } else {
        const reasonCode = hooks.repeatReasonCode ?? "dismount_transport_not_riding";
        receipt = {
          state: hooks.repeatSucceeds ? "succeeded" : "rejected",
          reasonCode: hooks.repeatSucceeds ? "transport_dismounted" : reasonCode,
          revision: client.state.snapshot.revision + 1,
          evidence: { detail: DISMOUNTED_EVIDENCE },
        };
        client.state.snapshot = { ...client.state.snapshot, revision: receipt.revision };
      }
      const pushed = { ...receipt, requestId: request.requestId, executionId: `exec_${ACTION}` };
      receipts.push(pushed);
      return pushed;
    },
  };
  return { client, receipts };
}

const run = (options = {}) => {
  const session = makeClient(options);
  return {
    ...session,
    result: () => runDismountTransportSmoke(session.client, session.receipts, {}, { terminalTimeoutMs: 1_000 }),
  };
};

test("dismount_transport: the terminal is asserted, and the world refuses a second dismount", async () => {
  const session = run();
  const result = await session.result();
  assert.equal(result.state, "passed");
  assert.equal(result.reasonCode, "transport_dismounted");
  assert.equal(result.horseId, HORSE_ID);
  assert.deepEqual(result.riding, { before: "true", after: "false", mountAfter: "false" });
  assert.equal(result.repeat.reasonCode, "dismount_transport_not_riding");
  assert.equal(result.repeat.state, "rejected");
});

test("dismount_transport: a repeat that still reports a dismount fails the run", async () => {
  // The world already has no mount, so a second success means the first receipt was not about the
  // world: the run must fail rather than accept it.
  const session = run({ hooks: { repeatSucceeds: true } });
  const result = await session.result();
  assert.equal(result.state, "blocked");
  assert.match(result.reasonCode, /dismount_transport_repeat_still_riding/);
});

test("dismount_transport: a repeat refused for another reason fails the run", async () => {
  const session = run({ hooks: { repeatReasonCode: "dismount_transport_rider_mismatch" } });
  const result = await session.result();
  assert.equal(result.state, "blocked");
  assert.match(result.reasonCode, /dismount_transport_repeat_not_refused/);
});

test("dismount_transport: an actor who was not riding is the declared Given absent", async () => {
  const session = run({ hooks: { firstCallRefuses: true } });
  const result = await session.result();
  assert.equal(result.state, "blocked");
  assert.match(result.reasonCode, /dismount_transport_declared_given_absent/);
});

test("dismount_transport: a claimed dismount that left the actor with a live execution fails the run", async () => {
  const session = run({ hooks: { busyAfterSuccess: true } });
  const result = await session.result();
  assert.equal(result.state, "blocked");
  assert.match(result.reasonCode, /dismount_transport_world_still_busy/);
});

test("dismount_transport: evidence that still reports a mount fails the run", async () => {
  // `Horse.dismount` is void, so the evidence IS the observation. An evidence string that still
  // says the actor is riding must not pass, however green the receipt state is.
  const session = run({
    hooks: {
      successEvidence:
        `horse_id=${HORSE_ID};location=Farm;tile=30,21;riding_before=true;mounting_before=false;riding_after=false;mount_after=true`,
    },
  });
  const result = await session.result();
  assert.equal(result.state, "blocked");
  assert.match(result.reasonCode, /dismount_transport_evidence_mount_after/);
});

test("dismount_transport: evidence that omits the observed mount fails the run", async () => {
  const session = run({
    hooks: { successEvidence: `horse_id=${HORSE_ID};location=Farm;tile=30,21;riding_before=true;riding_after=false` },
  });
  const result = await session.result();
  assert.equal(result.state, "blocked");
  assert.match(result.reasonCode, /dismount_transport_evidence_mount_after/);
});

test("dismount_transport: the evidence the runner asserts is the Mod's own key set", () => {
  const evidence = parseEvidence({ detail: DISMOUNTED_EVIDENCE });
  assert.equal(evidence.riding_before, "true");
  assert.equal(evidence.riding_after, "false");
  assert.equal(evidence.mount_after, "false");
  assert.equal(evidence.horse_id, HORSE_ID);
  // Empty evidence is not an observation, and the runner says so rather than asserting on NaN.
  assert.throws(() => parseEvidence({ detail: "" }), /native_local_evidence_empty/);
});
