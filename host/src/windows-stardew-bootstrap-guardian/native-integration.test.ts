import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

const helperPath = resolve(
  process.cwd(),
  "native/windows-stardew-bootstrap-guardian/.dist/win-x64/GameBuddy.WindowsStardewBootstrapGuardian.exe",
);
const instanceId = "53ee44a2-d70b-4a49-a857-1ca4883e5d2e";
const attemptId = "9b1c2d3e-4f5a-4b6c-8d7e-1f2a3b4c5d6e";

function request(operation: string, extra = "") {
  return `{"schemaVersion":1,"operation":"${operation}","guardianInstanceId":"${instanceId}","guardianEpoch":1,"attemptId":"${attemptId}"${extra}}\n`;
}

async function runHelper(input: string) {
  const env = { ...process.env };
  delete env.GAMEBUDDY_GUARDIAN_CONTROL_PIPE;
  delete env.GAMEBUDDY_GUARDIAN_CONTROL_TOKEN;
  const child = spawn(helperPath, [], {
    env,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
    shell: false,
  });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  child.stdout.on("data", (chunk) => stdout.push(Buffer.from(chunk)));
  child.stderr.on("data", (chunk) => stderr.push(Buffer.from(chunk)));
  let stdinError: NodeJS.ErrnoException | undefined;
  child.stdin.on("error", (error: NodeJS.ErrnoException) => { stdinError = error; });
  child.stdin.end(input);
  const result = await Promise.race([
    new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolveExit, rejectExit) => {
      child.once("error", rejectExit);
      child.once("close", (code, signal) => resolveExit({ code, signal }));
    }),
    new Promise<never>((_, rejectTimeout) => setTimeout(() => {
      child.kill();
      rejectTimeout(new Error("windows_guardian_integration_timeout"));
    }, 10_000)),
  ]);
  if (stdinError !== undefined && stdinError.code !== "EOF" && stdinError.code !== "EPIPE") throw stdinError;
  return { ...result, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr) };
}

test("published resident Guardian fails closed without private launcher credentials", async (t) => {
  if (process.platform !== "win32") {
    t.skip("Windows-only compiled Guardian integration");
    return;
  }
  try { await access(helperPath); } catch {
    t.skip("published Guardian helper is missing; run the Windows builder first");
    return;
  }

  for (const input of [
    "",
    request("arm_attempt"),
    request("arm_attempt", ',"sensitive":"token"'),
    request("arm_attempt").replace(/\n$/, "embedded\n"),
    `${request("arm_attempt")}${"x".repeat(70_000)}`,
  ]) {
    const result = await runHelper(input);
    assert.equal(result.code, 1);
    assert.equal(result.signal, null);
    assert.equal(result.stdout.length, 0);
    assert.equal(result.stderr.toString("utf8"), "windows_stardew_bootstrap_guardian_invalid_request\n");
  }
});
