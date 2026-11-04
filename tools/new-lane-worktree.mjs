#!/usr/bin/env node
/**
 * Create a lane worktree that a live gate can actually run in.
 *
 * WHY: `host/scripts/build-test-artifact.mjs` refuses inside a worktree - `host/node_modules` is a junction into
 * another tree, so `realpath(tsc.js)` escapes the repository root and the build stops with
 * `typescript_entry_escapes_repository_root`. "Just build it there" is therefore not available, and a lane without
 * `host/dist-test` cannot start a live run at all (`artifact_missing`, four runs lost to it in one day).
 *
 * A lane CAN share the main tree's artifact, because the freshness check compares CONTENT, not time
 * (`tools/lib/live-run-artifact-freshness.mjs`): the copy is correct exactly while this lane's Host sources are
 * byte-identical to the tree that built it. So this script copies `host/dist-test` only when the artifact's own
 * `build-manifest.json` matches this worktree's inputs, and refuses - naming the drifting files - the moment one
 * differs. It then asks the freshness check itself for the verdict, so the copy is not trusted on this script's word.
 *
 * USAGE:
 *   node tools/new-lane-worktree.mjs <name>      # creates ../<name> on branch lane/<name>
 *
 * It prints every action and every refusal, one line each. No game, no network, no model.
 */
import { spawnSync } from "node:child_process";
import { existsSync, symlinkSync } from "node:fs";
import { cp } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  collectTestArtifactInputs,
  readTestArtifactBuildManifest,
  TEST_ARTIFACT_BUILD_MANIFEST,
} from "../host/scripts/test-artifact-build-manifest.mjs";
import { assessLiveRunArtifactFreshness, findTestArtifactInputDrift } from "./lib/live-run-artifact-freshness.mjs";

const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
/** The install trees a lane cannot own: each is the main tree's copy, reached by a junction. */
const JUNCTIONED_MODULES = Object.freeze(["node_modules", "host/node_modules"]);
const MAX_LISTED_DRIFT = 5;

function print(line) {
  process.stdout.write(`${line}\n`);
}

function refuse(line) {
  process.stdout.write(`refused: ${line}\n`);
}

function git(args) {
  return spawnSync("git", args, { cwd: REPOSITORY_ROOT, encoding: "utf8" });
}

/** `git worktree add`, on a fresh `lane/<name>` branch or on the existing one when this lane is resumed. */
function createWorktree({ target, branch }) {
  const exists = git(["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]).status === 0;
  const outcome = exists ? git(["worktree", "add", target, branch]) : git(["worktree", "add", "-b", branch, target]);
  if (outcome.status !== 0) {
    process.stderr.write(`git worktree add failed (exit=${outcome.status}):\n${outcome.stderr ?? ""}`);
    return false;
  }
  print(`worktree: ${target} on ${branch}${exists ? " (existing branch)" : " (new branch)"}`);
  return true;
}

/** One junction per install tree, pointing at the main tree's copy. Returns the names that could not be linked. */
function linkModules({ target }) {
  const failed = [];
  for (const relativePath of JUNCTIONED_MODULES) {
    const source = join(REPOSITORY_ROOT, relativePath);
    const destination = join(target, relativePath);
    if (!existsSync(source)) {
      refuse(`junction ${relativePath}: the main tree has no ${relativePath} (run \`pnpm install\` there first)`);
      failed.push(relativePath);
      continue;
    }
    if (existsSync(destination)) {
      refuse(`junction ${relativePath}: ${relativePath} already exists in the worktree`);
      failed.push(relativePath);
      continue;
    }
    try {
      symlinkSync(source, destination, "junction");
      print(`junction: ${relativePath} -> ${source}`);
    } catch (error) {
      refuse(`junction ${relativePath}: ${error?.message ?? error}`);
      failed.push(relativePath);
    }
  }
  return failed;
}

/**
 * Copy the main tree's artifact when - and only when - the artifact's build manifest describes THIS worktree's
 * inputs. The decision is the freshness check's own comparison, not a second opinion written here.
 */
async function shareArtifact({ target }) {
  const source = join(REPOSITORY_ROOT, "host", "dist-test");
  const destination = join(target, "host", "dist-test");
  if (!existsSync(source)) {
    refuse(`artifact: the main tree has no host/dist-test (build it there with \`cd host && pnpm build:test\`)`);
    return;
  }
  let manifest;
  try {
    manifest = await readTestArtifactBuildManifest({ outputRoot: source });
  } catch (error) {
    refuse(`artifact: host/dist-test/${TEST_ARTIFACT_BUILD_MANIFEST} cannot be read (${error?.message ?? error})`);
    return;
  }
  if (manifest === undefined) {
    refuse(
      `artifact: host/dist-test carries no ${TEST_ARTIFACT_BUILD_MANIFEST}, so nothing proves it was built from these sources (rebuild it in the main tree)`,
    );
    return;
  }
  const drift = findTestArtifactInputDrift({
    manifest,
    inputs: await collectTestArtifactInputs({ repositoryRoot: target }),
  });
  if (drift.length > 0) {
    const listed = drift
      .slice(0, MAX_LISTED_DRIFT)
      .map((entry) => `${entry.code}:${entry.path}`)
      .join(", ");
    refuse(
      `artifact: this lane's sources differ from the build in ${drift.length} input(s): ${listed}${drift.length > MAX_LISTED_DRIFT ? `, and ${drift.length - MAX_LISTED_DRIFT} more` : ""}`,
    );
    return;
  }
  await cp(source, destination, { recursive: true, force: true });
  print(
    `artifact: copied host/dist-test from the main tree (${Object.keys(manifest.inputs).length} inputs match ${TEST_ARTIFACT_BUILD_MANIFEST})`,
  );
}

async function main(argv) {
  const name = argv[0];
  if (name === undefined || !/^[a-z0-9][a-z0-9._-]*$/u.test(name)) {
    process.stderr.write("usage: node tools/new-lane-worktree.mjs <name>   (lowercase letters, digits, dot, dash)\n");
    return 2;
  }
  const target = resolve(REPOSITORY_ROOT, "..", name);
  if (existsSync(target)) {
    process.stderr.write(`refused: ${target} already exists\n`);
    return 1;
  }
  if (!createWorktree({ target, branch: `lane/${name}` })) return 1;
  const unlinked = linkModules({ target });
  await shareArtifact({ target });
  // The freshness check, not this script, has the last word on whether the lane can run.
  const verdict = await assessLiveRunArtifactFreshness({ repositoryRoot: target });
  print(`freshness: ${verdict.stale ? "STALE" : "current"} (${verdict.rule}) ${verdict.detail}`);
  print(`next: cd ../${name} && node tools/prelive.mjs --no-game`);
  return unlinked.length === 0 ? 0 : 1;
}

if (import.meta.main) process.exitCode = await main(process.argv.slice(2));
