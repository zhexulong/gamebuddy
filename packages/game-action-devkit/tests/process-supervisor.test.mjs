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
  runOneShotControlChild,
} from "../src/process-supervisor.mjs";

const nodeCommand = process.execPath;
const childScript = (source) => ["--input-type=module", "-e", source];

test("exports stable timeout defaults", () => {
  assert.equal(DEFAULT_SUITE_TIMEOUT_MS, 15 * 60_000);
  assert.equal(CLEANUP_TIMEOUT_MS, 5_000);
});

test("runs a one-shot control child with one bounded JSON frame and separate stderr", async () => {
  const result = await runOneShotControlChild({
    command: nodeCommand,
    args: childScript(`
      let input = "";
      process.stdin.setEncoding("utf8");
      process.stdin.on("data", (chunk) => { input += chunk; });
      process.stdin.on("end", () => {
        const start = JSON.parse(input);
        process.stderr.write("diagnostic");
        process.stdout.write(JSON.stringify({ accepted: start.actionId }) + "\\n");
      });
    `),
    start: { actionId: "toggle_lamp" },
  });
  assert.deepEqual(result.result, { accepted: "toggle_lamp" });
  assert.equal(result.child.stderr, "diagnostic");
  assert.equal(result.child.stdout, '{"accepted":"toggle_lamp"}\n');
  assert.equal(result.child.stdout.includes("diagnostic"), false);
  assert.deepEqual(result.exit, { code: 0, signal: null });
  assert.ok(Number.isSafeInteger(result.child.pid));
});

test("rejects malformed, duplicate, oversized, and extra control-child stdout", async () => {
  for (const source of [
    "process.stdout.write('not-json\\n'); setInterval(() => {}, 1000);",
    "process.stdout.write('{}\\n{}\\n'); setInterval(() => {}, 1000);",
    "process.stdout.write('{}\\nextra'); setInterval(() => {}, 1000);",
    "process.stdout.write(JSON.stringify({ value: 'x'.repeat(64 * 1024) }) + '\\n'); setInterval(() => {}, 1000);"
  ]) {
    await assert.rejects(
      runOneShotControlChild({ command: nodeCommand, args: childScript(source), start: {} }),
      /control_child_invalid_result/,
    );
  }
});

test("enforces a 32 KiB byte limit for one-shot control start and terminal result lines", async () => {
  const jsonLineWithByteLength = (byteLength) => {
    const emptyLine = `${JSON.stringify({ value: "" })}\n`;
    return { value: "x".repeat(byteLength - Buffer.byteLength(emptyLine, "utf8")) };
  };
  const payloadLengthForLine = (byteLength) => byteLength - Buffer.byteLength(`${JSON.stringify({ value: "" })}\n`, "utf8");
  const controlChildResult = (byteLength, keepAlive = false) => childScript(
    `process.stdout.write(JSON.stringify({ value: "x".repeat(${payloadLengthForLine(byteLength)}) }) + "\\n");${keepAlive ? "setInterval(() => {}, 1000);" : ""}`,
  );
  const startAtLimit = jsonLineWithByteLength(32 * 1024);
  const startResult = await runOneShotControlChild({
    command: nodeCommand,
    args: childScript("process.stdout.write('{}\\n');"),
    start: startAtLimit,
  });
  assert.deepEqual(startResult.result, {});
  const resultAtLimit = await runOneShotControlChild({
    command: nodeCommand,
    args: controlChildResult(32 * 1024),
    start: {},
  });
  assert.equal(Buffer.byteLength(resultAtLimit.child.stdout, "utf8"), 32 * 1024);

  for (const byteLength of [32 * 1024 + 1, 64 * 1024]) {
    const line = jsonLineWithByteLength(byteLength);
    await assert.rejects(
      runOneShotControlChild({ command: "never-spawned", start: line, spawnProcess: () => assert.fail("must not spawn") }),
      /invalid_control_child_start/,
    );
    await assert.rejects(
      runOneShotControlChild({ command: nodeCommand, args: controlChildResult(byteLength, true), start: {} }),
      /control_child_invalid_result/,
    );
  }
});

test("does not spawn a pre-aborted control child", async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    runOneShotControlChild({ command: "never-spawned", start: {}, signal: controller.signal, spawnProcess: () => assert.fail("must not spawn") }),
    /control_child_aborted/,
  );
});

test("writes one JSON start line and uses caller abort as control-child cancellation", async () => {
  const controller = new AbortController();
  const result = runOneShotControlChild({
    command: nodeCommand,
    args: childScript(`
      let frames = 0;
      process.stdin.on("data", () => { frames += 1; });
      process.stdin.on("end", () => { if (frames !== 1) process.exitCode = 1; else setInterval(() => {}, 1000); });
    `),
    start: { request: "one" },
    signal: controller.signal,
  });
  setTimeout(() => controller.abort(), 50).unref();
  await assert.rejects(result, /control_child_aborted/);
  await assert.rejects(
    runOneShotControlChild({ command: nodeCommand, args: childScript(""), start: { value: "x".repeat(64 * 1024) } }),
    /invalid_control_child_start/,
  );
  const stderrResult = await runOneShotControlChild({
    command: nodeCommand,
    args: childScript("process.stderr.write('x'.repeat(128 * 1024)); process.stdout.write('{}\\n');"),
    start: {},
  });
  assert.ok(Buffer.byteLength(stderrResult.child.stderr, "utf8") <= 64 * 1024);
});

test("returns independent exit facts for valid result with nonzero code or signal", async () => {
  const nonzero = await runOneShotControlChild({
    command: nodeCommand,
    args: childScript("process.stdout.write('{}\\n'); process.exit(7);"),
    start: {},
  });
  assert.deepEqual(nonzero.exit, { code: 7, signal: null });
  const signalChild = fakeChild();
  const signaled = runOneShotControlChild({ command: "fake", start: {}, spawnProcess: () => signalChild });
  signalChild.stdout.emit("data", Buffer.from("{}\n"));
  signalChild.emit("close", null, "SIGTERM");
  assert.deepEqual((await signaled).exit, { code: null, signal: "SIGTERM" });
});

test("abort observed before completed close fails closed; close/result first returns exit facts", async () => {
  const controller = new AbortController();
  const child = fakeChild();
  const pending = runOneShotControlChild({
    command: "fake",
    start: {},
    signal: controller.signal,
    spawnProcess: () => child,
    killTree: async () => { child.emit("close", null, "SIGKILL"); },
  });
  controller.abort();
  await assert.rejects(pending, /control_child_aborted/);

  const completeChild = fakeChild();
  const settled = runOneShotControlChild({
    command: "fake",
    start: {},
    spawnProcess: () => completeChild,
  });
  completeChild.stdout.emit("data", Buffer.from("{}\n"));
  completeChild.emit("close", 7, null);
  assert.deepEqual((await settled).exit, { code: 7, signal: null });
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

test("retains the full 64 KiB generic capture budget independently of control lines", async () => {
  const result = await runBoundedChild({
    command: nodeCommand,
    args: childScript("process.stdout.write('x'.repeat(64 * 1024));"),
    timeoutMs: 5000,
  });
  assert.equal(Buffer.byteLength(result.stdout, "utf8"), 64 * 1024);
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

test("rejects mandatory spawn option overrides before spawning", async () => {
  for (const key of ["shell", "windowsHide", "detached", "stdio"]) {
    await assert.rejects(
      runBoundedChild({ command: "never-spawned", spawnOptions: { [key]: true }, spawnProcess: () => assert.fail("must not spawn") }),
      /test_supervisor_spawn_options_override_mandatory/,
    );
    await assert.rejects(
      runOneShotControlChild({ command: "never-spawned", start: {}, spawnOptions: { [key]: true }, spawnProcess: () => assert.fail("must not spawn") }),
      /test_supervisor_spawn_options_override_mandatory/,
    );
  }
});

test("cleans a real process tree before rejecting an invalid post-spawn child surface", async () => {
  const temp = await mkdtemp(join(tmpdir(), "game-action-devkit-invalid-child-"));
  const marker = join(temp, "should-not-exist");
  const children = [];
  const cleanupPids = [];
  const startRealButReturnInvalidSurface = () => {
    const child = spawn(nodeCommand, childScript(`
      import { writeFileSync } from "node:fs";
      setTimeout(() => writeFileSync(${JSON.stringify(marker)}, "leaked"), 300);
    `), { detached: process.platform !== "win32", stdio: "ignore", windowsHide: true });
    const record = { child, pid: child.pid, closed: false };
    record.close = new Promise((resolve) => {
      child.once("close", () => {
        record.closed = true;
        resolve();
      });
    });
    children.push(record);
    return { pid: child.pid };
  };
  const killRealChildAndWaitForClose = async (pid) => {
    cleanupPids.push(pid);
    const record = children.find((candidate) => candidate.pid === pid);
    assert.ok(record, `cleanup received unknown pid ${pid}`);
    assert.equal(record.child.kill("SIGKILL"), true);
    await record.close;
  };
  try {
    await assert.rejects(
      runBoundedChild({
        command: "fake",
        spawnProcess: startRealButReturnInvalidSurface,
        killTree: killRealChildAndWaitForClose,
        cleanupTimeoutMs: 500,
      }),
      /invalid_test_supervisor_child/,
    );
    await assert.rejects(
      runOneShotControlChild({
        command: "fake",
        start: {},
        spawnProcess: startRealButReturnInvalidSurface,
        killTree: killRealChildAndWaitForClose,
        cleanupTimeoutMs: 500,
      }),
      /invalid_control_child_process/,
    );
    assert.equal(children.length, 2);
    assert.deepEqual(cleanupPids, children.map((record) => record.pid));
    assert.ok(children.every((record) => record.closed));
    await new Promise((resolve) => setTimeout(resolve, 400));
    await assert.rejects(readFile(marker));
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("disposes all runBoundedChild listeners after timeout cleanup expires without close", async () => {
  const child = fakeChild();
  await assert.rejects(
    runBoundedChild({
      command: "fake",
      timeoutMs: 100,
      cleanupTimeoutMs: 1,
      spawnProcess: () => child,
      killTree: async () => {},
    }),
    /test_supervisor_timeout/,
  );
  for (const emitter of [child, child.stdout, child.stderr]) {
    assert.equal(emitter.listenerCount("error"), 0);
    assert.equal(emitter.listenerCount("close"), 0);
    assert.equal(emitter.listenerCount("data"), 0);
    assert.equal(emitter.listenerCount("end"), 0);
  }
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
  child.stdin = { end() {} };
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
