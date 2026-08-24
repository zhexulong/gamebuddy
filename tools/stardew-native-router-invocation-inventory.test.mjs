import assert from "node:assert/strict";
import test from "node:test";
import { deriveNativeRouterInvocationInventory } from "./lib/stardew-native-router-invocation-inventory.mjs";

const source = `class Demo { void Route() { before(); target.Call(1); if (ok) { after(); } } void Other() { other(); } }`;
test("inventories invocation syntax in source order only within the exact router body", async () => {
  const report = await deriveNativeRouterInvocationInventory({
    source,
    relativePath: "Demo.cs",
    signature: "void Route()",
  });
  assert.equal(report.syntaxInventoryState, "parse_clean_visible_invocations");
  assert.equal(report.routerParseGaps.length, 0);
  assert.equal(report.invocationCount, 3);
  assert.equal(report.invocations[0].sequence, 0);
  assert.equal(report.invocations[1].calleeSyntaxKind, "member_access_expression");
  assert.equal(report.invocations[2].resolutionState, "not_resolved_by_syntax_inventory");
  assert.doesNotMatch(
    Buffer.from(source).subarray(report.routerDeclaration.startByte, report.routerDeclaration.endByte).toString("utf8"),
    /other/,
  );
});
test("retains an exact invocation-free method as an empty syntax inventory", async () => {
  const report = await deriveNativeRouterInvocationInventory({
    source: `class Demo { void Empty() { int x = 1; } }`,
    relativePath: "Demo.cs",
    signature: "void Empty()",
  });
  assert.equal(report.invocationCount, 0);
  assert.deepEqual(report.invocations, []);
});
test("fails closed for a non-unique source router signature", async () => {
  await assert.rejects(
    () =>
      deriveNativeRouterInvocationInventory({
        source: `${source}\n${source}`,
        relativePath: "Demo.cs",
        signature: "void Route()",
      }),
    { code: "router_inventory_method_anchor_missing" },
  );
});
