import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import { promisify } from "node:util";
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import test from "node:test";

const execFileAsync = promisify(execFile);
const helperPath = resolve(
  process.cwd(),
  "native/windows-stardew-bootstrap-guardian/.dist/win-x64/GameBuddy.WindowsStardewBootstrapGuardian.exe",
);
const instanceId = "53ee44a2-d70b-4a49-a857-1ca4883e5d2e";
const attemptId = "9b1c2d3e-4f5a-4b6c-8d7e-1f2a3b4c5d6e";

function request(operation: string, extra = "") {
  return `{"schemaVersion":1,"operation":"${operation}","guardianInstanceId":"${instanceId}","guardianEpoch":1,"attemptId":"${attemptId}"${extra}}\n`;
}

type ObservedChild = Readonly<{
  processId: number;
  name: string;
  executablePath: string | null;
  commandLine: string | null;
}>;

async function processChildren(parentPid: number): Promise<ObservedChild[]> {
  const script = [
    "$p=Get-CimInstance Win32_Process -Filter \"ParentProcessId=$env:PARENT_PID\"",
    "@($p | Select-Object ProcessId,Name,ExecutablePath,CommandLine) | ConvertTo-Json -Compress",
  ].join("; ");
  try {
    const result = await execFileAsync("C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
      env: { PARENT_PID: String(parentPid), SystemRoot: "C:\\Windows" },
      windowsHide: true,
      timeout: 5_000,
    });
    if (result.stdout.trim() === "") return [];
    const parsed: unknown = JSON.parse(result.stdout);
    const values = Array.isArray(parsed) ? parsed : [parsed];
    return values.map((value: Record<string, unknown>) => ({
      processId: Number(value.ProcessId),
      name: String(value.Name),
      executablePath: value.ExecutablePath === null ? null : String(value.ExecutablePath),
      commandLine: value.CommandLine === null ? null : String(value.CommandLine),
    }));
  } catch (error) {
    throw new Error("windows_guardian_process_observation_unavailable", { cause: error });
  }
}

async function runHelper(input: string) {
  const child = spawn(helperPath, [], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true, shell: false });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  child.stdout.on("data", (chunk) => stdout.push(Buffer.from(chunk)));
  child.stderr.on("data", (chunk) => stderr.push(Buffer.from(chunk)));
  child.stdin.end(input);
  const [code, signal] = await new Promise<[number | null, NodeJS.Signals | null]>((resolveExit, rejectExit) => {
    child.once("error", rejectExit);
    child.once("close", (exitCode, exitSignal) => resolveExit([exitCode, exitSignal]));
  });
  return { code, signal, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr) };
}

test("real published Guardian helper accepts legal operations and never launches roles", async (t) => {
  if (process.platform !== "win32") {
    t.skip("Windows-only compiled Guardian integration");
    return;
  }
  try { await access(helperPath); } catch { t.skip("published Guardian helper is missing; run the Windows builder first"); return; }

  for (const input of [
    request("arm_attempt"),
    request("launch_role", ',"role":"player_host"'),
    request("contain_role", ',"role":"ai_client"'),
    request("begin_recovery", `,"recoveryInstanceId":"${instanceId}"`),
    request("recover_attempt"),
  ]) {
    const result = await runHelper(input);
    assert.equal(result.code, 0);
    assert.equal(result.signal, null);
    assert.equal(result.stderr.length, 0);
    assert.equal(result.stdout.toString("utf8"), '{"schemaVersion":1,"result":"kept_unavailable"}\n');
  }

  // Keep stdin open while observing the real helper's process tree. This is an
  // observation that the tracer creates no child process; it is not a Job
  // containment claim. The helper is blocked only in protocol input framing.
  const child = spawn(helperPath, [], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true, shell: false });
  try {
    child.stdin.write(request("launch_role", ',"role":"player_host"').slice(0, -1));
    await new Promise((resolveReady) => setTimeout(resolveReady, 100));
    assert.deepEqual(await processChildren(child.pid!), []);
    await new Promise((resolveReady) => setTimeout(resolveReady, 100));
    assert.deepEqual(await processChildren(child.pid!), []);
    child.stdin.end("\n");
    await new Promise<void>((resolveExit, rejectExit) => { child.once("error", rejectExit); child.once("close", () => resolveExit()); });
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill();
    child.stdin.destroy();
    child.stdout.destroy();
    child.stderr.destroy();
  }

  for (const input of [
    request("arm_attempt", ',"sensitive":"token"'),
    request("arm_attempt").replace(/\n$/, "embedded\n"),
    `${request("arm_attempt")}${"x".repeat(70_000)}`,
  ]) {
    const result = await runHelper(input);
    assert.notEqual(result.code, 0);
    assert.equal(result.signal, null);
    assert.equal(result.stdout.length, 0);
  }
});
