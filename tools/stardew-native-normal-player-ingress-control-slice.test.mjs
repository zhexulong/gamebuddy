import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { deriveNativeNormalPlayerControlSlice } from "./lib/stardew-native-normal-player-ingress-control-slice.mjs";
import { validateNativeNormalPlayerIngressRegister } from "./lib/stardew-native-normal-player-ingress-register.mjs";

const h = (value) => createHash("sha256").update(value).digest("hex");
const game = `protected override void Update(GameTime gameTime) { _update(gameTime2); }
private void _update(GameTime gameTime) { UpdateControlInput(gameTime); }
private void UpdateControlInput(GameTime time) { GetKeyboardState(); hooks.OnGame1_UpdateControlInput(ref a, ref b, ref c, delegate { if (actionButtonPressed || (dialogueUp && useToolButtonPressed)) pressActionButton(currentKBState, currentMouseState, currentPadState); if (useToolButtonPressed && (!player.UsingTool || player.CurrentTool is MeleeWeapon)) { player.FireTool(); pressUseToolButton(); } if (switchToolButtonPressed && !player.UsingTool) pressSwitchToolButton(); else if (pauseTime <= 0f && locationRequest == null) player.setMoving(1); CurrentEvent?.receiveMouseClick(a,b); }); }
public static bool pressActionButton(KeyboardState currentKBState, MouseState currentMouseState, GamePadState currentPadState) { return false; }
public static void pressSwitchToolButton() { }
public static bool pressUseToolButton() { return false; }`;
const farmer = `public void FireTool() { } public void setMoving(byte command) { }`;
const sourceFiles = {
  "StardewValley/Game1.cs": { text: game, sha256: h(game) },
  "StardewValley/Farmer.cs": { text: farmer, sha256: h(farmer) },
};
const attestation = {
  targetAssemblySha256: "a".repeat(64),
  sourceManifestSha256: "b".repeat(64),
  decompilerConfigurationDigest: "c".repeat(64),
};
test("derives only source-attested direct control roots and preserves dynamic/uninventoried exits", () => {
  const register = deriveNativeNormalPlayerControlSlice({ sourceFiles, attestation });
  const checked = validateNativeNormalPlayerIngressRegister(register, {
    expectedAttestation: attestation,
    sourceFiles,
  });
  assert.equal(checked.rootCount, 5);
  assert.equal(checked.gapCount, 3);
  assert.equal(checked.closureState, "partial");
  assert.deepEqual(
    register.roots.map((root) => root.rootId),
    [
      "root:game1-press-action",
      "root:game1-press-use-tool",
      "root:game1-press-switch-tool",
      "root:farmer-fire-tool",
      "root:farmer-set-moving",
    ],
  );
});
test("fails if exact source anchors do not have a unique native source witness", () => {
  assert.throws(
    () =>
      deriveNativeNormalPlayerControlSlice({
        sourceFiles: {
          ...sourceFiles,
          "StardewValley/Game1.cs": { text: `${game}\n${game}`, sha256: h(`${game}\n${game}`) },
        },
        attestation,
      }),
    { code: "normal_player_ingress_anchor_missing" },
  );
});
