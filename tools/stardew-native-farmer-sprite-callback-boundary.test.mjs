import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { validateNativeFarmerSpriteCallbackBoundary } from "./lib/stardew-native-farmer-sprite-callback-boundary.mjs";
const text = `void Store() { endOfAnimationFunction = value; } void Tick() { endOfAnimationBehavior callback = endOfAnimationFunction; callback(owner); }`,
  bytes = Buffer.from(text),
  h = createHash("sha256").update(bytes).digest("hex");
const loc = (start, end) => ({
  relativePath: "FarmerSprite.cs",
  startByte: start,
  endByte: end,
  sliceSha256: createHash("sha256").update(bytes.subarray(start, end)).digest("hex"),
  sourceFileSha256: h,
});
const sourceFiles = { "FarmerSprite.cs": { text, sha256: h } };
test("attests stored and deferred FarmerSprite callback invocation without interpreting it", () => {
  const result = validateNativeFarmerSpriteCallbackBoundary(
    {
      schemaVersion: 1,
      artifactKind: "native_farmer_sprite_callback_boundary",
      callbackStore: loc(0, text.indexOf("void Tick")),
      callbackInvoke: loc(text.indexOf("void Tick"), text.length),
    },
    { sourceFiles },
  );
  assert.equal(result.callbackBoundaryState, "source_attested_deferred_callback_invoke");
});
test("fails closed for stale callback locator", () => {
  assert.throws(
    () =>
      validateNativeFarmerSpriteCallbackBoundary(
        {
          schemaVersion: 1,
          artifactKind: "native_farmer_sprite_callback_boundary",
          callbackStore: { ...loc(0, 3), sliceSha256: "0".repeat(64) },
          callbackInvoke: loc(text.indexOf("void Tick"), text.length),
        },
        { sourceFiles },
      ),
    { code: "farmer_sprite_callback_locator_stale" },
  );
});
test("forbids product vocabulary", () => {
  assert.throws(() => validateNativeFarmerSpriteCallbackBoundary({ actionId: "no" }, { sourceFiles }), {
    code: "farmer_sprite_callback_forbidden_field",
  });
});
