import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import {
  changedPathGitArgs,
  readChangedPaths,
  readCiEvent,
  selectEntries,
  terminateProcessTree,
} from "./test-portfolio-manifest-runner.mjs";

const execFile = promisify(execFileCallback);

const manifest = {
  entries: [
    {
      id: "root",
      triggerPaths: ["src/root.mjs"],
      requiredOn: ["pull_request"],
      requires: [],
    },
    {
      id: "dependent",
      triggerPaths: ["src/dependent.mjs"],
      requiredOn: ["pull_request"],
      requires: ["root"],
    },
    {
      id: "main-only",
      triggerPaths: ["src/main.mjs"],
      requiredOn: ["main"],
      requires: [],
    },
  ],
};

test("selects changed pull-request entries and their dependencies deterministically", () => {
  assert.deepEqual(
    selectEntries(manifest, { eventKind: "pull_request", changedPaths: ["src/dependent.mjs"] }).map(
      (entry) => entry.id,
    ),
    ["dependent", "root"],
  );
  assert.deepEqual(
    selectEntries(manifest, { eventKind: "main", changedPaths: ["src/main.mjs"] }).map((entry) => entry.id),
    ["main-only"],
  );
});

test("uses recursive first-push diff-tree paths, including nested files", async () => {
  const root = await mkdtemp(join(tmpdir(), "gamebuddy-portfolio-git-"));
  try {
    await execFile("git", ["init", "--quiet"], { cwd: root });
    await execFile("git", ["config", "user.email", "test@example.invalid"], { cwd: root });
    await execFile("git", ["config", "user.name", "GameBuddy Test"], { cwd: root });
    await mkdir(join(root, "nested", "deep"), { recursive: true });
    await writeFile(join(root, "nested", "deep", "trigger.mjs"), "export {};\n");
    await execFile("git", ["add", "."], { cwd: root });
    await execFile("git", ["commit", "--quiet", "-m", "first"], { cwd: root });
    const { stdout } = await execFile("git", ["rev-parse", "HEAD"], { cwd: root });
    const after = stdout.trim();
    const changed = await readChangedPaths(root, { kind: "main", before: "0".repeat(40), after });
    assert.deepEqual(changed, ["nested/deep/trigger.mjs"]);
    assert.deepEqual(changedPathGitArgs({ kind: "main", before: "0".repeat(40), after }), [
      "diff-tree",
      "--root",
      "--no-commit-id",
      "--name-only",
      "-z",
      "-r",
      after,
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("constructs shell-free complete process-tree termination commands", () => {
  const calls = [];
  const child = { pid: 4321, kill: () => calls.push("fallback") };
  const fakeKiller = { once: (event, callback) => event === "close" && callback(0, null) };
  return terminateProcessTree(child, {
    platform: "win32",
    spawnProcess: (executable, args, options) => {
      calls.push({ executable, args, options });
      return fakeKiller;
    },
  }).then(() => {
    assert.deepEqual(calls, [
      {
        executable: "taskkill",
        args: ["/PID", "4321", "/T", "/F"],
        options: { shell: false, windowsHide: true, stdio: "ignore" },
      },
    ]);
  });
});

test("terminates a detached POSIX process group before retrying", async () => {
  const signals = [];
  await terminateProcessTree(
    { pid: 4321 },
    {
      platform: "linux",
      killProcess: (pid, signal) => signals.push([pid, signal]),
      wait: async () => undefined,
      graceMs: 0,
    },
  );
  assert.deepEqual(signals, [
    [-4321, "SIGTERM"],
    [-4321, "SIGKILL"],
  ]);
});

test("rejects unsupported or incomplete CI event data", async () => {
  await assert.rejects(
    readCiEvent({ eventName: "workflow_dispatch", eventPath: "unused" }),
    /portfolio_runner_unsupported_event/,
  );
  const root = await mkdtemp(join(tmpdir(), "gamebuddy-portfolio-event-"));
  try {
    const eventPath = join(root, "event.json");
    await writeFile(eventPath, JSON.stringify({ ref: "refs/heads/main", before: "bad", after: "bad" }));
    await assert.rejects(readCiEvent({ eventName: "push", eventPath }), /portfolio_runner_event_data_invalid/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
