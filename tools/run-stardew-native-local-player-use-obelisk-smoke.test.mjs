import assert from "node:assert/strict";
import test from "node:test";
import { assertUseObeliskPostconditions, validateNativeLocalFixtureConfig } from "./run-stardew-native-local-player-use-obelisk-smoke.mjs";

/**
 * A pass-shaped detail object. The runner's happy path is exercised live; what this file pins is the
 * CONTRACT, one clause at a time, because a single green live run cannot show which clause would have
 * caught a bad one. Each test below breaks exactly one fact and requires the matching refusal.
 */
function passingDetail() {
  return {
    reasonCode: "obelisk_arrived",
    requested: { targetId: "obelisk_abc", x: 34, y: 12, route: "building", destination: "Desert" },
    dispatchedRoute: "building",
    dispatchedTarget: "obelisk_abc",
    dispatchedTargetTile: "34,12",
    dispatchedOrigin: "Farm",
    dispatchedDestination: "Desert",
    terminalExpected: "Desert:35,43",
    terminalActual: "Desert:35,43",
    after: { hasLocation: true },
    afterLocation: "Desert",
    trace: [{ phase: "use", action: "use_obelisk" }, { phase: "terminal", state: "succeeded" }],
  };
}

test("use_obelisk: the pass contract accepts a real arrival", () => {
  assert.doesNotThrow(() => assertUseObeliskPostconditions(passingDetail()));
});

const clauses = [
  ["a different terminal reason", (d) => (d.reasonCode = "travel_completed"), /use_obelisk_reason/],
  ["a silently re-targeted obelisk", (d) => (d.dispatchedTarget = "obelisk_other"), /use_obelisk_target_mismatch/],
  ["a route the caller did not ask for", (d) => (d.dispatchedRoute = "island_farm_tile"), /use_obelisk_route_mismatch/],
  ["a tile that is not the advertised one", (d) => (d.dispatchedTargetTile = "1,1"), /use_obelisk_tile_mismatch/],
  ["a destination the client supplied rather than the structure", (d) => (d.dispatchedDestination = "Beach"), /use_obelisk_destination_mismatch/],
  ["an arrival at a location that is not the destination", (d) => (d.afterLocation = "Farm"), /use_obelisk_arrival_not_observed/],
  // A warp whose destination IS the origin: every other clause agrees, so the only thing wrong is
  // that the actor never went anywhere. (Setting afterLocation to some third place would trip the
  // arrival clause first and prove nothing about this one.)
  [
    "an arrival that never left the origin",
    (d) => {
      d.requested.destination = "Farm";
      d.dispatchedDestination = "Farm";
      d.afterLocation = "Farm";
      d.dispatchedOrigin = "Farm";
      d.terminalExpected = "Farm:34,12";
      d.terminalActual = "Farm:34,12";
    },
    /use_obelisk_did_not_move/,
  ],
  ["a terminal whose expected pair names somewhere else", (d) => (d.terminalExpected = "Beach:20,4"), /use_obelisk_terminal_expected_mismatch/],
  ["a terminal whose actual pair names somewhere else", (d) => (d.terminalActual = "Farm:1,1"), /use_obelisk_terminal_actual_mismatch/],
  ["a run that never dispatched", (d) => (d.trace = [{ phase: "terminal", state: "succeeded" }]), /use_obelisk_trace/],
];

for (const [label, breakIt, expected] of clauses) {
  test(`use_obelisk: refuses ${label}`, () => {
    const detail = passingDetail();
    breakIt(detail);
    assert.throws(() => assertUseObeliskPostconditions(detail), expected);
  });
}

test("use_obelisk: a fixture config for another scenario is refused", () => {
  const config = {
    NativeLocalPlayerFixture: { Enable: true, FixtureScenario: "native_use_obelisk_v1" },
  };
  assert.doesNotThrow(() => validateNativeLocalFixtureConfig(config));

  const wrongScenario = { NativeLocalPlayerFixture: { Enable: true, FixtureScenario: "native_till_soil_v1" } };
  assert.throws(() => validateNativeLocalFixtureConfig(wrongScenario), /native_local_fixture_scenario_mismatch/);

  const notEnabled = { NativeLocalPlayerFixture: { Enable: false, FixtureScenario: "native_use_obelisk_v1" } };
  assert.throws(() => validateNativeLocalFixtureConfig(notEnabled), /native_local_fixture_not_enabled/);

  // The topology guard must fire on a real violation, and must NOT fire merely because the game
  // dropped the non-ModConfig `Portfolio` key while rewriting the profile.
  const portfolioOn = {
    NativeLocalPlayerFixture: { Enable: true, FixtureScenario: "native_use_obelisk_v1" },
    Portfolio: { Enable: true },
  };
  assert.throws(() => validateNativeLocalFixtureConfig(portfolioOn), /native_local_fixture_topology_not_isolated/);
  const portfolioDropped = {
    NativeLocalPlayerFixture: { Enable: true, FixtureScenario: "native_use_obelisk_v1" },
  };
  assert.doesNotThrow(() => validateNativeLocalFixtureConfig(portfolioDropped));
});
