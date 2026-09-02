import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import test from "node:test";

import { testDependencyInvocations } from "./run-test-suite.mjs";

const hostRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = resolve(hostRoot, "..");

test("Windows dependency preparation explicitly mediates only fixed pnpm and bun commands through ComSpec", () => {
  const invocations = testDependencyInvocations({ platform: "win32", comSpec: "C:\\Windows\\System32\\cmd.exe" });
  assert.deepEqual(invocations.map(({ command, args, cwd }) => ({ command, args: args.slice(0, 3), cwd })), [
    { command: "C:\\Windows\\System32\\cmd.exe", args: ["/d", "/s", "/c"], cwd: repositoryRoot },
    { command: "C:\\Windows\\System32\\cmd.exe", args: ["/d", "/s", "/c"], cwd: hostRoot },
    { command: "C:\\Windows\\System32\\cmd.exe", args: ["/d", "/s", "/c"], cwd: hostRoot },
  ]);
  assert.deepEqual(invocations.map(({ args }) => args[3]), [
    'call "pnpm.cmd" "--filter" "@gamebuddy/voice-protocol" "build"',
    'call "bun.cmd" "install" "--cwd" "../vendor/magic-context" "--frozen-lockfile"',
    'call "bun.cmd" "run" "--cwd" "../vendor/magic-context/packages/pi-plugin" "build"',
  ]);
});

test("Windows dependency preparation rejects an unsafe command processor", () => {
  assert.throws(
    () => testDependencyInvocations({ platform: "win32", comSpec: "C:\\Windows\\System32\\cmd.exe & whoami" }),
    /test_dependency_command_processor_invalid/,
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
