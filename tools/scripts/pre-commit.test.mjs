#!/usr/bin/env node
// Proves the pre-commit hook's contract: it formats what is STAGED, writes the
// result back to the index, and leaves a neighbour's unstaged hunk on disk
// exactly where it was.
//
//   node tools/scratch/prove-precommit-absorbs.mjs
//
// Three readings:
//   1. a partially staged file - only MY hunk staged, a neighbour's hunk on disk
//      -> after the hook the index carries MINE and not the neighbour's
//   2. the worktree afterwards still carries the neighbour's hunk
//   3. a genuinely unformatted staged file IS reformatted, so this did not turn
//      the hook into a no-op
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const run = (cwd, args, opts = {}) =>
  execFileSync("git", args, { cwd, encoding: "utf8", maxBuffer: 1 << 26, ...opts }).trim();

const root = fs.mkdtempSync(path.join(os.tmpdir(), "hook-proof-"));
// The hook resolves the formatter relative to the repository root it runs in, so give it a
// node_modules that points at this checkout's biome.
fs.symlinkSync(path.resolve("node_modules"), path.join(root, "node_modules"), "junction");

run(root, ["init", "-q"]);
run(root, ["config", "user.email", "proof@example.invalid"]);
run(root, ["config", "user.name", "proof"]);
run(root, ["config", "core.hooksPath", path.resolve("tools/git-hooks")]);

const FILE = "shared.md";
const NEIGHBOUR = "NEIGHBOUR-HUNK";
const MINE = "MINE-HUNK";
fs.writeFileSync(path.join(root, FILE), ["# Title", "", "line A", "line B", ""].join("\n"));
run(root, ["add", FILE]);
run(root, ["commit", "-q", "--no-verify", "-m", "base"]);

// The worktree holds BOTH hunks; only mine is staged.
fs.writeFileSync(path.join(root, FILE), ["# Title", "", "line A", NEIGHBOUR, "line B", MINE, ""].join("\n"));
fs.writeFileSync(path.join(root, ".mine.md"), ["# Title", "", "line A", "line B", MINE, ""].join("\n"));
const blob = run(root, ["hash-object", "-w", ".mine.md"]);
run(root, ["update-index", "--add", "--cacheinfo", `100644,${blob},${FILE}`]);
fs.unlinkSync(path.join(root, ".mine.md"));

const stagedBefore = run(root, ["show", `:${FILE}`]);
console.log("1. before the hook");
console.log(`   index carries NEIGHBOUR: ${stagedBefore.includes(NEIGHBOUR)}`);
console.log(`   index carries MINE     : ${stagedBefore.includes(MINE)}`);

execFileSync("node", [path.resolve("tools/scripts/pre-commit.mjs")], { cwd: root, stdio: "pipe" });

const stagedAfter = run(root, ["show", `:${FILE}`]);
const diskAfter = fs.readFileSync(path.join(root, FILE), "utf8");
console.log("2. after the hook");
console.log(`   index carries NEIGHBOUR: ${stagedAfter.includes(NEIGHBOUR)}`);
console.log(`   index carries MINE     : ${stagedAfter.includes(MINE)}`);
console.log(`   disk still carries NEIGHBOUR: ${diskAfter.includes(NEIGHBOUR)}`);

const MESSY = "messy.md";
fs.writeFileSync(path.join(root, MESSY), "# Title\n\ntrailing spaces   \n\n\n");
run(root, ["add", MESSY]);
execFileSync("node", [path.resolve("tools/scripts/pre-commit.mjs")], { cwd: root, stdio: "pipe" });
const messyAfter = run(root, ["show", `:${MESSY}`]);
console.log("3. an unformatted staged file");
console.log(`   index is now formatted: ${!messyAfter.includes("trailing spaces   ")}`);

const pass =
  !stagedBefore.includes(NEIGHBOUR) &&
  !stagedAfter.includes(NEIGHBOUR) &&
  stagedAfter.includes(MINE) &&
  diskAfter.includes(NEIGHBOUR) &&
  !messyAfter.includes("trailing spaces   ");
console.log(pass ? "VERDICT: pass" : "VERDICT: fail");
process.exit(pass ? 0 : 1);
