import assert from "node:assert/strict";
import test from "node:test";
import { runM4BreakRockSourcePreflight } from "./run-stardew-portfolio-m4-break-rock-source-preflight.mjs";

test("M4 non-mutation preflight serializes the exact source blocker handoff", async () => {
  const result = await runM4BreakRockSourcePreflight();
  assert.deepEqual(result, {
    state: "BLOCKED",
    action: "break_rock_source",
    topology: "single_player_native_companion",
    mutationAttempted: false,
    producer: "fresh source observation",
    consumer: "typed guarded coordinator",
    verifier: "future exact fresh-debris reader",
    blocker: "m4_target_version_decompilation_correlation",
    sourceFact:
      "The audit aid identifies ResourceClump health/destroy and separate Debris creation, but blocks target-version decompilation correlation, signed source-class selection, semantic ingress, and fresh-drop partition realization.",
    pickup: "not invoked; distinct existing/future action",
    liveClosure: "none",
  });
});
