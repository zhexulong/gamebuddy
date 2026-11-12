// red-proof: inject  the unpublished-action check inverted (`!published.has(id)` -> `published.has(id)`)
//  -> `✖ a lane that grants an unpublished action is a named violation`, exit 1
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import {
  fixtureActionCoverageViolations,
  parseFixtureActionSets,
  REQUIRED_LANE_ACTIONS,
} from "./fixture-action-coverage.mjs";

const FIXTURE = readFileSync(new URL("./stardew-native-local-player-fixture.mjs", import.meta.url), "utf8");

test("the fixture's action sets parse, including a multi-line one", () => {
  const sets = parseFixtureActionSets(`
    if (action === "equip_tool") return ["equip_tool"];
    if (action === "play_session_multi_day")
      return [
        "sleep",
        // a comment with "quotes" in it
        "respond_level_up",
      ];
  `);
  assert.deepEqual(sets.get("equip_tool"), ["equip_tool"]);
  assert.deepEqual(sets.get("play_session_multi_day"), ["sleep", "respond_level_up"]);
});

test("a lane that omits an action its run needs is a named violation", () => {
  // The night's own defect (run g22): the multi-day lane granted the settlement menu's action and not the level-up
  // menu's, so the night could not finish - and the refusal reached the caller as its own timeout.
  //
  // The example is built from the required set ITSELF rather than spelling an action id, so a rename (the night's
  // action became `sleep`) cannot make this case stale: what it proves is that omitting one required action is named,
  // whichever action that is. `respond_level_up` is that one today, and it is the one that actually happened.
  const required = REQUIRED_LANE_ACTIONS.play_session_multi_day;
  const omitted = required.at(-1);
  const violations = fixtureActionCoverageViolations({
    sets: new Map([["play_session_multi_day", required.filter((id) => id !== omitted)]]),
    publishedIds: new Set(required),
  });
  assert.deepEqual(
    violations.map((entry) => entry.code),
    [`fixture_lane_missing_required_action:play_session_multi_day:${omitted}`],
  );
});

test("a lane that grants an unpublished action is a named violation", () => {
  const violations = fixtureActionCoverageViolations({
    sets: new Map([["equip_tool", ["equip_tool", "teleport_everywhere"]]]),
    publishedIds: new Set(["equip_tool"]),
    // No required lanes here: this case is about granting, and `required` is the other rule.
    required: {},
  });
  assert.deepEqual(
    violations.map((entry) => entry.code),
    ["fixture_grants_unpublished_action:equip_tool:teleport_everywhere"],
  );
});

test("a required lane the fixture never declares is named, and an empty surface is not a pass", () => {
  const missingLane = fixtureActionCoverageViolations({
    sets: new Map(),
    publishedIds: new Set(["sleep"]),
    required: { lane_that_does_not_exist: ["sleep"] },
  });
  assert.deepEqual(
    missingLane.map((entry) => entry.code),
    ["fixture_lane_not_declared:lane_that_does_not_exist"],
  );
  const emptySurface = fixtureActionCoverageViolations({ sets: new Map(), publishedIds: new Set(), required: {} });
  assert.deepEqual(
    emptySurface.map((entry) => entry.code),
    ["published_surface_empty"],
  );
});

test("the REAL fixture grants every required action, and only published ones", () => {
  // The live gate's own assertion, run here too so a regression fails in the unit suite rather than only in the gate.
  const surface = JSON.parse(
    readFileSync(
      new URL(
        "../../integrations/stardew/action-development/contracts/generated/action-surface.v1.json",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  const publishedIds = new Set(surface.actions.map((action) => action.actionId));
  const sets = parseFixtureActionSets(FIXTURE);
  assert.ok(sets.size > 20, `expected the fixture's lane sets, saw ${String(sets.size)}`);
  const violations = fixtureActionCoverageViolations({ sets, publishedIds, required: REQUIRED_LANE_ACTIONS });
  assert.deepEqual(violations, [], `fixture action coverage: ${violations.map((entry) => entry.code).join(", ")}`);
});
