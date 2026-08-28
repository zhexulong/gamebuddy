import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import * as core from "../scripts/static-artifact-manifest-core.mjs";
import {
  ARTIFACT_MANIFEST_FILE,
  BROWSER_CONTRACT,
  PROFILE_ID,
  createProductionArtifactManifest,
  verifyProductionArtifactManifest,
} from "../scripts/game-browser-artifact-manifest.mjs";

const nodeDefensePolicy = Object.freeze({ inspect: async () => {} });

async function createArtifactFixture() {
  const artifactRoot = await mkdtemp(join(tmpdir(), "gamebuddy-game-browser-manifest-"));
  await mkdir(join(artifactRoot, "assets"));
  await writeFile(join(artifactRoot, "index.html"), "<!doctype html>", "utf8");
  await writeFile(join(artifactRoot, "assets", "index-abcdefgh.js"), "console.log(1)", "utf8");
  return artifactRoot;
}

async function createGameArtifact() {
  const artifactRoot = await createArtifactFixture();
  await createProductionArtifactManifest(artifactRoot, nodeDefensePolicy);
  return artifactRoot;
}

test("Game policy emits and parses the exact five-field Game manifest", async () => {
  const artifactRoot = await createGameArtifact();
  try {
    const manifest = await verifyProductionArtifactManifest(artifactRoot, nodeDefensePolicy);
    assert.equal(ARTIFACT_MANIFEST_FILE, "game-browser-artifact-manifest.json");
    assert.equal(BROWSER_CONTRACT, "game_browser_api/v1");
    assert.equal(PROFILE_ID, "gamebuddy.game.preview");
    assert.deepEqual(Object.keys(manifest), ["schemaVersion", "browserContract", "profileId", "entryHtml", "assets"]);
    assert.equal(manifest.schemaVersion, 1);
    assert.equal(manifest.browserContract, BROWSER_CONTRACT);
    assert.equal(manifest.profileId, PROFILE_ID);
    assert.equal(manifest.entryHtml, "index.html");
    assert.equal(manifest.assets.length, 1);
    assert.deepEqual(JSON.parse(await readFile(join(artifactRoot, ARTIFACT_MANIFEST_FILE), "utf8")), manifest);
  } finally {
    await rm(artifactRoot, { recursive: true, force: true });
  }
});

test("Game policy rejects a manifest with a swapped contract or profile", async () => {
  for (const [field, value] of [["browserContract", "tavern_browser_api/v1"], ["profileId", "gamebuddy.tavern.browser.v1"]]) {
    const artifactRoot = await createGameArtifact();
    try {
      const manifestPath = join(artifactRoot, ARTIFACT_MANIFEST_FILE);
      const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
      manifest[field] = value;
      await writeFile(manifestPath, `${JSON.stringify(manifest)}\n`, "utf8");
      await assert.rejects(
        verifyProductionArtifactManifest(artifactRoot, nodeDefensePolicy),
        /invalid identity or shape/,
      );
    } finally {
      await rm(artifactRoot, { recursive: true, force: true });
    }
  }
});

test("Game policy requires its exact manifest filename", async () => {
  const artifactRoot = await createGameArtifact();
  try {
    await rename(join(artifactRoot, ARTIFACT_MANIFEST_FILE), join(artifactRoot, "tavern-browser-artifact-manifest.json"));
    await assert.rejects(verifyProductionArtifactManifest(artifactRoot, nodeDefensePolicy));
  } finally {
    await rm(artifactRoot, { recursive: true, force: true });
  }
});

test("common manifest core imports without frozen domain identity constants", async () => {
  assert.deepEqual(Object.keys(core), ["createStaticArtifactManifestPolicy"]);
  const source = await readFile(new URL("../scripts/static-artifact-manifest-core.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(source, /tavern|game/i);
});
