import assert from "node:assert/strict";
import test from "node:test";
import { runStandaloneExtractionRehearsal } from "../src/standalone-extraction-rehearsal.mjs";

test("materializes and executes the locked standalone package without former-root reads", { timeout: 240_000 }, async () => {
  const report = await runStandaloneExtractionRehearsal();
  assert.deepEqual(report, {
    schema: "gamebuddy-stardew-standalone-extraction-rehearsal/v1",
    status: "passed",
    devkitSource: "packed-artifact",
    dependencyInstall: "frozen",
    formerRootPolicy: "runtime-denied",
    legacyClosureExecuted: false,
    nodeVersion: "v24.13.0",
    pnpmVersion: "11.1.3",
    dotnetVersion: "8.0.424",
    actionCiStatus: "deterministic-ci",
    entries: [
      "equip-tool-contract-check",
      "scaffold-contract",
       "action-surface-check",
       "action-surface-export-check",
       "action-source-projection-check",
      "static-production-admission",
      "package-deterministic-tests",
    ],
  });
});
