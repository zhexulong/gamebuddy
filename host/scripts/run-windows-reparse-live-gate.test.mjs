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
  assert.match(source, /LIVE_GATE_CLEANUP_TIMEOUT_MS = 30_000/);
  assert.match(source, /const nonLinkFixture = await prepareConsumerFixture\(root, "n"\);/);
  assert.match(source, /const rootParent = parse\(resolve\(tmpdir\(\)\)\)\.root;[\s\S]*root = await mkdtemp\(join\(rootParent, "gamebuddy-windows-reparse-live-gate-"\)\);[\s\S]*await assertPrivateDirectory\(root, rootParent\);/);
  assert.match(source, /emittedRoot = await mkdtemp\(join\(hostRoot, "\.windows-reparse-live-gate-"\)\);[\s\S]*await assertPrivateDirectory\(emittedRoot, hostRoot\);/);
  assert.doesNotMatch(source, /const emittedState = await lstat\(emittedRoot\)/);
  assert.match(source, /await compileCurrentSource\(emittedRoot\);[\s\S]*await loadBuildInspectorAdapter\(emittedRoot\);/);
  assert.match(source, /const cleanupRunDirectories = async \(\) => \{[\s\S]*const cleanup = Promise\.all\(\[[\s\S]*removeRunDirectory\(emittedRoot\),[\s\S]*removeRunDirectory\(root\),[\s\S]*\]\)\.then\(\(values\) => values\.every\(Boolean\), \(\) => false\);[\s\S]*setTimeout\(\(\) => resolveCleanup\(false\), LIVE_GATE_CLEANUP_TIMEOUT_MS\);[\s\S]*return await Promise\.race\(\[cleanup, timeout\]\);/);
  assert.doesNotMatch(source, /Promise\.allSettled/);
  assert.match(source, /const cleaned = await cleanupRunDirectories\(\);[\s\S]*blankResult\(cleaned \? "current_source_emit_unavailable" : "probe_fixture_cleanup_failed", helperSha256\)/);
  assert.match(source, /if \(!await cleanupRunDirectories\(\)\) result\.reason = "probe_fixture_cleanup_failed";/);
  assert.doesNotMatch(source, /typescript-emitted|resolve\(root, "typescript-emitted"\)|join\(emittedRoot, "typescript-emitted"\)/);
  assert.match(source, /current_source_emit_unavailable/);
  assert.doesNotMatch(source, /\.dist-production-emitted/);
  assert.match(source, /"native", "windows-reparse-inspector", "\.dist", "win-x64", "windows-reparse-inspector\.manifest\.json"/);
  assert.match(source, /BUILD_ARTIFACT_REPARSE_INSPECTION\.create/);
  assert.match(source, /inspectWindowsReparse/);
  assert.match(source, /await rename\(fixture\.entry, fixture\.targetAssets\);[\s\S]*await symlink\(fixture\.targetAssets, fixture\.entry, linkType\);/);
  assert.doesNotMatch(source, /powershell(?:\.exe)?|verifyWindowsReparseInspectorPair/iu);
});

test("live gate imports both fresh adapter surfaces directly and passes its opaque capability to both consumers", async () => {
  const source = await readFile(script, "utf8");
  assert.match(source, /resolve\(emittedRoot, "windows-reparse-inspector", "index\.js"\)/);
  assert.match(source, /resolve\(emittedRoot, "tavern", "static-artifact", "index\.js"\)/);
  assert.match(source, /typeof boundary\?\.assertNoReparse !== "function"/);
  assert.match(source, /typeof adapter\.inspectWindowsPathIdentity !== "function"/);
  assert.match(source, /Object\.freeze\(\{ inspect: async \(path\) => await inspectorAdapter\.BUILD_ARTIFACT_REPARSE_INSPECTION\.assertNoReparse\(inspector, path\) \}\)/);
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

test("directory symlink capability unavailability remains blocked without preventing the AF_UNIX probe", async () => {
  const source = await readFile(script, "utf8");
  assert.match(source, /const DIRECTORY_SYMLINK_CAPABILITY_ERROR_CODES = new Set\(\["EPERM", "EACCES", "ENOTSUP"\]\);/);
  assert.match(source, /function isDirectorySymlinkCapabilityUnavailable\(error\) \{[\s\S]*DIRECTORY_SYMLINK_CAPABILITY_ERROR_CODES\.has\(error\.code\)/);
  assert.match(source, /let directorySymlinkUnavailable = false;[\s\S]*for \(const \[name, linkType, probeName\] of \[[\s\S]*\["directory-symlink", "dir", "directorySymlink"\],[\s\S]*try \{[\s\S]*assertConsumersReject\(fixture, linkType, consumers, inspector, inspectorAdapter\)[\s\S]*probeName === "directorySymlink" && isDirectorySymlinkCapabilityUnavailable\(error\)[\s\S]*directorySymlinkUnavailable = true;[\s\S]*continue;[\s\S]*throw error;/);
  assert.match(source, /const afUnixFixture = await assertFixtureHelper\(await buildWindowsAfUnixReparseFixture\(\)\);[\s\S]*const nonLinkFixture = await prepareConsumerFixture\(root, "n"\);[\s\S]*const nonLinkVerdict = await assertConsumersRejectAfUnix/);
  assert.match(source, /else if \(directorySymlinkUnavailable\)\s*result\.reason = "directory_symlink_fixture_unavailable";/);
});

test("AF_UNIX non-link reparse proof uses the repository builder and one exact consumer mutation", async () => {
  const source = await readFile(script, "utf8");
  assert.match(source, /buildWindowsAfUnixReparseFixture,[\s\S]*helperFileName as afUnixFixtureHelperFileName,[\s\S]*outputRoot as afUnixFixtureOutputRoot,[\s\S]*from "\.\/build-windows-af-unix-reparse-fixture\.mjs";/);
  assert.match(source, /const AF_UNIX_FIXTURE_READY_TIMEOUT_MS = 15_000;/);
  assert.match(source, /const AF_UNIX_FIXTURE_EXIT_TIMEOUT_MS = 15_000;/);
  assert.match(source, /const AF_UNIX_FIXTURE_OUTPUT_LIMIT_BYTES = 16 \* 1024;/);
  assert.match(source, /const afUnixFixture = await assertFixtureHelper\(await buildWindowsAfUnixReparseFixture\(\)\);/);
  assert.match(source, /const expectedHelperPath = resolve\(afUnixFixtureOutputRoot, afUnixFixtureHelperFileName\);[\s\S]*sameWindowsPath\(helperPath, expectedHelperPath\)[\s\S]*createHash\("sha256"\)\.update\(await readFile\(helperPath\)\)\.digest\("hex"\)[\s\S]*actualSha256 !== fixture\.sha256/);
  assert.match(source, /state\.child = spawn\(helperPath, \[socketPath\], \{[\s\S]*shell: false,[\s\S]*windowsHide: true,[\s\S]*detached: false,[\s\S]*stdio: \["pipe", "pipe", "pipe"\]/);
  assert.match(source, /state\.outputBytes > AF_UNIX_FIXTURE_OUTPUT_LIMIT_BYTES[\s\S]*af_unix_fixture_output_overflow/);
  assert.match(source, /setTimeout\(\(\) => reject\(new Error\("af_unix_fixture_ready_timeout"\)\), AF_UNIX_FIXTURE_READY_TIMEOUT_MS\)/);
  assert.match(source, /fixtureProcess\.stdout !== "ready\\n" \|\| fixtureProcess\.stderr !== ""/);
  assert.match(source, /let exit = await waitForAfUnixFixtureExit\(child, AF_UNIX_FIXTURE_EXIT_TIMEOUT_MS\);[\s\S]*child\.kill\(\)[\s\S]*exit = await waitForAfUnixFixtureExit\(child, AF_UNIX_FIXTURE_EXIT_TIMEOUT_MS\);/);
  assert.match(source, /fixtureProcess\.stopped = exit\.closed;/);
  assert.match(source, /if \(!await stopAfUnixFixture\(fixtureProcess\)\) throw new Error\("af_unix_fixture_cleanup_failed"\);/);
  assert.match(source, /const legacy = await inspectorAdapter\.inspectWindowsReparse\(inspector, socketPath\);[\s\S]*const identity = await inspectorAdapter\.inspectWindowsPathIdentity\(inspector, socketPath\);[\s\S]*legacy === "reparse" && identity\.objectKind === "regular_file" && identity\.isReparsePoint === true/);
  assert.match(source, /const baseline = await verifyConsumers\(fixture\.artifact, consumers, inspector, inspectorAdapter\);[\s\S]*await rename\(fixture\.entry, fixture\.targetAssets\);[\s\S]*fixtureProcess = startAfUnixFixture\(helper\.helperPath, fixture\.entry\);[\s\S]*const mutation = await verifyConsumers\(fixture\.artifact, consumers, inspector, inspectorAdapter\);/);
  assert.match(source, /if \(nonLinkVerdict\.baselineAccepted && nonLinkVerdict\.linkClassified\) \{[\s\S]*result\.probes\.nonLinkReparse = "passed";[\s\S]*consumerVerdicts\.push\(nonLinkVerdict\);[\s\S]*\}/);
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
