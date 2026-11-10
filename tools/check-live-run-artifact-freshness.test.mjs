// red-proof: inject  ignoring `artifact_content_mismatch` in `findTestArtifactInputDrift` -> `AssertionError`
//   false !== true at tools/check-live-run-artifact-freshness.test.mjs:254, in the copied-artifact case
//   (tools/lib/live-run-artifact-freshness.mjs)
import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  COPIED_TEST_ARTIFACT_ASSETS,
  TEST_ARTIFACT_BUILD_MANIFEST,
  writeTestArtifactBuildManifest,
} from "../host/scripts/test-artifact-build-manifest.mjs";
import { assessLiveRunArtifactFreshness, REBUILD_COMMAND } from "./lib/live-run-artifact-freshness.mjs";

/**
 * The live-run gate exists because a stale `host/dist-test` silently tests the wrong artifact, and the failure
 * always looks like a product bug. Each case below is one of the states a real run can be in.
 */
async function fixture({ sourceTime, outputTime, withSource = true, withOutput = true }) {
  const root = await mkdtemp(join(tmpdir(), "gb-freshness-"));
  const sourceDir = join(root, "host", "src");
  const outputDir = join(root, "host", "dist-test");
  if (withSource) {
    await mkdir(sourceDir, { recursive: true });
    const file = join(sourceDir, "bridge.ts");
    await writeFile(file, "export const x = 1;\n");
    await utimes(file, sourceTime, sourceTime);
  }
  if (withOutput) {
    await mkdir(outputDir, { recursive: true });
    const file = join(outputDir, "bridge.js");
    await writeFile(file, "export const x = 1;\n");
    await utimes(file, outputTime, outputTime);
  }
  return root;
}

const earlier = new Date("2026-10-07T10:00:00Z");
const later = new Date("2026-10-07T12:00:00Z");
const latest = new Date("2026-10-07T14:00:00Z");

test("a fresh artifact passes", async () => {
  const root = await fixture({ sourceTime: earlier, outputTime: later });
  try {
    const verdict = await assessLiveRunArtifactFreshness({ repositoryRoot: root });
    assert.equal(verdict.stale, false);
    assert.equal(verdict.reason, undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an artifact older than its sources is stale, and the verdict names both sides", async () => {
  const root = await fixture({ sourceTime: later, outputTime: earlier });
  try {
    const verdict = await assessLiveRunArtifactFreshness({ repositoryRoot: root });
    assert.equal(verdict.stale, true);
    assert.equal(verdict.reason, "artifact_older_than_inputs");
    assert.match(verdict.inputs.path, /bridge\.ts$/u);
    assert.match(verdict.outputs.path, /bridge\.js$/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a missing artifact is stale, never silently fresh", async () => {
  const root = await fixture({ sourceTime: earlier, outputTime: later, withOutput: false });
  try {
    const verdict = await assessLiveRunArtifactFreshness({ repositoryRoot: root });
    assert.equal(verdict.stale, true);
    assert.equal(verdict.reason, "artifact_missing");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an artifact with no emitted modules is stale, never silently fresh", async () => {
  const root = await fixture({ sourceTime: earlier, outputTime: later });
  try {
    await rm(join(root, "host", "dist-test", "bridge.js"), { force: true });
    const verdict = await assessLiveRunArtifactFreshness({ repositoryRoot: root });
    assert.equal(verdict.stale, true);
    assert.equal(verdict.reason, "artifact_empty");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a test source change does not make the artifact stale, a production one does", async () => {
  // Measured: four consecutive live runs were blocked because another lane edited a `*.test.ts` file seconds after each
  // rebuild. A test file cannot change any production module a live run imports, so it must not count as an input --
  // while a real production source still must.
  const root = await mkdtemp(join(tmpdir(), "gb-freshness-test-src-"));
  try {
    const sourceDir = join(root, "host", "src");
    const outputDir = join(root, "host", "dist-test");
    await mkdir(sourceDir, { recursive: true });
    await mkdir(outputDir, { recursive: true });
    const production = join(sourceDir, "bridge.ts");
    const testSource = join(sourceDir, "bridge.test.ts");
    const output = join(outputDir, "bridge.js");
    await writeFile(production, "export const x = 1;\n");
    await writeFile(testSource, "export const t = 1;\n");
    await writeFile(output, "export const x = 1;\n");
    await utimes(production, earlier, earlier);
    await utimes(output, later, later);
    await utimes(testSource, later, later);
    const withTestEdit = await assessLiveRunArtifactFreshness({ repositoryRoot: root });
    assert.equal(withTestEdit.stale, false, "a test-only edit must not block a live run");
    await utimes(production, latest, latest);
    const withProductionEdit = await assessLiveRunArtifactFreshness({ repositoryRoot: root });
    assert.equal(withProductionEdit.stale, true, "a production edit must still block it");
    assert.match(withProductionEdit.inputs.path, /bridge\.ts$/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test("the message a run sees names the locked rebuild entry, never a bare tsc", () => {
  // A run that fails without saying how to fix it wastes the same cycle it just spent. The command
  // must be the lock-holding public entry: a bare `tsc` bypasses the artifact lock and the test-only
  // overlay, and `--noEmitOnError false` emits a partial tree that reads as unrelated failures.
  assert.match(REBUILD_COMMAND, /build:test/u);
  assert.doesNotMatch(REBUILD_COMMAND, /\btsc\b/u);
});

/**
 * A tree that carries everything the build manifest records - the production sources, the copied assets, the compiler
 * configuration, an emitted module - and the manifest itself, written by the REAL producer
 * (`writeTestArtifactBuildManifest`), so these cases drive one side's real output instead of a hand-written copy of it.
 *
 * Every input is then rewritten after the build with the bytes it already had: that is the state that refused a live
 * run for nothing (`provider-catalog.ts` touched with unchanged content), and the state each case below starts from.
 */
async function builtFixture() {
  const root = await mkdtemp(join(tmpdir(), "gb-freshness-built-"));
  const host = join(root, "host");
  const sourceDir = join(host, "src");
  const outputDir = join(host, "dist-test");
  await mkdir(sourceDir, { recursive: true });
  await mkdir(outputDir, { recursive: true });
  await writeFile(join(sourceDir, "bridge.ts"), "export const x = 1;\n");
  await writeFile(join(sourceDir, "bridge.test.ts"), "export const t = 1;\n");
  const configurations = ["package.json", "tsconfig.json", "tsconfig.test.json"];
  for (const configuration of configurations) await writeFile(join(host, configuration), "{}\n");
  for (const asset of COPIED_TEST_ARTIFACT_ASSETS) {
    await mkdir(join(host, asset.source, ".."), { recursive: true });
    await writeFile(join(host, asset.source), "# copied asset\n");
  }
  await writeFile(join(outputDir, "bridge.js"), "export const x = 1;\n");
  await utimes(join(outputDir, "bridge.js"), earlier, earlier);
  await writeTestArtifactBuildManifest({ repositoryRoot: root, outputRoot: outputDir, builtAtMs: earlier.getTime() });
  for (const path of [
    join(sourceDir, "bridge.ts"),
    ...COPIED_TEST_ARTIFACT_ASSETS.map((asset) => join(host, asset.source)),
    ...configurations.map((configuration) => join(host, configuration)),
  ])
    await utimes(path, later, later);
  return { root, host, sourceDir, outputDir, configurations };
}

test("a newer modification time with identical content is NOT stale", async () => {
  // The false positive this whole rule replaces: a checkout, a formatter pass or a branch switch rewrites a file with
  // the bytes it already had, and the mtime rule refused a live run whose artifact was exactly right.
  const fixture = await builtFixture();
  try {
    const verdict = await assessLiveRunArtifactFreshness({ repositoryRoot: fixture.root });
    assert.equal(verdict.stale, false);
    assert.equal(verdict.rule, "content");
    assert.equal(verdict.reason, undefined);
    assert.match(verdict.detail, /content is unchanged/u);
    assert.match(verdict.detail, /modification times are not consulted/u);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("changed content under an unchanged modification time is stale, naming the path", async () => {
  const fixture = await builtFixture();
  try {
    const changed = join(fixture.sourceDir, "bridge.ts");
    await writeFile(changed, "export const x = 2;\n");
    await utimes(changed, later, later);
    const verdict = await assessLiveRunArtifactFreshness({ repositoryRoot: fixture.root });
    assert.equal(verdict.stale, true);
    assert.equal(verdict.reason, "artifact_content_mismatch:host/src/bridge.ts");
    assert.match(verdict.detail, /host\/src\/bridge\.ts/u);
    assert.equal(verdict.drift.length, 1);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("an input added after the build is stale, because the build never read it", async () => {
  const fixture = await builtFixture();
  try {
    await writeFile(join(fixture.sourceDir, "added-later.ts"), "export const added = 1;\n");
    const verdict = await assessLiveRunArtifactFreshness({ repositoryRoot: fixture.root });
    assert.equal(verdict.stale, true);
    assert.equal(verdict.reason, "artifact_input_unrecorded:host/src/added-later.ts");
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("a recorded input that is gone is stale, because the artifact still contains it", async () => {
  const fixture = await builtFixture();
  try {
    await rm(join(fixture.sourceDir, "bridge.ts"), { force: true });
    const verdict = await assessLiveRunArtifactFreshness({ repositoryRoot: fixture.root });
    assert.equal(verdict.stale, true);
    assert.equal(verdict.reason, "artifact_input_missing:host/src/bridge.ts");
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("a test source is outside the input population on both sides of the comparison", async () => {
  // Measured: four consecutive live runs were refused because another lane edited a `*.test.ts` seconds after each
  // rebuild. The manifest must not record one, or the content rule would refuse them again.
  const fixture = await builtFixture();
  try {
    await writeFile(join(fixture.sourceDir, "bridge.test.ts"), "export const t = 2;\n");
    const verdict = await assessLiveRunArtifactFreshness({ repositoryRoot: fixture.root });
    assert.equal(verdict.stale, false);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("without a build manifest the modification-time rule answers, and says no_manifest", async () => {
  const fixture = await builtFixture();
  try {
    await rm(join(fixture.outputDir, TEST_ARTIFACT_BUILD_MANIFEST), { force: true });
    const verdict = await assessLiveRunArtifactFreshness({ repositoryRoot: fixture.root });
    assert.equal(verdict.rule, "modification_time");
    assert.equal(verdict.stale, true);
    assert.equal(verdict.reason, "artifact_older_than_inputs");
    assert.match(verdict.detail, /no_manifest/u);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("a copied artifact is accepted while the lane's sources are identical, and refused the moment one differs", async () => {
  // A lane cannot build: `host/node_modules` is a junction, so the compiler entry escapes the repository root. Sharing
  // the main tree's artifact is the only way a lane gets one, and it is legal exactly while the sources are identical.
  const main = await builtFixture();
  const lane = await builtFixture();
  try {
    await rm(lane.outputDir, { recursive: true, force: true });
    await cp(main.outputDir, lane.outputDir, { recursive: true, force: true });
    const identical = await assessLiveRunArtifactFreshness({ repositoryRoot: lane.root });
    assert.equal(identical.stale, false, "identical sources must accept the copied artifact");
    await writeFile(join(lane.sourceDir, "bridge.ts"), "export const x = 3;\n");
    const drifted = await assessLiveRunArtifactFreshness({ repositoryRoot: lane.root });
    assert.equal(drifted.stale, true);
    assert.equal(drifted.reason, "artifact_content_mismatch:host/src/bridge.ts");
  } finally {
    await rm(main.root, { recursive: true, force: true });
    await rm(lane.root, { recursive: true, force: true });
  }
});
