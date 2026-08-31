import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rmdir, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  runStardewClosureBackend,
  TEARDOWN_RECEIPT_GRACE_MS,
} from "../src/stardew-closure-backend.mjs";
import { writeStardewClosureBackendResult } from "../src/write-lifecycle-result.mjs";

async function removeFixtureTree(directory) {
  const { lstat, readdir } = await import("node:fs/promises");
  const pending = [{ path: directory, visited: false }];
  let steps = 0;
  while (pending.length > 0) {
    if (++steps > 10_000) throw new Error("closure_backend_fixture_cleanup_unbounded");
    const current = pending.pop();
    const stats = await lstat(current.path).catch((error) => {
      if (error?.code === "ENOENT") return null;
      throw error;
    });
    if (!stats) continue;
    if (!stats.isDirectory() || stats.isSymbolicLink()) {
      await unlink(current.path);
      continue;
    }
    if (!current.visited) {
      pending.push({ path: current.path, visited: true });
      const entries = await readdir(current.path);
      for (const entry of entries) pending.push({ path: path.join(current.path, entry), visited: false });
      continue;
    }
    await rmdir(current.path);
  }
}

async function fixture(callback) {
  const root = await mkdtemp(path.join(os.tmpdir(), "stardew-closure-backend-"));
  const projectRoot = path.join(root, "project");
  const releaseDir = path.join(root, "release");
  await mkdir(projectRoot);
  await mkdir(releaseDir);
  try {
    await callback({ root, projectRoot, releaseDir });
  } finally {
    await removeFixtureTree(root);
  }
}

function profile(root) {
  return Object.freeze({
    gameInstallPath: path.join(root, "game"),
    modsPath: path.join(root, "game", "Mods"),
    nativeFixtureRoot: path.join(root, "native-fixture"),
    saveIdentity: "GameBuddyFixtureEquipTool_123",
    templateIdentity: "GameBuddyFixtureEquipTool_123",
    profileIdentity: "target-profile",
    timeoutMs: 30_000,
  });
}

function input(root, extra) {
  return Object.freeze({
    projectRoot: path.join(root, "project"),
    profile: profile(root),
    runId: "cb_test",
    releaseDir: path.join(root, "release"),
    actionResultFile: path.join(root, "action.json"),
    lifecycleResultFile: path.join(root, "lifecycle.json"),
    ...extra,
  });
}

function value(args, flag) {
  return args[args.indexOf(flag) + 1];
}

function assertRedacted(error, expectedCode, rawDetails) {
  assert.equal(error.message, expectedCode);
  assert.equal(Object.hasOwn(error, "cause"), false);
  assert.equal(Object.hasOwn(error, "errors"), false);
  assert.equal(error.cause, undefined);
  assert.equal(error.errors, undefined);
  const observable = [error.message, String(error), error.stack ?? "", JSON.stringify(error)].join("\n");
  for (const detail of rawDetails) assert.equal(observable.includes(detail), false, `must redact ${detail}`);
  return true;
}

test("backend returns completed when child exits 0 and the exact completed lifecycle result exists", async () => fixture(async ({ root, projectRoot, releaseDir }) => {
  const result = await runStardewClosureBackend({
    ...input(root),
    resolvePowerShell: () => "fake-powershell",
    runChild: async ({ args }) => {
      await writeStardewClosureBackendResult(value(args, "-LifecycleResultFile"), { state: "completed" });
      return { code: 0, signal: null };
    },
  });
  assert.deepEqual(result, Object.freeze({ state: "completed" }));
}));

test("backend passes exact fixed lifecycle flags and no phase-file flag", async () => fixture(async ({ root, projectRoot, releaseDir }) => {
  let call;
  await runStardewClosureBackend({
    ...input(root),
    resolvePowerShell: () => "fake-powershell",
    runChild: async (childInput) => {
      call = childInput;
      const actionFile = value(childInput.args, "-ResultFile");
      const lifecycleFile = value(childInput.args, "-LifecycleResultFile");
      await writeStardewClosureBackendResult(lifecycleFile, { state: "completed" });
      await writeFile(actionFile, "action-content");
      return { code: 0, signal: null };
    },
  });
  assert.equal(call.command, "fake-powershell");
  assert.equal(call.cwd, projectRoot);
  assert.equal(call.stdio, "pipe");
  assert.equal(call.terminationPolicy, "immediate");
  const get = (flag) => value(call.args, flag);
  assert.equal(get("-GamePath"), path.join(root, "game"));
  assert.equal(get("-ModsPath"), path.join(root, "game", "Mods"));
  assert.equal(get("-FixtureRoot"), path.join(root, "native-fixture"));
  assert.equal(get("-SaveName"), "GameBuddyFixtureEquipTool_123");
  assert.equal(get("-TemplateName"), "GameBuddyFixtureEquipTool_123");
  assert.equal(get("-ReleaseDir"), path.join(root, "release"));
  assert.equal(get("-Action"), "equip_tool");
  assert.equal(get("-TimeoutSeconds"), "30");
  assert.notEqual(get("-ResultFile"), get("-LifecycleResultFile"));
  assert.equal(call.args.includes("-LifecyclePhaseResultFile"), false);
  assert.match(get("-ScenarioIdentity"), /"runId":"cb_test"/);
  // The backend never reads/parses the action result.
  assert.equal(await readFile(get("-ResultFile"), "utf8"), "action-content");
}));

test("backend maps timeout rounding and outer containment exactly", async () => fixture(async ({ root }) => {
  const calls = [];
  const run = async (timeoutMs, index) => runStardewClosureBackend({
    ...input(root, {
      profile: { ...profile(root), timeoutMs },
      lifecycleResultFile: path.join(root, `lifecycle-${index}.json`),
    }),
    resolvePowerShell: () => "fake",
    runChild: async (childInput) => {
      calls.push(childInput);
      await writeStardewClosureBackendResult(value(childInput.args, "-LifecycleResultFile"), { state: "completed" });
      return { code: 0, signal: null };
    },
  });
  await run(30_000, 0);
  await run(30_001, 1);
  await run(120_000, 2);
  assert.equal(value(calls[0].args, "-TimeoutSeconds"), "30");
  assert.equal(calls[0].timeoutMs, 30_000 + TEARDOWN_RECEIPT_GRACE_MS);
  assert.equal(value(calls[1].args, "-TimeoutSeconds"), "31");
  assert.equal(calls[1].timeoutMs, 61_000);
  assert.equal(value(calls[2].args, "-TimeoutSeconds"), "120");
  assert.equal(calls[2].timeoutMs, 120_000 + TEARDOWN_RECEIPT_GRACE_MS);
}));

test("backend consumes a valid failed lifecycle result on child nonzero", async () => fixture(async ({ root }) => {
  await assert.rejects(
    () => runStardewClosureBackend({
      ...input(root),
      resolvePowerShell: () => "fake",
      runChild: async ({ args }) => {
        await writeStardewClosureBackendResult(value(args, "-LifecycleResultFile"), {
          state: "failed", phase: "fixture_prepare", code: "failed",
        });
        return { code: 2, signal: null };
      },
    }),
    (error) => assertRedacted(error, "stardew_closure_backend_phase_fixture_prepare_failed", [root]),
  );
}));

test("backend maps child nonzero with missing lifecycle result to lifecycle_result_missing", async () => fixture(async ({ root }) => {
  await assert.rejects(
    () => runStardewClosureBackend({
      ...input(root),
      resolvePowerShell: () => "fake",
      runChild: async () => ({ code: 2, signal: null }),
    }),
    /stardew_closure_backend_lifecycle_result_missing/,
  );
}));

test("backend maps child nonzero with malformed lifecycle result to lifecycle_result_invalid", async () => fixture(async ({ root }) => {
  await assert.rejects(
    () => runStardewClosureBackend({
      ...input(root),
      resolvePowerShell: () => "fake",
      runChild: async ({ args }) => {
        await writeFile(value(args, "-LifecycleResultFile"), "not-json{");
        return { code: 2, signal: null };
      },
    }),
    /stardew_closure_backend_lifecycle_result_invalid/,
  );
}));

test("backend maps a completed lifecycle result on child nonzero to a bounded contradiction", async () => fixture(async ({ root }) => {
  await assert.rejects(
    () => runStardewClosureBackend({
      ...input(root),
      resolvePowerShell: () => "fake",
      runChild: async ({ args }) => {
        await writeStardewClosureBackendResult(value(args, "-LifecycleResultFile"), { state: "completed" });
        return { code: 7, signal: null };
      },
    }),
    (error) => assertRedacted(error, "stardew_closure_backend_lifecycle_result_contradicts_child", [root]),
  );
}));

test("backend maps child signal with no lifecycle result to lifecycle_result_missing", async () => fixture(async ({ root }) => {
  await assert.rejects(
    () => runStardewClosureBackend({
      ...input(root),
      resolvePowerShell: () => "fake",
      runChild: async () => ({ code: null, signal: "SIGKILL" }),
    }),
    /stardew_closure_backend_lifecycle_result_missing/,
  );
}));

test("backend maps supervisor timeout and spawn failures to bounded child codes without raw detail", async () => fixture(async ({ root }) => {
  await assert.rejects(
    () => runStardewClosureBackend({
      ...input(root),
      resolvePowerShell: () => "fake",
      runChild: async () => { throw new Error("test_supervisor_timeout:pid=4242:timeout_ms=30000\nraw output detail"); },
    }),
    (error) => assertRedacted(error, "stardew_closure_backend_child_timeout", ["4242", "raw"]),
  );
  await assert.rejects(
    () => runStardewClosureBackend({
      ...input(root),
      resolvePowerShell: () => "fake",
      runChild: async () => { throw new Error("test_runner_failed:spawn:ENOENT raw spawn detail"); },
    }),
    (error) => assertRedacted(error, "stardew_closure_backend_child_spawn_failed", ["ENOENT", "raw"]),
  );
}));

test("backend fails closed when child exits 0 without a lifecycle result", async () => fixture(async ({ root }) => {
  await assert.rejects(
    () => runStardewClosureBackend({
      ...input(root),
      resolvePowerShell: () => "fake",
      runChild: async () => ({ code: 0, signal: null }),
    }),
    /stardew_closure_backend_lifecycle_result_missing/,
  );
}));

test("backend fails closed when child exits 0 with a failed lifecycle result", async () => fixture(async ({ root }) => {
  await assert.rejects(
    () => runStardewClosureBackend({
      ...input(root),
      resolvePowerShell: () => "fake",
      runChild: async ({ args }) => {
        await writeStardewClosureBackendResult(value(args, "-LifecycleResultFile"), {
          state: "failed", phase: "live_child", code: "failed",
        });
        return { code: 0, signal: null };
      },
    }),
    /stardew_closure_backend_lifecycle_result_not_completed/,
  );
}));

test("backend fails closed when child exits 0 with a malformed lifecycle result", async () => fixture(async ({ root }) => {
  await assert.rejects(
    () => runStardewClosureBackend({
      ...input(root),
      resolvePowerShell: () => "fake",
      runChild: async ({ args }) => {
        await writeFile(value(args, "-LifecycleResultFile"), JSON.stringify({ schema: "wrong", state: "completed" }));
        return { code: 0, signal: null };
      },
    }),
    /stardew_closure_backend_lifecycle_result_invalid/,
  );
}));

test("backend rejects invalid public input before touching a child", async () => fixture(async ({ root, projectRoot, releaseDir }) => {
  let childCalls = 0;
  const run = (extra) => runStardewClosureBackend({
    ...input(root, extra),
    runChild: async () => { childCalls += 1; return { code: 0, signal: null }; },
  });
  await assert.rejects(run({ projectRoot: "relative" }), /stardew_closure_backend_invalid_input/);
  await assert.rejects(run({ releaseDir: "relative" }), /stardew_closure_backend_invalid_input/);
  await assert.rejects(run({ actionResultFile: "relative" }), /stardew_closure_backend_invalid_input/);
  await assert.rejects(run({ lifecycleResultFile: "relative" }), /stardew_closure_backend_invalid_input/);
  await assert.rejects(run({ runId: "" }), /stardew_closure_backend_invalid_input/);
  await assert.rejects(run({ profile: { ...profile(root), timeoutMs: 29_999 } }), /stardew_closure_backend_invalid_input/);
  await assert.rejects(run({ profile: { ...profile(root), modsPath: "" } }), /stardew_closure_backend_invalid_input/);
  await assert.rejects(run({ actionResultFile: path.join(root, "same.json"), lifecycleResultFile: path.join(root, "same.json") }), /stardew_closure_backend_invalid_input/);
  assert.equal(childCalls, 0);
}));

test("backend rejects a non-string raw read error without leaking detail", async () => fixture(async ({ root }) => {
  await assert.rejects(
    () => runStardewClosureBackend({
      ...input(root),
      resolvePowerShell: () => "fake",
      readResult: async () => { throw new Error("raw_read_detail C:\\private\\path"); },
      runChild: async () => ({ code: 0, signal: null }),
    }),
    (error) => assertRedacted(error, "stardew_closure_backend_lifecycle_result_invalid", ["raw", "C:\\private"]),
  );
}));