import assert from "node:assert/strict";
import { lstat, mkdir, mkdtemp, readdir, rmdir, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { inspectEquipToolReleaseBundle } from "../src/equip-tool-preflight.mjs";
import { publishEquipToolReleaseBundle, RELEASE_BUNDLE_FILES } from "../src/release-bundle-publisher.mjs";

async function cleanup(root) {
  const stack = [{ path: root, visited: false }];
  while (stack.length) {
    const item = stack.pop();
    const state = await lstat(item.path).catch((error) => error?.code === "ENOENT" ? null : Promise.reject(error));
    if (!state) continue;
    if (!state.isDirectory() || state.isSymbolicLink()) { await unlink(item.path); continue; }
    if (!item.visited) {
      stack.push({ path: item.path, visited: true });
      for (const name of await readdir(item.path)) stack.push({ path: path.join(item.path, name), visited: false });
    } else await rmdir(item.path);
  }
}
async function withRoot(run) {
  const root = await mkdtemp(path.join(os.tmpdir(), "release-publisher-"));
  try { await run(root); } finally { await cleanup(root); }
}
async function source(root, manifest = {}) {
  const directory = path.join(root, "build");
  await mkdir(directory);
  for (const [name, contents] of [
    ["GameBuddy.Stardew.dll", "mod"],
    ["GameBuddy.Stardew.Core.dll", "core"],
    ["manifest.json", JSON.stringify({ Name: "GameBuddy", UniqueID: "zhexulong.GameBuddy", EntryDll: "GameBuddy.Stardew.dll", Version: "0.1.0", ...manifest })],
    ["GameBuddy.Stardew.deps.json", "{}"],
    ["GameBuddy.Stardew.Core.pdb", "sidecar"],
  ]) await writeFile(path.join(directory, name), contents);
  return directory;
}
function profile(root, releaseDir) {
  return { releaseDir, modsPath: path.join(root, "mods"), adapterVersion: "0.1.0" };
}

test("publishes an exact four-file bundle from a build directory with sidecars", async () => withRoot(async (root) => {
  const build = await source(root);
  await mkdir(path.join(root, "mods"));
  await mkdir(path.join(root, "mods", "GameBuddy"));
  const destination = path.join(root, "published", "equip-tool-v1");
  const receipt = await publishEquipToolReleaseBundle({ sourceDir: build, destinationDir: destination });
  assert.deepEqual((await readdir(destination)).sort(), [...RELEASE_BUNDLE_FILES].sort());
  assert.deepEqual(receipt, { schema: "gamebuddy-stardew-release-bundle-publication/v1", status: "published", destinationDir: destination, adapterVersion: "0.1.0", algorithm: "sha256", digest: receipt.digest, files: 4 });
  assert.match(receipt.digest, /^[a-f0-9]{64}$/);
  assert.deepEqual(await inspectEquipToolReleaseBundle(profile(root, destination)), { algorithm: "sha256", digest: receipt.digest, adapterVersion: "0.1.0", files: 4 });
  await assert.rejects(inspectEquipToolReleaseBundle(profile(root, build)), /stardew_immutable_release_bundle_source_untrusted/);
  await assert.rejects(publishEquipToolReleaseBundle({ sourceDir: build, destinationDir: destination }), /atomic_directory_output_exists/);
}));

test("unexpected staging entry prevents final publication", async () => withRoot(async (root) => {
  const build = await source(root);
  await writeFile(path.join(build, "GameBuddy.Stardew.dll"), Buffer.alloc(8 * 1024 * 1024, 7));
  const destination = path.join(root, "published", "raced");
  const publication = publishEquipToolReleaseBundle({ sourceDir: build, destinationDir: destination });
  const parent = path.dirname(destination);
  let staging;
  for (let attempt = 0; attempt < 1_000 && !staging; attempt += 1) {
    const entries = await readdir(parent).catch((error) => error?.code === "ENOENT" ? [] : Promise.reject(error));
    const name = entries.find((entry) => entry.startsWith(`.${path.basename(destination)}.staging-`));
    if (name) staging = path.join(parent, name);
    else await new Promise((resolve) => setImmediate(resolve));
  }
  assert.ok(staging, "publisher staging was not observed");
  await writeFile(path.join(staging, "unexpected"), "x");
  await assert.rejects(publication, /stardew_release_bundle_publish_(staging_entries_invalid|cleanup_uncertain)/);
  await assert.rejects(lstat(destination), { code: "ENOENT" });
  await unlink(path.join(staging, "unexpected"));
  await rmdir(staging).catch((error) => { if (error?.code !== "ENOENT") throw error; });
}));

test("manifest mismatch publishes no final directory", async () => withRoot(async (root) => {
  const build = await source(root, { UniqueID: "wrong" });
  const destination = path.join(root, "published", "invalid");
  await assert.rejects(publishEquipToolReleaseBundle({ sourceDir: build, destinationDir: destination }), /stardew_release_bundle_publish_manifest_identity_mismatch/);
  await assert.rejects(lstat(destination), { code: "ENOENT" });
}));
