import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { probeStardewGameRoot } from "./discovery.js";

/**
 * An unreadable directory and an empty directory are different facts, and the
 * probe used to report them identically: both came back as
 * `{ gameExecutable: false, smapi: false }`, which every caller reads as "this
 * folder is not a Stardew install". So a permission or IO failure during the
 * check silently downgraded a real installation to "not installed" - the same
 * shape as the rest of tonight's silent-failure findings, where absence of an
 * answer is read as a benign answer.
 *
 * The probe reports only presence, never a path, so the distinction has to be
 * carried by the shape of the answer rather than by a message.
 */

test("a path that cannot be inspected is not reported as an absent installation", async () => {
  // A NUL byte in the path makes the filesystem call fail with an error that is
  // NOT "not there" (it is EINVAL on Windows). That is the case the probe used to
  // report as `gameExecutable: false, smapi: false`, i.e. as a folder that holds no
  // game, which is how a real installation could be silently downgraded.
  const probe = await probeStardewGameRoot("C:\\Games\\Stardew\u0000Valley");
  assert.equal(
    probe.readable,
    false,
    "an uninspectable root must be reported as uninspectable, not as a directory holding no game",
  );
});

test("a path whose parent is a regular file is genuinely absent, not uninspectable", async () => {
  // ENOTDIR means the path cannot exist, which is an answer: the folder is not
  // there. The distinction matters - collapsing this into 'unreadable' would make
  // every stale Steam library path look like a broken installation.
  const root = await mkdtemp(join(tmpdir(), "probe-notdir-"));
  try {
    const notADirectory = join(root, "file.txt");
    await (await import("node:fs/promises")).writeFile(notADirectory, "x", "utf8");
    const probe = await probeStardewGameRoot(join(notADirectory, "Stardew Valley"));
    assert.equal(probe.readable, true);
    assert.equal(probe.gameExecutable, false);
    assert.equal(probe.smapi, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an existing directory with no executables is a readable answer of absent", async () => {
  const root = await mkdtemp(join(tmpdir(), "probe-empty-"));
  try {
    const probe = await probeStardewGameRoot(root);
    assert.equal(probe.readable, true);
    assert.equal(probe.gameExecutable, false);
    assert.equal(probe.smapi, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a directory is only reported as holding the game when both executables are regular files", async () => {
  const root = await mkdtemp(join(tmpdir(), "probe-full-"));
  try {
    const { mkdir, writeFile } = await import("node:fs/promises");
    await writeFile(join(root, "Stardew Valley.exe"), "x", "utf8");
    // A directory named like the loader is not the loader.
    await mkdir(join(root, "StardewModdingAPI.exe"));
    const probe = await probeStardewGameRoot(root);
    assert.equal(probe.readable, true);
    assert.equal(probe.gameExecutable, true);
    assert.equal(probe.smapi, false, "a directory mistakenly named like the executable is not the executable");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
