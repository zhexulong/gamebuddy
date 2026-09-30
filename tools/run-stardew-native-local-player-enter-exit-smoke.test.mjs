import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { connectNativeLocalClient } from "./lib/stardew-native-smoke-harness-v1.mjs";
import { runEnterExitSmoke } from "./run-stardew-native-local-player-enter-exit-smoke.mjs";

const CAPABILITIES = ["cancel_active_execution", "enter_exit", "inspect_self", "move_to_tile"];
const FARM_DOOR = { sourceX: 1, sourceY: 2, targetLocation: "Farm", targetX: 3, targetY: 4 };
// The gated door the second phase proves: the fixture Farm's Greenhouse human
// door refuses without ccPantry (GreenhouseBuilding.OnUseHumanDoor), so
// enter_exit must come back rejected/door_gate_refused instead of entering.
const GATED_DOOR = { sourceX: 7, sourceY: 8, targetLocation: "Greenhouse", targetX: 10, targetY: 23 };

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

function doorSnapshot(location, tile, revision, capabilities = CAPABILITIES) {
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
  };
}

function createFake({ tile: initialTile = { x: 2, y: 2 }, capabilities = CAPABILITIES, gateBypassed = false, gateTeleports = false, gateState = "rejected" } = {}) {
  const listeners = new Set();
  let revision = 7;
  let location = "FarmHouse";
  let tile = initialTile;
  const snapshotOf = () => doorSnapshot(location, tile, revision, capabilities);
  const publish = (payload) => {
    for (const listener of listeners) listener({ type: "execution_receipt", payload });
  };
  const client = {
    state: { snapshot: snapshotOf() },
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
          if (gateBypassed)
            publish({ ...accepted, state: "succeeded", reasonCode: "enter_exit_completed", revision });
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
  assert.match(source, /connectNativeLocalClient\(config\)/);
  assert.match(source, /runEnterExitSmoke\(session\.client, session\.receipts, config\)/);
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
