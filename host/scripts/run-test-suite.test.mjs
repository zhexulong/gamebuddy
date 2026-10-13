import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { testDependencyInvocations, vendorRebuildSkipReason, vendorRebuildSkipReport } from "./run-test-suite.mjs";

const hostRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = resolve(hostRoot, "..");
const windowsComSpec = "C:\\Windows\\System32\\cmd.exe";
// Spelled out rather than imported from the runner, so a runner list that grows
// makes the "already present" fixture incomplete and fails the skip assertion
// instead of silently following it.
const vendorBuildEntries = Object.freeze([
  "dist/index.js",
  "dist/tavern/index.js",
  "dist/tavern/index.d.ts",
  "dist/memory/index.js",
  "dist/memory/index.d.ts",
]);

/** Materialize a vendored pi-plugin root carrying exactly `entries`. */
async function withVendorPluginRoot(entries, run) {
  const vendorPluginRoot = await mkdtemp(join(tmpdir(), "run-test-suite-vendor-"));
  try {
    for (const entry of entries) {
      const file = join(vendorPluginRoot, entry);
      await mkdir(dirname(file), { recursive: true });
      await writeFile(file, "");
    }
    return await run(vendorPluginRoot);
  } finally {
    await rm(vendorPluginRoot, { recursive: true, force: true });
  }
}

test("the skip report names the reason and the two commands it dropped", () => {
  const report = vendorRebuildSkipReport();
  assert.match(report, /^host_test_dependency_step_skipped:reason=/);
  assert.ok(report.includes(vendorRebuildSkipReason));
  assert.ok(report.includes("magic_context_vendor_install (bun install --cwd ../vendor/magic-context --frozen-lockfile)"));
  assert.ok(report.includes("magic_context_vendor_build (bun run --cwd ../vendor/magic-context/packages/pi-plugin build)"));
});

test("Windows dependency preparation invokes fixed pnpm through ComSpec and a CI-provided Bun executable", async () => {
  await withVendorPluginRoot([], (vendorPluginRoot) => {
    const { skipReason, invocations } = testDependencyInvocations({
      platform: "win32",
      comSpec: windowsComSpec,
      bunExecutable: process.execPath,
      vendorPluginRoot,
    });
    assert.equal(skipReason, null);
    assert.deepEqual({ command: invocations[0].command, args: invocations[0].args.slice(0, 3), cwd: invocations[0].cwd }, {
      command: windowsComSpec,
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
});

test("a checkout already carrying the vendor build output skips the rebuild under the named reason", async () => {
  await withVendorPluginRoot(vendorBuildEntries, (vendorPluginRoot) => {
    // No bunExecutable override: the skipped rebuild is Bun's only consumer, so
    // the developer-machine path must not fail on an executable it never uses.
    const { skipReason, invocations } = testDependencyInvocations({ platform: "win32", comSpec: windowsComSpec, vendorPluginRoot });
    assert.equal(skipReason, vendorRebuildSkipReason);
    assert.deepEqual(invocations.map((entry) => entry.command), [windowsComSpec]);
    assert.equal(invocations[0].args[3], "call pnpm.cmd --filter @gamebuddy/voice-protocol build");
  });
});

test("a checkout without the complete vendor build output plans the rebuild", async () => {
  for (const entries of [[], vendorBuildEntries.slice(0, -1)]) {
    await withVendorPluginRoot(entries, (vendorPluginRoot) => {
      const { skipReason, invocations } = testDependencyInvocations({
        platform: "win32",
        comSpec: windowsComSpec,
        bunExecutable: process.execPath,
        vendorPluginRoot,
      });
      assert.equal(skipReason, null);
      assert.deepEqual(invocations.map((entry) => entry.command), [windowsComSpec, process.execPath, process.execPath]);
      assert.deepEqual(invocations[1].args, ["install", "--cwd", "../vendor/magic-context", "--frozen-lockfile"]);
      assert.deepEqual(invocations[2].args, ["run", "--cwd", "../vendor/magic-context/packages/pi-plugin", "build"]);
    });
  }
});

test("Windows dependency preparation rejects an unsafe command processor", async () => {
  await withVendorPluginRoot([], (vendorPluginRoot) => {
    assert.throws(
      () => testDependencyInvocations({
        platform: "win32",
        comSpec: "C:\\Windows\\System32\\cmd.exe & whoami",
        bunExecutable: process.execPath,
        vendorPluginRoot,
      }),
      /test_dependency_command_processor_invalid/,
    );
  });
});

test("a missing or unusable Bun names GAMEBUDDY_BUN_EXECUTABLE and what it must point at", async () => {
  await withVendorPluginRoot([], (vendorPluginRoot) => {
    assert.throws(
      () => testDependencyInvocations({ platform: "win32", comSpec: windowsComSpec, bunExecutable: "", vendorPluginRoot }),
      /test_dependency_bun_executable_unset: set GAMEBUDDY_BUN_EXECUTABLE to the absolute path of an existing bun\.exe/,
    );
    assert.throws(
      () => testDependencyInvocations({ platform: "win32", comSpec: windowsComSpec, bunExecutable: "bun.ps1", vendorPluginRoot }),
      /test_dependency_bun_executable_invalid: set GAMEBUDDY_BUN_EXECUTABLE to the absolute path of an existing bun\.exe/,
    );
    assert.throws(
      () => testDependencyInvocations({
        platform: "win32",
        comSpec: windowsComSpec,
        bunExecutable: "C:\\missing\\bun.exe",
        vendorPluginRoot,
      }),
      /test_dependency_bun_executable_missing: C:\\missing\\bun\.exe is not an existing file; set GAMEBUDDY_BUN_EXECUTABLE/,
    );
  });
});

test("non-Windows dependency preparation retains direct fixed executable invocations", async () => {
  await withVendorPluginRoot([], (vendorPluginRoot) => {
    const { skipReason, invocations } = testDependencyInvocations({ platform: "linux", vendorPluginRoot });
    assert.equal(skipReason, null);
    assert.deepEqual(invocations, [
      { command: "pnpm", args: ["--filter", "@gamebuddy/voice-protocol", "build"], cwd: repositoryRoot },
      { command: "bun", args: ["install", "--cwd", "../vendor/magic-context", "--frozen-lockfile"], cwd: hostRoot },
      { command: "bun", args: ["run", "--cwd", "../vendor/magic-context/packages/pi-plugin", "build"], cwd: hostRoot },
    ]);
  });
});
