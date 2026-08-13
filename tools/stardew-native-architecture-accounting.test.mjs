import assert from "node:assert/strict";
import test from "node:test";
import { accountExactPaths, deriveArchitectureAccounting } from "./lib/stardew-native-architecture-accounting.mjs";

const sourceRecords = [
  { relativePath: "StardewValley/Game1.cs", text: "void Root() {} void Boundary() {}" },
  { relativePath: "Netcode/NetEvent0.cs", text: "class NetEvent0 {}" },
];
const roots = [
  { id: "root:fixture", family: "fixture-root", sourcePath: "StardewValley/Game1.cs", anchor: "void Root()" },
];
const boundaries = [
  {
    id: "boundary:fixture",
    family: "fixture-boundary",
    sourcePath: "StardewValley/Game1.cs",
    anchor: "void Boundary()",
  },
];

test("accounts every exact source/content input path without semantic classifications", () => {
  const report = deriveArchitectureAccounting({
    sourceRecords,
    contentPaths: ["Data/Example.xnb", "Maps/Example.xnb"],
    rootRegister: roots,
    boundaryRegister: boundaries,
    requiredRootFamilies: ["fixture-root"],
  });
  assert.equal(report.inputAccountingState, "source_and_content_input_accounting_complete");
  assert.equal(report.architectureAccountingState, "incomplete_pending_exhaustive_root_and_handoff_review");
  assert.equal(report.sourceAccounting.rows.length, 2);
  assert.equal(report.contentAccounting.rows.length, 2);
  assert.equal(report.sourceAccounting.unaccountedPathCount, 0);
  assert.equal(report.contentAccounting.multiplyAccountedPathCount, 0);
  assert.deepEqual(Object.keys(report).sort(), [
    "architectureAccountingState",
    "boundaryRegister",
    "contentAccounting",
    "inputAccountingState",
    "missingRootFamilies",
    "rootRegister",
    "sourceAccounting",
  ]);
});

test("fails closed when an architecture root family or exact source anchor is missing", () => {
  assert.throws(
    () =>
      deriveArchitectureAccounting({
        sourceRecords,
        contentPaths: ["Data/Example.xnb"],
        rootRegister: roots,
        boundaryRegister: boundaries,
        requiredRootFamilies: ["fixture-root", "missing-root"],
      }),
    { code: "architecture_root_family_missing" },
  );
  assert.throws(
    () =>
      deriveArchitectureAccounting({
        sourceRecords,
        contentPaths: ["Data/Example.xnb"],
        rootRegister: [{ ...roots[0], anchor: "not present" }],
        boundaryRegister: boundaries,
        requiredRootFamilies: ["fixture-root"],
      }),
    { code: "architecture_register_anchor_missing" },
  );
});

test("fails closed on duplicate or unsafe exact paths instead of silently dropping them", () => {
  assert.throws(
    () =>
      accountExactPaths({
        paths: ["Data/Example.xnb", "data/example.xnb"],
        ownerForPath: () => "fixture",
        kind: "content",
      }),
    { code: "architecture_paths_not_unique" },
  );
  assert.throws(
    () =>
      accountExactPaths({
        paths: ["../Data/Example.xnb"],
        ownerForPath: () => "fixture",
        kind: "content",
      }),
    { code: "architecture_path_invalid" },
  );
});
