import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { withTestArtifactLock } from "./test-artifact-lock.mjs";
import { runCompiledTests, runScriptTests } from "./run-tests.mjs";

const hostRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

await withTestArtifactLock(async () => {
  // Use the internal implementation: the public build:test wrapper acquires
  // this same lock for standalone callers and would otherwise self-deadlock.
  await import("./build-test-artifact-locked.mjs");
  await runCompiledTests();
});

// Script-level tests include lock protocol tests that intentionally invoke
// public package scripts. They must run after the outer artifact lock closes.
if (process.env.GAMEBUDDY_HOST_TEST_COMPILED_ONLY !== "1") await runScriptTests();
