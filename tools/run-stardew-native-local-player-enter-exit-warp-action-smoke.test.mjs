import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { connectNativeLocalClient } from "./lib/stardew-native-smoke-harness-v1.mjs";
import { runEnterExitWarpActionSmoke } from "./run-stardew-native-local-player-enter-exit-warp-action-smoke.mjs";

const CAPABILITIES = ["cancel_active_execution", "enter_exit", "inspect_self", "move_to_tile"];
const STANDING = { x: 12, y: 20 };
// The tile the runner must derive: one south of the actor, never a published
// `doorTargets` entry (the door table does not hold the fixture's tile).
const TARGET = { x: STANDING.x, y: STANDING.y + 1 };
const GATE_EVIDENCE = `source=${TARGET.x},${TARGET.y};gate=refused;entry=perform_action;dialogue=Door is locked.`;

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

function snapshotWith({ revision, tile, location = "Farm", capabilities = CAPABILITIES }) {
  return {
    revision,
    location,
    tile,
    actionable: true,
    activeExecution: null,
    capabilities,
    // Deliberately empty: the fixture's tile IS the widening's case and is not a door
    // table member, so production cannot publish a door target for it. A runner that
    // depended on one would fail here rather than on the game.
    doorTargets: [],
  };
}

/**
 * A real client in shape: it answers the calls the harness makes and moves the world the
 * way the two candidate admissions would. The default world is the one the fixture
 * declares (gate refuses, actor stays); every option models one way the run must NOT
 * accept a green-looking result.
 */
function createFake(options = {}) {
  const listeners = new Set();
  let revision = 7;
  let tile = { ...STANDING };
  let location = "Farm";
  const publish = (payload) => {
    for (const listener of listeners) listener({ type: "execution_receipt", payload });
  };
  const client = {
    state: { snapshot: snapshotWith({ revision, tile, location }) },
    observe: async () => {
      const snapshot = snapshotWith({ revision, tile, location });
      client.state.snapshot = snapshot;
      return snapshot;
    },
    execute: async ({ requestId, action, args }) => {
      const executionId = `execution-${action}`;
      const accepted = { requestId, executionId, state: "accepted", reasonCode: "accepted", revision };
      if (action === "move_to_tile") {
        revision += 1;
        tile = { x: args.x, y: args.y };
        publish({ ...accepted, state: "succeeded", reasonCode: "target_reached", revision });
        return accepted;
      }
      if (action === "enter_exit") {
        revision += 1;
        if (options.bypassGate) {
          // The defect the widening closes: the resolver warp taken instead of the
          // gate. The actor really does land in the Community Center.
          publish({ ...accepted, state: "succeeded", reasonCode: "enter_exit_completed", revision });
          location = "CommunityCenter";
          tile = { x: 32, y: 23 };
          return accepted;
        }
        publish({
          ...accepted,
          state: options.terminalState ?? "rejected",
          reasonCode: options.reasonCode ?? "door_gate_refused",
          revision,
          evidence: { detail: options.evidenceDetail ?? GATE_EVIDENCE },
        });
        if (options.movesOnRefusal) {
          location = "CommunityCenter";
          tile = { x: 32, y: 23 };
        }
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

function run(options = {}, config = fixtureConfig()) {
  const client = createFake(options);
  const receipts = [];
  client.onFact((fact) => {
    if (fact.type === "execution_receipt") receipts.push(fact.payload);
  });
  return runEnterExitWarpActionSmoke(client, receipts, config, {
    moveTimeoutMs: 1_000,
    enterExitTimeoutMs: 1_000,
  });
}

test("enter_exit warp action: the gate refusal is proven from the world, not the receipt", async () => {
  const result = await run();
  assert.equal(result.state, "passed");
  assert.equal(result.reasonCode, "door_gate_refused");
  assert.equal(result.location, "Farm");
  assert.equal(result.standing, `${STANDING.x},${STANDING.y}`);
  assert.equal(result.target, `${TARGET.x},${TARGET.y}`);
  // The target is derived from the actor, so the run must not have needed a published
  // door target at all.
  assert.deepEqual(result.before.doorTargets, undefined);
  assert.equal(result.evidence.gate, "refused");
  assert.equal(result.evidence.entry, "perform_action");
  assert.equal(result.evidence.dialogue, "Door is locked.");
  assert.deepEqual(
    result.trace.map((entry) => entry.action),
    ["move_to_tile", "enter_exit"],
  );
  assert.equal(result.after.location, "Farm");
  assert.deepEqual(result.after.tile, STANDING);
});

test("enter_exit warp action: a warp through the gate fails the run", async () => {
  // The load-bearing negative. `getWarpFromDoor` resolves this tile to CommunityCenter,
  // so an admission that fell back to the resolver would report a success and move the
  // actor. That must never read as a pass.
  const result = await run({ bypassGate: true });
  assert.equal(result.state, "blocked");
  assert.match(result.reasonCode, /^enter_exit_warp_action_warped_through_the_gate:succeeded/);
});

test("enter_exit warp action: the pre-widening 'no door here' code is not a gate refusal", async () => {
  // Before the widening this tile reached only the resolver fallback, which refused with
  // `door_not_available` because a single-token action resolves to no warp record. That
  // code says "nothing happened here", not "the game's own gate refused", so accepting it
  // would let the gate go unproven.
  const result = await run({ reasonCode: "door_not_available" });
  assert.equal(result.state, "blocked");
  assert.match(result.reasonCode, /^enter_exit_warp_action_not_gate_refused:rejected\/door_not_available/);
});

test("enter_exit warp action: the neighbouring failure code for an unfolded entry is refused", async () => {
  // `door_transition_not_started` is the Mod's other honest non-warp terminal (the entry
  // ran and did nothing). It is a different fact from a gate refusal and must not pass.
  const result = await run({ reasonCode: "door_transition_not_started" });
  assert.equal(result.state, "blocked");
  assert.match(result.reasonCode, /^enter_exit_warp_action_not_gate_refused/);
});

test("enter_exit warp action: a refusal code on a non-rejected state is not a settled refusal", async () => {
  const result = await run({ terminalState: "uncertain" });
  assert.equal(result.state, "blocked");
  assert.match(result.reasonCode, /^enter_exit_warp_action_not_gate_refused:uncertain\/door_gate_refused/);
});

test("enter_exit warp action: a refusal that still moved the actor fails the run", async () => {
  const result = await run({ movesOnRefusal: true });
  assert.equal(result.state, "blocked");
  assert.match(result.reasonCode, /^enter_exit_warp_action_moved_location:Farm:CommunityCenter/);
});

test("enter_exit warp action: the game's own dialogue is required evidence", async () => {
  // The refusal's evidence must let a reader tell "the gate refused" from "nothing
  // happened": the entry name and the game's dialogue text are that difference.
  const result = await run({
    evidenceDetail: `source=${TARGET.x},${TARGET.y};gate=refused;entry=perform_action`,
  });
  assert.equal(result.state, "blocked");
  assert.match(result.reasonCode, /^enter_exit_warp_action_evidence_dialogue_missing/);
});

test("enter_exit warp action: an entry that merely ran is not a refusal", async () => {
  const result = await run({
    evidenceDetail: `source=${TARGET.x},${TARGET.y};gate=passed;entry=resolved_warp_fallback;dialogue=none`,
  });
  assert.equal(result.state, "blocked");
  assert.match(result.reasonCode, /^enter_exit_warp_action_evidence_gate:passed:refused/);
});

test("enter_exit warp action: the resolver fallback entry is not the native door entry", async () => {
  const result = await run({
    evidenceDetail: `source=${TARGET.x},${TARGET.y};gate=refused;entry=resolved_warp_fallback;dialogue=Door is locked.`,
  });
  assert.equal(result.state, "blocked");
  assert.match(result.reasonCode, /^enter_exit_warp_action_evidence_entry:resolved_warp_fallback:perform_action/);
});

test("enter_exit warp action: a fixture that did not reach the Farm is refused", async () => {
  const client = createFake();
  client.state.snapshot = { ...snapshotWith({ revision: 1, tile: STANDING }), location: "FarmHouse" };
  client.observe = async () => client.state.snapshot;
  const receipts = [];
  client.onFact((fact) => {
    if (fact.type === "execution_receipt") receipts.push(fact.payload);
  });
  const result = await runEnterExitWarpActionSmoke(client, receipts, fixtureConfig(), {
    moveTimeoutMs: 1_000,
    enterExitTimeoutMs: 1_000,
  });
  assert.equal(result.state, "blocked");
  assert.match(result.reasonCode, /^enter_exit_warp_action_not_on_farm:FarmHouse/);
});

test("enter_exit warp action: a surface without enter_exit fails closed", async () => {
  const client = createFake();
  client.state.snapshot = snapshotWith({ revision: 1, tile: STANDING, capabilities: ["inspect_self"] });
  client.observe = async () => client.state.snapshot;
  const receipts = [];
  client.onFact((fact) => {
    if (fact.type === "execution_receipt") receipts.push(fact.payload);
  });
  const result = await runEnterExitWarpActionSmoke(client, receipts, fixtureConfig(), {
    moveTimeoutMs: 1_000,
    enterExitTimeoutMs: 1_000,
  });
  assert.equal(result.state, "blocked");
  assert.match(result.reasonCode, /native_required_capability_missing/);
  assert.equal(result.trace.length, 0);
});

test("enter_exit warp action: a non-isolated topology is rejected", async () => {
  await assert.rejects(
    run({}, fixtureConfig({ Portfolio: { Enable: true } })),
    (error) => error?.message === "native_local_fixture_topology_not_isolated",
  );
});

test("enter_exit warp action: the shared harness session is driven and torn down exactly once", async () => {
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
  const result = await runEnterExitWarpActionSmoke(session.client, session.receipts, config);
  assert.equal(result.state, "passed");
  session.close();
  assert.equal(fake.closed, 1);
});

test("enter_exit warp action: the CLI entry owns exactly one shared-session teardown", async () => {
  const source = await readFile(
    new URL("./run-stardew-native-local-player-enter-exit-warp-action-smoke.mjs", import.meta.url),
    "utf8",
  );
  assert.match(source, /connectNativeLocalClient\(config, \{ loadModule: loadHostTestModule \}\)/);
  assert.match(source, /runEnterExitWarpActionSmoke\(session\.client, session\.receipts, config\)/);
  assert.match(source, /finally \{[\s\S]*?session\.close\(\);/);
  assert.equal((source.match(/session\.close\(\)/g) ?? []).length, 1);
});
