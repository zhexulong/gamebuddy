import assert from "node:assert/strict";
import test from "node:test";
import { auditBridgeRouteEquivalence } from "./lib/stardew-player-command-equivalence-audit.mjs";

const rules = [
  {
    candidateId: "forage.pickup_spawned_object",
    implementationActionId: "pickup_forage",
    bridgeMethod: "RequestLocalPickupForage",
    humanPath: "Game1.tryToCheckAt -> GameLocation.checkAction",
    requiredHumanGuards: [
      {
        id: "not_on_bridge",
        humanFragment: "if (player.onBridge.Value)",
        bridgeFragments: ["Game1.player.onBridge.Value", "Game1.tryToCheckAt("],
        explanation: "bridge guard",
      },
      {
        id: "within_action_radius",
        humanFragment: "Utility.tileWithinRadiusOfPlayer",
        bridgeFragments: ["Utility.tileWithinRadiusOfPlayer", "Game1.tryToCheckAt("],
        explanation: "range guard",
      },
    ],
  },
];

test("reports a bridge equivalence gap when a required human-path guard is absent", () => {
  const source = `
    public void RequestLocalPickupForage() {
      if (!Utility.tileWithinRadiusOfPlayer(1, 2, 1, Game1.player)) return;
      location.checkAction(tile, viewport, Game1.player);
    }
  `;
  const [finding] = auditBridgeRouteEquivalence(source, rules);
  assert.equal(finding.state, "bridge_equivalence_gap");
  assert.deepEqual(
    finding.missingGuards.map((guard) => guard.id),
    ["not_on_bridge"],
  );
});

test("recognizes a target-version player-ingress delegate as preserving its guarded subpath", () => {
  const source = `
    public void RequestLocalPickupForage() {
      Game1.tryToCheckAt(tile, Game1.player);
    }
  `;
  const [finding] = auditBridgeRouteEquivalence(source, rules);
  assert.equal(finding.state, "source_guard_equivalence_candidate");
  assert.deepEqual(finding.missingGuards, []);
});

test("only reports a source-guard candidate when all required guards are present", () => {
  const source = `
    public void RequestLocalPickupForage() {
      if (Game1.player.onBridge.Value) return;
      if (!Utility.tileWithinRadiusOfPlayer(1, 2, 1, Game1.player)) return;
      location.checkAction(tile, viewport, Game1.player);
    }
  `;
  const [finding] = auditBridgeRouteEquivalence(source, rules);
  assert.equal(finding.state, "source_guard_equivalence_candidate");
  assert.deepEqual(finding.missingGuards, []);
});

test("fails closed when the declared bridge method does not exist", () => {
  const [finding] = auditBridgeRouteEquivalence("public void OtherMethod() {}", rules);
  assert.equal(finding.state, "bridge_source_missing");
  assert.equal(finding.missingGuards.length, 2);
});
