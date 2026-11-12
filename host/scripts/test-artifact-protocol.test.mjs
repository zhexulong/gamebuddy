import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { access, readFile, readdir, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, relative, resolve } from "node:path";
import { withTestArtifactLock } from "./test-artifact-lock.mjs";
import test from "node:test";

import { DEFAULT_SUITE_TIMEOUT_MS, runBoundedChild } from "./child-process-tool.mjs";
import { assertHostVerificationArtifactManifest } from "./verification-artifact-manifest.mjs";

const hostRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = resolve(hostRoot, "..");
const manifestFileName = "verification-artifact-manifest.json";
const pnpmCli = process.platform === "win32"
  ? resolve(process.env.APPDATA ?? resolve(process.env.USERPROFILE ?? hostRoot, "AppData", "Roaming"), "npm", "node_modules", "pnpm", "bin", "pnpm.cjs")
  : undefined;
/**
 * The Node a child of this suite must run under. The Host suite's coordinator publishes the Node it
 * resolved as `GAMEBUDDY_HOST_TEST_NODE` (`run-tests.mjs:172`) because `process.execPath` is bun when
 * the suite itself is launched by bun; `process.execPath` stays the correct fallback under Node.
 */
const testNode = process.env.GAMEBUDDY_HOST_TEST_NODE ?? process.execPath;

async function runScript(name) {
  try {
    return await runBoundedChild({
      command: pnpmCli ? testNode : "pnpm",
      args: pnpmCli ? [pnpmCli, "run", name] : ["run", name],
      cwd: hostRoot,
      timeoutMs: DEFAULT_SUITE_TIMEOUT_MS,
      spawnOptions: { env: { ...process.env, GAMEBUDDY_HOST_TEST_COMPILED_ONLY: "1" } },
    });
  } catch (error) {
    throw new Error(`package_script_${name}_failed:${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * This file deletes `host/dist-test` on purpose, and every later file in its batch loads
 * `compiled-test-bootstrap.mjs`, whose first two lines statically import `../dist-test/*`. A run that
 * failed before its own rebuild therefore left three more files to die at load with
 * `ERR_MODULE_NOT_FOUND` - which the runner retries as "environmental" and reports as their failures, so
 * one red file read as four. The rebuild is unconditional for that reason; one red file costs one file.
 */
async function rebuildTestArtifactIfMissing() {
  const present = await access(resolve(hostRoot, "dist-test")).then(() => true, () => false);
  if (present) return;
  try {
    await runScript("build:test");
  } catch {
    // The failure that reached this point is the one worth reporting; a rebuild that cannot run is the
    // same fault again, and letting it out would replace the original message.
  }
}

const digestOf = (bytes) => createHash("sha256").update(bytes).digest("hex");

/**
 * The files the published manifest recorded whose content no longer matches it.
 *
 * The population is the manifest's own inventory rather than a second walk of the tree: a check that re-derived
 * the file list could disagree with the build about which files the build described. This build writes its
 * manifest at the end of its own run, so a source file that another lane writes while the build runs leaves the
 * manifest disagreeing with the tree - the reading is "the source moved", and these paths name what moved.
 */
async function driftedSourceEntries() {
  const manifest = JSON.parse(await readFile(resolve(hostRoot, "dist-test", manifestFileName), "utf8"));
  const recorded = [
    ...manifest.source.entries.map((entry) => ({ path: resolve(hostRoot, entry.path), label: entry.path, sha256: entry.sha256 })),
    ...manifest.source.dependencies.packages.flatMap((entry) => entry.files.map((file) => ({
      path: resolve(repositoryRoot, entry.path, file.path),
      label: `${entry.path}/${file.path}`,
      sha256: file.sha256,
    }))),
    { path: resolve(repositoryRoot, manifest.source.dependencies.lockfile.path), label: manifest.source.dependencies.lockfile.path, sha256: manifest.source.dependencies.lockfile.sha256 },
  ];
  const drifted = [];
  for (const entry of recorded)
    if (await readFile(entry.path).then(digestOf, () => "unreadable") !== entry.sha256) drifted.push(entry.label);
  return drifted;
}

/**
 * One step marker per long phase.
 *
 * The runner watches this child's own output, and `node --test` prints nothing until a test completes - so a
 * file whose first test builds the whole artifact was `kind=no_output` for two minutes: indistinguishable from
 * a hang, and a reader had to guess whether it was waiting on the lock, on the compiler, or on nothing. Each
 * line below names the step that is about to cost the time and the thing it waits for.
 */
function step(name, detail = "") {
  console.error(`test_artifact_protocol:step=${name}${detail === "" ? "" : `:${detail}`}`);
}

test("package test and build:test serialize their complete dist-test ownership", async (t) => {
  const lockPath = resolve(hostRoot, ".test-artifact.lock");
  const blockers = [];
  try {
    step("acquire_artifact_lock", `waits_for=${relative(hostRoot, lockPath).replaceAll("\\", "/")}:the_compile_phase_released_it_so_contenders_can_be_tested`);
    // A valid, live lock is the deterministic contention fixture. Acquire it
    // through the production protocol before touching dist-test, then keep the
    // exact owner alive while both public scripts prove they fail closed.
    await withTestArtifactLock(async () => {
      step("artifact_lock_held");
      await rm(resolve(hostRoot, "dist-test"), { recursive: true, force: true });
      const ownedLockBytes = await readFile(lockPath);
      step("contenders_started", "both_package_scripts_race_the_held_lock");
      const contentionStartedAtMs = Date.now();
      const results = await Promise.allSettled([runScript("test"), runScript("build:test")]);
      step("contenders_rejected", `elapsed_ms=${Date.now() - contentionStartedAtMs}`);
      assert.equal(results.filter((result) => result.status === "fulfilled").length, 0);
      assert.equal(results.filter((result) => result.status === "rejected").length, 2);
      for (const result of results) {
        assert.equal(result.status, "rejected");
        assert.match(String(result.reason), /host_test_artifact_already_in_use/);
      }
      await assert.rejects(access(resolve(hostRoot, "dist-test")), { code: "ENOENT" });
      // Contenders must preserve the live owner's exact bytes; in particular,
      // they must never replace it with a malformed or newly generated record.
      assert.deepEqual(await readFile(lockPath), ownedLockBytes);
    }, { lockPath });
    // One uncontended invocation must still publish the complete verification
    // artifact. This is intentionally sequential: contention is checked above.
    step("build_test_started", "uncontended:the_lock_is_free_again:this_step_compiles_the_whole_artifact");
    const buildStartedAtMs = Date.now();
    await runScript("build:test");
    step("build_test_completed", `elapsed_ms=${Date.now() - buildStartedAtMs}`);
    step("manifest_check_started", "compares_the_published_manifest_against_this_tree");
    try {
      await assertHostVerificationArtifactManifest({ root: hostRoot });
    } catch (error) {
      // A source file written by another lane between the build's snapshot and this check is a source tree
      // that moved, not an artifact that is wrong - and the manifest's own inventory names which files moved.
      // An empty list is still a failure: with nothing moved, a digest disagreement is the defect itself.
      const drifted = error?.message === "host_verification_artifact_source_snapshot_mismatch" ? await driftedSourceEntries() : [];
      if (drifted.length === 0) throw error;
      blockers.push(`source_moved_during_build:files=${drifted.length}:paths=${drifted.join(",")}`);
      step("manifest_blocked", `source_moved_during_build:files=${drifted.length}`);
    }
    // "Complete" is read from the source tree, not from file names someone remembered: every test module the
    // compiler was given has its emitted counterpart in the artifact. The stale path that produced this line was
    // `runtime.test.js`, renamed to `runtime.private.test.ts` when that test declared the internals it pins - a name
    // list here can only ever describe the tree it was written against, so the population follows the source instead.
    const testSources = (await readdir(resolve(hostRoot, "src"), { recursive: true })).filter((name) => name.endsWith(".test.ts"));
    assert.ok(testSources.length > 300, `the population must not silently shrink: ${testSources.length} sources`);
    for (const name of testSources) {
      const emitted = resolve(hostRoot, "dist-test", name.replace(/\.ts$/u, ".js"));
      await access(emitted).catch(() => assert.fail(`no emitted test module for src/${name}`));
    }
    await access(resolve(hostRoot, "dist-test", "test-fixtures", "windows-named-mutex-safety-seal-worker.js"));
    await assert.rejects(access(resolve(hostRoot, "dist-test", "test-fixtures", "windows-named-mutex-safety-seal-worker.ts")), { code: "ENOENT" });
    await assert.rejects(access(resolve(hostRoot, "dist", "test-fixtures", "windows-named-mutex-safety-seal-worker.js")), { code: "ENOENT" });
    await assert.rejects(access(resolve(hostRoot, "dist-test", "main.js")), { code: "ENOENT" });
    await assert.rejects(access(resolve(hostRoot, "dist-test", "dialogue-web-main.js")), { code: "ENOENT" });
    const productionMaterializer = await readFile(resolve(hostRoot, "src", "continuity-semantic-game-runtime-materializer", "continuity-semantic-game-runtime-materializer.ts"), "utf8");
    const testMaterializer = await readFile(resolve(hostRoot, "dist-test", "continuity-semantic-game-runtime-materializer", "continuity-semantic-game-runtime-materializer.js"), "utf8");
    assert.doesNotMatch(productionMaterializer, /materializer\.test-support/);
    assert.match(testMaterializer, /recordMaterializedProductionRuntimeForTest/);
    assert.match(testMaterializer, /forgetMaterializedProductionRuntimeForTest/);
  } finally {
    await rebuildTestArtifactIfMissing();
  }
  // A blocked reading is published, never swallowed: the artifact's content was asserted above, and this says
  // the one property that could not be measured on this tree, naming the files that moved under it.
  if (blockers.length > 0) t.skip(`BLOCKED: ${blockers.join(" ")}`);
});

test("a raced cross-process candidate never leaves a malformed published lock", async () => {
  const lockPath = resolve(hostRoot, `.test-artifact-race-${process.pid}-${Date.now()}.lock`);
  const worker = resolve(hostRoot, "scripts/test-artifact-protocol-worker.mjs");
  const result = await runBoundedChild({
    command: testNode,
    args: [worker, "raced-contender", lockPath],
    cwd: hostRoot,
    timeoutMs: 10_000,
  });
  assert.match(result.stdout + result.stderr, /race_complete/u);
  // The worker owns and releases this lock through withTestArtifactLock. Do
  // not unlink the pathname here: if a replacement owner wins after a worker
  // failure, an unconditional finally cleanup would delete that owner.
  await assert.rejects(access(lockPath), { code: "ENOENT" });
});
