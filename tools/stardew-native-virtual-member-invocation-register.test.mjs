import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  deriveNativeVirtualMemberInvocationRegister,
  validateNativeVirtualMemberInvocationRegister,
} from "./lib/stardew-native-virtual-member-invocation-register.mjs";

const h = (text) => createHash("sha256").update(text).digest("hex");
const tool = `namespace Demo; public class Tool { public virtual bool beginUsing(GameLocation l, int x, int y, Farmer who) { who.Halt(); Update(); return false; } }`;
const axe = `namespace Demo; public class Axe : Tool { public override bool beginUsing(GameLocation l, int x, int y, Farmer who) { Update(); who.EndUsingTool(); return true; } }`;
const hoe = `namespace Demo; public class Hoe : Tool { }`;
const sourceFiles = {
  "StardewValley/Tool.cs": { text: tool, sha256: h(tool) },
  "StardewValley/Tools/Axe.cs": { text: axe, sha256: h(axe) },
  "StardewValley/Tools/Hoe.cs": { text: hoe, sha256: h(hoe) },
};
test("inventories the Tool base virtual body and direct-source visible overrides without inferring effects", async () => {
  const report = await deriveNativeVirtualMemberInvocationRegister({ sourceFiles, methodName: "beginUsing" });
  assert.deepEqual(
    report.implementations.map((item) => [item.receiverType, item.implementationKind, item.invocationCount]),
    [
      ["Tool", "base_virtual", 2],
      ["Axe", "direct_source_override", 2],
    ],
  );
  assert.deepEqual(report.receiverRegister.inheritedBaseReceiverTypes, ["Hoe"]);
  assert.equal(report.analysisBoundary.transitionDerivation, "not_performed");
  assert.equal((await validateNativeVirtualMemberInvocationRegister(report, { sourceFiles })).implementationCount, 2);
});
test("fails closed when an exact implementation inventory becomes stale", async () => {
  const report = await deriveNativeVirtualMemberInvocationRegister({ sourceFiles, methodName: "beginUsing" });
  const stale = { ...report, implementations: [] };
  await assert.rejects(() => validateNativeVirtualMemberInvocationRegister(stale, { sourceFiles }), {
    code: "virtual_member_invocation_register_stale",
  });
});
test("forbids primitive and action vocabulary", async () => {
  const report = await deriveNativeVirtualMemberInvocationRegister({ sourceFiles, methodName: "beginUsing" });
  await assert.rejects(
    () => validateNativeVirtualMemberInvocationRegister({ ...report, actionId: "no" }, { sourceFiles }),
    { code: "virtual_member_invocation_register_forbidden_field" },
  );
});
test("accepts only the literal Tool virtual method set, never a regex fragment", async () => {
  // A command-line argument is interpolated into a base-signature pattern; the
  // METHODS gate narrows it to six literal identifiers so no regex can be
  // injected. The gate is the primary check, and the escape in the pattern
  // construction is the local backstop.
  await assert.rejects(
    () => deriveNativeVirtualMemberInvocationRegister({ sourceFiles, methodName: "beginUsing)(.*(" }),
    { code: "virtual_member_invocation_register_method_invalid" },
  );
  await assert.rejects(
    () => deriveNativeVirtualMemberInvocationRegister({ sourceFiles, methodName: "\\E" + "x" }),
    { code: "virtual_member_invocation_register_method_invalid" },
  );
  // The fixture Tool.cs declared only `beginUsing`; a real supported method
  // passes the METHODS gate (any base-signature failure downstream would be a
  // fixture/source error, never the injection code).
  assert.equal(
    (await deriveNativeVirtualMemberInvocationRegister({ sourceFiles, methodName: "beginUsing" })).methodName,
    "beginUsing",
  );
});
