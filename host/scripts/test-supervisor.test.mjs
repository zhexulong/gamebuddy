import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runBoundedChild } from "./test-supervisor.mjs";

async function withFixture(run) {
  const root = await mkdtemp(join(tmpdir(), "gamebuddy-test-supervisor-"));
  try { await run(root); } finally { await rm(root, { recursive: true, force: true }); }
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

test("non-zero direct child is a test failure with its bounded output", async () => withFixture(async (root) => {
  const script = join(root, "failure.cjs");
  await writeFile(script, fixture('process.stderr.write("failure-detail"); process.exit(7);'), "utf8");
  await assert.rejects(runBoundedChild({ command: process.execPath, args: [script], cwd: root, timeoutMs: 2_000 }), /test_runner_failed:code=7[\s\S]*failure-detail/);
}));
