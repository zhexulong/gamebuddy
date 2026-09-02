import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";

const releaseEntry = fileURLToPath(new URL("./build-release-production-artifact.mjs", import.meta.url));
const workflowPath = fileURLToPath(new URL("../../.github/workflows/release-windows.yml", import.meta.url));

test("release entry is a fixed no-argument composition and rejects caller-controlled release inputs by shape", async () => {
  const source = await readFile(releaseEntry, "utf8");
  assert.match(source, /export async function buildReleaseProductionArtifact\(\) \{ return publishFixedReleaseProductionArtifact\(\); \}/);
  assert.match(source, /if \(resolve\(process\.argv\[1\] \?\? ""\) === scriptPath\) await buildReleaseProductionArtifact\(\);/);
  assert.doesNotMatch(source, /process\.argv\[(?!1\])|--(?:runtime|provider|output|emitted|path|url|checksum)/i);
  assert.doesNotMatch(source, /buildReleaseProductionArtifact\s*\([^)]*\w/);
});

test("protected release gate remains fixed upstream of the no-argument entry", async () => {
  const source = await readFile(fileURLToPath(new URL("./node-runtime-release-acquisition.mjs", import.meta.url)), "utf8");
  assert.match(source, /export async function publishFixedReleaseProductionArtifact\(\) \{/);
  assert.match(source, /assertProtectedWindowsReleaseCiEnvironment\(\);/);
  assert.match(source, /return acquireReleaseRuntimePublisher\(\{ descriptor, fetchRelease: fetch \}, async \(\) => buildFixedReleaseProductionArtifact\(\)\);/);
});

test("release workflow delegates always cleanup to the no-input owned-root cleanup entry", async () => {
  const workflow = await readFile(workflowPath, "utf8");
  const cleanup = workflow.match(/- name: Remove this release run's acquisition scratch\n([\s\S]*)$/)?.[0] ?? "";
  assert.match(cleanup, /if: always\(\)/);
  assert.match(cleanup, /^\s*run: node host\/scripts\/release-owned-scratch-cleanup\.mjs$/m);
  assert.doesNotMatch(cleanup, /(?:shell:|pwsh|powershell|cmd|Get-ChildItem|Remove-Item|TEMP|Path utilities)/i);
  assert.doesNotMatch(cleanup, /\$\{\{|inputs\.|sign(?:tool|ing)|upload-artifact/i);
});

test("owned cleanup has no caller path ingress and uses the native inspector-owned helper", async () => {
  const source = await readFile(fileURLToPath(new URL("./release-owned-scratch-cleanup.mjs", import.meta.url)), "utf8");
  assert.match(source, /assertProtectedWindowsReleaseCiEnvironment\(\);/);
  assert.match(source, /cleanupWindowsReleaseOwnedScratch\(\);/);
  assert.doesNotMatch(source, /process\.argv\[[^1]|--(?:path|root|temp)/i);
});
