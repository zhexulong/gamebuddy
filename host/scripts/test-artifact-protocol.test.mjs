import assert from "node:assert/strict";
import { access, readFile, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { withTestArtifactLock } from "./test-artifact-lock.mjs";
import test from "node:test";

import { DEFAULT_SUITE_TIMEOUT_MS, runBoundedChild } from "@gamebuddy/game-action-devkit/process-supervisor";
import { assertHostVerificationArtifactManifest } from "./verification-artifact-manifest.mjs";

const hostRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pnpmCli = process.platform === "win32"
  ? resolve(process.env.APPDATA ?? resolve(process.env.USERPROFILE ?? hostRoot, "AppData", "Roaming"), "npm", "node_modules", "pnpm", "bin", "pnpm.cjs")
  : undefined;


async function runScript(name) {
  try {
    return await runBoundedChild({
      command: pnpmCli ? process.execPath : "pnpm",
      args: pnpmCli ? [pnpmCli, "run", name] : ["run", name],
      cwd: hostRoot,
      timeoutMs: DEFAULT_SUITE_TIMEOUT_MS,
      spawnOptions: { env: { ...process.env, GAMEBUDDY_HOST_TEST_COMPILED_ONLY: "1" } },
    });
  } catch (error) {
    throw new Error(`package_script_${name}_failed:${error instanceof Error ? error.message : String(error)}`);
  }
}

test("package test and build:test serialize their complete dist-test ownership", async () => {
  const lockPath = resolve(hostRoot, ".test-artifact.lock");
  // A valid, live lock is the deterministic contention fixture. Acquire it
  // through the production protocol before touching dist-test, then keep the
  // exact owner alive while both public scripts prove they fail closed.
  await withTestArtifactLock(async () => {
    await rm(resolve(hostRoot, "dist-test"), { recursive: true, force: true });
    const ownedLockBytes = await readFile(lockPath);
    const results = await Promise.allSettled([runScript("test"), runScript("build:test")]);
    assert.equal(results.filter((result) => result.status === "fulfilled").length, 0);
    assert.equal(results.filter((result) => result.status === "rejected").length, 2);
    for (const result of results) {
      assert.equal(result.status, "rejected");
      assert.match(String(result.reason), /host_test_artifact_already_in_use/);
    }
    await assert.rejects(access(resolve(hostRoot, "dist-test")), { code: "ENOENT" });
    // Contenders must preserve the live owner's exact bytes; in particular,
    // they must never replace it with a malformed or newly generated record.
    assert.deepEqual(await readFile(lockPath), ownedLockBytes);
  }, { lockPath });
  // One uncontended invocation must still publish the complete verification
  // artifact. This is intentionally sequential: contention is checked above.
  await runScript("build:test");
  await assertHostVerificationArtifactManifest({ root: hostRoot });
  await access(resolve(hostRoot, "dist-test", "runtime.test.js"));
  await access(resolve(hostRoot, "dist-test", "action-registry.test.js"));
  await access(resolve(hostRoot, "dist-test", "test-fixtures", "windows-named-mutex-safety-seal-worker.js"));
  await assert.rejects(access(resolve(hostRoot, "dist-test", "test-fixtures", "windows-named-mutex-safety-seal-worker.ts")), { code: "ENOENT" });
  await assert.rejects(access(resolve(hostRoot, "dist", "test-fixtures", "windows-named-mutex-safety-seal-worker.js")), { code: "ENOENT" });
  await assert.rejects(access(resolve(hostRoot, "dist-test", "main.js")), { code: "ENOENT" });
  await assert.rejects(access(resolve(hostRoot, "dist-test", "dialogue-web-main.js")), { code: "ENOENT" });
  const productionMaterializer = await readFile(resolve(hostRoot, "src", "continuity-semantic-game-runtime-materializer", "continuity-semantic-game-runtime-materializer.ts"), "utf8");
  const testMaterializer = await readFile(resolve(hostRoot, "dist-test", "continuity-semantic-game-runtime-materializer", "continuity-semantic-game-runtime-materializer.js"), "utf8");
  assert.doesNotMatch(productionMaterializer, /materializer\.test-support/);
  assert.match(testMaterializer, /recordMaterializedProductionRuntimeForTest/);
  assert.match(testMaterializer, /forgetMaterializedProductionRuntimeForTest/);
});

test("a raced cross-process candidate never leaves a malformed published lock", async () => {
  const lockPath = resolve(hostRoot, `.test-artifact-race-${process.pid}-${Date.now()}.lock`);
  const worker = resolve(hostRoot, "scripts/test-artifact-protocol-worker.mjs");
  const result = await runBoundedChild({
    command: process.execPath,
    args: [worker, "raced-contender", lockPath],
    cwd: hostRoot,
    timeoutMs: 10_000,
  });
  assert.match(result.stdout + result.stderr, /race_complete/u);
  // The worker owns and releases this lock through withTestArtifactLock. Do
  // not unlink the pathname here: if a replacement owner wins after a worker
  // failure, an unconditional finally cleanup would delete that owner.
  await assert.rejects(access(lockPath), { code: "ENOENT" });
});
