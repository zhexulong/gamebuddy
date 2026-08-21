import { createHash } from "node:crypto";

const SHA256 = /^[a-f0-9]{64}$/;
function fail(code, message, details = {}) {
  const error = new Error(message);
  error.code = code;
  error.details = details;
  throw error;
}
function noProductTerms(value, at = "$") {
  const forbidden = new Set([
    "action",
    "actionId",
    "primitive",
    "primitiveId",
    "operation",
    "operationId",
    "semanticFamily",
    "intent",
    "contract",
    "receipt",
    "evidence",
    "policy",
    "capability",
    "publicActionId",
    "projection",
    "reuse",
  ]);
  if (Array.isArray(value)) return value.forEach((x, i) => noProductTerms(x, `${at}[${i}]`));
  if (!value || typeof value !== "object") return;
  for (const [key, x] of Object.entries(value)) {
    if (forbidden.has(key))
      fail("farmer_sprite_callback_forbidden_field", `FarmerSprite callback boundary must not infer ${key}.`, {
        at: `${at}.${key}`,
      });
    noProductTerms(x, `${at}.${key}`);
  }
}
function exact(locator, sourceFiles, label) {
  if (
    !locator ||
    typeof locator.relativePath !== "string" ||
    !Number.isInteger(locator.startByte) ||
    !Number.isInteger(locator.endByte) ||
    locator.endByte <= locator.startByte ||
    !SHA256.test(locator.sliceSha256 ?? "") ||
    !SHA256.test(locator.sourceFileSha256 ?? "")
  )
    fail("farmer_sprite_callback_locator_invalid", `Expected exact ${label} locator.`);
  const source = sourceFiles?.[locator.relativePath];
  if (!source || source.sha256 !== locator.sourceFileSha256 || typeof source.text !== "string")
    fail("farmer_sprite_callback_source_missing", `Exact source missing for ${label}.`);
  const bytes = Buffer.from(source.text, "utf8");
  if (
    locator.endByte > bytes.length ||
    createHash("sha256").update(bytes.subarray(locator.startByte, locator.endByte)).digest("hex") !==
      locator.sliceSha256
  )
    fail("farmer_sprite_callback_locator_stale", `Exact ${label} locator stale.`);
  return bytes.subarray(locator.startByte, locator.endByte).toString("utf8");
}
/** Attests only that FarmerSprite stores an end callback and later invokes it
 * from its per-frame animation update. It intentionally cannot name callbacks
 * or decide completion / gameplay effect. */
export function validateNativeFarmerSpriteCallbackBoundary(trace, { sourceFiles } = {}) {
  noProductTerms(trace);
  if (!trace || trace.schemaVersion !== 1 || trace.artifactKind !== "native_farmer_sprite_callback_boundary")
    fail("farmer_sprite_callback_schema_invalid", "Expected native FarmerSprite callback boundary schema version 1.");
  const store = exact(trace.callbackStore, sourceFiles, "callback store"),
    invoke = exact(trace.callbackInvoke, sourceFiles, "callback invoke");
  if (!store.includes("endOfAnimationFunction") || !store.includes("="))
    fail("farmer_sprite_callback_store_missing", "Callback store must assign endOfAnimationFunction.");
  if (!invoke.includes("endOfAnimationFunction") || !invoke.includes("endOfAnimationBehavior") || !invoke.includes("("))
    fail("farmer_sprite_callback_invoke_missing", "Callback invoke must transfer and invoke endOfAnimationFunction.");
  return Object.freeze({
    callbackBoundaryState: "source_attested_deferred_callback_invoke",
    analysisBoundary: Object.freeze({
      callbackIdentityResolution: "not_performed",
      callbackEffectInterpretation: "not_performed",
      completionTerminality: "not_inferred",
      transitionDerivation: "not_performed",
      primitiveDerivation: "not_performed",
      publicActionProjection: "not_performed",
    }),
  });
}
