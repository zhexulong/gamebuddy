import { execFile } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { promisify } from "node:util";
import { withTestArtifactLock } from "./test-artifact-lock.mjs";
import { runCompiledTests, runScriptTests } from "./run-tests.mjs";

const execFileAsync = promisify(execFile);
const hostRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = resolve(hostRoot, "..");
const vendorPluginRootPath = resolve(repositoryRoot, "vendor", "magic-context", "packages", "pi-plugin");
const cmdMetacharacter = /[&|<>^()%!\r\n]/;

// These are the only commands this suite is permitted to invoke through cmd.
// They stay as argv-like fixed data so no caller-controlled shell text exists.
// `vendorRebuild` marks the steps whose only product is the vendored pi-plugin
// build output, so they are the steps the presence of that output makes
// redundant.
const testDependencyCommands = Object.freeze([
  Object.freeze({ step: "voice_protocol_build", command: "pnpm", args: Object.freeze(["--filter", "@gamebuddy/voice-protocol", "build"]), cwd: repositoryRoot, vendorRebuild: false }),
  Object.freeze({ step: "magic_context_vendor_install", command: "bun", args: Object.freeze(["install", "--cwd", "../vendor/magic-context", "--frozen-lockfile"]), cwd: hostRoot, vendorRebuild: true }),
  Object.freeze({ step: "magic_context_vendor_build", command: "bun", args: Object.freeze(["run", "--cwd", "../vendor/magic-context/packages/pi-plugin", "build"]), cwd: hostRoot, vendorRebuild: true }),
]);
const vendorRebuildCommands = testDependencyCommands.filter((entry) => entry.vendorRebuild);

/**
 * The vendor build output the compiled suite resolves: the vendored pi-plugin
 * package's declared `.` import entry (the file `resolveMagicContextExtensionEntry`
 * loads) and its `tavern`/`memory` subpath exports, each as the runtime bundle
 * and the declaration the Host typechecks against. `dist/index.d.ts` is absent
 * on purpose: the package declares no `types` for its `.` export and no source
 * imports that entry, so a successful build never emits it.
 */
const vendorBuildEntries = Object.freeze([
  "dist/index.js",
  "dist/tavern/index.js",
  "dist/tavern/index.d.ts",
  "dist/memory/index.js",
  "dist/memory/index.d.ts",
]);

/**
 * Named, bounded skip reason for the vendored pi-plugin rebuild.
 *
 * It is a condition on the artifact the step produces, never an operator
 * switch: a checkout that lacks that output - a fresh clone, or a CI job whose
 * own vendor build has not run - still runs the rebuild, so no path can skip
 * work that was never done.
 */
export const vendorRebuildSkipReason =
  "the vendored pi-plugin build output this suite resolves is already present, so the fixed bun install and pi-plugin build would only reproduce it";

function isRegularFile(path) {
  return statSync(path, { throwIfNoEntry: false })?.isFile() === true;
}

function vendorBuildPresent(vendorPluginRoot) {
  return vendorBuildEntries.every((entry) => isRegularFile(resolve(vendorPluginRoot, entry)));
}

function fixedWindowsCommandToken(token) {
  // The dependency manifest contains only fixed argv tokens. cmd's `call`
  // treats a quoted first argument differently, so do not quote these tokens.
  if (typeof token !== "string" || !/^[A-Za-z0-9@._/:=-]+$/.test(token))
    throw new Error("invalid_test_dependency_command_token");
  return token;
}

function windowsCommandProcessor(comSpec) {
  if (typeof comSpec !== "string" || !/^[A-Za-z]:\\.+\.exe$/i.test(comSpec) || comSpec.includes("\0") || cmdMetacharacter.test(comSpec))
    throw new Error("test_dependency_command_processor_invalid");
  return comSpec;
}

const bunExecutableRemedy =
  "set GAMEBUDDY_BUN_EXECUTABLE to the absolute path of an existing bun.exe (the file oven-sh/setup-bun installs, or %APPDATA%\\npm\\node_modules\\bun\\bin\\bun.exe); the npm bun.ps1 shim on PATH is deliberately rejected because this runner invokes fixed argv and cannot execute it";

function configuredBunExecutable(bunExecutable) {
  if (bunExecutable === undefined || bunExecutable === "")
    throw new Error(`test_dependency_bun_executable_unset: ${bunExecutableRemedy}`);
  if (typeof bunExecutable !== "string" || !/^[A-Za-z]:\\.+\.exe$/i.test(bunExecutable) || bunExecutable.includes("\0") || cmdMetacharacter.test(bunExecutable))
    throw new Error(`test_dependency_bun_executable_invalid: ${bunExecutableRemedy}`);
  if (!isRegularFile(bunExecutable))
    throw new Error(`test_dependency_bun_executable_missing: ${bunExecutable} is not an existing file; ${bunExecutableRemedy}`);
  return bunExecutable;
}

function plannedInvocation(entry, { platform, comSpec, bunExecutable }) {
  if (platform !== "win32") return Object.freeze({ command: entry.command, args: entry.args, cwd: entry.cwd });
  if (entry.command === "bun") {
    return Object.freeze({
      command: configuredBunExecutable(bunExecutable),
      args: entry.args,
      cwd: entry.cwd,
    });
  }
  // cmd parses a quoted token after `call` as a literal executable name.
  // The manifest is strictly validated to fixed, whitespace-free tokens, so
  // unquoted concatenation preserves its argv semantics without shell input.
  const command = `${fixedWindowsCommandToken(entry.command)}.cmd`;
  const commandText = `call ${command} ${entry.args.map(fixedWindowsCommandToken).join(" ")}`;
  return Object.freeze({
    command: windowsCommandProcessor(comSpec),
    args: Object.freeze(["/d", "/s", "/c", commandText]),
    cwd: entry.cwd,
  });
}

/**
 * Return the fixed dependency-preparation plan for this machine: the
 * invocations to run, and the named reason the vendored pi-plugin rebuild was
 * dropped when its build output is already on disk.
 *
 * Windows requires an absolute CI-provided Bun executable. The vendored
 * rebuild is Bun's only consumer here, so Bun is validated exactly when that
 * rebuild is planned - a checkout that already carries the output does not fail
 * on an executable it would never invoke.
 */
export function testDependencyInvocations({
  platform = process.platform,
  comSpec = process.env.ComSpec,
  bunExecutable = process.env.GAMEBUDDY_BUN_EXECUTABLE,
  vendorPluginRoot = vendorPluginRootPath,
} = {}) {
  const vendorRebuildNeeded = !vendorBuildPresent(vendorPluginRoot);
  return Object.freeze({
    skipReason: vendorRebuildNeeded ? null : vendorRebuildSkipReason,
    invocations: Object.freeze(
      testDependencyCommands
        .filter((entry) => vendorRebuildNeeded || !entry.vendorRebuild)
        .map((entry) => plannedInvocation(entry, { platform, comSpec, bunExecutable })),
    ),
  });
}

/**
 * The one line a skipped rebuild prints: name the reason and the fixed commands
 * the skip dropped, because a silent skip reads as a step that ran.
 */
export function vendorRebuildSkipReport() {
  const skipped = vendorRebuildCommands
    .map((entry) => `${entry.step} (${[entry.command, ...entry.args].join(" ")})`)
    .join("; ");
  return `host_test_dependency_step_skipped:reason=${vendorRebuildSkipReason}:skipped=${skipped}`;
}

async function prepareTestDependencies() {
  const { skipReason, invocations } = testDependencyInvocations();
  if (skipReason !== null) console.error(vendorRebuildSkipReport());
  for (const invocation of invocations) {
    await execFileAsync(invocation.command, invocation.args, { cwd: invocation.cwd, windowsHide: true });
  }
  const declaredArtifact = resolve(hostRoot, "node_modules", "@cortexkit", "pi-magic-context", "dist");
  if (!existsSync(declaredArtifact)) throw new Error("magic_context_declared_artifact_missing_after_build");
  await import("./sync-declared-magic-context-artifact.mjs");
}

/**
 * The Windows test preflight, run as a prerequisite rather than as a phase.
 *
 * It is the gate that says a host test could even pass on the machine this product ships to, so a red
 * one means no phase can be trusted: nothing runs, and the summary says what was missing instead of
 * turning a missing capability into a pile of confusing phase failures.
 */
async function runTestPreflight() {
  await execFileAsync(process.execPath, [resolve(repositoryRoot, "tools", "check-host-windows-test-preflight.mjs")], {
    cwd: repositoryRoot,
    windowsHide: true,
  });
}

/**
 * The phases this suite runs, in order. `GAMEBUDDY_HOST_TEST_COMPILED_ONLY=1` drops the script phase; that
 * is the only thing that can narrow the suite, and the phase summary carries the count it produced.
 */
function testPhases({ env, failFast }) {
  const phases = [
    {
      suite: "compiled",
      run: () =>
        withTestArtifactLock(async () => {
          await prepareTestDependencies();
          // Use the internal implementation: the public build:test wrapper acquires
          // this same lock for standalone callers and would otherwise self-deadlock.
          await import("./build-test-artifact-locked.mjs");
          await runCompiledTests({ keepGoing: !failFast });
        }),
    },
    // Script-level tests include lock protocol tests that intentionally invoke
    // public package scripts. They must run after the outer artifact lock closes.
    { suite: "scripts", run: () => runScriptTests({ keepGoing: !failFast }) },
  ];
  return env.GAMEBUDDY_HOST_TEST_COMPILED_ONLY === "1" ? phases.filter((phase) => phase.suite === "compiled") : phases;
}

/** What this run covered, published on every exit path - the same reading the batch runner prints per phase. */
function phasesSummaryLine({ phasesTotal, notRun, failedPhases, wallMs }) {
  const remaining = notRun.length;
  const parts = [`host_test_suite_phases:phases examined ${phasesTotal - remaining} of ${phasesTotal}`];
  if (remaining > 0) parts.push(`remaining ${remaining} not run`, `phases_not_run ${remaining}`);
  parts.push(`failed ${failedPhases}`, `wall_ms ${wallMs}`);
  return parts.join(" · ");
}

/**
 * Run every phase and publish what ran.
 *
 * Every phase runs by default; `--fail-fast` is the interactive exception. The old default stopped at the
 * first failing phase, so the exit code answered "did the first failing phase fail" - which cannot be told
 * from "everything passed before we stopped". That is the same defect the batch runner had one level down.
 */
export async function runTestPhases(phases, { failFast = false, now = Date.now } = {}) {
  const startedAtMs = now();
  const failures = [];
  const notRun = [];
  for (const [index, phase] of phases.entries()) {
    try {
      await phase.run();
      console.error(`host_test_phase_ok:suite=${phase.suite}`);
    } catch (error) {
      failures.push({ suite: phase.suite, error });
      if (failFast) {
        for (let rest = index + 1; rest < phases.length; rest += 1) notRun.push({ suite: phases[rest].suite, reason: "fail_fast" });
        break;
      }
    }
  }
  const summary = phasesSummaryLine({ phasesTotal: phases.length, notRun, failedPhases: failures.length, wallMs: now() - startedAtMs });
  const notRunLines = notRun.map((entry) => `host_test_suite_phase_not_run:suite=${entry.suite}:reason=${entry.reason}`);
  for (const line of notRunLines) console.error(line);
  console.error(summary);
  if (failures.length === 0 && notRun.length === 0) return;
  // Each phase's own message already names its files, and the per-batch lines above carry each file's own
  // reason; this aggregate is what says which phases produced them.
  throw new Error(
    [
      `test_suite_failed:${failures.length} phase(s): ${failures.map((entry) => entry.suite).join(", ")}`,
      ...failures.map((entry) => `${entry.suite}: ${entry.error instanceof Error ? entry.error.message : String(entry.error)}`),
      ...notRunLines,
      summary,
    ].join("\n"),
  );
}

export async function main({ argv = process.argv, env = process.env, preflight = runTestPreflight, phases = undefined } = {}) {
  const failFast = argv.includes("--fail-fast");
  const planned = phases ?? testPhases({ env, failFast });
  try {
    await preflight();
  } catch (error) {
    console.error(`host_test_suite_phases:not_run: phases 0 of ${planned.length}: preflight failed`);
    throw error;
  }
  await runTestPhases(planned, { failFast });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error.stack ?? error.message);
    process.exitCode = 1;
  });
}
