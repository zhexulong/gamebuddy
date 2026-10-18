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

export async function main() {
  // `--keep-going` means every phase runs and every failing file is reported, not just the first
  // phase's. Without it each phase keeps its own fail-fast throw, exactly as before.
  const keepGoing = process.argv.includes("--keep-going");
  const phaseFailures = [];
  const runPhase = async (phase) => {
    try {
      await phase();
    } catch (error) {
      if (!keepGoing) throw error;
      phaseFailures.push(error);
    }
  };

  await runPhase(async () => {
    await withTestArtifactLock(async () => {
      await prepareTestDependencies();
      // Use the internal implementation: the public build:test wrapper acquires
      // this same lock for standalone callers and would otherwise self-deadlock.
      await import("./build-test-artifact-locked.mjs");
      await runCompiledTests();
    });
  });

  // Script-level tests include lock protocol tests that intentionally invoke
  // public package scripts. They must run after the outer artifact lock closes.
  if (process.env.GAMEBUDDY_HOST_TEST_COMPILED_ONLY !== "1") await runPhase(runScriptTests);

  if (phaseFailures.length > 0) {
    // Every phase ran; this is the aggregate. Each phase's own message already names its files, and
    // the per-batch lines above carry each file's own reason.
    const messages = phaseFailures.map((error) => (error instanceof Error ? error.message : String(error)));
    throw new Error(
      `${messages.join("\n")}\nhost_test_suite_all_phases_ran:phases=${phaseFailures.length}`,
    );
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error.stack ?? error.message);
    process.exitCode = 1;
  });
}
