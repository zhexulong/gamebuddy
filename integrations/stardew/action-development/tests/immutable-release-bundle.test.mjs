import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, readdir, rmdir, symlink, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createImmutableReleaseBundleBinding, IMMUTABLE_RELEASE_BUNDLE_FILES, inspectExactReleaseBundle } from "../src/immutable-release-bundle.mjs";

const CONTENTS = Object.freeze({
  "GameBuddy.Stardew.dll": "mod",
  "GameBuddy.Stardew.Core.dll": "core",
  "Raffinert.FuzzySharp.dll": "fuzzy",
  "manifest.json": JSON.stringify({ Name: "GameBuddy", UniqueID: "zhexulong.GameBuddy", EntryDll: "GameBuddy.Stardew.dll", Version: "0.1.0" }),
  "GameBuddy.Stardew.deps.json": "{}",
});
function digest(contents = CONTENTS) {
  const hash = createHash("sha256");
  for (const name of IMMUTABLE_RELEASE_BUNDLE_FILES) {
    hash.update(Buffer.from(name)); hash.update(Buffer.from([0])); hash.update(Buffer.from(contents[name]));
  }
  return hash.digest("hex");
}
async function removeFixtureTree(directory) {
  const entries = await readdir(directory, { withFileTypes: true }).catch((error) => {
    if (error?.code === "ENOENT") return [];
    throw error;
  });
  for (const entry of entries) {
    const candidate = path.join(directory, entry.name);
    const details = await lstat(candidate);
    if (details.isSymbolicLink() || details.isFile()) await unlink(candidate);
    else if (details.isDirectory()) {
      await removeFixtureTree(candidate);
      await rmdir(candidate);
    } else throw new Error("immutable_release_test_cleanup_unexpected_entry");
  }
}
async function context(callback) {
  const root = await mkdtemp(path.join(os.tmpdir(), "immutable-release-"));
  const releaseDir = path.join(root, "release"); const modsPath = path.join(root, "game", "Mods"); const runRoot = path.join(root, "runs");
  await mkdir(releaseDir); await mkdir(modsPath, { recursive: true }); await mkdir(runRoot);
  for (const [name, contents] of Object.entries(CONTENTS)) await writeFile(path.join(releaseDir, name), contents);
  try { await callback({ root, releaseDir, modsPath, runRoot, expectedDigest: digest(), runIdentity: "run-1" }); }
  finally {
    await removeFixtureTree(root);
    await rmdir(root);
  }
}
function errorCode(code) { return new RegExp(`stardew_immutable_release_bundle_${code}`); }

const HAS_DISTINCT_TEST_VOLUMES = path.parse(process.cwd()).root.toLowerCase() !== path.parse(os.tmpdir()).root.toLowerCase();
test("accepts physically separate release and runtime roots on different volumes", { skip: !HAS_DISTINCT_TEST_VOLUMES }, async () => {
  const sourceParent = await mkdtemp(path.join(process.cwd(), ".immutable-release-cross-volume-"));
  const runtimeParent = await mkdtemp(path.join(os.tmpdir(), "immutable-release-cross-volume-"));
  const releaseDir = path.join(sourceParent, "release");
  const modsPath = path.join(runtimeParent, "game", "Mods");
  const runRoot = path.join(runtimeParent, "runs");
  await mkdir(releaseDir);
  await mkdir(modsPath, { recursive: true });
  await mkdir(runRoot);
  for (const [name, contents] of Object.entries(CONTENTS)) await writeFile(path.join(releaseDir, name), contents);
  try {
    const binding = await createImmutableReleaseBundleBinding({ releaseDir, modsPath, runRoot, expectedDigest: digest(), runIdentity: "cross-volume" });
    await binding.runLifecycle(async () => ({
      operationResult: null,
      cleanupResult: { schema: "gamebuddy-stardew-lifecycle-cleanup-result/v1", completed: true },
    }));
    await binding.close();
  } finally {
    await removeFixtureTree(sourceParent);
    await rmdir(sourceParent);
    await removeFixtureTree(runtimeParent);
    await rmdir(runtimeParent);
  }
});

test("successful exact five-file binding stages every canonical entry and lifecycle-only", async () => context(async (options) => {
  assert.deepEqual(IMMUTABLE_RELEASE_BUNDLE_FILES, [
    "GameBuddy.Stardew.dll",
    "GameBuddy.Stardew.Core.dll",
    "Raffinert.FuzzySharp.dll",
    "manifest.json",
    "GameBuddy.Stardew.deps.json",
  ]);
  const binding = await createImmutableReleaseBundleBinding(options);
  const staged = binding.inspect().releaseDir;
  assert.notEqual(staged, options.releaseDir); assert.notEqual(staged, path.join(options.modsPath, "GameBuddy"));
  assert.deepEqual((await readdir(staged)).sort(), [...IMMUTABLE_RELEASE_BUNDLE_FILES].sort());
  assert.equal(Object.hasOwn(binding, "prepare"), false);
  assert.equal(Object.hasOwn(binding, "restore"), false);
  await assert.rejects(binding.close(), errorCode("close_before_restore"));
  await binding.runLifecycle(async () => ({
    operationResult: null,
    cleanupResult: { schema: "gamebuddy-stardew-lifecycle-cleanup-result/v1", completed: true },
  }));
  await binding.close();
  await assert.rejects(binding.close(), errorCode("closed"));
  await assert.rejects(readFile(staged), /ENOENT|EISDIR/);
}));

test("runs a complete lifecycle once against the immutable staged bundle", async () => context(async (options) => {
  const binding = await createImmutableReleaseBundleBinding(options);
  const staged = binding.inspect().releaseDir;
  const result = await binding.runLifecycle(async (value) => {
    assert.equal(value.releaseDir, staged);
    return {
      operationResult: { proof: "accepted" },
      cleanupResult: { schema: "gamebuddy-stardew-lifecycle-cleanup-result/v1", completed: true },
    };
  }, { releaseDir: "attacker" });
  assert.deepEqual(result, { proof: "accepted" });
  await assert.rejects(binding.runLifecycle(async () => ({
    operationResult: null,
    cleanupResult: { schema: "gamebuddy-stardew-lifecycle-cleanup-result/v1", completed: true },
  })), errorCode("lifecycle_replay"));
  await binding.close();
}));

test("incomplete lifecycle preserves staging and prevents close", async () => context(async (options) => {
  const binding = await createImmutableReleaseBundleBinding(options);
  const staged = binding.inspect().releaseDir;
  await assert.rejects(binding.runLifecycle(async () => ({
    operationResult: null,
    cleanupResult: { schema: "gamebuddy-stardew-lifecycle-cleanup-result/v1", completed: false },
  })), errorCode("lifecycle_incomplete"));
  assert.equal((await lstat(staged)).isDirectory(), true);
  await assert.rejects(binding.close(), errorCode("close_before_restore"));
}));

test("includes Raffinert.FuzzySharp.dll in the exact-bundle digest", async () => context(async (options) => {
  const original = await inspectExactReleaseBundle(options);
  await writeFile(path.join(options.releaseDir, "Raffinert.FuzzySharp.dll"), "changed-fuzzy");
  const changed = await inspectExactReleaseBundle(options);
  assert.equal(original.files, 5);
  assert.equal(changed.files, 5);
  assert.notEqual(changed.digest, original.digest);
}));

test("rejects a four-file source missing Raffinert.FuzzySharp.dll", async () => context(async (options) => {
  await unlink(path.join(options.releaseDir, "Raffinert.FuzzySharp.dll"));
  await assert.rejects(createImmutableReleaseBundleBinding(options), errorCode("source_untrusted"));
  assert.deepEqual(await readdir(options.runRoot), []);
}));

test("rejects wrong preflight digest and leaves no staging directory", async () => context(async (options) => {
  await assert.rejects(createImmutableReleaseBundleBinding({ ...options, expectedDigest: "0".repeat(64) }), errorCode("digest_mismatch"));
  assert.deepEqual(await readdir(options.runRoot), []);
}));

test("rejects source drift before copy", async () => context(async (options) => {
  await writeFile(path.join(options.releaseDir, "GameBuddy.Stardew.dll"), "changed");
  await assert.rejects(createImmutableReleaseBundleBinding(options), errorCode("digest_mismatch"));
}));

test("detects source drift during copy through the pinned-handle final source revalidation", async () => context(async (options) => {
  const large = Buffer.alloc(64 * 1024 * 1024, 7);
  await writeFile(path.join(options.releaseDir, "GameBuddy.Stardew.dll"), large);
  const changed = { ...CONTENTS, "GameBuddy.Stardew.dll": large };
  const promise = createImmutableReleaseBundleBinding({ ...options, expectedDigest: digest(changed) });
  while (!(await readdir(options.runRoot)).includes(".gamebuddy-release-run-1")) await new Promise((resolve) => setImmediate(resolve));
  await writeFile(path.join(options.releaseDir, "GameBuddy.Stardew.dll"), "switched");
  await assert.rejects(promise, errorCode("source_drift"));
}));

test("rejects symlink bundle file", { skip: process.platform === "win32" }, async () => context(async (options) => {
  const candidate = path.join(options.releaseDir, "GameBuddy.Stardew.dll"); await unlink(candidate); await symlink(path.join(options.releaseDir, "GameBuddy.Stardew.Core.dll"), candidate);
  await assert.rejects(createImmutableReleaseBundleBinding(options), errorCode("source_untrusted"));
}));

test("staged tamper prevents lifecycle execution", async () => context(async (options) => {
  const binding = await createImmutableReleaseBundleBinding(options);
  await writeFile(path.join(binding.inspect().releaseDir, "manifest.json"), "tampered");
  await assert.rejects(binding.runLifecycle(async () => assert.fail("must not run lifecycle")), errorCode("staged_tamper"));
}));

test("cleanup rejects unexpected contents and reports uncertainty", async () => context(async (options) => {
  const binding = await createImmutableReleaseBundleBinding(options);
  await binding.runLifecycle(async () => ({
    operationResult: null,
    cleanupResult: { schema: "gamebuddy-stardew-lifecycle-cleanup-result/v1", completed: true },
  }));
  const staged = binding.inspect().releaseDir; await writeFile(path.join(staged, "unexpected"), "x");
  await assert.rejects(binding.close(), errorCode("cleanup_uncertain"));
  assert.ok((await readdir(staged)).includes("unexpected"));
}));

test("exclusive package/run ownership rejects staging replay", async () => context(async (options) => {
  await mkdir(path.join(options.runRoot, ".gamebuddy-release-run-1"));
  await assert.rejects(createImmutableReleaseBundleBinding(options), errorCode("staging_owned"));
}));

test("untrusted source yields a bounded error with no cause/errors leak", async () => context(async (options) => {
  await unlink(path.join(options.releaseDir, "Raffinert.FuzzySharp.dll"));
  await assert.rejects(createImmutableReleaseBundleBinding(options), (error) => {
    assert.strictEqual(error.message, "stardew_immutable_release_bundle_source_untrusted");
    assert.strictEqual(Object.hasOwn(error, "cause"), false);
    assert.strictEqual(Object.hasOwn(error, "errors"), false);
    return true;
  });
  assert.deepEqual(await readdir(options.runRoot), []);
}));

test("cleanup uncertainty yields a bounded error with no cause/errors leak and preserves staging", async () => context(async (options) => {
  const binding = await createImmutableReleaseBundleBinding(options);
  await binding.runLifecycle(async () => ({
    operationResult: null,
    cleanupResult: { schema: "gamebuddy-stardew-lifecycle-cleanup-result/v1", completed: true },
  }));
  const staged = binding.inspect().releaseDir;
  await writeFile(path.join(staged, "unexpected"), "x");
  await assert.rejects(binding.close(), (error) => {
    assert.strictEqual(error.message, "stardew_immutable_release_bundle_cleanup_uncertain");
    assert.strictEqual(Object.hasOwn(error, "cause"), false);
    assert.strictEqual(Object.hasOwn(error, "errors"), false);
    return true;
  });
  assert.ok((await readdir(staged)).includes("unexpected"));
}));
