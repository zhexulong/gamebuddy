import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { main, runTestPhases, testDependencyInvocations, vendorRebuildSkipReason, vendorRebuildSkipReport } from "./run-test-suite.mjs";

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
/** Run `body` with console.error captured, so a summary line can be asserted byte for byte. */
async function withCapturedErrorLines(body) {
  const lines = [];
  const originalError = console.error;
  console.error = (line) => lines.push(line);
  try {
    return { lines, outcome: await body().then(() => null, (error) => error) };
  } finally {
    console.error = originalError;
  }
}

/** A phase that records nothing and either passes or throws its own named failure. */
function fixturePhase(suite, { fails = false, ran } = {}) {
  return {
    suite,
    run: async () => {
      ran?.push(suite);
      if (fails) throw new Error(`fixture_phase_failed:${suite}`);
    },
  };
}

test("every phase runs by default and the summary says so", async () => {
  const { lines, outcome } = await withCapturedErrorLines(() => runTestPhases([fixturePhase("compiled"), fixturePhase("scripts")], { now: () => 0 }));
  assert.equal(outcome, null);
  assert.deepEqual(lines, [
    "host_test_phase_ok:suite=compiled",
    "host_test_phase_ok:suite=scripts",
    "host_test_suite_phases:phases examined 2 of 2 · failed 0 · wall_ms 0",
  ]);
});

test("a failing phase does not hide the phase after it", async () => {
  const ran = [];
  const { lines, outcome } = await withCapturedErrorLines(() =>
    runTestPhases([fixturePhase("compiled", { fails: true, ran }), fixturePhase("scripts", { fails: true, ran })], { now: () => 0 }),
  );
  assert.deepEqual(ran, ["compiled", "scripts"], "the phase after a failing one still runs");
  assert.match(outcome.message, /test_suite_failed:2 phase\(s\): compiled, scripts/u);
  assert.match(outcome.message, /compiled: fixture_phase_failed:compiled/u);
  assert.match(outcome.message, /scripts: fixture_phase_failed:scripts/u);
  assert.match(outcome.message, /phases examined 2 of 2 · failed 2/u, "the error carries the summary too");
  assert.deepEqual(lines, ["host_test_suite_phases:phases examined 2 of 2 · failed 2 · wall_ms 0"]);
});

test("a compiled failure still runs the script phase", async () => {
  const ran = [];
  const { lines, outcome } = await withCapturedErrorLines(() =>
    runTestPhases([fixturePhase("compiled", { fails: true, ran }), fixturePhase("scripts", { ran })], { now: () => 0 }),
  );
  assert.deepEqual(ran, ["compiled", "scripts"]);
  assert.match(outcome.message, /test_suite_failed:1 phase\(s\): compiled/u);
  assert.deepEqual(lines, [
    "host_test_phase_ok:suite=scripts",
    "host_test_suite_phases:phases examined 2 of 2 · failed 1 · wall_ms 0",
  ]);
});

test("--fail-fast ends at the first failing phase and names the phase it did not run", async () => {
  const ran = [];
  const { lines, outcome } = await withCapturedErrorLines(() =>
    runTestPhases([fixturePhase("compiled", { fails: true, ran }), fixturePhase("scripts", { ran })], {
      failFast: true,
      now: () => 0,
    }),
  );
  assert.deepEqual(ran, ["compiled"]);
  assert.match(outcome.message, /host_test_suite_phase_not_run:suite=scripts:reason=fail_fast/u);
  assert.deepEqual(lines, [
    "host_test_suite_phase_not_run:suite=scripts:reason=fail_fast",
    "host_test_suite_phases:phases examined 1 of 2 · remaining 1 not run · phases_not_run 1 · failed 1 · wall_ms 0",
  ]);
});

test("a red preflight blocks every phase and keeps the preflight's own reason", async () => {
  const ran = [];
  const { lines, outcome } = await withCapturedErrorLines(() =>
    main({
      argv: [],
      preflight: async () => {
        throw new Error("host_windows_test_preflight:blocked");
      },
      phases: [fixturePhase("compiled", { ran }), fixturePhase("scripts", { ran })],
    }),
  );
  assert.match(outcome.message, /host_windows_test_preflight:blocked/u, "the preflight's own reason survives");
  assert.deepEqual(ran, [], "no phase runs behind a red preflight");
  assert.deepEqual(lines, ["host_test_suite_phases:not_run: phases 0 of 2: preflight failed"]);
});
