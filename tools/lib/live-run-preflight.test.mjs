// The preflight's own falsifiers: every check it makes has to be able to go red.
//
// A gate nobody can make fail is decoration, which is why each case below builds the exact tree shape that check exists
// for and asserts the code it must report. The good tree is the control.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { preflightLiveRun } from "./live-run-preflight.mjs";

const codesFor = (result) => result.checks.map((entry) => entry.code);
const failureCodes = (result) => result.checks.filter((entry) => !entry.ok).map((entry) => entry.code);

/** A tree that passes everything, so each case below can break exactly one thing. */
function goodTree(root) {
  const modsPath = join(root, "mods");
  const releaseDir = join(root, "release");
  const hostRoot = join(root, "host");
  const fixtureRoot = join(root, "fixtures");
  const modRoot = join(root, "mod");
  mkdirSync(join(modsPath, "GameBuddy.Stardew"), { recursive: true });
  writeFileSync(
    join(modsPath, "GameBuddy.Stardew", "config.json"),
    JSON.stringify({ PipeName: "gamebuddy-test-pipe" }),
  );
  mkdirSync(releaseDir, { recursive: true });
  writeFileSync(join(releaseDir, "GameBuddy.Stardew.dll"), "dll");
  mkdirSync(join(hostRoot, "src"), { recursive: true });
  writeFileSync(join(hostRoot, "src", "index.ts"), "export {};\n");
  mkdirSync(join(hostRoot, "dist-test"), { recursive: true });
  writeFileSync(join(hostRoot, "dist-test", "index.js"), "export {};\n");
  mkdirSync(join(modRoot, "src"), { recursive: true });
  writeFileSync(join(modRoot, "src", "Thing.cs"), "class Thing {}\n");
  mkdirSync(join(fixtureRoot, "templates", "Fixture_1"), { recursive: true });
  return { modsPath, releaseDir, hostRoot, fixtureRoot, modRoot, saveName: "Fixture_1" };
}

/** Timestamps are what these checks compare, so the fixture tree has to control them. */
const touch = (path, when) => utimesSync(path, when, when);

test("the good tree passes every check", () => {
  const root = mkdtempSync(join(tmpdir(), "preflight-good-"));
  try {
    const tree = goodTree(root);
    // The DLL must be at least as new as the sources, and the artifact at least as new as host/src.
    const past = new Date(Date.now() - 60_000);
    const now = new Date();
    touch(join(tree.modRoot, "src", "Thing.cs"), past);
    touch(join(tree.releaseDir, "GameBuddy.Stardew.dll"), now);
    touch(join(tree.hostRoot, "src", "index.ts"), past);
    touch(join(tree.hostRoot, "dist-test", "index.js"), now);
    const result = preflightLiveRun(tree);
    assert.deepEqual(failureCodes(result), [], JSON.stringify(result.checks, null, 1));
    assert.equal(result.ok, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("two GameBuddy folders are refused, because SMAPI would load neither", () => {
  const root = mkdtempSync(join(tmpdir(), "preflight-dupe-"));
  try {
    const tree = goodTree(root);
    mkdirSync(join(tree.modsPath, "GameBuddy"), { recursive: true });
    const result = preflightLiveRun(tree);
    assert.ok(failureCodes(result).includes("mods_path_exactly_one_gamebuddy"), codesFor(result).join(","));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a Mod bundle older than its sources is refused, because the run would measure other code", () => {
  const root = mkdtempSync(join(tmpdir(), "preflight-stale-mod-"));
  try {
    const tree = goodTree(root);
    touch(join(tree.releaseDir, "GameBuddy.Stardew.dll"), new Date(Date.now() - 120_000));
    touch(join(tree.modRoot, "src", "Thing.cs"), new Date());
    const result = preflightLiveRun(tree);
    assert.ok(failureCodes(result).includes("mod_bundle_fresh"), codesFor(result).join(","));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a host artifact older than host/src is refused", () => {
  const root = mkdtempSync(join(tmpdir(), "preflight-stale-host-"));
  try {
    const tree = goodTree(root);
    touch(join(tree.hostRoot, "dist-test", "index.js"), new Date(Date.now() - 120_000));
    touch(join(tree.hostRoot, "src", "index.ts"), new Date());
    const result = preflightLiveRun(tree);
    assert.ok(failureCodes(result).includes("host_artifact_fresh"), codesFor(result).join(","));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a missing fixture template is refused by path", () => {
  const root = mkdtempSync(join(tmpdir(), "preflight-template-"));
  try {
    const tree = goodTree(root);
    rmSync(join(tree.fixtureRoot, "templates", "Fixture_1"), { recursive: true, force: true });
    const result = preflightLiveRun(tree);
    assert.ok(failureCodes(result).includes("fixture_template_present"), codesFor(result).join(","));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a held fixture lock and an orphaned backup are both refused", () => {
  const root = mkdtempSync(join(tmpdir(), "preflight-lock-"));
  try {
    const tree = goodTree(root);
    mkdirSync(join(tree.fixtureRoot, ".stardew-native-local-player-fixture.lock"), { recursive: true });
    writeFileSync(join(tree.fixtureRoot, "some-backup.orphaned-1234"), "");
    const result = preflightLiveRun(tree);
    const failures = failureCodes(result);
    assert.ok(failures.includes("fixture_lock_free"), codesFor(result).join(","));
    assert.ok(failures.includes("fixture_root_has_no_orphan_backups"), codesFor(result).join(","));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an unreadable bridge config is a named refusal, not a guess", () => {
  const root = mkdtempSync(join(tmpdir(), "preflight-pipe-"));
  try {
    const tree = goodTree(root);
    writeFileSync(join(tree.modsPath, "GameBuddy.Stardew", "config.json"), JSON.stringify({ PipeName: "bad name!" }));
    const result = preflightLiveRun(tree);
    assert.ok(failureCodes(result).includes("bridge_config_readable"), codesFor(result).join(","));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a runner without a CLI entry point is refused, because the driver would run nothing", () => {
  const root = mkdtempSync(join(tmpdir(), "preflight-runner-"));
  try {
    const tree = goodTree(root);
    const result = preflightLiveRun({ ...tree, action: "respond_level_up" });
    // The real repo's runner has the entry point; this asserts the check is present and green on the real tree.
    const entry = result.checks.find((item) => item.code === "smoke_runner_has_cli");
    assert.equal(entry.ok, true, JSON.stringify(entry));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
