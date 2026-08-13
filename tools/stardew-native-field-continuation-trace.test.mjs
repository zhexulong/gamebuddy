import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { validateNativeFieldContinuationTrace } from "./lib/stardew-native-field-continuation-trace.mjs";
const text = `class Farmer { List<int> movementDirections; void Set(){ movementDirections.Insert(0, 1); } void Update(){ if(movementDirections.Contains(1)) Move(); } void Halt(){ movementDirections.Clear(); } }`;
const hash = createHash("sha256").update(text).digest("hex");
function loc(needle) {
  const startByte = Buffer.byteLength(text.slice(0, text.indexOf(needle)));
  const endByte = startByte + Buffer.byteLength(needle);
  return {
    relativePath: "Demo.cs",
    startByte,
    endByte,
    sliceSha256: createHash("sha256").update(Buffer.from(text).subarray(startByte, endByte)).digest("hex"),
    sourceFileSha256: hash,
  };
}
const sourceFiles = { "Demo.cs": { text, sha256: hash } };
function valid() {
  return {
    schemaVersion: 1,
    artifactKind: "native_field_continuation_trace",
    fieldName: "movementDirections",
    fieldDeclaration: loc("List<int> movementDirections"),
    writerCallsites: [loc("movementDirections.Insert")],
    consumerCallsites: [loc("movementDirections.Contains")],
    clearerCallsites: [loc("movementDirections.Clear")],
  };
}
test("requires exact source-backed write, consumer, and clearer witnesses", () => {
  const r = validateNativeFieldContinuationTrace(valid(), { sourceFiles });
  assert.equal(r.consumerCount, 1);
});
test("fails closed if a supposed consumer does not reference field", () => {
  const x = valid();
  x.consumerCallsites = [loc("Move()")];
  assert.throws(() => validateNativeFieldContinuationTrace(x, { sourceFiles }), {
    code: "field_continuation_callsite_invalid",
  });
});
