import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import test from "node:test";

import { testDependencyInvocations } from "./run-test-suite.mjs";

const hostRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = resolve(hostRoot, "..");

test("Windows dependency preparation invokes fixed pnpm through ComSpec and a CI-provided Bun executable", () => {
  const invocations = testDependencyInvocations({
    platform: "win32",
    comSpec: "C:\\Windows\\System32\\cmd.exe",
    bunExecutable: process.execPath,
  });
  assert.deepEqual({ command: invocations[0].command, args: invocations[0].args.slice(0, 3), cwd: invocations[0].cwd }, {
    command: "C:\\Windows\\System32\\cmd.exe",
    args: ["/d", "/s", "/c"],
    cwd: repositoryRoot,
  });
  assert.equal(invocations[1].cwd, hostRoot);
  assert.equal(invocations[2].cwd, hostRoot);
  assert.equal(invocations[0].args[3], "call pnpm.cmd --filter @gamebuddy/voice-protocol build");
  assert.equal(invocations[1].command, process.execPath);
  assert.equal(invocations[2].command, process.execPath);
  assert.deepEqual(invocations[1].args, ["install", "--cwd", "../vendor/magic-context", "--frozen-lockfile"]);
  assert.deepEqual(invocations[2].args, ["run", "--cwd", "../vendor/magic-context/packages/pi-plugin", "build"]);
});


test("Windows dependency preparation rejects an unsafe command processor", () => {
  assert.throws(
    () => testDependencyInvocations({ platform: "win32", comSpec: "C:\\Windows\\System32\\cmd.exe & whoami", bunExecutable: process.execPath }),
    /test_dependency_command_processor_invalid/,
  );
});

test("Windows dependency preparation requires a fixed existing Bun executable", () => {
  assert.throws(
    () => testDependencyInvocations({ platform: "win32", comSpec: "C:\\Windows\\System32\\cmd.exe", bunExecutable: "" }),
    /test_dependency_bun_executable_invalid/,
  );
  assert.throws(
    () => testDependencyInvocations({
      platform: "win32",
      comSpec: "C:\\Windows\\System32\\cmd.exe",
      bunExecutable: "C:\\missing\\bun.exe",
    }),
    /test_dependency_bun_executable_missing/,
  );
});

test("non-Windows dependency preparation retains direct fixed executable invocations", () => {
  const invocations = testDependencyInvocations({ platform: "linux" });
  assert.deepEqual(invocations, [
    { command: "pnpm", args: ["--filter", "@gamebuddy/voice-protocol", "build"], cwd: repositoryRoot },
    { command: "bun", args: ["install", "--cwd", "../vendor/magic-context", "--frozen-lockfile"], cwd: hostRoot },
    { command: "bun", args: ["run", "--cwd", "../vendor/magic-context/packages/pi-plugin", "build"], cwd: hostRoot },
  ]);
});
