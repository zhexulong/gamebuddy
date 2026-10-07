import assert from "node:assert/strict";
import test from "node:test";

import { runUseWarpItemSmoke } from "./run-stardew-native-local-player-use-warp-item-smoke.mjs";

const ACTION = "use_warp_item";
const TOTEM = {
  slot: 1,
  qualifiedItemId: "(O)689",
  displayName: "Warp Totem: Mountains",
  stack: 1,
  destination: "Mountain",
  destinationX: 31,
  destinationY: 20,
};

/**
 * The Mod's own discovery projection: one owned warp totem whose destination is another
 * location (so the native warp is not a no-op), and the actor standing on the Farm.
 */
function snapshotWith({ revision, location = "Farm", totems = [TOTEM] }) {
  return {
    revision,
    location,
    tile: { x: 5, y: 5 },
    actionable: true,
    activeExecution: null,
    capabilities: ["cancel_active_execution", "inspect_self", ACTION],
    warpItemTargets: totems,
  };
}

function successEvidence({ stackBefore, stackAfter, destination = TOTEM.destination }) {
  return {
    detail:
      `slot=${TOTEM.slot};item=${TOTEM.qualifiedItemId};display_name=${TOTEM.displayName};origin=Farm;origin_tile=5,5;` +
      `destination=${destination};destination_tile=31,20;usable_context=true;native_use_started=true;` +
      `stack_before=${stackBefore};stack_after=${stackAfter};routine_armed=true`,
  };
}

/**
 * A real client in shape: it answers the same calls the harness makes, moves the world the
 * way the native pair would (one unit consumed, then the delayed warp), and refuses the
 * already-consumed slot. The receipt is minted from the live projection, and the world only
 * moves when the request named a slot the world actually holds -- which is the rule under
 * test.
 */
function makeClient({ totems = [TOTEM] } = {}) {
  const receipts = [];
  const client = {
    state: { snapshot: snapshotWith({ revision: 1, totems }) },
    observe: async () => client.state.snapshot,
    execute: async (request) => {
      const live = client.state.snapshot.warpItemTargets[0] ?? null;
      const accepted = {
        requestId: request.requestId,
        executionId: live ? "use-warp-item-execution" : "use-warp-item-refused",
        state: "accepted",
        reasonCode: "accepted",
        revision: client.state.snapshot.revision,
        // The dispatch facts ride the DISPATCH receipt, which is what the real Mod emits
        // (farmhandexecutioncontroller.itemtileactions.cs:373-378).
        evidence: live ? successEvidence({ stackBefore: live.stack, stackAfter: live.stack - 1 }) : undefined,
      };
      const terminal = live
        ? {
            requestId: request.requestId,
            executionId: accepted.executionId,
            state: "succeeded",
            reasonCode: "warp_item_arrived",
            revision: client.state.snapshot.revision + 1,
            // The arrival terminal is minted by the SHARED arrival path, so it describes the ARRIVAL.
            evidence: { detail: `expected=${live.destination};actual=${live.destination}` },
          }
        : {
            requestId: request.requestId,
            executionId: accepted.executionId,
            state: "rejected",
            reasonCode: "item_not_owned_in_slot",
            revision: client.state.snapshot.revision + 1,
            evidence: { detail: `slot=${request.args.slot}` },
          };
      if (live) {
        // One unit consumed and the actor moved: the arrival is the postcondition.
        client.state.snapshot = snapshotWith({
          revision: terminal.revision,
          location: live.destination,
          totems: live.stack > 1 ? [{ ...live, stack: live.stack - 1 }] : [],
        });
      }
      receipts.push(terminal);
      return accepted;
    },
  };
  return { client, receipts };
}

const run = (options) => {
  const session = makeClient(options);
  return {
    ...session,
    result: () => runUseWarpItemSmoke(session.client, session.receipts, {}, { terminalTimeoutMs: 1_000, arrivalTimeoutMs: 1_000 }),
  };
};

test("use_warp_item: the arrival is asserted from the world and the native unit is consumed", async () => {
  const session = run();
  const result = await session.result();
  assert.equal(result.state, "passed");
  assert.equal(result.reasonCode, "warp_item_arrived");
  assert.equal(result.arrival.origin, "Farm");
  assert.equal(result.arrival.destination, "Mountain");
  assert.equal(result.evidence.native_use_started, "true");
  assert.equal(result.negative.reasonCode, "item_not_owned_in_slot");
  assert.equal(result.negative.location, "Mountain");
});

test("use_warp_item: a receipt that does not show the unit consumed fails the run", async () => {
  // A green arrival receipt whose stack facts did not move cannot prove the native pair
  // ran; without this the consumption half of the contract is untested.
  const session = run();
  const original = session.client.execute;
  session.client.execute = async (request) => {
    const accepted = await original(request);
    // The stack facts ride the dispatch receipt, so that is where the falsified claim must go.
    if (accepted.state === "accepted" && accepted.evidence)
      accepted.evidence = successEvidence({ stackBefore: 1, stackAfter: 1 });
    return accepted;
  };
  const result = await session.result();
  assert.equal(result.state, "blocked");
  assert.match(result.reasonCode, /use_warp_item_stack_not_consumed/);
});

test("use_warp_item: an arrival receipt whose world did not move fails the run", async () => {
  // The receipt claims the warp; the world still has the actor on the origin. A green
  // receipt is not evidence, so this must not pass.
  const session = run();
  const original = session.client.execute;
  session.client.execute = async (request) => {
    const accepted = await original(request);
    session.client.state.snapshot = snapshotWith({ revision: session.client.state.snapshot.revision, location: "Farm", totems: [] });
    return accepted;
  };
  const result = await session.result();
  assert.equal(result.state, "blocked");
  // Either the arrival wait times out or the arrival guard reports the mismatch: both are
  // the same failure, and the run must not pass while the actor is still on the origin.
  assert.match(result.reasonCode, /use_warp_item_world_unchanged|native_fresh_snapshot_timeout/);
});

test("use_warp_item: the consumed slot is refused, and a refusal that moved the world fails the run", async () => {
  const honest = run();
  const honestResult = await honest.result();
  assert.equal(honestResult.state, "passed");

  const moved = run();
  const original = moved.client.execute;
  moved.client.execute = async (request) => {
    const accepted = await original(request);
    const terminal = moved.receipts.at(-1);
    if (terminal.state === "rejected") {
      moved.client.state.snapshot = snapshotWith({
        revision: terminal.revision,
        location: "Desert",
        totems: [],
      });
    }
    return accepted;
  };
  const movedResult = await moved.result();
  assert.equal(movedResult.state, "blocked");
  assert.match(movedResult.reasonCode, /use_warp_item_refusal_moved_world/);
});

test("use_warp_item: the second activation on the SAME slot must not report a second arrival", async () => {
  // A forged success on the consumed slot is the failure this pins: without it the
  // runner's refusal check could be satisfied by any terminal.
  const session = run();
  const original = session.client.execute;
  session.client.execute = async (request) => {
    const accepted = await original(request);
    const terminal = session.receipts.at(-1);
    if (terminal.state === "rejected") {
      terminal.state = "succeeded";
      terminal.reasonCode = "warp_item_arrived";
    }
    return accepted;
  };
  const result = await session.result();
  assert.equal(result.state, "blocked");
  assert.match(result.reasonCode, /use_warp_item_consumed_totem_not_refused/);
});

test("use_warp_item: a totem whose destination is the current location is not the declared Given", async () => {
  const session = run({ totems: [{ ...TOTEM, destination: "Farm" }] });
  const result = await session.result();
  assert.equal(result.state, "blocked");
  assert.match(result.reasonCode, /use_warp_item_declared_given_absent/);
});

test("use_warp_item: evidence that omits the destination fails the run", async () => {
  const session = run();
  const original = session.client.execute;
  session.client.execute = async (request) => {
    const accepted = await original(request);
    if (accepted.state === "accepted" && accepted.evidence)
      accepted.evidence = { detail: `slot=1;item=(O)689;native_use_started=true;stack_before=1;stack_after=0` };
    return accepted;
  };
  const result = await session.result();
  assert.equal(result.state, "blocked");
  assert.match(result.reasonCode, /use_warp_item_evidence_destination/);
});

test("use_warp_item: no advertised totem is not the declared Given", async () => {
  const session = run({ totems: [] });
  const result = await session.result();
  assert.equal(result.state, "blocked");
  assert.equal(result.reasonCode, "use_warp_item_no_advertised_totem");
});
