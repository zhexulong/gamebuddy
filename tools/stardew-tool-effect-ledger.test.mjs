import assert from "node:assert/strict";
import test from "node:test";
import { deriveStardewToolEffectLedger } from "./lib/stardew-tool-effect-ledger.mjs";

function method(name, fragments) {
  return `public void ${name}() {\n${fragments.map((fragment) => `  // ${fragment}`).join("\n")}\n}`;
}

// The exact-DLL CLI is the target-version evidence gate. This synthetic source
// fixture isolates the ledger's schema/fail-closed behavior from the checked-in
// decompiler snapshot, which can have different local variable names.
function sources() {
  return {
    "StardewValley/Game1.cs": method("pressUseToolButton", ["player.CurrentTool != null", "player.BeginUsingTool()"]),
    "StardewValley/Farmer.cs": method("performBeginUsingTool", [
      "CurrentTool != null",
      "CurrentTool.beginUsing(base.currentLocation, (int)lastClick.X, (int)lastClick.Y, this)",
    ]),
    "StardewValley/Tools/Hoe.cs": method("DoFunction", [
      "tilesAffected(vector, power, who)",
      "location.makeHoeDirt(item)",
      "location.checkForBuriedItem",
      "Game1.stats.DirtHoed++",
    ]),
    "StardewValley/Tools/Axe.cs": method("DoFunction", [
      "location.performToolAction(this, num, num2)",
      "value.performToolAction(this, 0, tile)",
      "largeFeature.performToolAction(this, 0, tile)",
      "value2.performToolAction(this)",
      "location.Objects.Remove(key)",
    ]),
    "StardewValley/Tools/Pickaxe.cs": method("DoFunction", [
      "location.performToolAction(this, num, num2)",
      "value.IsBreakableStone()",
      "value.minutesUntilReady.Value -=",
      "location.OnStoneDestroyed(value.ItemId, num, num2",
      "location.Objects.Remove(new Vector2(num, num2))",
      'value.Name.Contains("Boulder")',
    ]),
    "StardewValley/Tools/WateringCan.cs": method("DoFunction", [
      "Game1.currentLocation.CanRefillWateringCanOnTile",
      "WaterLeft = waterCanMax",
      "WaterLeft > 0 || who.hasWateringCanEnchantment",
      "value.performToolAction(this, 0, item)",
      "value2.performToolAction(this)",
      "location.performToolAction(this",
      "WaterLeft -= power + 1",
    ]),
    "StardewValley/Tools/Pan.cs": `${method("beginUsing", ["location.orePanPoint", "Utility.distance", "who.FarmerSprite.animateOnce(303", "who.forceCanMove()"])}\n${method("DoFunction", ["who.addItemsByMenuIfNecessary(getPanItems(location, who))", "location.orePanPoint.Value = Point.Zero", "location.performOrePanTenMinuteUpdate", "finish()"])}\n${method("doFinish", ["lastUser.CanMove = true", "lastUser.UsingTool = false", "lastUser.canReleaseTool = true"])}`,
    "StardewValley/Tools/FishingRod.cs": `${method("beginUsing", ["isTimingCast = true", "who.UsingTool = true", "who.canMove = false", "who.canReleaseTool = false", "setTimingCastAnimation(who)"])}\n${method("DoFunction", ["location.canFishHere() && location.isTileFishable", "isFishing = true", "timeUntilFishingBite = calculateTimeUntilFishingBite", "who.UsingTool = true", "who.canMove = false"])}`,
    "StardewValley/Tool.cs": method("endUsing", [
      "this is FishingRod fishingRod && who.IsLocalPlayer",
      "DoFunction(who.currentLocation, (int)who.lastClick.X",
    ]),
    "StardewValley/Tools/MeleeWeapon.cs": `${method("animateSpecialMove", ["specialCooldown() <= 0", "animateSpecialMoveEvent.Fire()"])}\n${method("DoDamage", ["if (!who.IsLocalPlayer)", "location.damageMonster(areaOfEffect", "location.projectiles.RemoveWhere", "value.performToolAction(this, 0, item)", "location.performToolAction(this, (int)item.X, (int)item.Y)"])}`,
  };
}

test("derives bounded effect summaries without inferring public actions", () => {
  const ledger = deriveStardewToolEffectLedger(sources());
  assert.equal(ledger.state, "source_effect_summary_partial");
  assert.deepEqual(ledger.scope.included, ["Hoe", "Axe", "Pickaxe", "WateringCan", "Pan", "FishingRod", "MeleeWeapon"]);
  assert.equal(ledger.entries.length, 8);
  assert.ok(ledger.entries.every((entry) => entry.state === "source_effect_summary_partial"));
  assert.ok(ledger.entries.every((entry) => entry.publicProjection.startsWith("not_inferred")));
  assert.ok(ledger.entries.every((entry) => entry.unknownSinks.length > 0));
  assert.ok(
    ledger.entries
      .slice(0, 7)
      .every(
        (entry) =>
          entry.sourceEvidence.some((anchor) => anchor.sourceFile === "StardewValley/Game1.cs") &&
          entry.sourceEvidence.some((anchor) => anchor.sourceFile === "StardewValley/Farmer.cs"),
      ),
  );
  assert.equal(ledger.reuseHypotheses[0].conclusion, "implementation_reuse_candidate_only");
  assert.match(ledger.nonRuntimeNotice, /does not create, merge, publish, authorize, execute/);
});

test("fails closed when target source no longer proves an anchored effect", () => {
  const fixture = sources();
  fixture["StardewValley/Tools/Pan.cs"] = fixture["StardewValley/Tools/Pan.cs"].replace(
    "location.orePanPoint.Value = Point.Zero",
    "location.orePanPoint.Value = replacement",
  );
  assert.throws(() => deriveStardewToolEffectLedger(fixture), { code: "stardew_tool_effect_ledger_evidence_missing" });
});

test("fails closed when a required method source is absent", () => {
  const fixture = sources();
  delete fixture["StardewValley/Game1.cs"];
  assert.throws(() => deriveStardewToolEffectLedger(fixture), { code: "stardew_tool_effect_ledger_evidence_missing" });
});
