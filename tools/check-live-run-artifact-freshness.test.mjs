import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

test("the message a run sees names the rebuild command", () => {
  // A run that fails without saying how to fix it wastes the same cycle it just spent.
  assert.equal(REBUILD_COMMAND, "cd host && node node_modules/typescript/bin/tsc --project tsconfig.test.json --noEmitOnError false");
});
