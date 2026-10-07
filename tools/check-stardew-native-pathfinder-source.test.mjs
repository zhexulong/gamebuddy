import assert from "node:assert/strict";
import test from "node:test";
import { checkStardewNativePathfinderSource } from "./check-stardew-native-pathfinder-source.mjs";

const MOVEMENT = "integrations/stardew/StardewBodyController.cs";

test("the shipped native pathfinder call sites use owned predicates and plan evidence", () => {
  const report = checkStardewNativePathfinderSource();
  assert.deepEqual(report.findings, []);
  assert.equal(report.ok, true);
});

test("mutation: handing the coordinate goal to the native pathfinder is rejected", () => {
  const mutated = `
class Mutated {
  void Move() {
    var controller = new PathFindController(player, location, targetTile, facing);
    int plannedTiles = controller.pathToEndPoint?.Count ?? 0;
    if (plannedTiles == 0) trace.Add("movement_refused");
  }
}`;
  const report = checkStardewNativePathfinderSource({
    roots: [],
    sourceOverrides: { [MOVEMENT]: mutated },
  });
  assert.ok(report.findings.some((finding) => finding.code === "native_pathfinder_goal_not_owned_predicate"));
});

test("mutation: the forbidden native goal delegate is rejected", () => {
  const mutated = `class Mutated { void Move() {
    var controller = new PathFindController(player, location, PathFindController.isAtEndPoint, facing);
    int plannedTiles = controller.pathToEndPoint?.Count ?? 0;
  } }`;
  const report = checkStardewNativePathfinderSource({
    roots: [],
    sourceOverrides: { [MOVEMENT]: mutated },
  });
  assert.ok(report.findings.some((finding) => finding.code === "native_pathfinder_goal_not_owned_predicate"));
});

test("mutation: a self-driven call without plan/refusal evidence is rejected", () => {
  const mutated = `
class Mutated {
  void Move() {
    var controller = new PathFindController(player, location, (node, target, l, c) => node.x == target.X, facing);
    player.controller = controller;
  }
}`;
  const report = checkStardewNativePathfinderSource({
    roots: [],
    sourceOverrides: { [MOVEMENT]: mutated },
  });
  assert.ok(report.findings.some((finding) => finding.code === "native_pathfinder_missing_plan_or_refusal_evidence"));
});
