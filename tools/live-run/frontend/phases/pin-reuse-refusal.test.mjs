// Reusing an `--out` whose stage root still holds a previous run's worktree is refused, and the refusal
// is NAMED.
//
// Measured 2026-11-15, run 3 of five: `DONE-PIN-FAIL (previous worktree could not be cleared)` in
// `pin.log` and `Error: phase pin failed (exit 1)` in the terminal. The worktree could not be removed
// because a survivor of the previous run held something inside it, and the operator was told neither
// which path nor what to do. This drives the real `pin.ps1` against a throwaway git repository whose
// worktree directory is held open by a live child, which is the shape a survivor produces.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const PIN_SCRIPT = fileURLToPath(new URL("./pin.ps1", import.meta.url));

test(
  "a reused --out refuses with previous_worktree_not_cleared:<path> and the remedy",
  { timeout: 120_000 },
  async () => {
    const root = mkdtempSync(join(tmpdir(), "gb-pin-reuse-"));
    const repo = join(root, "repo");
    const stageRoot = join(root, "shots.stage");
    const worktree = join(stageRoot, "worktree");
    const logPath = join(root, "pin.log");
    mkdirSync(worktree, { recursive: true });
    writeFileSync(join(worktree, "held.txt"), "a survivor of the previous run holds this\n", "utf8");

    // A throwaway repository: `worktree remove` and `worktree prune` must never run against the real one.
    execFileSync("git", ["init", "-q", repo], { windowsHide: true });
    execFileSync(
      "git",
      ["-C", repo, "-c", "user.email=pin@test", "-c", "user.name=pin", "commit", "-q", "--allow-empty", "-m", "seed"],
      {
        windowsHide: true,
      },
    );

    // The survivor: its working directory is the worktree, and Windows will not delete a directory that is
    // some process's current directory.
    const survivor = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000);"], {
      cwd: worktree,
      stdio: "ignore",
      windowsHide: true,
    });
    try {
      await new Promise((resolve) => setTimeout(resolve, 600));
      const result = await new Promise((resolve) => {
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

      assert.equal(result.code, 1, `pin must refuse; it said:\n${result.output.slice(-1500)}`);
      const log = readFileSync(logPath, "utf8");
      assert.match(
        log,
        new RegExp(`previous_worktree_not_cleared:${worktree.replace(/[\\^$.*+?()[\]{}|]/gu, "\\$&")}`, "u"),
      );
      assert.match(log, /remedy: pass a FRESH --out/u);
      assert.match(log, /DONE-PIN-FAIL \(previous worktree could not be cleared\)/u);
    } finally {
      survivor.kill("SIGKILL");
      rmSync(root, { recursive: true, force: true });
    }
  },
);
