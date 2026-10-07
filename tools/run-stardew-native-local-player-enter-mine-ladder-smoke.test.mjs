import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { connectNativeLocalClient } from "./lib/stardew-native-smoke-harness-v1.mjs";
import {
  assertEnterMineLadderPostconditions,
  runEnterMineLadderSmoke,
} from "./run-stardew-native-local-player-enter-mine-ladder-smoke.mjs";

const SCENARIO = "native_mine_enter_ladder_v1";
const CAPABILITIES = ["cancel_active_execution", "enter_mine", "inspect_self", "move_to_tile"];
const ORIGIN_LEVEL = 1;
const ORIGIN_LOCATION = `UndergroundMine${ORIGIN_LEVEL}`;
const DEEPER_LOCATION = `UndergroundMine${ORIGIN_LEVEL + 1}`;
/** The fixture's ladder: one tile north of the tile the native lifecycle lands the actor on. */
const LADDER = { targetId: "mine_entrance_0123456789abcdef", x: 6, y: 6 };
const STANDING = { x: LADDER.x, y: LADDER.y + 1 };
const ARRIVAL_TILE = { x: 10, y: 4 };

/** The Mod's travel-completion evidence for a mine entry (`CompleteTravelAfterWarp`). */
function descentEvidence(level) {
  return `expected=UndergroundMine${level}:6,6;actual=UndergroundMine${level}:${ARRIVAL_TILE.x},${ARRIVAL_TILE.y};level=${level}`;
}

function levelOf(location) {
  const match = /^UndergroundMine(\d+)$/.exec(location ?? "");
  return match === null ? null : Number.parseInt(match[1], 10);
}

function fixtureConfig(overrides = {}) {
  return {
    SaveId: "save",
    WorldId: "world",
    PlayerId: "player",
    CompanionId: "companion",
    PipeName: "pipe",
    BridgeToken: "token",
    NativeLocalPlayerFixture: { Enable: true, FixtureScenario: SCENARIO },
    Portfolio: { Enable: false },
    HostAutomation: { Enable: false },
    HostFarmhandProvisioning: { Enable: false },
    FarmhandProvisioner: { Enable: false },
    ...overrides,
  };
}

function snapshotWith({ revision, location, tile, targets = [LADDER], capabilities = CAPABILITIES }) {
  return {
    revision,
    location,
    tile,
    actionable: true,
    activeExecution: null,
    capabilities: [...capabilities],
    mineEntranceTargets: targets.map((target) => ({ ...target })),
  };
}

/**
 * A real client in shape: it answers the calls the harness makes and moves the world the
 * way a descending ladder does. The default world is the one the fixture declares (the
 * actor lands beside a live ladder, the descent reaches the next level); every option
 * models one way the run must NOT accept a green-looking result.
 */
function createFake(options = {}) {
  const listeners = new Set();
  let revision = 4;
  let location = options.originLocation ?? ORIGIN_LOCATION;
  let tile = { ...(options.actorTile ?? STANDING) };
  let targets = options.targets ?? [LADDER];
  const capabilities = options.capabilities ?? CAPABILITIES;
  const publish = (payload) => {
    for (const listener of listeners) listener({ type: "execution_receipt", payload });
  };
  const client = {
    state: { snapshot: snapshotWith({ revision, location, tile, targets, capabilities }) },
    observe: async () => {
      const next = snapshotWith({ revision, location, tile, targets, capabilities });
      client.state.snapshot = next;
      return next;
    },
    onFact: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    execute: async ({ requestId, action, args }) => {
      const executionId = `execution-${action}`;
      const accepted = { requestId, executionId, state: "accepted", reasonCode: "accepted", revision };
      if (action === "move_to_tile") {
        revision += 1;
        if (options.moveRejected) {
          const rejected = {
            ...accepted,
            state: "rejected",
            reasonCode: "target_not_reachable",
            revision,
          };
          publish(rejected);
          return rejected;
        }
        tile = { x: args.x, y: args.y };
        publish({ ...accepted, state: "succeeded", reasonCode: "target_reached", revision });
        return accepted;
      }
      if (action !== "enter_mine") throw new Error(`unexpected_action:${action}`);
      assert.equal(args.expectedTargetId, LADDER.targetId);
      assert.equal(args.x, LADDER.x);
      assert.equal(args.y, LADDER.y);

      revision += 1;
      const originLevel = levelOf(location);
      const terminal = {
        ...accepted,
        state: options.terminalState ?? "succeeded",
        reasonCode: options.reasonCode ?? "mine_entered",
        revision,
        evidence: {
          detail: options.terminalEvidence ?? descentEvidence(originLevel + 1),
        },
      };
      // The world moves BEFORE the terminal is readable, exactly like the native warp:
      // the receipt's revision is the revision of the observation that shows the new
      // location.
      if (options.arrivalLocation !== "unchanged") {
        location = options.arrivalLocation ?? `UndergroundMine${originLevel + 1}`;
        tile = { ...ARRIVAL_TILE };
        targets = options.arrivalTargets ?? [LADDER];
      }
      if (!options.immediateTerminal) publish(terminal);
      return options.immediateTerminal
        ? terminal
        : { ...accepted, reasonCode: "mine_entry_pending", revision, evidence: { detail: "level=unused" } };
    },
  };
  return client;
}

function run(options = {}, config = fixtureConfig(), timeouts = {}) {
  const client = createFake(options);
  const receipts = [];
  client.onFact((fact) => {
    if (fact.type === "execution_receipt") receipts.push(fact.payload);
  });
  return runEnterMineLadderSmoke(client, receipts, config, {
    settleTimeoutMs: 250,
    moveTimeoutMs: 500,
    ladderTimeoutMs: 500,
    ...timeouts,
  });
}

test("enter_mine ladder: the descent is proven from the world, not the receipt", async () => {
  const result = await run();
  assert.equal(result.state, "passed");
  assert.equal(result.reasonCode, "mine_entered");
  assert.equal(result.ladder.targetId, LADDER.targetId);
  assert.equal(result.beforeLocation, ORIGIN_LOCATION);
  assert.equal(result.beforeLevel, ORIGIN_LEVEL);
  assert.equal(result.expectedLevel, ORIGIN_LEVEL + 1);
  assert.equal(result.afterLocation, DEEPER_LOCATION);
  assert.equal(result.afterLevel, ORIGIN_LEVEL + 1);
  assert.equal(result.terminalLevel, ORIGIN_LEVEL + 1);
  assert.equal(result.standing, `${STANDING.x},${STANDING.y}`);
  assert.deepEqual(
    result.trace.filter((entry) => entry.phase !== "terminal").map((entry) => entry.action),
    ["move_to_tile", "enter_mine"],
  );
  assert.deepEqual(
    result.trace.filter((entry) => entry.phase === "terminal").map((entry) => entry.reasonCode),
    ["mine_entered"],
  );
});

test("enter_mine ladder: an immediate terminal is a legal answer", async () => {
  // The Mod answers with a terminal directly when the native work resolves in the same
  // call. Demanding `accepted` first fails a correct run, which is the shape that has
  // now bitten three runners.
  const result = await run({ immediateTerminal: true });
  assert.equal(result.state, "passed");
  assert.equal(result.afterLevel, ORIGIN_LEVEL + 1);
});

test("enter_mine ladder: an actor away from the ladder walks to it", async () => {
  // The fixture places the ladder beside the tile the native lifecycle lands the actor
  // on, so this is the other branch of the same contract: the actor is NOT already in
  // range and the runner must reach the ladder's neighbourhood with a real move.
  const result = await run({ actorTile: { x: 12, y: 20 } });
  assert.equal(result.state, "passed");
  const move = result.trace.find((entry) => entry.action === "move_to_tile");
  assert.deepEqual(move.args, STANDING);
  assert.equal(result.standing, `${STANDING.x},${STANDING.y}`);
});

test("enter_mine ladder: a move that never reaches the ladder fails the run", async () => {
  const result = await run({ actorTile: { x: 12, y: 20 }, moveRejected: true });
  assert.equal(result.state, "blocked");
  assert.match(result.reasonCode, /^enter_mine_ladder_move_failed:rejected\/target_not_reachable/);
});

test("enter_mine ladder: a receipt that did not move the world fails the run", async () => {
  // The load-bearing negative: the terminal says mine_entered and the actor is still on
  // the origin level. That must never read as a pass.
  const result = await run({ arrivalLocation: "unchanged" });
  assert.equal(result.state, "blocked");
  assert.match(result.reasonCode, /^enter_mine_ladder_descent_level_mismatch:1!=2/);
});

test("enter_mine ladder: the expected descent is derived from the observed origin level", async () => {
  // Nothing is hard-coded: from level 3 the contract expects level 4, and the receipt
  // and the world agree on 4.
  const result = await run({ originLocation: "UndergroundMine3" });
  assert.equal(result.state, "passed");
  assert.equal(result.beforeLevel, 3);
  assert.equal(result.expectedLevel, 4);
  assert.equal(result.afterLocation, "UndergroundMine4");
  assert.equal(result.terminalLevel, 4);
});

test("enter_mine ladder: a terminal that names another level fails the run", async () => {
  const result = await run({
    terminalEvidence: `expected=${DEEPER_LOCATION}:6,6;actual=${DEEPER_LOCATION}:10,4;level=5`,
  });
  assert.equal(result.state, "blocked");
  assert.match(result.reasonCode, /^enter_mine_ladder_terminal_level_mismatch:5!=2/);
});

test("enter_mine ladder: the entrance branch's refusal is not a descent", async () => {
  // `mine_entrance_target_unavailable` is the other branch's code and says the request
  // never named a live ladder tile; accepting it would let the ladder path go unproven.
  const result = await run({ terminalState: "rejected", reasonCode: "mine_entrance_target_unavailable" });
  assert.equal(result.state, "blocked");
  assert.match(result.reasonCode, /^enter_mine_ladder_terminal_mismatch:rejected\/mine_entrance_target_unavailable/);
});

test("enter_mine ladder: an uncertain descent is not a success", async () => {
  const result = await run({ terminalState: "uncertain", reasonCode: "mine_entry_postcondition_mismatch" });
  assert.equal(result.state, "blocked");
  assert.match(result.reasonCode, /^enter_mine_ladder_terminal_mismatch:uncertain/);
});

test("enter_mine ladder: a partially succeeded descent is not a success", async () => {
  const result = await run({ terminalState: "partially_succeeded" });
  assert.equal(result.state, "blocked");
  assert.match(result.reasonCode, /^enter_mine_ladder_terminal_mismatch:partially_succeeded/);
});

test("enter_mine ladder: the descent level is required in the evidence", async () => {
  const result = await run({ terminalEvidence: `actual=${DEEPER_LOCATION}:10,4` });
  assert.equal(result.state, "blocked");
  assert.match(result.reasonCode, /^enter_mine_ladder_terminal_level_missing/);
});

test("enter_mine ladder: a level with no ladder target cannot be requested", async () => {
  const result = await run({ targets: [] });
  assert.equal(result.state, "blocked");
  assert.equal(result.reasonCode, "enter_mine_ladder_target_missing");
});

test("enter_mine ladder: two ladders make the target ambiguous", async () => {
  const result = await run({
    targets: [LADDER, { targetId: "mine_entrance_fedcba9876543210", x: 2, y: 3 }],
  });
  assert.equal(result.state, "blocked");
  assert.equal(result.reasonCode, "enter_mine_ladder_target_ambiguous:2");
});

test("enter_mine ladder: a fixture that never reached a mine shaft is refused", async () => {
  const result = await run({ originLocation: "Farm", actorTile: { x: 1, y: 1 } });
  assert.equal(result.state, "blocked");
  assert.match(result.reasonCode, /^enter_mine_ladder_not_in_mine_shaft:Farm/);
});

test("enter_mine ladder: a surface without the ladder capability fails closed", async () => {
  const result = await run({ capabilities: ["inspect_self"] });
  assert.equal(result.state, "blocked");
  assert.match(result.reasonCode, /native_required_capability_missing/);
  assert.equal(result.trace.length, 0);
});

test("enter_mine ladder: the pass contract rejects each clause it claims", () => {
  const detail = {
    reasonCode: "mine_entered",
    ladder: { targetId: LADDER.targetId, x: LADDER.x, y: LADDER.y },
    standing: `${STANDING.x},${STANDING.y}`,
    beforeLocation: ORIGIN_LOCATION,
    beforeLevel: ORIGIN_LEVEL,
    expectedLevel: ORIGIN_LEVEL + 1,
    afterLocation: DEEPER_LOCATION,
    afterLevel: ORIGIN_LEVEL + 1,
    terminalLevel: ORIGIN_LEVEL + 1,
    trace: [{ action: "enter_mine" }],
  };
  assert.doesNotThrow(() => assertEnterMineLadderPostconditions({ ...detail }));

  assert.throws(
    () => assertEnterMineLadderPostconditions({ ...detail, expectedLevel: ORIGIN_LEVEL + 2 }),
    /enter_mine_ladder_expected_level_not_derived/,
  );
  assert.throws(
    () => assertEnterMineLadderPostconditions({ ...detail, afterLevel: null, afterLocation: ORIGIN_LOCATION }),
    /enter_mine_ladder_arrival_not_observed/,
  );
  assert.throws(
    () => assertEnterMineLadderPostconditions({ ...detail, afterLevel: ORIGIN_LEVEL }),
    /enter_mine_ladder_descent_level_mismatch/,
  );
  assert.throws(
    () => assertEnterMineLadderPostconditions({ ...detail, terminalLevel: 9 }),
    /enter_mine_ladder_terminal_level_mismatch/,
  );
  assert.throws(
    () => assertEnterMineLadderPostconditions({ ...detail, reasonCode: "mine_entry_pending" }),
    /enter_mine_ladder_reason/,
  );
  assert.throws(
    () => assertEnterMineLadderPostconditions({ ...detail, trace: [{ action: "move_to_tile" }] }),
    /enter_mine_ladder_trace/,
  );
});

test("enter_mine ladder: a non-isolated topology or another scenario is rejected", async () => {
  await assert.rejects(
    run({}, fixtureConfig({ Portfolio: { Enable: true } })),
    (error) => error?.message === "native_local_fixture_topology_not_isolated",
  );
  await assert.rejects(
    run({}, fixtureConfig({ NativeLocalPlayerFixture: { Enable: true, FixtureScenario: "native_enter_mine_v1" } })),
    (error) => error?.message === "native_local_fixture_scenario_mismatch:native_enter_mine_v1",
  );
});

test("enter_mine ladder: the shared harness session is driven and torn down exactly once", async () => {
  const fake = createFake();
  fake.connect = async (scope, pipeName, token) => {
    fake.scope = scope;
    fake.pipeName = pipeName;
    fake.token = token;
    return fake;
  };
  fake.closed = 0;
  fake.close = () => {
    fake.closed += 1;
  };
  const config = fixtureConfig();
  const session = await connectNativeLocalClient(config, {
    loadModule: async () => ({ LocalStardewBridgeClient: fake }),
  });
  const result = await runEnterMineLadderSmoke(session.client, session.receipts, config, {
    settleTimeoutMs: 250,
    moveTimeoutMs: 500,
    ladderTimeoutMs: 500,
  });
  assert.equal(result.state, "passed");
  session.close();
  assert.equal(fake.closed, 1);
});

test("enter_mine ladder: the immediate dispatch response may be a terminal, never a required accepted", async () => {
  // The Mod answers with a terminal directly when its native work resolves inside the same
  // call, so the runner accepts that shape BY CONSTRUCTION rather than by relying on the
  // receipt waiter's search list — and it must never demand `accepted` from the response,
  // which is the shape that has bitten three runners.
  const source = await readFile(
    new URL("./run-stardew-native-local-player-enter-mine-ladder-smoke.mjs", import.meta.url),
    "utf8",
  );
  assert.match(source, /TERMINAL_STATES\.has\(dispatched\.state\)/);
  assert.match(source, /TERMINAL_STATES\.has\(move\.state\)/);
  assert.doesNotMatch(source, /state !== "accepted"/);
});

test("enter_mine ladder: the CLI entry owns exactly one shared-session teardown", async () => {
  const source = await readFile(
    new URL("./run-stardew-native-local-player-enter-mine-ladder-smoke.mjs", import.meta.url),
    "utf8",
  );
  assert.match(source, /connectNativeLocalClient\(config, \{ loadModule: loadHostTestModule \}\)/);
  assert.match(source, /runEnterMineLadderSmoke\(session\.client, session\.receipts, config\)/);
  assert.match(source, /finally \{[\s\S]*?session\.close\(\);/);
  assert.equal((source.match(/session\.close\(\)/g) ?? []).length, 1);
});
