import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { access, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import test from "node:test";

import { DEFAULT_SUITE_TIMEOUT_MS, runBoundedChild } from "./test-supervisor.mjs";
import { assertHostVerificationArtifactManifest } from "./verification-artifact-manifest.mjs";

const hostRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm";

function spawnPnpm(command, args, options) {
  // Node on Windows needs a shell to launch a `.cmd` shim. /c accepts one
  // command string: passing separate argv values can make cmd treat an
  // unquoted package script as an invalid command before pnpm is started.
  const quote = (value) => /[\s"]/u.test(value) ? `"${value.replaceAll('"', '\\"')}"` : value;
  return spawn("cmd.exe", ["/d", "/s", "/c", [command, ...args].map(quote).join(" ")], options);
}

async function runScript(name) {
  try {
    return await runBoundedChild({
      command: pnpm,
      args: ["run", name],
      cwd: hostRoot,
      timeoutMs: DEFAULT_SUITE_TIMEOUT_MS,
      ...(process.platform === "win32" ? { spawnProcess: spawnPnpm } : {}),
    });
  } catch (error) {
    throw new Error(`package_script_${name}_failed:${error instanceof Error ? error.message : String(error)}`);
  }
}

test("package test and build:test serialize their complete dist-test ownership", async () => {
  await rm(resolve(hostRoot, "dist-test"), { recursive: true, force: true });
  const results = await Promise.allSettled([runScript("test"), runScript("build:test")]);
  const succeeded = results.filter((result) => result.status === "fulfilled");
  const rejected = results.filter((result) => result.status === "rejected");
  assert.equal(
    succeeded.length,
    1,
    `exactly one package script owns dist-test; failures=${rejected.map((result) => String(result.reason)).join("\n---\n")}`,
  );
  assert.equal(rejected.length, 1, "the competing package script fails closed instead of deleting active output");
  assert.match(String(rejected[0].reason), /host_test_artifact_already_in_use/);
  await assertHostVerificationArtifactManifest({ root: hostRoot });
  await access(resolve(hostRoot, "dist-test", "runtime.test.js"));
  await access(resolve(hostRoot, "dist-test", "action-registry.test.js"));
  await access(resolve(hostRoot, "dist-test", "test-fixtures", "windows-named-mutex-safety-seal-worker.js"));
  await assert.rejects(access(resolve(hostRoot, "dist-test", "test-fixtures", "windows-named-mutex-safety-seal-worker.ts")), { code: "ENOENT" });
  await assert.rejects(access(resolve(hostRoot, "dist", "test-fixtures", "windows-named-mutex-safety-seal-worker.js")), { code: "ENOENT" });
  await assert.rejects(access(resolve(hostRoot, "dist-test", "main.js")), { code: "ENOENT" });
  await assert.rejects(access(resolve(hostRoot, "dist-test", "dialogue-web-main.js")), { code: "ENOENT" });
});
