import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { isWindowsReparseLiveGateResult, runWindowsReparseLiveGate } from "./run-windows-reparse-live-gate.mjs";

const script = fileURLToPath(new URL("./run-windows-reparse-live-gate.mjs", import.meta.url));

function runGateProcess() {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(process.execPath, [script], { shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    const stdout = []; const stderr = [];
    child.stdout.on("data", (chunk) => stdout.push(Buffer.from(chunk)));
    child.stderr.on("data", (chunk) => stderr.push(Buffer.from(chunk)));
    child.once("error", rejectRun);
    child.once("close", (code, signal) => resolveRun({ code, signal, stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8") }));
  });
}

function strings(value, values = []) {
  if (typeof value === "string") values.push(value);
  else if (value && typeof value === "object") for (const child of Object.values(value)) strings(child, values);
  return values;
}

test("live-gate result validator accepts only the fixed redacted schema", () => {
  const valid = {
    schemaVersion: 1,
    gate: "windows_reparse_live_gate/v1",
    status: "blocked",
    reason: "non_link_reparse_fixture_unavailable",
    helperSha256: "a".repeat(64),
    probes: { regular: "passed", junction: "passed", directorySymlink: "passed", nonLinkReparse: "blocked" },
    consumers: { browserGenerator: "blocked", hostStaticVerifier: "blocked" },
  };
  assert.equal(isWindowsReparseLiveGateResult(valid), true);
  for (const malformed of [
    { ...valid, extra: true },
    { ...valid, helperSha256: "not-a-digest" },
    { ...valid, reason: "absolute/path" },
    { ...valid, probes: { ...valid.probes, regular: "skipped" } },
    { ...valid, consumers: { browserGenerator: "blocked" } },
  ]) assert.equal(isWindowsReparseLiveGateResult(malformed), false);
});

test("live gate emits current source directly into a fresh private host-root child and never imports the global emitted adapter", async () => {
  const source = await readFile(script, "utf8");
  assert.match(source, /resolve\(hostRoot, "node_modules", "typescript", "lib", "tsc\.js"\)/);
  assert.match(source, /spawn\(command, args, \{[\s\S]*cwd: hostRoot,[\s\S]*env: safeEnvironment,[\s\S]*shell: false,/);
  assert.match(source, /"--project", resolve\(hostRoot, "tsconfig\.production\.json"\),[\s\S]*"--outDir", emittedRoot/);
  assert.match(source, /TYPESCRIPT_COMPILER_TIMEOUT_MS = 120_000/);
  assert.match(source, /TYPESCRIPT_COMPILER_OUTPUT_LIMIT_BYTES = 64 \* 1024/);
  assert.match(source, /emittedRoot = await mkdtemp\(join\(hostRoot, "\.windows-reparse-live-gate-"\)\);[\s\S]*const emittedState = await lstat\(emittedRoot\);[\s\S]*emittedState\.isDirectory\(\) \|\| emittedState\.isSymbolicLink\(\)/);
  assert.match(source, /await compileCurrentSource\(emittedRoot\);[\s\S]*await loadBuildInspectorAdapter\(emittedRoot\);/);
  assert.match(source, /const cleanupRunDirectories = async \(\) => \{[\s\S]*Promise\.allSettled\([\s\S]*rm\(emittedRoot, \{ recursive: true, force: true \}\)[\s\S]*rm\(root, \{ recursive: true, force: true \}\)/);
  assert.match(source, /await cleanupRunDirectories\(\);/);
  assert.doesNotMatch(source, /typescript-emitted|resolve\(root, "typescript-emitted"\)|join\(emittedRoot, "typescript-emitted"\)/);
  assert.match(source, /current_source_emit_unavailable/);
  assert.doesNotMatch(source, /\.dist-production-emitted/);
  assert.match(source, /"native", "windows-reparse-inspector", "\.dist", "win-x64", "windows-reparse-inspector\.manifest\.json"/);
  assert.match(source, /createBuildWindowsReparseInspector/);
  assert.match(source, /inspectWindowsReparse/);
  assert.match(source, /await rename\(fixture\.entry, fixture\.targetAssets\);[\s\S]*await symlink\(fixture\.targetAssets, fixture\.entry, linkType\);/);
  assert.doesNotMatch(source, /powershell(?:\.exe)?|verifyWindowsReparseInspectorPair/iu);
});

test("live gate imports both fresh adapter surfaces directly and passes its opaque capability to both consumers", async () => {
  const source = await readFile(script, "utf8");
  assert.match(source, /resolve\(emittedRoot, "windows-reparse-inspector", "index\.js"\)/);
  assert.match(source, /resolve\(emittedRoot, "tavern", "static-artifact", "index\.js"\)/);
  assert.match(source, /typeof adapter\.assertNoWindowsReparse !== "function"/);
  assert.match(source, /Object\.freeze\(\{ inspect: async \(path\) => await inspectorAdapter\.assertNoWindowsReparse\(inspector, path\) \}\)/);
  assert.match(source, /verifyProductionArtifactManifest\(artifact, browserPolicy\)/);
  assert.match(source, /verifyTavernStaticArtifact\(artifact, \{[\s\S]*\}, inspector\)/);
  assert.doesNotMatch(source, /createBuildArtifactInspectionPolicy/);
});

test("each consumer rejection follows acceptance of its paired ordinary artifact and exact assets mutation", async () => {
  const source = await readFile(script, "utf8");
  assert.match(source, /const assets = join\(artifact, "assets"\);/);
  assert.match(source, /await mkdir\(assets, \{ recursive: true \}\);/);
  assert.match(source, /const baseline = await verifyConsumers\(fixture\.artifact, consumers, inspector, inspectorAdapter\);[\s\S]*if \(!baseline\.browserAccepted \|\| !baseline\.staticAccepted\)[\s\S]*await replaceAssetsWithReparseLink\(fixture, linkType\);/);
  assert.match(source, /await rename\(fixture\.entry, fixture\.targetAssets\);[\s\S]*await symlink\(fixture\.targetAssets, fixture\.entry, linkType\);/);
  assert.match(source, /const linkClassified = await isDirectoryLink\(fixture\.entry\)[\s\S]*inspectWindowsReparse\(inspector, fixture\.entry\).*=== "reparse"/);
  assert.match(source, /const mutation = await verifyConsumers\(fixture\.artifact, consumers, inspector, inspectorAdapter\);/);
  assert.match(source, /consumerVerdicts\.every\(\(verdict\) => verdict\.baselineAccepted && verdict\.browserRejected\)/);
  assert.match(source, /consumerVerdicts\.every\(\(verdict\) => verdict\.baselineAccepted && verdict\.staticRejected\)/);
  assert.doesNotMatch(source, /reparse-entry/);
});

test("a malformed baseline or unclassified mutation cannot count as consumer rejection evidence", async () => {
  const source = await readFile(script, "utf8");
  assert.match(source, /if \(!baseline\.browserAccepted \|\| !baseline\.staticAccepted\)\s*return \{ baselineAccepted: false, linkClassified: false, browserRejected: false, staticRejected: false \};/);
  assert.match(source, /if \(!linkClassified\)\s*return \{ baselineAccepted: true, linkClassified: false, browserRejected: false, staticRejected: false \};/);
  assert.match(source, /if \(!verdict\.baselineAccepted \|\| !verdict\.linkClassified\) continue;/);
});

test("live gate emits one redacted exact-schema blocked result and exits nonzero until every real assertion passes", async () => {
  const child = await runGateProcess();
  assert.notEqual(child.code, 0);
  assert.equal(child.signal, null);
  assert.equal(child.stderr, "");
  assert.match(child.stdout, /^\{[^\n]+\}\n$/);
  const result = JSON.parse(child.stdout);
  assert.equal(isWindowsReparseLiveGateResult(result), true);
  assert.equal(result.status, "blocked");
  assert.notEqual(result.reason, "passed");
  for (const value of strings(result)) {
    assert.doesNotMatch(value, /gamebuddy-windows-reparse-live-gate|[A-Za-z]:[\\/]|(?:^|[\\/])tmp(?:[\\/]|$)/i);
  }
});

test("direct non-Windows invocation is an explicit blocked platform result, never a skipped pass", async () => {
  const result = await runWindowsReparseLiveGate();
  assert.equal(isWindowsReparseLiveGateResult(result), true);
  assert.equal(result.status, "blocked");
  if (process.platform !== "win32") {
    assert.deepEqual(result, {
      schemaVersion: 1,
      gate: "windows_reparse_live_gate/v1",
      status: "blocked",
      reason: "windows_platform_required",
      helperSha256: null,
      probes: { regular: "blocked", junction: "blocked", directorySymlink: "blocked", nonLinkReparse: "blocked" },
      consumers: { browserGenerator: "blocked", hostStaticVerifier: "blocked" },
    });
  }
});
