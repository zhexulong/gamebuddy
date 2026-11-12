import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";

const releaseEntry = fileURLToPath(new URL("./build-release-production-artifact.mjs", import.meta.url));
const workflowPath = fileURLToPath(new URL("../../.github/workflows/release-windows.yml", import.meta.url));

/**
 * The one step a `- name:` marker introduces: its own lines, up to the first non-blank line indented no deeper
 * than the marker. The cleanup assertions below are about THAT step, and reading from the marker to the end of
 * the file meant they read every later job as well: the workflow grew a `publish-release` job after this step,
 * and the `shell: pwsh` it uses there was reported as the cleanup step choosing a shell.
 */
function workflowStep(workflow, name) {
  const lines = workflow.split("\n");
  const marker = `- name: ${name}`;
  const start = lines.findIndex((line) => line.trim() === marker);
  assert.notEqual(start, -1, `the release workflow has no step named ${name}`);
  const indent = lines[start].length - lines[start].trimStart().length;
  const body = [lines[start]];
  for (const line of lines.slice(start + 1)) {
    if (line.trim() !== "" && line.length - line.trimStart().length <= indent) break;
    body.push(line);
  }
  return body.join("\n");
}

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
  const workflow = await readFile(workflowPath, "utf8");
  assert.match(
    workflow,
    /node host\/scripts\/build-windows-reparse-inspector\.mjs\n\s+- uses: actions\/setup-dotnet@v4\n\s+with:\n\s+dotnet-version: 6\.0\.x\n\s+- run: dotnet restore integrations\/stardew\/tests\/GameBuddy\.Stardew\.Core\.Tests\/GameBuddy\.Stardew\.Core\.Tests\.csproj\n\s+- run: dotnet restore integrations\/stardew\/tests\/GameBuddy\.Stardew\.Integration\.Tests\/GameBuddy\.Stardew\.Integration\.Tests\.csproj\n\s+- run: pnpm --dir host test/,
  );
});

test("release workflow delegates always cleanup to the no-input owned-root cleanup entry", async () => {
  const workflow = await readFile(workflowPath, "utf8");
  const cleanup = workflowStep(workflow, "Remove this release run's acquisition scratch");
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
