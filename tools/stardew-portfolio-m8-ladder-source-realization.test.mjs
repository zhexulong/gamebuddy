import assert from "node:assert/strict";
import test from "node:test";
import { extractAnchors, validateDossier } from "./stardew-portfolio-m8-ladder-source-realization.mjs";
const game = `public override bool checkAction(Location t, Rectangle v, Farmer who) { if (who.IsLocalPlayer) { switch (x) { case 173: Game1.enterMine(mineLevel + 1); playSound("stairsdown"); return true; } } }`;
const warp = `public static void enterMine(int whatLevel, int? forceLayout = null) { warpFarmer(MineShaft.GetLevelName(whatLevel, forceLayout), 6, 6, 2); }`;
const spawn = `public void createLadderDown(int x, int y, bool forceShaft = false) { createLadderDownEvent[new Point(x, y)] = forceShaft; }`;
function files() {
  return {
    "StardewValley/Locations/MineShaft.cs": Buffer.from(`${game}\n${spawn}`),
    "StardewValley/Game1.cs": Buffer.from(warp),
  };
}
test("M8 ladder extraction requires exact local-player case-173 commit and native warp", () => {
  const a = extractAnchors(files());
  assert.equal(a.length, 4);
  assert.equal(a[0].semanticRole, "normal_player_fresh_existing_ladder_interaction_guard");
  assert.equal(a[1].semanticRole, "case_173_immediate_next_floor_native_commit");
});
test("M8 ladder extraction fails closed when case-173 or local-player guard drifts", () => {
  const bad = files();
  bad["StardewValley/Locations/MineShaft.cs"] = Buffer.from(
    game.replace("who.IsLocalPlayer", "who.IsNotLocalPlayer") + "\n" + spawn,
  );
  assert.throws(() => extractAnchors(bad), /ladder interaction guard incomplete/);
});
test("M8 ladder dossier rejects promotion or target drift", () => {
  const d = {
    target: {
      relativeFileName: "Stardew Valley.dll",
      fileVersion: "1.6.15.24356",
      productVersion: "1.6.15.24356",
      length: 6268416,
      sha256: "7f1e5b8e58d2758b78570ba771bbeb03d33522f62188bf6c32edf0cf626deaee",
    },
    actionId: "use_mine_ladder",
    topology: "single_player_native_companion",
    anchors: [1, 2, 3, 4],
    conclusion: { primitiveSourceRealizationStatus: "realized" },
  };
  assert.equal(validateDossier(d), true);
  assert.throws(() => validateDossier({ ...d, actionId: "select_mine_elevator_floor" }), /invalid/);
  assert.throws(
    () => validateDossier({ ...d, conclusion: { primitiveSourceRealizationStatus: "unknown" } }),
    /invalid/,
  );
});
