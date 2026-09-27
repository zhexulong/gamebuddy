import assert from "node:assert/strict";
import test from "node:test";
import {
  candidateStandingTiles,
  ensureActorAtLocation,
  ensureAdjacentTo,
  ensureAdjacentToFreshTarget,
  isAdjacent,
} from "./lib/stardew-shared-world-navigation.mjs";

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

/**
 * A live target such as a Pet moves between observations. Planning the walk once
 * from a stale tile would leave the actor standing where the target no longer
 * is, so the helper must re-read the target each attempt and walk to the new
 * tile instead of retrying the old one.
 */
test("ensureAdjacentToFreshTarget re-reads a moved target instead of retrying its stale tile", async () => {
  // The first advertised Pet tile is not reachable; the Pet has moved by the
  // next attempt and the helper must plan against the new tile.
  const session = sessionOf(
    createFake({
      start: { location: "Farm", tile: { x: 4, y: 4 } },
      onMove: ({ args }) => ({ ok: Math.max(Math.abs(args.x - 50), Math.abs(args.y - 50)) <= 1 }),
    }),
  );
  const reads = [{ x: 30, y: 40 }, { x: 50, y: 50 }];
  let read = 0;
  const targets = () => [reads[Math.min(read++, reads.length - 1)]];
  const { snapshot, target } = await ensureAdjacentToFreshTarget(session.client, session.receipts, "Farm", targets, {
    attempts: 3,
  });
  assert.deepEqual(target, { x: 50, y: 50 });
  // The contract is standing ON a reported tile, not merely next to one: being
  // one tile away from a tile that is itself one tile from the target leaves the
  // actor two tiles from the target, outside the action's own range. Assert the
  // stronger property so the weaker reading cannot come back.
  assert.deepEqual(snapshot.tile, { x: 50, y: 50 });
  assert.equal(isAdjacent(snapshot.tile, { x: 50, y: 50 }), true);
});

test("ensureAdjacentToFreshTarget fails closed after the attempt budget is exhausted", async () => {
  const session = sessionOf(createFake({ start: { location: "Farm", tile: { x: 4, y: 4 } }, onMove: () => ({ ok: false }) }));
  await assert.rejects(
    ensureAdjacentToFreshTarget(session.client, session.receipts, "Farm", () => [{ x: 30, y: 40 }], { attempts: 2, waitPolls: 0 }),
    /target_tile_unreachable/,
  );
});

test("ensureAdjacentToFreshTarget rejects an empty target set instead of guessing a tile", async () => {
  const session = sessionOf(createFake({ start: { location: "Farm", tile: { x: 4, y: 4 } } }));
  await assert.rejects(
    // waitPolls: 0 -- a target set that is never populated must fail at once, not
    // spend the production wait budget learning that.
    ensureAdjacentToFreshTarget(session.client, session.receipts, "Farm", () => [], { attempts: 1, waitPolls: 0 }),
    /no_usable_target_tile/,
  );
});

test("ensureAdjacentToFreshTarget waits for a moving target to settle instead of failing on first sight", async () => {
  // A Pet wanders and is only reachable while holding still. An empty acceptable
  // set is therefore normal at some instants and must not decide the outcome:
  // the helper should observe again within its bounded budget and act once the
  // target settles. Without the wait the first "moving" observation would end the
  // attempt, making success depend on when the driver happened to look.
  const session = sessionOf(
    createFake({
      start: { location: "Farm", tile: { x: 4, y: 4 } },
      onMove: ({ args }) => ({ ok: Math.max(Math.abs(args.x - 20), Math.abs(args.y - 20)) <= 1 }),
    }),
  );
  const observations = [
    [], // pet mid-wander: nothing acceptable right now
    [], // still moving
    [{ x: 20, y: 20 }], // settled: reachable
  ];
  let read = 0;
  // Bound the wait so the test stays fast; the production default is larger.
  const targets = () => observations[Math.min(read++, observations.length - 1)];
  const { target } = await ensureAdjacentToFreshTarget(session.client, session.receipts, "Farm", targets, {
    attempts: 1,
    waitPolls: 5,
    waitIntervalMs: 1,
  });
  assert.deepEqual(target, { x: 20, y: 20 });
  assert.ok(read >= 3, `expected the helper to observe again while the target moved (observed ${read} times)`);
});
