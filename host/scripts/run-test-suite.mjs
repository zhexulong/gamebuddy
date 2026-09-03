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
const cmdMetacharacter = /[&|<>^()%!\r\n]/;

// These are the only commands this suite is permitted to invoke through cmd.
// They stay as argv-like fixed data so no caller-controlled shell text exists.
const testDependencyCommands = Object.freeze([
  Object.freeze({ command: "pnpm", args: Object.freeze(["--filter", "@gamebuddy/voice-protocol", "build"]), cwd: repositoryRoot }),
  Object.freeze({ command: "bun", args: Object.freeze(["install", "--cwd", "../vendor/magic-context", "--frozen-lockfile"]), cwd: hostRoot }),
  Object.freeze({ command: "bun", args: Object.freeze(["run", "--cwd", "../vendor/magic-context/packages/pi-plugin", "build"]), cwd: hostRoot }),
]);

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

function configuredBunExecutable(bunExecutable) {
  if (typeof bunExecutable !== "string" || !/^[A-Za-z]:\\.+\.exe$/i.test(bunExecutable) || bunExecutable.includes("\0") || cmdMetacharacter.test(bunExecutable))
    throw new Error("test_dependency_bun_executable_invalid");
  if (!existsSync(bunExecutable) || !statSync(bunExecutable).isFile())
    throw new Error("test_dependency_bun_executable_missing");
  return bunExecutable;
}

/** Return fixed dependency build invocations. Windows requires a CI-provided Bun executable. */
export function testDependencyInvocations({
  platform = process.platform,
  comSpec = process.env.ComSpec,
  bunExecutable = process.env.GAMEBUDDY_BUN_EXECUTABLE,
} = {}) {
  return Object.freeze(testDependencyCommands.map((entry) => {
    if (platform !== "win32") return entry;
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
  }));
}

async function prepareTestDependencies() {
  for (const invocation of testDependencyInvocations()) {
    await execFileAsync(invocation.command, invocation.args, { cwd: invocation.cwd, windowsHide: true });
  }
  const declaredArtifact = resolve(hostRoot, "node_modules", "@cortexkit", "pi-magic-context", "dist");
  if (!existsSync(declaredArtifact)) throw new Error("magic_context_declared_artifact_missing_after_build");
  await import("./sync-declared-magic-context-artifact.mjs");
}

export async function main() {
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
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error.stack ?? error.message);
    process.exitCode = 1;
  });
}
