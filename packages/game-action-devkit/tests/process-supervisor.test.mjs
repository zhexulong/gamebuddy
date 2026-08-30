import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";
import {
  CLEANUP_TIMEOUT_MS,
  DEFAULT_SUITE_TIMEOUT_MS,
  runBoundedChild,
} from "../src/process-supervisor.mjs";

const nodeCommand = process.execPath;
const childScript = (source) => ["--input-type=module", "-e", source];

test("exports stable timeout defaults", () => {
  assert.equal(DEFAULT_SUITE_TIMEOUT_MS, 15 * 60_000);
  assert.equal(CLEANUP_TIMEOUT_MS, 5_000);
});

test("deadline races child close, not only exit", async () => {
  const result = await runBoundedChild({
    command: nodeCommand,
    args: childScript("process.stdout.write('ok'); setTimeout(() => {}, 250);"),
    timeoutMs: 5000,
  });
  assert.equal(result.code, 0);
  assert.equal(result.stdout, "ok");
});

test("bounds public output at 64 KiB without splitting UTF-8", async () => {
  const result = await runBoundedChild({
    command: nodeCommand,
    args: childScript("process.stdout.write('😀'.repeat(100000)); process.stderr.write('界'.repeat(100000));"),
    timeoutMs: 5000,
  });
  assert.ok(Buffer.byteLength(result.stdout, "utf8") <= 64 * 1024);
  assert.ok(Buffer.byteLength(result.stderr, "utf8") <= 64 * 1024);
  assert.ok(Buffer.byteLength(result.output, "utf8") <= 64 * 1024);
  assert.ok(!result.output.endsWith("\uFFFD"));
});

test("does not append an incomplete leading UTF-8 sequence at the byte limit", async () => {
  const result = await runBoundedChild({
    command: nodeCommand,
    args: childScript("process.stdout.write('a'.repeat(65535)); process.stdout.write('界');"),
    timeoutMs: 5000,
  });
  assert.equal(Buffer.byteLength(result.stdout, "utf8"), 65535);
  assert.ok(!result.stdout.includes("\uFFFD"));
});

test("supports inherited stdio without requiring capture streams", async () => {
  const result = await runBoundedChild({
    command: nodeCommand,
    args: childScript("process.exit(0);"),
    timeoutMs: 1000,
    stdio: "inherit",
  });
  assert.equal(result.code, 0);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "");
});

test("rejects an invalid cleanup budget before spawning", async () => {
  await assert.rejects(
    runBoundedChild({ command: "never-spawned", cleanupTimeoutMs: Infinity, spawnProcess: () => assert.fail("must not spawn") }),
    /invalid_test_supervisor_cleanup_timeout/,
  );
});

test("preserves named failure prefixes", async () => {
  await assert.rejects(
    runBoundedChild({
      command: nodeCommand,
      args: childScript("console.error('failed'); process.exit(7);"),
      timeoutMs: 1000,
    }),
    (error) => error.message.startsWith("test_runner_failed:code=7") && error.message.includes("failed"),
  );
  await assert.rejects(
    runBoundedChild({
      command: nodeCommand,
      args: childScript("setInterval(() => {}, 1000);"),
      timeoutMs: 100,
    }),
    (error) => error.message.startsWith("test_supervisor_timeout:pid=") && error.message.includes("timeout_ms=100"),
  );
});

function fakeChild({ pid = 4321 } = {}) {
  const child = new EventEmitter();
  child.pid = pid;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = () => true;
  return child;
}

async function withFakeChild(run) {
  const child = fakeChild();
  const resultPromise = run(child);
  setImmediate(() => child.emit("close", 0, null));
  return resultPromise;
}

test("passes caller-selected termination policy to injected cleanup", async () => {
  const calls = [];
  await withFakeChild((child) => runBoundedChild({
    command: "fake",
    timeoutMs: 100,
    terminationPolicy: "term-then-kill",
    graceMs: 321,
    spawnProcess: () => child,
    killTree: async (pid, options) => {
      calls.push({ pid, ...options });
    },
  }));
  assert.deepEqual(calls, []);

  const timeoutChild = fakeChild({ pid: 9876 });
  const timeoutPromise = runBoundedChild({
    command: "fake",
    timeoutMs: 100,
    terminationPolicy: "term-then-kill",
    graceMs: 321,
    spawnProcess: () => timeoutChild,
    killTree: async (pid, options) => {
      calls.push({ pid, ...options });
      timeoutChild.emit("close", 0, null);
    },
  });
  await assert.rejects(timeoutPromise, /test_supervisor_timeout/);
  assert.equal(calls.at(-1).pid, 9876);
  assert.equal(calls.at(-1).terminationPolicy, "term-then-kill");
  assert.equal(calls.at(-1).graceMs, 321);
  assert.ok(calls.at(-1).signal instanceof AbortSignal);
});

test("awaits cleanup that resolves within its independent post-timeout budget", async () => {
  const child = fakeChild({ pid: 1234 });
  let cleanupSettled = false;
  const started = Date.now();
  await assert.rejects(
    runBoundedChild({
      command: "fake",
      timeoutMs: 100,
      cleanupTimeoutMs: 300,
      spawnProcess: () => child,
      killTree: () => new Promise((resolve) => setTimeout(() => {
        cleanupSettled = true;
        child.emit("close", 0, null);
        resolve();
      }, 40)),
    }),
    /test_supervisor_timeout/,
  );
  assert.equal(cleanupSettled, true);
  assert.ok(Date.now() - started >= 130);
});

test("aborts a cleanup hook that outlives its bounded cleanup phase", async () => {
  const child = fakeChild({ pid: 1234 });
  let aborted = false;
  await assert.rejects(
    runBoundedChild({
      command: "fake",
      timeoutMs: 100,
      cleanupTimeoutMs: 120,
      spawnProcess: () => child,
      killTree: (_pid, { signal }) => new Promise((resolve) => {
        signal.addEventListener("abort", () => {
          aborted = true;
          resolve();
        }, { once: true });
      }),
    }),
    /test_supervisor_timeout/,
  );
  assert.equal(aborted, true);
});

test("supports injectable spawn and kill hooks without touching game integrations", async () => {
  const temp = await mkdtemp(join(tmpdir(), "game-action-devkit-"));
  try {
    const child = fakeChild({ pid: 6789 });
    const result = await runBoundedChild({
      command: "fake",
      args: ["arg"],
      cwd: temp,
      spawnProcess(command, args, options) {
        assert.equal(command, "fake");
        assert.deepEqual(args, ["arg"]);
        assert.equal(options.shell, false);
        setImmediate(() => {
          child.stdout.emit("data", Buffer.from("ok"));
          child.emit("close", 0, null);
        });
        return child;
      },
      killTree: async () => {},
    });
    assert.equal(result.stdout, "ok");
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});
