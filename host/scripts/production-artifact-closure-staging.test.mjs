// The deployed runtime closure is cached by content, because `pnpm deploy` is the
// one step of the release-shaped build that reaches a package registry. These
// tests hold the two halves of that claim: the key follows the deploy's inputs,
// and a stored tree is reused only while it still hashes to its own record.
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdir, mkdtemp, readdir, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  closureCacheIdentity,
  readVerifiedClosureCache,
  stageDeclaredRuntimeClosure,
  writeClosureCache,
} from "./production-artifact-closure-staging.mjs";

const TEST_ARTIFACT = /(?:^|\/)(?:[^/]*\.(?:test|test-support)(?:\.[^/]+)?|test-fixtures)(?:\/|$)/i;

/** A Host root whose deploy inputs are small enough to hash, plus the tree a deploy would leave. */
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "gb-closure-cache-"));
  const repositoryRoot = join(root, "repo");
  await mkdir(join(repositoryRoot, "host"), { recursive: true });
  await writeFile(join(repositoryRoot, "pnpm-workspace.yaml"), "packages:\n  - host\n");
  await writeFile(join(repositoryRoot, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
  await writeFile(join(repositoryRoot, "package.json"), `${JSON.stringify({ name: "fixture-root", private: true })}\n`);
  await writeFile(join(repositoryRoot, "host", "package.json"),
    `${JSON.stringify({ name: "@gamebuddy/companion-host", dependencies: { typebox: "1.1.38" } })}\n`);
  const deployedModules = join(root, "deployed", "node_modules");
  await mkdir(join(deployedModules, "typebox"), { recursive: true });
  await writeFile(join(deployedModules, "typebox", "package.json"), `${JSON.stringify({ name: "typebox", version: "1.1.38" })}\n`);
  await writeFile(join(deployedModules, "typebox", "index.js"), "export {};\n");
  return { root, repositoryRoot, hostRoot: join(repositoryRoot, "host"), deployedModules,
    cleanup: async () => await rm(root, { recursive: true, force: true }) };
}

test("a stored tree is served back while it verifies, and refused by name once it does not", async () => {
  const tree = await fixture();
  try {
    const cacheRoot = join(tree.root, "cache");
    const { key, cacheDir } = await closureCacheIdentity({ hostRoot: tree.hostRoot, cacheRoot });
    assert.equal(await readVerifiedClosureCache({ cacheDir, key }), null);

    await writeClosureCache({ cacheDir, key, deployedModules: tree.deployedModules });
    const reused = await readVerifiedClosureCache({ cacheDir, key });
    assert.equal(await readFile(join(reused, "typebox", "index.js"), "utf8"), "export {};\n");

    // Same three files, different content: present is not the claim.
    await writeFile(join(reused, "typebox", "index.js"), "export {  };\n");
    await assert.rejects(readVerifiedClosureCache({ cacheDir, key }), (error) => {
      assert.match(error.message, /^runtime_closure_cache_invalid:/u);
      assert.ok(error.message.includes(cacheDir), error.message);
      assert.match(error.message, /digests to [0-9a-f]{16} where the record says [0-9a-f]{16}/u);
      return true;
    });
  } finally {
    await tree.cleanup();
  }
});

test("a record that cannot be read is its own refusal, not a miss", async () => {
  const tree = await fixture();
  try {
    const cacheRoot = join(tree.root, "cache");
    const { key, cacheDir } = await closureCacheIdentity({ hostRoot: tree.hostRoot, cacheRoot });
    await writeClosureCache({ cacheDir, key, deployedModules: tree.deployedModules });
    await rm(join(cacheDir, "closure.json"));
    await assert.rejects(readVerifiedClosureCache({ cacheDir, key }),
      /^Error: runtime_closure_cache_invalid:.*\(no readable closure\.json\)$/u);
  } finally {
    await tree.cleanup();
  }
});

test("the key is the deploy's inputs: content, not the checkout it sits in", async () => {
  const first = await fixture();
  const second = await fixture();
  try {
    const before = (await closureCacheIdentity({ hostRoot: first.hostRoot, cacheRoot: join(first.root, "cache") })).key;
    // A second root with identical bytes is the same closure — which is what lets a
    // pinned worktree reuse the checkout that built the cache.
    assert.equal((await closureCacheIdentity({ hostRoot: second.hostRoot, cacheRoot: join(second.root, "cache") })).key, before);
    await writeFile(join(first.repositoryRoot, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n\n");
    assert.notEqual((await closureCacheIdentity({ hostRoot: first.hostRoot, cacheRoot: join(first.root, "cache") })).key, before);
    await writeFile(join(first.repositoryRoot, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
    assert.equal((await closureCacheIdentity({ hostRoot: first.hostRoot, cacheRoot: join(first.root, "cache") })).key, before);
  } finally {
    await first.cleanup();
    await second.cleanup();
  }
});

test("a verified entry is staged without opening a scratch workspace", async () => {
  const tree = await fixture();
  try {
    const cacheRoot = join(tree.root, "cache");
    const { key, cacheDir } = await closureCacheIdentity({ hostRoot: tree.hostRoot, cacheRoot });
    await writeClosureCache({ cacheDir, key, deployedModules: tree.deployedModules });
    const stagingRoot = join(tree.root, "staging");
    const scratchRoot = join(tree.root, "scratch");
    await mkdir(stagingRoot, { recursive: true });
    const origins = await stageDeclaredRuntimeClosure({ hostRoot: tree.hostRoot, stagingRoot, scratchRoot,
      externalRuntimeClosure: { kind: "declared_external_runtime_closure", packages: ["typebox"] },
      testArtifact: TEST_ARTIFACT, cacheRoot });
    assert.equal(existsSync(scratchRoot), false, "a cache hit must not deploy");
    assert.deepEqual([...origins.keys()].sort(),
      ["node_modules/typebox/index.js", "node_modules/typebox/package.json", "package.json"]);
    assert.equal(await readFile(join(stagingRoot, "node_modules", "typebox", "index.js"), "utf8"), "export {};\n");
    assert.deepEqual(JSON.parse(await readFile(join(stagingRoot, "package.json"), "utf8")).dependencies, { typebox: "*" });
  } finally {
    await tree.cleanup();
  }
});

test("the cache keeps itself bounded without pruning a tree a build could be reading", async () => {
  const tree = await fixture();
  try {
    const cacheRoot = join(tree.root, "cache");
    const day = 24 * 60 * 60 * 1000;
    const keys = ["a", "b", "c", "d", "e"].map((letter) => letter.repeat(64));
    for (const [index, key] of keys.entries()) {
      await writeClosureCache({ cacheDir: join(cacheRoot, key), key, deployedModules: tree.deployedModules });
      const aged = new Date(Date.now() - (50 - index * 10) * day);
      await utimes(join(cacheRoot, key), aged, aged);
    }
    // One fresh entry: the newest three are kept, the three month-old trees beyond them go.
    const fresh = "f".repeat(64);
    await writeClosureCache({ cacheDir: join(cacheRoot, fresh), key: fresh, deployedModules: tree.deployedModules });
    assert.deepEqual((await readdir(cacheRoot)).sort(), [keys[3], keys[4], fresh]);

    // Inside the age floor nothing is removed, whatever the count: a build on this
    // machine may be adopting one of these right now.
    await rm(cacheRoot, { recursive: true, force: true });
    for (const digit of ["1", "2", "3", "4", "5"]) {
      const key = digit.repeat(64);
      await writeClosureCache({ cacheDir: join(cacheRoot, key), key, deployedModules: tree.deployedModules });
      const young = new Date(Date.now() - 60 * 60 * 1000);
      await utimes(join(cacheRoot, key), young, young);
    }
    assert.equal((await readdir(cacheRoot)).length, 5);
  } finally {
    await tree.cleanup();
  }
});

test("a cached tree that no longer carries a declared package is named as such", async () => {
  const tree = await fixture();
  try {
    const cacheRoot = join(tree.root, "cache");
    const { key, cacheDir } = await closureCacheIdentity({ hostRoot: tree.hostRoot, cacheRoot });
    await writeClosureCache({ cacheDir, key, deployedModules: tree.deployedModules });
    const stagingRoot = join(tree.root, "staging");
    await mkdir(stagingRoot, { recursive: true });
    await assert.rejects(stageDeclaredRuntimeClosure({ hostRoot: tree.hostRoot, stagingRoot,
      scratchRoot: join(tree.root, "scratch"), cacheRoot, testArtifact: TEST_ARTIFACT,
      externalRuntimeClosure: { kind: "declared_external_runtime_closure", packages: ["typebox", "unused"] } }),
    /^Error: closure_staging_declared_package_missing:unused$/u);
  } finally {
    await tree.cleanup();
  }
});
