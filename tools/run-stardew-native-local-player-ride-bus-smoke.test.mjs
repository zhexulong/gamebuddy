import assert from "node:assert/strict";
import test from "node:test";
import { assertRideBusPostconditions, parseStrictEvidence, runRideBusSmoke } from "./run-stardew-native-local-player-ride-bus-smoke.mjs";

const SCENARIO = "native_ride_bus_v1";
const CAPABILITIES = ["cancel_active_execution", "inspect_self", "ride_bus"];

const config = {
  SaveId: "save",
  WorldId: "world",
  PlayerId: "player",
  CompanionId: "companion",
  PipeName: "pipe",
  BridgeToken: "token",
  DeniedActions: [],
  DeniedActionFamilies: [],
  ExperimentalActions: [],
  NativeLocalPlayerFixture: {
    Enable: true,
    Bootstrap: { Enable: false },
    FixtureScenario: SCENARIO,
  },
};

const ARRIVED_EVIDENCE =
  "origin=BusStop;destination=Desert;fare=500;money_before=6000;money_after=5500";
// The wire carries evidence as an object; the Mod's string form arrives as
// `{ detail: "..." }`. The fake mirrors that so the tests cannot pass on a shape
// the real bridge never sends (this is exactly how the first live attempt failed).
const asWireEvidence = (text) => ({ detail: text });

function snapshot(revision, location) {
  return {
    revision,
    location,
    tile: { x: 12, y: 11 },
    actionable: true,
    activeExecution: null,
    capabilities: [...CAPABILITIES],
  };
}

/**
 * The Mod's shape is modelled faithfully where it carries the proof: `ride_bus`
 * answers admission immediately with a Running receipt (`bus_departure_started`)
 * because the native cutscene owns the departure, and the durable terminal arrives
 * on a later game update. The runner must therefore prove the terminal, not the
 * timing — and the world, not the receipt, is the authority on the arrival.
 */
function makeClient({ terminalReason = "bus_arrived", evidence = ARRIVED_EVIDENCE, arrival = "Desert" } = {}) {
  let current = snapshot(5, "BusStop");
  const receipts = [];
  const client = {
    state: { snapshot: current },
    observe: async () => current,
    execute: async (request) => {
      assert.equal(request.action, "ride_bus");
      assert.deepEqual(request.args, {});
      const running = {
        requestId: request.requestId,
        executionId: "exec_ride_bus",
        state: "running",
        reasonCode: "bus_departure_started",
        revision: 6,
        evidence: asWireEvidence("origin=BusStop;destination=Desert;fare=500;money_before=6000"),
      };
      receipts.push(running);
      const terminal = {
        requestId: request.requestId,
        executionId: "exec_ride_bus",
        state: terminalReason === "bus_arrived" ? "succeeded" : "uncertain",
        reasonCode: terminalReason,
        revision: 7,
        evidence: asWireEvidence(evidence),
      };
      receipts.push(terminal);
      current = snapshot(7, arrival);
      return running;
    },
  };
  return { client, receipts };
}

test("passes when the native ride reaches the desert and the fare was spent", async () => {
  const { client, receipts } = makeClient();
  const result = await runRideBusSmoke(client, receipts, config, { rideTimeoutMs: 500 });

  assert.equal(result.state, "passed");
  assert.equal(result.reasonCode, "bus_arrived");
  assert.equal(result.origin, "BusStop");
  assert.equal(result.destination, "Desert");
  assert.equal(result.fare, 500);
  assert.equal(result.moneyBefore, 6000);
  assert.equal(result.moneyAfter, 5500);
  assert.equal(result.runningReason, "bus_departure_started");
  assert.equal(result.location, "Desert");
  assert.equal(result.trace.filter((entry) => entry.action === "ride_bus").length, 1);
  assert.equal(result.trace[0].action, "ride_bus");
});

test("blocks when the terminal is the unconfirmed branch", async () => {
  const { client, receipts } = makeClient({
    terminalReason: "bus_arrival_unconfirmed",
    evidence: "origin=BusStop;expected=Desert;observed=BusStop;fare=500;money_before=6000",
  });
  const result = await runRideBusSmoke(client, receipts, config, { rideTimeoutMs: 500 });

  assert.equal(result.state, "blocked");
  assert.match(result.reasonCode, /ride_bus_terminal_mismatch/);
});

test("blocks when the receipt claims an arrival the world did not produce", async () => {
  const { client, receipts } = makeClient({ arrival: "BusStop" });
  const result = await runRideBusSmoke(client, receipts, config, { rideTimeoutMs: 500 });

  assert.equal(result.state, "blocked");
  assert.match(result.reasonCode, /ride_bus_arrival_not_observed/);
});

test("blocks when the fare was not actually deducted", async () => {
  const { client, receipts } = makeClient({
    evidence: "origin=BusStop;destination=Desert;fare=500;money_before=6000;money_after=6000",
  });
  const result = await runRideBusSmoke(client, receipts, config, { rideTimeoutMs: 500 });

  assert.equal(result.state, "blocked");
  assert.match(result.reasonCode, /ride_bus_fare_not_deducted/);
});

test("refuses a config that is not this scenario or is not topology-isolated", async () => {
  const { client, receipts } = makeClient();

  const wrongScenario = await runRideBusSmoke(client, receipts, {
    ...config,
    NativeLocalPlayerFixture: { ...config.NativeLocalPlayerFixture, FixtureScenario: "native_ride_minecart_v1" },
  });
  assert.equal(wrongScenario.state, "blocked");
  assert.match(wrongScenario.reasonCode, /native_local_fixture_scenario_mismatch/);

  const notIsolated = await runRideBusSmoke(client, receipts, {
    ...config,
    Portfolio: { Enable: true },
  });
  assert.equal(notIsolated.state, "blocked");
  assert.match(notIsolated.reasonCode, /native_local_fixture_topology_not_isolated/);

  // `Portfolio` is not a ModConfig property, so the game drops it when it rewrites
  // the profile config: its absence must NOT be treated as a topology violation.
  const absentPortfolio = await runRideBusSmoke(client, receipts, config);
  assert.equal(absentPortfolio.state, "passed");
});

test("parses the Mod's string evidence as well as the wire object", () => {
  // Both shapes must work: the parser is about the contract (key=value pairs),
  // not about which envelope the evidence arrived in. The FIRST live attempt failed
  // for exactly this reason — the runner assumed a string while the wire sends an
  // object — so both shapes are pinned here.
  const fromWire = parseStrictEvidence({ detail: ARRIVED_EVIDENCE });
  const fromString = parseStrictEvidence(ARRIVED_EVIDENCE);
  for (const fields of [fromWire, fromString]) {
    assert.equal(fields.origin, "BusStop");
    assert.equal(fields.destination, "Desert");
    assert.equal(fields.fare, "500");
    assert.equal(fields.money_after, "5500");
  }
  assert.throws(() => parseStrictEvidence(null), /ride_bus_evidence_missing/);
  assert.throws(() => parseStrictEvidence({ detail: "" }), /ride_bus_evidence_missing/);
  assert.throws(() => parseStrictEvidence({ detail: "noequals" }), /ride_bus_evidence_malformed/);
});

test("the pass contract rejects each clause it claims", async () => {
  const detail = {
    reasonCode: "bus_arrived",
    origin: "BusStop",
    destination: "Desert",
    fare: 500,
    moneyBefore: 6000,
    moneyAfter: 5500,
    after: { hasLocation: true },
    trace: [{ action: "ride_bus" }],
  };
  assert.doesNotThrow(() => assertRideBusPostconditions({ ...detail }));

  assert.throws(() => assertRideBusPostconditions({ ...detail, destination: "Town" }), /ride_bus_destination/);
  assert.throws(() => assertRideBusPostconditions({ ...detail, moneyAfter: 6000 }), /ride_bus_fare_not_deducted/);
  assert.throws(() => assertRideBusPostconditions({ ...detail, fare: 0 }), /ride_bus_fare_not_positive/);
  assert.throws(() => assertRideBusPostconditions({ ...detail, trace: [] }), /ride_bus_trace/);
  assert.throws(() => assertRideBusPostconditions({ ...detail, after: {} }), /ride_bus_after_missing/);
});
