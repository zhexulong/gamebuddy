import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { validateNativeRouterExitClassifier } from "./lib/stardew-native-router-exit-classifier.mjs";
import { deriveNativeRouterInvocationInventory } from "./lib/stardew-native-router-invocation-inventory.mjs";

const source = `class Demo { void Route() { direct(); target.Dynamic(); local(); } void direct() {} void local() {} }`;
const inventory = await deriveNativeRouterInvocationInventory({
  source,
  relativePath: "Demo.cs",
  signature: "void Route()",
});
const fileHash = inventory.routerDeclaration.sourceFileSha256;
const loc = (needle) => {
  const bytes = Buffer.from(source);
  const startByte = bytes.indexOf(Buffer.from(needle));
  return {
    relativePath: "Demo.cs",
    startByte,
    endByte: startByte + Buffer.byteLength(needle),
    sliceSha256: createHash("sha256")
      .update(bytes.subarray(startByte, startByte + Buffer.byteLength(needle)))
      .digest("hex"),
    sourceFileSha256: fileHash,
  };
};
function valid() {
  return {
    schemaVersion: 1,
    artifactKind: "native_router_exit_classifier",
    routerDeclaration: inventory.routerDeclaration,
    records: inventory.invocations.map((invocation, index) =>
      index === 0
        ? {
            invocationId: invocation.invocationId,
            sourceLocator: invocation.sourceLocator,
            exitKind: "direct_source_handoff",
            targetDeclaration: loc("void direct()"),
            reason: "Exact source declaration.",
          }
        : index === 1
          ? {
              invocationId: invocation.invocationId,
              sourceLocator: invocation.sourceLocator,
              exitKind: "dynamic_dispatch_boundary",
              gapId: "gap:dynamic",
              possiblyGameplayBearing: true,
              reason: "Runtime receiver.",
            }
          : {
              invocationId: invocation.invocationId,
              sourceLocator: invocation.sourceLocator,
              exitKind: "source_local_mutation_region",
              regionLocator: inventory.routerDeclaration,
              reason: "Owned source region.",
            },
    ),
  };
}
test("requires one exact neutral exit disposition per router invocation", () => {
  const result = validateNativeRouterExitClassifier(valid(), { inventory });
  assert.equal(result.invocationCount, 3);
  assert.equal(result.blockingGapCount, 1);
  assert.deepEqual(result.blockingGapIds, ["gap:dynamic"]);
});
test("fails closed for silent invocation omission and public terms", () => {
  const missing = valid();
  missing.records.pop();
  assert.throws(() => validateNativeRouterExitClassifier(missing, { inventory }), {
    code: "router_exit_classifier_unclassified",
  });
  const forbidden = valid();
  forbidden.primitiveId = "no";
  assert.throws(() => validateNativeRouterExitClassifier(forbidden, { inventory }), {
    code: "router_exit_classifier_forbidden_field",
  });
});
