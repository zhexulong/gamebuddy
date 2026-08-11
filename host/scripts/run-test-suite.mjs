import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { withTestArtifactLock } from "./test-artifact-lock.mjs";

const hostRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function run(command, args) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, args, {
      cwd: hostRoot,
      stdio: "inherit",
      // Node's Windows .cmd execution requires cmd.exe. Keep the command and
      // its arguments separate; protocol tests exercise the real wrapper
      // lifecycle rather than treating wrapper launch as a detached success.
      ...(process.platform === "win32" && command.endsWith(".cmd")
        ? { shell: true }
        : {}),
    });
    child.once("error", rejectRun);
    child.once("exit", (code, signal) => code === 0 ? resolveRun() : rejectRun(new Error(`host_test_stage_failed:code=${code}:signal=${signal ?? "none"}`)));
  });
}

await withTestArtifactLock(async () => {
  // Use the internal implementation: the public build:test wrapper acquires
  // this same lock for standalone callers and would otherwise self-deadlock.
  await import("./build-test-artifact-locked.mjs");
  await run(process.execPath, ["scripts/run-tests.mjs"]);
});
