import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { validateNativeEventContinuationTrace } from "./lib/stardew-native-event-continuation-trace.mjs";

const source = `class NetEvent0 { void Fire() {} void Poll() {} } class Farmer { NetEvent0 fireToolEvent; void Init() { fireToolEvent.onEvent += performFireTool; } void FireTool() { fireToolEvent.Fire(); } void Update() { fireToolEvent.Poll(); } void performFireTool() {} }`;
const file = "Demo.cs";
const hash = createHash("sha256").update(source).digest("hex");
function loc(needle) {
  const startByte = Buffer.byteLength(source.slice(0, source.indexOf(needle)));
  const endByte = startByte + Buffer.byteLength(needle);
  return {
    relativePath: file,
    startByte,
    endByte,
    sliceSha256: createHash("sha256").update(Buffer.from(source).subarray(startByte, endByte)).digest("hex"),
    sourceFileSha256: hash,
  };
}
const sourceFiles = { [file]: { text: source, sha256: hash } };
function valid() {
  return {
    schemaVersion: 1,
    artifactKind: "native_event_continuation_trace",
    eventField: "fireToolEvent",
    handlerMember: "performFireTool",
    eventDeclaration: loc("NetEvent0 fireToolEvent"),
    registration: loc("fireToolEvent.onEvent += performFireTool"),
    handlerDeclaration: loc("void performFireTool()"),
    eventClassMethods: [
      { name: "Fire", declaration: loc("void Fire()") },
      { name: "Poll", declaration: loc("void Poll()") },
    ],
    triggerCallsites: [loc("fireToolEvent.Fire()")],
    pollCallsites: [loc("fireToolEvent.Poll()")],
    continuationState: "locally_attested_polling_and_handler",
  };
}
test("requires exact source evidence for NetEvent registration, Fire/Poll, and handler", () => {
  const result = validateNativeEventContinuationTrace(valid(), { sourceFiles });
  assert.equal(result.continuationState, "locally_attested_polling_and_handler");
  assert.equal(result.pollCallsiteCount, 1);
});
test("fails closed for a registration that does not bind the event to its handler", () => {
  const broken = valid();
  broken.registration = loc("fireToolEvent.Fire()");
  assert.throws(() => validateNativeEventContinuationTrace(broken, { sourceFiles }), {
    code: "native_event_trace_registration_missing",
  });
});
