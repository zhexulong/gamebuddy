import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { promisify } from "node:util";
import { withTestArtifactLock } from "./test-artifact-lock.mjs";
import { runCompiledTests, runScriptTests } from "./run-tests.mjs";

const execFileAsync = promisify(execFile);
const hostRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = resolve(hostRoot, "..");

async function prepareTestDependencies() {
  const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
  const bun = process.platform === "win32" ? "bun.cmd" : "bun";
  const commandOptions = { cwd: repositoryRoot, shell: process.platform === "win32", windowsHide: true };
  await execFileAsync(pnpm, ["--filter", "@gamebuddy/voice-protocol", "build"], commandOptions);
  await execFileAsync(bun, ["install", "--cwd", "../vendor/magic-context", "--frozen-lockfile"], {
    ...commandOptions,
    cwd: hostRoot,
  });
  await execFileAsync(bun, ["run", "--cwd", "../vendor/magic-context/packages/pi-plugin", "build"], {
    ...commandOptions,
    cwd: hostRoot,
  });
  const declaredArtifact = resolve(hostRoot, "node_modules", "@cortexkit", "pi-magic-context", "dist");
  if (!existsSync(declaredArtifact)) throw new Error("magic_context_declared_artifact_missing_after_build");
  await import("./sync-declared-magic-context-artifact.mjs");
}

await withTestArtifactLock(async () => {
  await prepareTestDependencies();
  // Use the internal implementation: the public build:test wrapper acquires
  // this same lock for standalone callers and would otherwise self-deadlock.
  await import("./build-test-artifact-locked.mjs");
  await runCompiledTests();
});

// Script-level tests include lock protocol tests that intentionally invoke
// public package scripts. They must run after the outer artifact lock closes.
if (process.env.GAMEBUDDY_HOST_TEST_COMPILED_ONLY !== "1") await runScriptTests();
