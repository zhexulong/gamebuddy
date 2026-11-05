#!/usr/bin/env node
/**
 * Create a lane worktree that can build.
 *
 * WHY: a lane used to be created with `node_modules` and `host/node_modules` junctioned into the main tree, and it
 * could not build at all. `realpath(tsc)` then landed outside the repository, so the build stopped with
 * `typescript_entry_escapes_repository_root` and the verification manifest with
 * `host_verification_artifact_dependency_outside_repository`. Every lane paid for that discovery on its own. This
 * script gives the lane its own install instead, and puts the three things around it in the only order that works:
 *
 *   1. submodules    `git submodule update --init` from the shared object store: no fetch, no network.
 *   2. vendored dist  a submodule checkout carries no build output, so every package that has a `dist` in the main
 *                     tree and not here gets a copy. The submodule commit is identical on both sides, so the artifact
 *                     describes the same source. Without it the compiler reports `Cannot find module
 *                     '@cortexkit/pi-magic-context'` and `'@gamebuddy/voice-protocol'`.
 *   3. install       `pnpm install --frozen-lockfile --offline` in the lane, plus one install per vendored submodule
 *                     that owns its own workspace: the build imports `vendor/pi-koe/scripts/build-release-artifact.mjs`,
 *                     which needs esbuild.
 *
 * Step 2 before step 3 is the whole point of that order. pnpm snapshots a `file:` dependency into `node_modules/.pnpm`
 * when it installs and never re-copies it, so a `dist` that appears afterwards is invisible - `Already up to date`,
 * `--force` included. A lane that copies a vendored `dist` after installing has to delete `node_modules` and install
 * again; this script copies first and is never in that state.
 *
 * A lane CAN still share the main tree's `host/dist-test`, because the freshness check compares CONTENT, not time
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
import { existsSync } from "node:fs";
import { cp, readdir, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import {
  collectTestArtifactInputs,
  readTestArtifactBuildManifest,
  TEST_ARTIFACT_BUILD_MANIFEST,
} from "../host/scripts/test-artifact-build-manifest.mjs";
import { assessLiveRunArtifactFreshness, findTestArtifactInputDrift } from "./lib/live-run-artifact-freshness.mjs";

const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** The submodules the Host build reads from. Both sit outside the pnpm workspace, so neither is installed by step 3. */
const VENDORED_SUBMODULES = Object.freeze(["vendor/pi-koe", "vendor/magic-context"]);

/** A vendored submodule that owns a pnpm workspace of its own; the build imports a script that imports esbuild. */
const SUBMODULE_INSTALLS = Object.freeze(["vendor/pi-koe"]);

/**
 * The dependency entries whose resolution decides whether this lane owns its install. `typescript` is the compiler
 * entry the build realpath-checks, and the two `file:` packages are what the verification manifest resolves and
 * refuses when they land in another tree.
 */
const INSTALL_RESOLUTION_ENTRIES = Object.freeze([
  "host/node_modules/typescript",
  "host/node_modules/@cortexkit/pi-magic-context",
  "host/node_modules/@gamebuddy/voice-protocol",
]);

const PNPM_INSTALL = "pnpm install --frozen-lockfile --offline";
const MAX_LISTED_DRIFT = 5;

function print(line) {
  process.stdout.write(`${line}\n`);
}

function refuse(line) {
  process.stdout.write(`refused: ${line}\n`);
}

function git(args, { cwd = REPOSITORY_ROOT } = {}) {
  return spawnSync("git", args, { cwd, encoding: "utf8" });
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

/**
 * Check the vendored submodules out into the lane. A worktree shares the main repository's object store, so the
 * recorded commits are already there and this fetches nothing.
 */
function initSubmodules({ target }) {
  const outcome = git(["submodule", "update", "--init", ...VENDORED_SUBMODULES], { cwd: target });
  if (outcome.status !== 0) {
    process.stderr.write(`git submodule update --init failed (exit=${outcome.status}):\n${outcome.stderr ?? ""}`);
    return false;
  }
  print(`submodules: ${VENDORED_SUBMODULES.join(", ")} at their pinned commits (shared object store, no fetch)`);
  return true;
}

/** Repo-relative package directories under the vendored submodules that carry a built `dist` in this tree. */
async function discoverVendoredDistPackages({ root }) {
  const packages = [];
  for (const submodule of VENDORED_SUBMODULES) {
    let entries;
    try {
      entries = await readdir(join(root, submodule, "packages"), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const directory = `${submodule}/packages/${entry.name}`;
      if (existsSync(join(root, directory, "dist"))) packages.push(directory);
    }
  }
  return packages.sort((left, right) => left.localeCompare(right, "en"));
}

/**
 * The vendored `dist` trees this lane has to copy: one per package whose main-tree copy carries a build output and
 * whose lane copy does not. Same submodule commit on both sides, so the output describes the source in the lane.
 */
export function planVendoredDistCopies({ packages, laneHasDist }) {
  return packages
    .filter((directory) => !laneHasDist(directory))
    .map((directory) => ({
      package: directory,
      source: `${directory}/dist`,
      destination: `${directory}/dist`,
    }));
}

async function copyVendoredDists({ target, copies }) {
  if (copies.length === 0) {
    print("dist: every vendored package already carries its build output here");
    return;
  }
  for (const copy of copies) {
    await cp(join(REPOSITORY_ROOT, copy.source), join(target, copy.destination), { recursive: true, force: true });
    print(`dist: copied ${copy.source} from the main tree (same submodule commit)`);
  }
  print(
    `dist: ${copies.length} package(s) copied BEFORE the install; pnpm links a file: dependency at install time, so a dist copied afterwards would be invisible to it`,
  );
}

function pnpmInstall({ target, directory }) {
  const cwd = resolve(target, directory);
  print(`install: ${directory === "." ? "lane" : directory} -> ${PNPM_INSTALL}`);
  const outcome = spawnSync(PNPM_INSTALL, { cwd, stdio: "inherit", shell: true });
  if (outcome.status !== 0) {
    process.stderr.write(
      `pnpm install failed in ${cwd} (exit=${outcome.status ?? outcome.error?.message ?? "unknown"})\n`,
    );
    return false;
  }
  return true;
}

/** Vendored dist copies first, install second. Returns false when any install failed. */
async function installLane({ target, copies }) {
  await copyVendoredDists({ target, copies });
  if (!pnpmInstall({ target, directory: "." })) return false;
  for (const directory of SUBMODULE_INSTALLS) if (!pnpmInstall({ target, directory })) return false;
  return true;
}

/**
 * The entries that resolve outside `laneRoot`. The build refuses both shapes itself - a junctioned install tree makes
 * `realpath(tsc)` escape the repository and the verification manifest refuse the dependency - so this asks the same
 * question before anything is built, and names the entry that answers wrong.
 */
export function modulesOutsideLane({ laneRoot, entries }) {
  const root = resolve(laneRoot);
  return entries.filter((entry) => {
    const value = relative(root, resolve(entry.resolved));
    return value === ".." || value.startsWith(`..${sep}`) || isAbsolute(value);
  });
}

/** Fails closed unless every dependency entry the build reads resolves inside this lane. */
async function assertInstallIsLocal({ target }) {
  const entries = [];
  for (const path of INSTALL_RESOLUTION_ENTRIES) {
    try {
      entries.push({ path, resolved: await realpath(join(target, path)) });
    } catch (error) {
      refuse(`install: ${path} does not resolve in this lane (${error?.code ?? error?.message ?? error})`);
      return false;
    }
  }
  const outside = modulesOutsideLane({ laneRoot: target, entries });
  if (outside.length > 0) {
    refuse(
      `install: ${outside.map((entry) => `${entry.path} -> ${entry.resolved}`).join(", ")} resolve outside the lane, which the build rejects as a dependency outside the repository`,
    );
    return false;
  }
  print(`install: ${INSTALL_RESOLUTION_ENTRIES.length} dependency entries resolve inside the lane`);
  return true;
}

/**
 * Whether the main tree's artifact describes this lane's inputs. The comparison is the freshness check's own, not a
 * second opinion written here; a missing manifest is a refusal, never a copy.
 */
export function decideArtifactCopy({ manifest, inputs }) {
  if (manifest === undefined)
    return {
      copy: false,
      reason: `host/dist-test carries no ${TEST_ARTIFACT_BUILD_MANIFEST}, so nothing proves it was built from these sources (rebuild it in the main tree)`,
    };
  const drift = findTestArtifactInputDrift({ manifest, inputs });
  if (drift.length > 0) {
    const listed = drift
      .slice(0, MAX_LISTED_DRIFT)
      .map((entry) => `${entry.code}:${entry.path}`)
      .join(", ");
    const rest = drift.length > MAX_LISTED_DRIFT ? `, and ${drift.length - MAX_LISTED_DRIFT} more` : "";
    return {
      copy: false,
      drift,
      reason: `this lane's sources differ from the build in ${drift.length} input(s): ${listed}${rest}`,
    };
  }
  return { copy: true, inputs: Object.keys(manifest.inputs).length };
}

/**
 * Copy the main tree's artifact when - and only when - its build manifest describes THIS worktree's inputs.
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
  const decision = decideArtifactCopy({
    manifest,
    inputs: await collectTestArtifactInputs({ repositoryRoot: target }),
  });
  if (!decision.copy) {
    refuse(`artifact: ${decision.reason}`);
    return;
  }
  await cp(source, destination, { recursive: true, force: true });
  print(
    `artifact: copied host/dist-test from the main tree (${decision.inputs} inputs match ${TEST_ARTIFACT_BUILD_MANIFEST})`,
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
  if (!initSubmodules({ target })) return 1;
  const copies = planVendoredDistCopies({
    packages: await discoverVendoredDistPackages({ root: REPOSITORY_ROOT }),
    laneHasDist: (directory) => existsSync(join(target, directory, "dist")),
  });
  if (!(await installLane({ target, copies }))) return 1;
  if (!(await assertInstallIsLocal({ target }))) return 1;
  await shareArtifact({ target });
  // The freshness check, not this script, has the last word on whether the lane can run.
  const verdict = await assessLiveRunArtifactFreshness({ repositoryRoot: target });
  print(`freshness: ${verdict.stale ? "STALE" : "current"} (${verdict.rule}) ${verdict.detail}`);
  print(`next: cd ../${name} && pnpm --dir host build:test`);
  print(`then: cd ../${name} && node tools/prelive.mjs --no-game`);
  return 0;
}

if (import.meta.main) process.exitCode = await main(process.argv.slice(2));
