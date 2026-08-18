import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  deriveNativeVirtualReceiverRegister,
  validateNativeVirtualReceiverRegister,
} from "./lib/stardew-native-virtual-receiver-register.mjs";
const h = (text) => createHash("sha256").update(text).digest("hex");
const axe = `namespace Demo; public class Axe : Tool { public override bool beginUsing(GameLocation l, int x, int y, Farmer who) { return true; } }`;
const hoe = `namespace Demo; public class Hoe : Tool { }`;
const indirect = `namespace Demo; public class FancyAxe : Axe { public override bool beginUsing(GameLocation l, int x, int y, Farmer who) { return false; } }`;
const sourceFiles = {
  "Axe.cs": { text: axe, sha256: h(axe) },
  "Hoe.cs": { text: hoe, sha256: h(hoe) },
  "FancyAxe.cs": { text: indirect, sha256: h(indirect) },
};
test("enumerates direct source Tool receivers and exact visible virtual overrides without resolving runtime dispatch", () => {
  const report = deriveNativeVirtualReceiverRegister({ sourceFiles, methodName: "beginUsing" });
  assert.deepEqual(
    report.receivers.map((item) => item.receiverType),
    ["Axe", "Hoe"],
  );
  assert.deepEqual(
    report.overrides.map((item) => item.receiverType),
    ["Axe"],
  );
  assert.deepEqual(report.inheritedBaseReceiverTypes, ["Hoe"]);
  assert.deepEqual(report.indirectOverrideReceiverTypes, ["FancyAxe"]);
  assert.equal(report.analysisBoundary.indirectSubclasses, "source_visible_but_not_resolved");
  assert.deepEqual(validateNativeVirtualReceiverRegister(report, { sourceFiles }).overrides, report.overrides);
});
test("fails closed when persisted receiver list no longer matches exact source", () => {
  const report = { ...deriveNativeVirtualReceiverRegister({ sourceFiles, methodName: "beginUsing" }), receivers: [] };
  assert.throws(() => validateNativeVirtualReceiverRegister(report, { sourceFiles }), {
    code: "virtual_receiver_register_stale",
  });
});
test("forbids primitive or action vocabulary", () => {
  const report = {
    ...deriveNativeVirtualReceiverRegister({ sourceFiles, methodName: "beginUsing" }),
    primitiveId: "no",
  };
  assert.throws(() => validateNativeVirtualReceiverRegister(report, { sourceFiles }), {
    code: "virtual_receiver_register_forbidden_field",
  });
});
