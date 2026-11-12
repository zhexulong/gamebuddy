import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { connectNativeLocalClient, publishedActionRegistrations } from "./lib/stardew-native-smoke-harness-v1.mjs";
import { enterExitMode, runEnterExitSmoke } from "./run-stardew-native-local-player-enter-exit-smoke.mjs";

const CAPABILITIES = ["cancel_active_execution", "enter_exit", "inspect_self", "move_to_tile"];
const FARM_DOOR = { sourceX: 1, sourceY: 2, targetLocation: "Farm", targetX: 3, targetY: 4 };
// The gated door the second phase proves: the fixture Farm's Greenhouse human
// door refuses without ccPantry (GreenhouseBuilding.OnUseHumanDoor), so
// enter_exit must come back rejected/door_gate_refused instead of entering.
const GATED_DOOR = { sourceX: 7, sourceY: 8, targetLocation: "Greenhouse", targetX: 10, targetY: 23 };

// The warp-table shape `round19` measured: a source tile the snapshot publishes in `warps` and the door table does
// not own. Deliberately NOT the live fixture's coordinates - a slice that only passes on `Farm(41,65)` tests the
// fixture, not the rule.
const EDGE_WARP = { sourceX: 5, sourceY: 9, targetLocation: "Forest", targetX: 12, targetY: 30, accessible: true };

function fixtureConfig(overrides = {}) {
  return {
    SaveId: "save",
    WorldId: "world",
    PlayerId: "player",
    CompanionId: "companion",
    PipeName: "pipe",
    BridgeToken: "token",
    NativeLocalPlayerFixture: { Enable: true },
    Portfolio: { Enable: false },
    HostAutomation: { Enable: false },
    HostFarmhandProvisioning: { Enable: false },
    FarmhandProvisioner: { Enable: false },
    ...overrides,
  };
}

function doorSnapshot(location, tile, revision, capabilities = CAPABILITIES, warps = []) {
  return {
    revision,
    location,
    tile,
    actionable: true,
    activeExecution: null,
    capabilities,
    // The Greenhouse door only exists on the Farm, exactly like production
    // discovery: a FarmHouse snapshot advertises the Farm exit only.
    doorTargets: location === "Farm" ? [GATED_DOOR] : [FARM_DOOR],
    warps,
  };
}

function createFake({
  tile: initialTile = { x: 2, y: 2 },
  capabilities = CAPABILITIES,
  gateBypassed = false,
  gateTeleports = false,
  gateState = "rejected",
} = {}) {
  const listeners = new Set();
  let revision = 7;
  let location = "FarmHouse";
  let tile = initialTile;
  const snapshotOf = () => doorSnapshot(location, tile, revision, capabilities);
  const publish = (payload) => {
    for (const listener of listeners) listener({ type: "execution_receipt", payload });
  };
  const client = {
    state: { catalogRegistrations: publishedActionRegistrations(), snapshot: snapshotOf() },
    observe: async () => {
      const snapshot = snapshotOf();
      client.state.snapshot = snapshot;
      return snapshot;
    },
    execute: async ({ requestId, action, args }) => {
      const executionId = `execution-${action}`;
      const accepted = { requestId, executionId, state: "accepted", reasonCode: "accepted", revision };
      if (action === "move_to_tile") {
        revision += 1;
        publish({ ...accepted, state: "succeeded", reasonCode: "target_reached", revision });
        tile = { x: args.x, y: args.y };
        return accepted;
      }
      if (action === "enter_exit") {
        revision += 1;
        // The gated Greenhouse door refuses without ccPantry: the actor stays on
        // the Farm and the game draws its own locked-door dialogue, which the
        // Mod closes before reporting.
        if (args.x === GATED_DOOR.sourceX && args.y === GATED_DOOR.sourceY) {
          // `gateBypassed` models the defect this phase exists to catch: an
          // enter_exit that walks a locked door through anyway and reports
          // success. The runner must refuse to call that a pass.
          if (gateBypassed) publish({ ...accepted, state: "succeeded", reasonCode: "enter_exit_completed", revision });
          else publish({ ...accepted, state: gateState, reasonCode: "door_gate_refused", revision });
          // `gateTeleports` models a refusal that moved the actor anyway.
          if (gateTeleports) {
            location = GATED_DOOR.targetLocation;
            tile = { x: GATED_DOOR.targetX, y: GATED_DOOR.targetY };
          }
          return accepted;
        }
        // Stale facts that share only one identity field must never satisfy
        // the terminal wait; the runner may only accept the exact pair, so any
        // single-field correlation would fail on these non-completing decoys.
        publish({
          ...accepted,
          executionId: "decoy-execution",
          state: "succeeded",
          reasonCode: "decoy_wrong_execution",
          revision,
        });
        publish({
          ...accepted,
          requestId: "decoy-request",
          state: "succeeded",
          reasonCode: "decoy_wrong_request",
          revision,
        });
        publish({ ...accepted, state: "succeeded", reasonCode: "enter_exit_completed", revision });
        client.enterExitRequestId = requestId;
        location = "Farm";
        tile = { x: 3, y: 4 };
        return accepted;
      }
      throw new Error(`unexpected_action:${action}`);
    },
    onFact: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  return client;
}

function collectReceipts(client) {
  const receipts = [];
  client.onFact((fact) => {
    if (fact.type === "execution_receipt") receipts.push(fact.payload);
  });
  return receipts;
}

/**
 * A location whose only transitions live in the WARP table.
 *
 * This is the shape `round19` met: the snapshot publishes `warps`, the door table holds nothing at that tile (or
 * nothing at all), and `enter_exit` must still resolve it. `doorTargets` is empty by default because a location with
 * one edge warp legitimately advertises no door target - the door mode's own precondition would fail here.
 */
function createWarpFake({
  tile: initialTile = { x: 20, y: 20 },
  warps = [EDGE_WARP],
  doorTargets = [],
  warpOutcome = "completed",
} = {}) {
  const listeners = new Set();
  let revision = 7;
  let location = "Farm";
  let tile = initialTile;
  const snapshotOf = () => doorSnapshot(location, tile, revision, CAPABILITIES, warps);
  const snapshotWithDoors = () => ({ ...snapshotOf(), doorTargets });
  const publish = (payload) => {
    for (const listener of listeners) listener({ type: "execution_receipt", payload });
  };
  const client = {
    state: { catalogRegistrations: publishedActionRegistrations(), snapshot: snapshotWithDoors() },
    observe: async () => {
      const snapshot = snapshotWithDoors();
      client.state.snapshot = snapshot;
      return snapshot;
    },
    execute: async ({ requestId, action, args }) => {
      const executionId = `execution-${action}`;
      const accepted = { requestId, executionId, state: "accepted", reasonCode: "accepted", revision };
      if (action === "move_to_tile") {
        revision += 1;
        tile = { x: args.x, y: args.y };
        publish({
          ...accepted,
          state: "succeeded",
          reasonCode: "target_reached",
          revision,
          evidence: { detail: `target=${args.x},${args.y}` },
        });
        return accepted;
      }
      if (action === "enter_exit") {
        revision += 1;
        // The Mod resolves the tile the CALLER named, so the fake must too: publishing `warps[0]` regardless of the
        // request would make every selection rule indistinguishable.
        const resolved = warps.find((warp) => warp.sourceX === args.x && warp.sourceY === args.y) ?? null;
        // `door_not_available` is the PRE-widening refusal: the Mod consulted the door table only and the tile lives
        // in the warp table. It is the exact code `round19` produced seven times.
        if (warpOutcome === "door_not_available" || resolved === null) {
          publish({ ...accepted, state: "rejected", reasonCode: "door_not_available", revision });
          return accepted;
        }
        // `stays_put` models the defect this slice exists to catch: a receipt that reports the transition while the
        // body never moved.
        if (warpOutcome === "completed") {
          location = resolved.targetLocation;
          tile = { x: resolved.targetX, y: resolved.targetY };
        }
        const destination = `${resolved.targetLocation}:${resolved.targetX},${resolved.targetY}`;
        publish({
          ...accepted,
          state: "succeeded",
          reasonCode: "enter_exit_completed",
          revision,
          evidence: { detail: `expected=${destination};actual=${destination}` },
        });
        client.enterExitRequestId = requestId;
        return accepted;
      }
      throw new Error(`unexpected_action:${action}`);
    },
    onFact: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  return client;
}

test("enter-exit runner passes when already adjacent to the door source", async () => {
  const client = createFake();
  const receipts = collectReceipts(client);
  const result = await runEnterExitSmoke(client, receipts, fixtureConfig());
  assert.equal(result.state, "passed");
  assert.equal(result.reasonCode, "enter_exit_completed");
  assert.equal(result.receipt.reasonCode, "enter_exit_completed");
  assert.equal(result.before.location, "FarmHouse");
  assert.equal(result.after.location, "Farm");
  assert.deepEqual(result.after.tile, { x: 3, y: 4 });
  // Two phases: the FarmHouse exit completes, then the gated Greenhouse door
  // on the Farm must refuse. The trace therefore carries both legs.
  assert.deepEqual(
    result.trace.map((entry) => entry.action),
    ["enter_exit", "move_to_tile", "enter_exit"],
  );
  assert.equal(result.doorGate.state, "passed");
  assert.equal(result.doorGate.reasonCode, "door_gate_refused");
  assert.equal(result.doorGate.receipt.state, "rejected");
  assert.equal(result.doorGate.after.location, "Farm");
});

test("enter-exit runner moves to the door source before entering", async () => {
  const client = createFake({ tile: { x: 6, y: 6 } });
  const receipts = collectReceipts(client);
  const result = await runEnterExitSmoke(client, receipts, fixtureConfig());
  assert.equal(result.state, "passed");
  assert.equal(result.reasonCode, "enter_exit_completed");
  assert.deepEqual(
    result.trace.map((entry) => entry.action),
    ["move_to_tile", "enter_exit", "move_to_tile", "enter_exit"],
  );
  assert.equal(result.doorGate.reasonCode, "door_gate_refused");
  assert.equal(result.after.location, "Farm");
  assert.deepEqual(result.after.tile, { x: 3, y: 4 });
});

test("enter-exit runner waits for the exact request/execution pair, ignoring identity decoys", async () => {
  const client = createFake();
  const receipts = collectReceipts(client);
  const result = await runEnterExitSmoke(client, receipts, fixtureConfig());
  assert.equal(result.state, "passed");
  assert.equal(result.reasonCode, "enter_exit_completed");
  assert.equal(result.requestId, client.enterExitRequestId);
  assert.equal(result.executionId, "execution-enter_exit");
  const terminalLike = receipts.filter(
    (receipt) => receipt.executionId === "execution-enter_exit" && receipt.state === "succeeded",
  );
  assert.equal(terminalLike.length, 2, "the real terminal and one decoy share the executionId");
});

test("enter-exit runner blocks on a non-isolated capability surface", async () => {
  const client = createFake({ capabilities: ["cancel_active_execution", "inspect_self", "move_to_tile"] });
  const receipts = collectReceipts(client);
  const result = await runEnterExitSmoke(client, receipts, fixtureConfig());
  assert.equal(result.state, "blocked");
  assert.match(result.reasonCode, /native_required_capability_missing/);
  assert.equal(result.trace.length, 0);
  assert.equal(result.doorGate, undefined);
});

test("enter-exit runner rejects a non-isolated topology", async () => {
  const client = createFake();
  await assert.rejects(
    runEnterExitSmoke(client, [], fixtureConfig({ Portfolio: { Enable: true } })),
    (error) => error?.message === "native_local_fixture_topology_not_isolated",
  );
});

test("enter-exit runner drives the shared harness session and tears down exactly once", async () => {
  const fake = {
    ...createFake(),
    connect: async (scope, pipeName, token) => {
      fake.scope = scope;
      fake.pipeName = pipeName;
      fake.token = token;
      return fake;
    },
    close: () => {
      fake.closed += 1;
    },
    closed: 0,
  };
  const config = fixtureConfig();
  const session = await connectNativeLocalClient(config, {
    loadModule: async () => ({ LocalStardewBridgeClient: fake }),
  });
  assert.deepEqual(session.scope, {
    integrationId: "stardew",
    saveId: "save",
    worldId: "world",
    playerId: "player",
    companionId: "companion",
  });
  const result = await runEnterExitSmoke(session.client, session.receipts, config);
  assert.equal(result.state, "passed");
  session.close();
  assert.equal(fake.closed, 1);
});

test("enter-exit runner CLI entry owns exactly one shared-session teardown", async () => {
  const source = await readFile(
    new URL("./run-stardew-native-local-player-enter-exit-smoke.mjs", import.meta.url),
    "utf8",
  );
  // The CLI connects with the TEST loader (the production Host generation is not available in this environment),
  // so the assertion reads the call and its loader, not a literal argument list.
  assert.match(source, /connectNativeLocalClient\(config, \{ loadModule: loadHostTestModule \}\)/);
  assert.match(source, /runEnterExitSmoke\(session\.client, session\.receipts, config, \{ mode \}\)/);
  assert.match(source, /finally \{[\s\S]*?session\.close\(\);/);
  assert.equal((source.match(/session\.close\(\)/g) ?? []).length, 1);
});

test("enter-exit runner refuses to call a walk-through-locked-door a pass", async () => {
  // Negative case for the gate phase. If enter_exit reports success on the
  // gated Greenhouse door -- the defect this whole change prevents -- the run
  // must be blocked, not passed.
  const client = createFake({ gateBypassed: true });
  const receipts = collectReceipts(client);
  const result = await runEnterExitSmoke(client, receipts, fixtureConfig());
  assert.equal(result.doorGate.state, "blocked");
  assert.match(result.doorGate.reasonCode, /^door_gate_unexpected:/);
  assert.match(result.doorGate.reasonCode, /reason=enter_exit_completed/);
  assert.equal(result.state, "blocked");
});

test("enter-exit runner blocks when the gate reports the refusal code without a rejected state", async () => {
  // Third negative case: `door_gate_refused` is only a settled refusal when the
  // terminal state is `rejected`. An `uncertain` receipt carrying the refusal
  // code -- the shape a refusal whose settle could not be confirmed would take --
  // must not be read as a proven gate.
  const client = createFake({ gateState: "uncertain" });
  const receipts = collectReceipts(client);
  const result = await runEnterExitSmoke(client, receipts, fixtureConfig());
  assert.equal(result.doorGate.state, "blocked");
  assert.match(result.doorGate.reasonCode, /state=uncertain/);
  assert.equal(result.state, "blocked");
});

test("enter-exit runner blocks when the gated door moves the actor instead of refusing", async () => {
  // Second negative case: a refusal that still teleported the actor is not a
  // refusal. The gate phase asserts the actor stayed put, so a fake whose gated
  // attempt relocates the actor must be reported blocked.
  const client = createFake({ gateTeleports: true });
  const receipts = collectReceipts(client);
  const result = await runEnterExitSmoke(client, receipts, fixtureConfig());
  assert.equal(result.doorGate.state, "blocked");
  assert.match(result.doorGate.reasonCode, /moved/);
  assert.equal(result.state, "blocked");
});

test("enter-exit warp mode resolves a source tile the door table does not own", async () => {
  // The defect this mode exists for: `round19` published `Farm(41,65)->Forest` in `warps`, the companion stood on the
  // adjacent tile and called `enter_exit(41,65)`, and the Mod refused `door_not_available` seven times over three
  // minutes. The door mode cannot reach this shape at all - its target comes from `doorTargets`.
  const client = createWarpFake({ tile: { x: EDGE_WARP.sourceX, y: EDGE_WARP.sourceY - 1 } });
  const receipts = collectReceipts(client);
  const result = await runEnterExitSmoke(client, receipts, fixtureConfig(), { mode: "warp" });
  assert.equal(result.state, "passed");
  assert.equal(result.reasonCode, "enter_exit_completed");
  assert.equal(result.source.source, `Farm:${EDGE_WARP.sourceX},${EDGE_WARP.sourceY}`);
  assert.equal(result.source.target, `${EDGE_WARP.targetLocation}:${EDGE_WARP.targetX},${EDGE_WARP.targetY}`);
  assert.equal(result.doorTableHoldsSource, false);
  // The world fact, not the receipt: the actor is really in the destination location on the declared tile.
  assert.equal(result.after.location, EDGE_WARP.targetLocation);
  assert.deepEqual(result.after.tile, { x: EDGE_WARP.targetX, y: EDGE_WARP.targetY });
  // No door gate phase runs here: a warp has no click entry, and running the Buildings-layer Action for one would
  // execute whatever Action happened to sit there.
  assert.equal(result.doorGate, undefined);
  assert.deepEqual(
    result.trace.map((entry) => entry.action),
    ["enter_exit"],
  );
});

test("enter-exit warp mode walks to the warp source before entering", async () => {
  const client = createWarpFake({ tile: { x: 20, y: 20 } });
  const receipts = collectReceipts(client);
  const result = await runEnterExitSmoke(client, receipts, fixtureConfig(), { mode: "warp" });
  assert.equal(result.state, "passed");
  assert.deepEqual(
    result.trace.map((entry) => entry.action),
    ["move_to_tile", "enter_exit"],
  );
});

test("enter-exit warp mode picks the nearest usable warp by rule, not by coordinate", async () => {
  // Three warps, and the one nearest the actor is deliberately NEITHER the first nor the last: a slice that took
  // `warps[0]` or a hardcoded coordinate would pick a different one, and only a rule-based selection lands here.
  const near = { sourceX: 4, sourceY: 4, targetLocation: "Forest", targetX: 1, targetY: 1, accessible: true };
  const far = { sourceX: 90, sourceY: 90, targetLocation: "Town", targetX: 2, targetY: 2, accessible: true };
  const client = createWarpFake({ tile: { x: 3, y: 3 }, warps: [far, near] });
  const receipts = collectReceipts(client);
  const result = await runEnterExitSmoke(client, receipts, fixtureConfig(), { mode: "warp" });
  assert.equal(result.state, "passed");
  assert.equal(result.source.source, `Farm:${near.sourceX},${near.sourceY}`);
  assert.equal(result.source.target, `${near.targetLocation}:${near.targetX},${near.targetY}`);
});

test("enter-exit warp mode skips a warp whose published accessible flag is false", async () => {
  // `accessible:false` is the engine's own refusal of that leg, so an unusable exit must not be chosen even when it
  // is nearer. An ABSENT flag means NOT MEASURED and must never be read as unusable - covered by the other cases.
  const blocked = { sourceX: 3, sourceY: 3, targetLocation: "Town", targetX: 2, targetY: 2, accessible: false };
  const usable = { sourceX: 40, sourceY: 40, targetLocation: "Forest", targetX: 1, targetY: 1, accessible: true };
  const client = createWarpFake({ tile: { x: 2, y: 2 }, warps: [blocked, usable] });
  const receipts = collectReceipts(client);
  const result = await runEnterExitSmoke(client, receipts, fixtureConfig(), { mode: "warp" });
  assert.equal(result.state, "passed");
  assert.equal(result.source.source, `Farm:${usable.sourceX},${usable.sourceY}`);
});

test("enter-exit warp mode skips a warp whose target is the location the actor is already in", async () => {
  const selfLoop = { sourceX: 3, sourceY: 3, targetLocation: "Farm", targetX: 2, targetY: 2 };
  const exit = { sourceX: 40, sourceY: 40, targetLocation: "Forest", targetX: 1, targetY: 1 };
  const client = createWarpFake({ tile: { x: 2, y: 2 }, warps: [selfLoop, exit] });
  const receipts = collectReceipts(client);
  const result = await runEnterExitSmoke(client, receipts, fixtureConfig(), { mode: "warp" });
  assert.equal(result.state, "passed");
  assert.equal(result.source.target, "Forest:1,1");
});

test("enter-exit warp mode reports not_exercised when the location has no warp the door table lacks", async () => {
  // The precedent `morning-liveness` set: a slice that could not run must say so by name instead of passing. Here the
  // only warp source is ALSO a door target, so the door mode already covers it and this slice would prove nothing.
  const client = createWarpFake({
    tile: { x: 2, y: 2 },
    warps: [{ sourceX: FARM_DOOR.sourceX, sourceY: FARM_DOOR.sourceY, targetLocation: "Farm", targetX: 3, targetY: 4 }],
    doorTargets: [FARM_DOOR],
  });
  const receipts = collectReceipts(client);
  const result = await runEnterExitSmoke(client, receipts, fixtureConfig(), { mode: "warp" });
  assert.equal(result.state, "not_exercised");
  assert.match(result.reasonCode, /^no_warp_only_source:/);
  // The reason names WHICH filter emptied the set, so a reader is not left guessing.
  assert.match(result.reasonCode, /warps=1/);
  assert.match(result.reasonCode, /notDoorOwned=0/);
  assert.equal(result.trace.length, 0, "not_exercised must send nothing");
});

test("enter-exit warp mode reports not_exercised when the location publishes no warps at all", async () => {
  const client = createWarpFake({ warps: [] });
  const receipts = collectReceipts(client);
  const result = await runEnterExitSmoke(client, receipts, fixtureConfig(), { mode: "warp" });
  assert.equal(result.state, "not_exercised");
  assert.match(result.reasonCode, /warps=0/);
});

test("enter-exit warp mode blocks on the pre-widening door_not_available refusal", async () => {
  // The RED-FIRST case. Before 2026-11-01 `enter_exit` consulted `ResolveDoorWarp` only, so a warp-table tile came
  // back `rejected/door_not_available`. That must never read as a pass: it is the exact three-minute loop.
  const client = createWarpFake({ tile: { x: 20, y: 20 }, warpOutcome: "door_not_available" });
  const receipts = collectReceipts(client);
  const result = await runEnterExitSmoke(client, receipts, fixtureConfig(), { mode: "warp" });
  assert.equal(result.state, "blocked");
  assert.match(result.reasonCode, /enter_exit_warp_failed:rejected\/door_not_available/);
});

test("enter-exit warp mode blocks when the receipt reports the move but the actor stands still", async () => {
  // The shape this repository has paid for: a receipt that says it moved while the body did not. The world fact is
  // asserted independently of the receipt, so this cannot pass.
  const client = createWarpFake({ tile: { x: 20, y: 20 }, warpOutcome: "stays_put" });
  const receipts = collectReceipts(client);
  const result = await runEnterExitSmoke(client, receipts, fixtureConfig(), { mode: "warp" });
  assert.equal(result.state, "blocked");
  assert.match(result.reasonCode, /^enter_exit_warp_postcondition_mismatch:/);
  // The actor walked to the standing tile and stayed there; the receipt claimed Forest(12,30).
  assert.match(result.reasonCode, /location=Farm:Forest/);
  assert.match(result.reasonCode, /tile=5,9:12,30/);
});

test("enter-exit warp mode needs no door target on the snapshot", async () => {
  // A location with one edge warp and no door at all is the ordinary interior case. The door mode's precondition must
  // not be applied to it, or the slice fails for a reason the action cannot fix.
  const client = createWarpFake({ tile: { x: 20, y: 20 }, doorTargets: [] });
  const receipts = collectReceipts(client);
  const result = await runEnterExitSmoke(client, receipts, fixtureConfig(), { mode: "warp" });
  assert.equal(result.state, "passed");
});

test("enter-exit warp mode still requires the isolated fixture topology and the action surface", async () => {
  const client = createWarpFake();
  await assert.rejects(
    runEnterExitSmoke(client, [], fixtureConfig({ Portfolio: { Enable: true } }), { mode: "warp" }),
    (error) => error?.message === "native_local_fixture_topology_not_isolated",
  );
  // The warp slice has its own observation path, so it needs its own proof that the capability gate still runs: a
  // surface without `enter_exit` must fail closed before any request, not after a refused receipt.
  const unadvertised = createWarpFake();
  unadvertised.observe = async () => ({
    ...(await createWarpFake().observe()),
    capabilities: ["cancel_active_execution", "inspect_self", "move_to_tile"],
  });
  const result = await runEnterExitSmoke(unadvertised, collectReceipts(unadvertised), fixtureConfig(), {
    mode: "warp",
  });
  assert.equal(result.state, "blocked");
  assert.match(result.reasonCode, /native_required_capability_missing:enter_exit/);
  assert.equal(result.trace.length, 0);
});

test("enter-exit mode defaults to door and rejects an unknown mode", () => {
  // A flag that is silently ignored runs the WRONG slice while claiming the requested one - a pass proving the wrong
  // thing, which is worse than a failure.
  assert.equal(enterExitMode(["node", "runner.mjs", "--client-config", "c.json"]), "door");
  assert.equal(enterExitMode(["node", "runner.mjs", "--client-config", "c.json", "--mode", "warp"]), "warp");
  assert.equal(enterExitMode(["node", "runner.mjs", "--client-config", "c.json", "--mode=warp"]), "warp");
  assert.throws(
    () => enterExitMode(["node", "runner.mjs", "--mode", "travel"]),
    /native_local_enter_exit_mode_invalid/,
  );
  assert.throws(() => enterExitMode(["node", "runner.mjs", "--mode"]), /native_local_enter_exit_mode_invalid/);
});

test("enter-exit warp mode reports not_exercised on a warp table with no usable source", async () => {
  // A warp with a negative target tile is not a usable exit: `validWarp` rejects it, so the slice has nothing to
  // exercise and says so rather than executing against an impossible destination.
  const client = createWarpFake({
    warps: [{ sourceX: 5, sourceY: 9, targetLocation: "Forest", targetX: -3, targetY: 30 }],
  });
  const receipts = collectReceipts(client);
  const result = await runEnterExitSmoke(client, receipts, fixtureConfig(), { mode: "warp" });
  assert.equal(result.state, "not_exercised");
  assert.match(result.reasonCode, /valid=0/);
});
