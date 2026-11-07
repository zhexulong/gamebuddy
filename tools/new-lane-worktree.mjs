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
 *   1. submodules    copied from the main tree's checkout. `git submodule update --init` inside a linked worktree
 *                     is not offline in practice: it clones from the recorded URL, which on this machine hangs on a
 *                     credential prompt with no terminal to answer it. The two trees are at the same pinned commits,
 *                     so a copy is the same source.
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
 * Two inputs a checkout simply does not carry are mounted from the main tree before anything runs (`design/`, `ref/`,
 * both gitignored, both read-only here), and the native helper pair is published with the project's own publisher and
 * then placed where the live-run launcher checks for it. Those three repairs were done by hand in five lanes on
 * 2026-11-07, and each cost its own discovery: with `design/` absent, prelive's l0b goes red - six of the inventory
 * reconciliation gate's fourteen tests fail, and the observation-gap gate prints `observation_gap_skipped` instead of a
 * verdict - and with the pair absent from `native/`, the live-run launcher reports
 * `windows_stale_lock_reclaimer_unavailable:builder_did_not_produce_the_pair` even though the build it just ran
 * succeeded.
 *
 * USAGE:
 *   node tools/new-lane-worktree.mjs <name>      # creates ../<name> on branch lane/<name>
 *
 * It prints every action and every refusal, one line each. No game, no network, no model.
 */
import { spawnSync } from "node:child_process";
import { cpSync, existsSync } from "node:fs";
import { copyFile, cp, mkdir, readdir, realpath, symlink } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

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

/**
 * Directories the main tree has and a `git worktree add` cannot: both are gitignored, so they are absent from every
 * checkout, and each one is a rung's input. `neededBy` is what a lane creator is told when the main tree lacks it,
 * because the failure it replaces never names the path.
 */
export const LANE_MOUNTS = Object.freeze([
  { path: "design", neededBy: "prelive l0b reads design/gameplay-capability-catalog.json" },
  { path: "ref", neededBy: "prelive l0b recomputes the action inventory from ref/external/StardewValleyDecompiled" },
]);

/**
 * Where the live-run launcher looks for the stale-lock pair. The publisher does not write here - it publishes
 * `host/native/windows-stale-lock-reclaimer/.dist/win-x64` - so a lane that has published and not propagated reports
 * `windows_stale_lock_reclaimer_unavailable:builder_did_not_produce_the_pair`.
 */
export const LANE_NATIVE_PAIR_ROOT = "native/windows-stale-lock-reclaimer/.dist/win-x64";
const NATIVE_PAIR_PUBLISHER = "host/scripts/build-windows-stale-lock-reclaimer.mjs";

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
  for (const submodule of VENDORED_SUBMODULES) {
    const source = join(REPOSITORY_ROOT, submodule);
    if (!existsSync(source)) {
      refuse(`the main tree has no ${submodule} checkout to copy from`);
      return false;
    }
    cpSync(source, join(target, submodule), {
      recursive: true,
      filter: (path) => !/[\\/]\.git([\\/]|$)/u.test(path) && !/[\\/]node_modules([\\/]|$)/u.test(path),
    });
    print(`submodules: ${submodule} copied from the main tree at the same pinned commit (no fetch)`);
  }
  return true;
}

/**
 * Which declared mounts this main tree can supply. A lane must not be created without one: the rung that needed it goes
 * red later, inside a child process, and the ladder's summary names the gate but not the input it lacked.
 */
export function planLaneMounts({ mounts = LANE_MOUNTS, exists }) {
  const links = [];
  const missing = [];
  for (const mount of mounts) (exists(mount.path) ? links : missing).push(mount);
  return { links, missing };
}

/** One refusal line per mount the main tree cannot supply, each naming the path and the rung that reads it. */
export function describeMissingMounts(missing) {
  return missing.map((mount) => `the main tree has no ${mount.path}/ to link - ${mount.neededBy}`);
}

/**
 * Link a read-only mount into the lane. A link, not a copy: `ref/` is 637 MB and the gates that read either directory
 * only read it.
 */
async function linkLaneMounts({ target, links }) {
  for (const mount of links) {
    const source = join(REPOSITORY_ROOT, mount.path);
    try {
      await symlink(source, join(target, mount.path), "junction");
    } catch (error) {
      refuse(`mount: ${mount.path} could not be linked from ${source} (${error?.code ?? error?.message ?? error})`);
      return false;
    }
    print(`mount: ${mount.path} -> ${source} (a link: the lane only reads it, so a copy would only drift)`);
  }
  return true;
}

/**
 * Publish the native helper pair with the project's own publisher, then place it where the live-run launcher checks.
 * The publisher is imported from THIS lane, so the binary is built from the lane's sources and written under the
 * lane's `host/`; it is the only thing that mints the pair.
 */
async function publishNativeHelperPair({ target }) {
  let pair;
  try {
    const publisher = await import(pathToFileURL(join(target, NATIVE_PAIR_PUBLISHER)).href);
    pair = await publisher.buildWindowsStaleLockReclaimer();
  } catch (error) {
    refuse(
      `native: ${NATIVE_PAIR_PUBLISHER} refused (${error?.message ?? error}) - pnpm test and the live-run launcher both read that pair`,
    );
    return;
  }
  print(`native: ${relative(target, pair.helperPath)} published from this lane's sources`);
  const destination = join(target, LANE_NATIVE_PAIR_ROOT);
  await mkdir(destination, { recursive: true });
  for (const source of [pair.helperPath, pair.manifestPath]) {
    await copyFile(source, join(destination, basename(source)));
  }
  print(`native: the same pair placed under ${LANE_NATIVE_PAIR_ROOT}, where the live-run launcher checks for it`);
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
  // Before the worktree exists, so a refusal leaves nothing half-created and names the path the main tree lacks.
  const mounts = planLaneMounts({ exists: (path) => existsSync(join(REPOSITORY_ROOT, path)) });
  if (mounts.missing.length > 0) {
    for (const line of describeMissingMounts(mounts.missing)) refuse(`mount: ${line}`);
    return 1;
  }
  if (!createWorktree({ target, branch: `lane/${name}` })) return 1;
  if (!(await linkLaneMounts({ target, links: mounts.links }))) return 1;
  if (!initSubmodules({ target })) return 1;
  const copies = planVendoredDistCopies({
    packages: await discoverVendoredDistPackages({ root: REPOSITORY_ROOT }),
    laneHasDist: (directory) => existsSync(join(target, directory, "dist")),
  });
  if (!(await installLane({ target, copies }))) return 1;
  if (!(await assertInstallIsLocal({ target }))) return 1;
  await publishNativeHelperPair({ target });
  await shareArtifact({ target });
  // The freshness check, not this script, has the last word on whether the lane can run.
  const verdict = await assessLiveRunArtifactFreshness({ repositoryRoot: target });
  print(`freshness: ${verdict.stale ? "STALE" : "current"} (${verdict.rule}) ${verdict.detail}`);
  print(`next: cd ../${name} && pnpm --dir host build:test`);
  print(`then: cd ../${name} && node tools/prelive.mjs --no-game`);
  return 0;
}

if (import.meta.main) process.exitCode = await main(process.argv.slice(2));
