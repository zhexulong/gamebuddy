import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { deriveNativeInteractionMechanismFamilyRegister } from "./lib/stardew-native-mechanism-family-register.mjs";
const sha = (value) => createHash("sha256").update(value).digest("hex");
function report(rows) {
  return {
    schemaVersion: 1,
    artifactKind: "native_interaction_mechanism_enumeration",
    target: { sha256: "a".repeat(64) },
    source: {
      sourceManifestSha256: "b".repeat(64),
      files: [...new Set(rows.map((row) => row.sourcePath))].map((relativePath) => ({
        relativePath,
        sha256: sha(relativePath),
        byteLength: 0,
      })),
    },
    enumeration: { mechanisms: rows },
  };
}
function row(id, category, family, sourcePath, extra = {}) {
  return {
    mechanismId: id,
    category,
    family,
    sourcePath,
    sourceLocator: { relativePath: sourcePath, startByte: 0, endByte: 1, sliceSha256: sha(id) },
    fileSyntaxState: "parse_clean",
    ...extra,
  };
}
test("family register partitions every raw syntax match exactly once without action semantics", () => {
  const output = deriveNativeInteractionMechanismFamilyRegister(
    report([
      row("a", "host-declaration-syntax", "host:update", "StardewValley/Locations/A.cs", { lexicalOwnerSyntax: "A" }),
      row("b", "host-declaration-syntax", "host:update", "StardewValley/Locations/B.cs", { lexicalOwnerSyntax: "B" }),
      row("c", "content-interpreter-syntax", "content:load", "StardewValley/Locations/A.cs", {
        lexicalMemberSyntax: "update",
      }),
      row("d", "content-interpreter-syntax", "content:load", "StardewValley/Menus/M.cs", {
        lexicalMemberSyntax: "update",
      }),
    ]),
  );
  assert.equal(output.inputMechanismCount, 4);
  assert.equal(output.familyCount, 3);
  assert.equal(new Set(output.families.flatMap((family) => family.memberIds)).size, 4);
  assert.equal(JSON.stringify(output).includes("primitiveId"), false);
  assert.equal(JSON.stringify(output).includes("actionId"), false);
});
