import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  deriveNativeCompletionEventRegister,
  validateNativeCompletionEventRegister,
} from "./lib/stardew-native-completion-event-register.mjs";
const h = (text) => createHash("sha256").update(text).digest("hex");
const text = `class Pan { private readonly NetEvent0 finishEvent = new NetEvent0(); void init() { finishEvent.onEvent += doFinish; } void Done() { finishEvent.Fire(); } void tick() { finishEvent.Poll(); } private void doFinish() { } }`;
const sourceFiles = { "Pan.cs": { text, sha256: h(text) } };
const definitions = [{ eventId: "pan-finish", relativePath: "Pan.cs" }];
test("enumerates exact visible Fire/Poll/handler wiring without interpreting completion", () => {
  const report = deriveNativeCompletionEventRegister({ sourceFiles, definitions });
  assert.equal(report.eventCount, 1);
  assert.equal(report.events[0].fireCallsites.length, 1);
  assert.equal(report.events[0].pollCallsites.length, 1);
  assert.equal(report.analysisBoundary.continuationTerminality, "not_inferred");
  assert.equal(validateNativeCompletionEventRegister(report, { sourceFiles }).eventCount, 1);
});
test("fails closed for missing local Poll", () => {
  assert.throws(
    () =>
      deriveNativeCompletionEventRegister({
        sourceFiles: {
          "Pan.cs": {
            text: text.replace("finishEvent.Poll();", ""),
            sha256: h(text.replace("finishEvent.Poll();", "")),
          },
        },
        definitions,
      }),
    { code: "completion_event_register_wiring_missing" },
  );
});
test("forbids product vocabulary", () => {
  const report = deriveNativeCompletionEventRegister({ sourceFiles, definitions });
  assert.throws(() => validateNativeCompletionEventRegister({ ...report, primitiveId: "no" }, { sourceFiles }), {
    code: "completion_event_register_forbidden_field",
  });
});
