/**
 * The Windows reclamation helpers' falsifiers, and the one that matters most: a recursive delete of a sandbox
 * containing a junction must NOT reach the real target.
 *
 * The canary here is the point. A test that only asserted "the sandbox is gone" would pass for an implementation
 * that deletes the player's real Mods tree along with it.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  assertNoSurvivingStardewProcesses,
  classifyPathEntry,
  killProcessTree,
  linkTarget,
  listStardewProcessIds,
  removeSandboxTree,
  TASKKILL_ALREADY_EXITED_STATUS,
} from "./windows-process-tree.mjs";

const IS_WINDOWS = process.platform === "win32";

test("a kill is by exact PID and tolerates only the already-exited status", () => {
  const calls = [];
  const exec = (file, args) => {
    calls.push({ file, args });
  };
  assert.equal(killProcessTree(4242, { exec }), "killed");
  assert.deepEqual(calls[0].file, "taskkill");
  assert.deepEqual(calls[0].args, ["/PID", "4242", "/T", "/F"]);

  // A process that finished on its own is normal, and 128 is how Windows says so.
  const alreadyGone = () => {
    const error = new Error("taskkill failed");
    error.status = TASKKILL_ALREADY_EXITED_STATUS;
    throw error;
  };
  assert.equal(killProcessTree(7, { exec: alreadyGone }), "already_exited");

  // Anything else is a real failure and must surface: a cleanup step that cannot tell "nothing to do" from
  // "could not do it" becomes the fault it exists to prevent.
  const otherFailure = () => {
    const error = new Error("access denied");
    error.status = 5;
    throw error;
  };
  assert.throws(() => killProcessTree(7, { exec: otherFailure }), /access denied/u);

  // A localization-proof contract: the classification never reads the message. A non-English Windows says
  // `错误: 找不到进程 "1234"。`, which contains no `not found` at all.
  const localizedFailure = () => {
    const error = new Error('错误: 找不到进程 "1234"。');
    error.status = TASKKILL_ALREADY_EXITED_STATUS;
    throw error;
  };
  assert.equal(killProcessTree(1234, { exec: localizedFailure }), "already_exited");
  assert.throws(() => killProcessTree(0, { exec }), /invalid_process_pid/u);
});

test("surviving processes are reported as a fact, split into ours and not ours", () => {
  const list = () => Object.freeze([111, 222]);
  const result = assertNoSurvivingStardewProcesses({ launchedPids: [111], list });
  assert.deepEqual(result.survivors, [111, 222]);
  // Only the process this run launched is its to act on; the other is reported, never killed.
  assert.deepEqual(result.ours, [111]);
  assert.deepEqual(
    assertNoSurvivingStardewProcesses({ launchedPids: [1], list: () => Object.freeze([]) }).survivors,
    [],
  );
});

test("the reclamation walk detaches links and leaves the real target alone", { skip: !IS_WINDOWS }, () => {
  const root = mkdtempSync(join(tmpdir(), "gb-reclaim-"));
  try {
    const canary = join(root, "canary-real");
    const sandbox = join(root, "sandbox");
    mkdirSync(canary, { recursive: true });
    mkdirSync(join(sandbox, "nested"), { recursive: true });
    writeFileSync(join(canary, "sentinel.txt"), "sentinel", "utf8");
    writeFileSync(join(sandbox, "own-file.txt"), "own", "utf8");
    // A junction pointing OUT of the sandbox, which is exactly the shape a dependency link has.
    execFileSync(
      "powershell",
      [
        "-NoProfile",
        "-Command",
        `New-Item -ItemType Junction -Path '${join(sandbox, "dep")}' -Target '${canary}' | Out-Null`,
      ],
      {
        timeout: 30_000,
        windowsHide: true,
      },
    );
    assert.equal(classifyPathEntry(join(sandbox, "dep")), "reparse_point");
    assert.equal(linkTarget(join(sandbox, "dep")), canary, "a detach is attributable to the target it pointed at");
    assert.equal(classifyPathEntry(join(sandbox, "own-file.txt")), "file");
    assert.equal(classifyPathEntry(join(sandbox, "nested")), "directory");

    const result = removeSandboxTree(sandbox);
    assert.equal(result.detached.length, 1, "the junction must be detached, not descended into");
    assert.equal(existsSync(sandbox), false, "the sandbox itself is gone");
    // THE CANARY: the real target and its file survive.
    assert.equal(existsSync(join(canary, "sentinel.txt")), true);
    assert.equal(readFileSync(join(canary, "sentinel.txt"), "utf8"), "sentinel");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a sandbox with no links still deletes, and reports no detach", { skip: !IS_WINDOWS }, () => {
  const root = mkdtempSync(join(tmpdir(), "gb-reclaim-plain-"));
  try {
    const sandbox = join(root, "sandbox");
    mkdirSync(join(sandbox, "a", "b"), { recursive: true });
    writeFileSync(join(sandbox, "a", "b", "f.txt"), "x", "utf8");
    const result = removeSandboxTree(sandbox);
    assert.deepEqual(result.detached, []);
    assert.equal(existsSync(sandbox), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a link is never descended into, so its target's FILES are never even enumerated", { skip: !IS_WINDOWS }, () => {
  // The canary check above proves the target survived. This proves WHY: the walk does not treat the link as a
  // directory. A walk that descended would still delete the link afterwards, so the canary alone would pass while
  // an inner unlink of the target's own files had already happened.
  const root = mkdtempSync(join(tmpdir(), "gb-reclaim-walk-"));
  try {
    const target = join(root, "target-with-secret");
    const sandbox = join(root, "sandbox");
    mkdirSync(join(target, "inside"), { recursive: true });
    writeFileSync(join(target, "inside", "secret.txt"), "do not detach me", "utf8");
    mkdirSync(sandbox, { recursive: true });
    execFileSync(
      "powershell",
      [
        "-NoProfile",
        "-Command",
        `New-Item -ItemType Junction -Path '${join(sandbox, "dep")}' -Target '${target}' | Out-Null`,
      ],
      {
        timeout: 30_000,
        windowsHide: true,
      },
    );
    const result = removeSandboxTree(sandbox);
    // Exactly one detach: the link. Nothing inside the target was walked, so nothing inside was unlinked.
    assert.deepEqual(result.detached, [join(sandbox, "dep")]);
    assert.equal(existsSync(join(target, "inside", "secret.txt")), true);
    assert.equal(existsSync(join(target, "inside")), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("listing Stardew processes parses the tool's own output and never invents a PID", () => {
  const list = listStardewProcessIds({ exec: () => "  111\n222\n\n" });
  assert.deepEqual(list, [111, 222]);
  assert.deepEqual(listStardewProcessIds({ exec: () => "" }), []);
  // A non-numeric line is dropped rather than becoming NaN, which would make a survivor comparison meaningless.
  assert.deepEqual(listStardewProcessIds({ exec: () => "abc\n333\n" }), [333]);
});
