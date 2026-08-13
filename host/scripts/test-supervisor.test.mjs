import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { spawn } from "node:child_process";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runBoundedChild } from "./test-supervisor.mjs";

async function withFixture(run) {
  const root = await mkdtemp(join(tmpdir(), "gamebuddy-test-supervisor-"));
  try { await run(root); } finally { await rm(root, { recursive: true, force: true }); }
}

async function waitForFile(path) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try { await access(path); return; } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  throw new Error(`fixture_ready_timeout:${path}`);
}

function fixture(source) {
  return `const { writeFileSync } = require("node:fs");\n${source}`;
}

test("supervisor returns bounded output from a successful direct child", async () => withFixture(async (root) => {
  const script = join(root, "success.cjs");
  await writeFile(script, fixture('process.stdout.write("ok");'), "utf8");
  const result = await runBoundedChild({ command: process.execPath, args: [script], cwd: root, timeoutMs: 2_000 });
  assert.equal(result.code, 0);
  assert.equal(result.output, "ok");
}));

test("supervisor fails explicitly at the total suite deadline and invokes owner-tree cleanup", async () => withFixture(async (root) => {
  const script = join(root, "hang.cjs");
  await writeFile(script, fixture("setInterval(() => {}, 1_000);"), "utf8");
  const reaped = [];
  await assert.rejects(
    runBoundedChild({ command: process.execPath, args: [script], cwd: root, timeoutMs: 100, killTree: async (pid) => { reaped.push(pid); const child = spawn(process.platform === "win32" ? "taskkill.exe" : "kill", process.platform === "win32" ? ["/PID", String(pid), "/T", "/F"] : ["-KILL", String(pid)], { stdio: "ignore" }); await new Promise((resolve) => child.once("close", resolve)); } }),
    /test_supervisor_timeout/,
  );
  assert.equal(reaped.length, 1);
  assert.ok(reaped[0] > 0);
}));

test("cleanup settles when the injected tree reaper never settles", async () => {
  const child = new EventEmitter();
  child.pid = 4242;
  child.exitCode = null;
  child.signalCode = null;
  const started = Date.now();
  await assert.rejects(
    runBoundedChild({ command: "fake", args: [], cwd: process.cwd(), timeoutMs: 100, cleanupTimeoutMs: 25, spawnProcess: () => child, killTree: () => new Promise(() => {}) }),
    /test_supervisor_timeout:pid=4242:timeout_ms=100/,
  );
  assert.ok(Date.now() - started < 1_000);
});

test("default cleanup owns the fixture process group, not just the direct child", async () => withFixture(async (root) => {
  const script = join(root, "tree-hang.cjs");
  const childPid = join(root, "child.pid");
  await writeFile(script, fixture(`
    const { spawn } = require("node:child_process");
    const child = spawn(process.execPath, ["-e", "if (process.send) process.send({ ready: true }); setInterval(() => {}, 1_000);"], { stdio: ["ignore", "ignore", "ignore", "ipc"] });
    child.on("message", (message) => {
      if (message?.ready !== true) return;
      writeFileSync(${JSON.stringify(childPid)}, String(child.pid));
      setInterval(() => {}, 1_000);
    });
  `), "utf8");
  const run = runBoundedChild({ command: process.execPath, args: [script], cwd: root, timeoutMs: 500 });
  await waitForFile(childPid);
  await assert.rejects(run, /test_supervisor_timeout/);
  const pid = Number(await readFile(childPid, "utf8"));
  assert.ok(Number.isInteger(pid) && pid > 0);
  await assert.rejects(async () => process.kill(pid, 0), { code: "ESRCH" });
}));

test("stdout and stderr are capped at a valid UTF-8 byte boundary", async () => withFixture(async (root) => {
  const script = join(root, "large-output.cjs");
  await writeFile(script, fixture('process.stdout.write("€".repeat(30_000)); process.stderr.write("€".repeat(30_000));'), "utf8");
  const result = await runBoundedChild({ command: process.execPath, args: [script], cwd: root, timeoutMs: 2_000 });
  assert.ok(Buffer.byteLength(result.stdout, "utf8") <= 64 * 1024);
  assert.ok(Buffer.byteLength(result.stderr, "utf8") <= 64 * 1024);
  assert.ok(Buffer.byteLength(result.output, "utf8") <= 64 * 1024);
  assert.equal(result.stdout.includes("\uFFFD"), false);
  assert.equal(result.stderr.includes("\uFFFD"), false);
  assert.equal(result.output.includes("\uFFFD"), false);
}));

test("supervisor emits bounded diagnostic heartbeats without changing a successful outcome", async () => withFixture(async (root) => {
  const script = join(root, "slow-success.cjs");
  await writeFile(script, fixture("setTimeout(() => process.stdout.write(\"done\"), 75);"), "utf8");
  const heartbeats = [];
  const result = await runBoundedChild({
    command: process.execPath,
    args: [script],
    cwd: root,
    timeoutMs: 2_000,
    heartbeatIntervalMs: 10,
    onHeartbeat: (heartbeat) => heartbeats.push(heartbeat),
  });
  assert.equal(result.output, "done");
  assert.ok(heartbeats.length > 0);
  assert.ok(heartbeats.every((heartbeat) => Number.isInteger(heartbeat.pid) && heartbeat.pid > 0 && heartbeat.elapsedMs >= 0));
}));

test("non-zero direct child is a test failure with its bounded output", async () => withFixture(async (root) => {
  const script = join(root, "failure.cjs");
  await writeFile(script, fixture('process.stderr.write("failure-detail"); process.exit(7);'), "utf8");
  await assert.rejects(runBoundedChild({ command: process.execPath, args: [script], cwd: root, timeoutMs: 2_000 }), /test_runner_failed:code=7[\s\S]*failure-detail/);
}));
