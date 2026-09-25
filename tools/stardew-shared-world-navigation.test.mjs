import assert from "node:assert/strict";
import test from "node:test";
import { candidateStandingTiles, ensureActorAtLocation, ensureAdjacentTo, isAdjacent } from "./lib/stardew-shared-world-navigation.mjs";

const CAPABILITIES = ["cancel_active_execution", "inspect_self", "move_to_tile", "travel", "enter_exit", "machine_inspect"];

/** A scripted fake bridge: it applies the exact outcomes the helpers expect. */
function createFake({ start, warps = [], onMove } = {}) {
  const listeners = new Set();
  let revision = 1;
  let location = start.location;
  let tile = { ...start.tile };
  const client = {
    state: {},
    observe: async () => {
      revision += 1;
      const value = snapshot();
      client.state.snapshot = value;
      return value;
    },
    execute: async ({ requestId, action, args }) => {
      const executionId = `exec-${revision}`;
      const accepted = { requestId, executionId, state: "accepted", reasonCode: "accepted", revision };
      publish(accepted);
      if (action === "move_to_tile") {
        const outcome = onMove ? onMove({ location, tile, args }) : { ok: true };
        if (outcome.ok) tile = { x: args.x, y: args.y };
        publish({ ...accepted, state: outcome.ok ? "succeeded" : "rejected", reasonCode: outcome.ok ? "target_reached" : "no_path", revision: ++revision });
      } else if (action === "enter_exit" || action === "travel") {
        const warp = warps.find((candidate) => candidate.sourceX === args.x && candidate.sourceY === args.y);
        if (warp === undefined) {
          publish({ ...accepted, state: "rejected", reasonCode: "warp_not_available", revision: ++revision });
        } else {
          location = warp.targetLocation;
          tile = { x: warp.targetX, y: warp.targetY };
          publish({ ...accepted, state: "succeeded", reasonCode: action === "enter_exit" ? "enter_exit_completed" : "travel_completed", revision: ++revision });
        }
      } else {
        publish({ ...accepted, state: "rejected", reasonCode: "unsupported", revision: ++revision });
      }
      // The real bridge admits the projection that follows a committed action,
      // so the cached snapshot tracks the actor's new placement.
      client.state.snapshot = snapshot();
      return accepted;
    },
    onFact: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  const snapshot = () => ({ revision, location, tile: { ...tile }, actionable: true, activeExecution: null, capabilities: CAPABILITIES, warps, machineTargets: [] });
  const publish = (payload) => {
    for (const listener of listeners) listener({ type: "execution_receipt", payload });
  };
  return client;
}

function sessionOf(client) {
  const receipts = [];
  client.onFact((fact) => {
    if (fact.type === "execution_receipt") receipts.push(fact.payload);
  });
  return { client, receipts };
}

const CABIN = { location: "FarmHouse", tile: { x: 9, y: 9 } };
const CABIN_WARP = { sourceX: 3, sourceY: 12, targetLocation: "Farm", targetX: 25, targetY: 33 };

test("isAdjacent uses Chebyshev distance and rejects malformed tiles", () => {
  assert.equal(isAdjacent({ x: 5, y: 5 }, { x: 5, y: 5 }), true);
  assert.equal(isAdjacent({ x: 5, y: 5 }, { x: 6, y: 6 }), true);
  assert.equal(isAdjacent({ x: 5, y: 5 }, { x: 7, y: 5 }), false);
  assert.equal(isAdjacent({ x: 5 }, { x: 5, y: 5 }), false);
});

test("candidateStandingTiles covers the full Chebyshev-1 neighbourhood, nearest first", () => {
  const tiles = candidateStandingTiles({ x: 4, y: 7 });
  assert.equal(tiles.length, 9);
  assert.deepEqual(tiles[0], { x: 4, y: 7 });
  // The eight neighbours are exactly those within Chebyshev 1.
  assert.deepEqual(
    tiles.map((tile) => `${tile.x},${tile.y}`).slice(1).sort(),
    ["3,6", "3,7", "3,8", "4,6", "4,8", "5,6", "5,7", "5,8"],
  );
});

test("ensureActorAtLocation returns immediately when already in the target location", async () => {
  const session = sessionOf(createFake({ start: { location: "Farm", tile: { x: 4, y: 4 } } }));
  const { snapshot, trace } = await ensureActorAtLocation(session.client, session.receipts, "Farm");
  assert.equal(snapshot.location, "Farm");
  assert.deepEqual(trace, []);
});

test("ensureActorAtLocation follows an advertised warp into the target location", async () => {
  const session = sessionOf(createFake({ start: CABIN, warps: [CABIN_WARP] }));
  const { snapshot, trace } = await ensureActorAtLocation(session.client, session.receipts, "Farm");
  assert.equal(snapshot.location, "Farm");
  assert.deepEqual(snapshot.tile, { x: 25, y: 33 });
  assert.deepEqual(
    trace.map((entry) => entry.step),
    ["move_to_tile", "enter_exit"],
  );
});

test("ensureActorAtLocation fails closed when no route is advertised", async () => {
  const session = sessionOf(createFake({ start: CABIN, warps: [] }));
  await assert.rejects(ensureActorAtLocation(session.client, session.receipts, "Farm"), /no_advertised_route/);
});

test("ensureActorAtLocation fails closed when the warp traversal is rejected", async () => {
  const session = sessionOf(createFake({ start: CABIN, warps: [CABIN_WARP], onMove: ({ location }) => (location === CABIN.location ? { ok: false } : { ok: true }) }));
  await assert.rejects(ensureActorAtLocation(session.client, session.receipts, "Farm"), /warp_traversal_failed/);
});

test("ensureAdjacentTo crosses locations then walks to a neighbour of the target", async () => {
  const session = sessionOf(createFake({ start: CABIN, warps: [CABIN_WARP] }));
  const { snapshot, trace } = await ensureAdjacentTo(session.client, session.receipts, { location: "Farm", tile: { x: 30, y: 40 } });
  assert.equal(snapshot.location, "Farm");
  assert.equal(isAdjacent(snapshot.tile, { x: 30, y: 40 }), true);
  assert.deepEqual(
    trace.map((entry) => entry.step),
    ["move_to_tile", "enter_exit", "move_to_tile"],
  );
});

test("ensureAdjacentTo skips the walk when the arrival tile is already adjacent", async () => {
  const session = sessionOf(createFake({ start: { location: "Farm", tile: { x: 31, y: 40 } } }));
  const { snapshot, trace } = await ensureAdjacentTo(session.client, session.receipts, { location: "Farm", tile: { x: 30, y: 40 } });
  assert.deepEqual(snapshot.tile, { x: 31, y: 40 });
  assert.deepEqual(trace, []);
});

test("ensureAdjacentTo fails closed when no adjacent tile is reachable", async () => {
  const session = sessionOf(createFake({ start: { location: "Farm", tile: { x: 4, y: 4 } }, onMove: () => ({ ok: false }) }));
  await assert.rejects(ensureAdjacentTo(session.client, session.receipts, { location: "Farm", tile: { x: 30, y: 40 } }), /no_reachable_adjacent_tile/);
});

test("ensureAdjacentTo rejects a malformed target instead of guessing", async () => {
  const session = sessionOf(createFake({ start: { location: "Farm", tile: { x: 4, y: 4 } } }));
  await assert.rejects(ensureAdjacentTo(session.client, session.receipts, { location: "Farm", tile: { x: 1.5, y: 2 } }), /invalid_target_tile/);
  await assert.rejects(ensureAdjacentTo(session.client, session.receipts, { tile: { x: 1, y: 2 } }), /invalid_target_location/);
});

/**
 * A native transition admits one revision and then clears its placeholder, so
 * later equal-revision observations are refused even though only a passive field
 * such as `CanMove` changed. Locomotion must still complete using that admitted
 * projection instead of deadlocking on a snapshot the bridge will never re-admit.
 */
test("locomotion completes when the post-transition revision can no longer be re-admitted", async () => {
  const session = sessionOf(createFake({ start: { location: "Farm", tile: { x: 4, y: 4 } } }));
  const base = session.client.observe;
  let reads = 0;
  session.client.observe = async () => {
    reads += 1;
    // Mirror the bridge: the reads up to the transition are admitted, then every
    // later equal-revision read is refused while the projection stays valid.
    if (reads > 2) throw new Error("observe_snapshot_not_admitted");
    return await base();
  };
  const { snapshot, trace } = await ensureAdjacentTo(session.client, session.receipts, { location: "Farm", tile: { x: 14, y: 14 } });
  assert.equal(isAdjacent(snapshot.tile, { x: 14, y: 14 }), true);
  assert.deepEqual(
    trace.map((entry) => entry.step),
    ["move_to_tile"],
  );
});

test("locomotion still fails closed when no placement projection was ever admitted", async () => {
  const session = sessionOf(createFake({ start: { location: "Farm", tile: { x: 4, y: 4 } } }));
  session.client.observe = async () => {
    throw new Error("observe_snapshot_not_admitted");
  };
  session.client.state.snapshot = { location: "unknown", tile: { x: 0, y: 0 }, actionable: false, revision: 0 };
  const original = session.client.execute;
  session.client.execute = original;
  await assert.rejects(
    ensureAdjacentTo(session.client, session.receipts, { location: "Farm", tile: { x: 5, y: 4 } }, { timeoutMs: 400 }),
    /native_fresh_snapshot_timeout/,
  );
});
