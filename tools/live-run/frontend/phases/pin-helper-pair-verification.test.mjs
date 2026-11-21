// Every native helper pair the pin copies into a stage is verified by the builder that will CONSUME it.
// `required` decides whether an ABSENT pair fails the pin; it never decides whether a PRESENT one is
// checked.
//
// Measured 2026-11-22 (`D:\gb-lanes\deathproof-y`, commit 776f169f): the main checkout's
// `host/native/windows-stale-lock-reclaimer/.dist/win-x64` held a manifest naming sha256 `b10eddbf…`
// beside an exe hashing `5d2cb694…`, in a six-file directory - the residue of two publishes into one
// shared root (`host/scripts/build-windows-stale-lock-reclaimer.test.mjs` moves that root aside and
// republishes it). The pin marked this helper `required = $false`, so it copied the pair WITHOUT asking
// the builder; `build.ps1` step 3 saw an exe and skipped its rebuild; and the generation builder then
// refused the copy `windows_stale_lock_reclaimer_pair_invalid` 137 s into the build phase - after the
// typecheck and the Mod build had already been paid for, and with nothing naming the copy as the cause.
//
// This drives the real `pin.ps1` against a throwaway repository whose reclaimer pair is poisoned exactly
// that way. The verdict comes from the builder module the pin is told to consult, copied into the
// fixture from the real tree: the acceptance rule stays in one place, and this test only supplies the
// repository the pin reads.
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const PIN_SCRIPT = fileURLToPath(new URL("./pin.ps1", import.meta.url));
const REPO_ROOT = fileURLToPath(new URL("../../../../", import.meta.url));
const STALE_LOCK_RECLAIMER_BUILDER = join(REPO_ROOT, "host", "scripts", "build-windows-stale-lock-reclaimer.mjs");
const DOTNET_SDK_LOCK = join(REPO_ROOT, "host", "scripts", "dotnet-sdk-lock.mjs");

/** A file the pin's materialization steps look for, committed so the worktree checks it out. */
function seedFile(path, body = "") {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, body, "utf8");
}

/** The paths `pin.ps1` §1-§4b touches, as placeholders: the pair under test is §4c's. */
function seedMaterialization(repo) {
  seedFile(join(repo, "node_modules", ".gitkeep"));
  seedFile(join(repo, "host", "node_modules", "typescript", "lib", "tsc.js"));
  seedFile(join(repo, "dialogue-web", "node_modules", "vite", "bin", "vite.js"));
  for (const sibling of ["rolldown", "postcss", "esbuild", "picomatch", "tinyglobby", "jiti", "lightningcss", "yaml"])
    seedFile(join(repo, "node_modules", ".pnpm", "node_modules", sibling, ".gitkeep"));
  seedFile(join(repo, "vendor", "pi-koe", ".gitkeep"));
  seedFile(join(repo, "vendor", "magic-context", "packages", "cli", ".gitkeep"));
  seedFile(join(repo, "vendor", "magic-context", "packages", "dashboard", ".gitkeep"));
}

/**
 * The builder module the pin will hand to `probes/verified-helper-pair.mjs`, copied from the real tree so
 * the acceptance rule is the product's, plus the poisoned pair it must refuse: a manifest naming one
 * helper beside another helper's bytes, which is what two publishes into one shared root leave behind.
 */
function seedPoisonedReclaimerPair(repo) {
  const scripts = join(repo, "host", "scripts");
  mkdirSync(scripts, { recursive: true });
  copyFileSync(STALE_LOCK_RECLAIMER_BUILDER, join(scripts, "build-windows-stale-lock-reclaimer.mjs"));
  copyFileSync(DOTNET_SDK_LOCK, join(scripts, "dotnet-sdk-lock.mjs"));
  const pair = join(repo, "host", "native", "windows-stale-lock-reclaimer", ".dist", "win-x64");
  seedFile(join(pair, "GameBuddy.WindowsStaleLockReclaimer.exe"), "the helper some other publish wrote\n");
  seedFile(join(pair, "GameBuddy.WindowsStaleLockReclaimer.pdb"), "a publish residue a single-file publish never writes\n");
  seedFile(
    join(pair, "windows-stale-lock-reclaimer.manifest.json"),
    '{"schemaVersion":1,"protocolVersion":1,"rid":"win-x64","helperFileName":"GameBuddy.WindowsStaleLockReclaimer.exe","sha256":"b10eddbfb18436d1a7fb6bb95ff0a078a4d7dbf801ff91026e2d0b7264e7a1c9"}\n',
  );
}

function runPin({ repo, stageRoot, worktree, logPath }) {
  return new Promise((resolve) => {
    const child = spawn(
      "powershell.exe",
      [
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        PIN_SCRIPT,
        "-Repo",
        repo,
        "-Worktree",
        worktree,
        "-StageRoot",
        stageRoot,
        "-Commit",
        "HEAD",
        "-Log",
        logPath,
      ],
      { stdio: ["ignore", "pipe", "pipe"], windowsHide: true },
    );
    let output = "";
    child.stdout.on("data", (chunk) => {
      output += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      output += String(chunk);
    });
    child.on("close", (code) => resolve({ code, output }));
  });
}

test(
  "a poisoned helper pair in the main checkout refuses the pin by name instead of being copied",
  { timeout: 180_000 },
  async () => {
    const root = mkdtempSync(join(tmpdir(), "gb-pin-helper-pair-"));
    const repo = join(root, "repo");
    const stageRoot = join(root, "shots.stage");
    const worktree = join(stageRoot, "worktree");
    const logPath = join(root, "pin.log");

    mkdirSync(repo, { recursive: true });
    execFileSync("git", ["init", "-q", repo], { windowsHide: true });
    seedMaterialization(repo);
    seedPoisonedReclaimerPair(repo);
    execFileSync("git", ["-C", repo, "add", "-A", "--force"], { windowsHide: true });
    execFileSync(
      "git",
      ["-C", repo, "-c", "user.email=pin@test", "-c", "user.name=pin", "commit", "-q", "-m", "seed"],
      { windowsHide: true },
    );

    try {
      const result = await runPin({ repo, stageRoot, worktree, logPath });
      const log = readFileSync(logPath, "utf8");

      // The defect this test exists for: the copy is handed on without asking the builder.
      assert.match(
        log,
        /windows-stale-lock-reclaimer \.dist copied; win-x64 entries=\[/u,
        `the pin must have reached its helper-pair copy step; it said:\n${log.slice(-2000)}`,
      );
      assert.match(
        log,
        /windows_stale_lock_reclaimer_pair_invalid:/u,
        `a pair its builder refuses must be named before the build phase pays for it; the pin said:\n${log.slice(-2000)}`,
      );
      assert.match(log, /DONE-PIN-FAIL \(a native helper pair did not survive the copy\)/u);
      assert.equal(result.code, 1, `the pin must refuse a pair its builder rejects; it said:\n${result.output.slice(-1500)}`);

      // The refusal must arrive at the copy, not 137 s into a build: nothing downstream may have run.
      assert.doesNotMatch(log, /DONE-PIN$/mu, "the pin ended as a success with a helper its builder refuses");
      assert.doesNotMatch(log, /=== 5\. CONTAINMENT CHECK ===/u, "the pin went on past the copy it refuses");
    } finally {
      spawnSync("git", ["-C", repo, "worktree", "prune"], { windowsHide: true });
      rmSync(root, { recursive: true, force: true });
    }
  },
);
