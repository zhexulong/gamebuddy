import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  findFoldedDebugCommandLiterals,
  parseDebugInputLiterals,
  scanFixtureSeeding,
} from "./fixture-seeding-gate.mjs";

const STARDEW_ROOT = fileURLToPath(new URL("../../../integrations/stardew", import.meta.url));

test("extracts parseDebugInput literals from C# source", () => {
  const source = `
    Game1.game1.parseDebugInput("RemoveDirt", null);
    Game1.game1.parseDebugInput("SpreadSeeds 745", null);
    Game1.game1.parseDebugInput($"Build \\"Slime Hutch\\" {x} {y}", null);
  `;
  const literals = parseDebugInputLiterals(source);
  assert.deepEqual(literals.slice(0, 2), ["RemoveDirt", "SpreadSeeds 745"]);
});

test("flags a folded argument-blind command (the 2026-10-04 live-run failure)", () => {
  // Reproduces the exact regression: SpreadDirt swallows "SpreadSeeds 745".
  const offenders = findFoldedDebugCommandLiterals('parseDebugInput("SpreadDirt SpreadSeeds 745")');
  assert.deepEqual(offenders, ["SpreadDirt SpreadSeeds 745"]);
  assert.deepEqual(findFoldedDebugCommandLiterals('parseDebugInput("RemoveDirt SpreadDirt SpreadSeeds 472")'), [
    "RemoveDirt SpreadDirt SpreadSeeds 472",
  ]);
});

test("accepts the two-call form and commands that legitimately take arguments", () => {
  assert.deepEqual(
    findFoldedDebugCommandLiterals(`
      parseDebugInput("RemoveDirt", null);
      parseDebugInput("SpreadDirt", null);
      parseDebugInput("SpreadSeeds 745", null);
      parseDebugInput("GrowCrops 8", null);
      parseDebugInput("Build \\"Slime Hutch\\" 10 4", null);
    `),
    [],
  );
});

test("the real Mod fixture partials seed with exactly one command per call", async () => {
  const scan = await scanFixtureSeeding({ stardewRoot: STARDEW_ROOT });
  assert.equal(scan.unreadable, false, "integrations/stardew must be readable");
  assert.ok(scan.scanned.length > 0, "at least one ModEntry.Fixtures*.cs partial must exist");
  assert.deepEqual(
    scan.offenders,
    [],
    `argument-blind debug commands must not swallow a following command: ${JSON.stringify(scan.offenders)}`,
  );
});

test("the scan reports an unreadable root instead of passing silently", async () => {
  const scan = await scanFixtureSeeding({ stardewRoot: joinMissing() });
  assert.equal(scan.unreadable, true);
  assert.deepEqual(scan.offenders, []);
});

function joinMissing() {
  return fileURLToPath(new URL("./definitely-not-a-directory", import.meta.url));
}
