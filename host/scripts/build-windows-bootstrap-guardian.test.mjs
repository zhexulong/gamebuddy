import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { spawn } from "node:child_process";
import test from "node:test";
import {
  buildWindowsBootstrapGuardian,
  canonicalManifest,
  fixtureFileName,
  testGuardianFileName,
  fixtureProjectFile,
  guardianOutputRoot,
  helperFileName,
  manifestFileName,
  projectFile,
} from "./build-windows-bootstrap-guardian.mjs";

const isWindowsX64 = process.platform === "win32" && process.arch === "x64";
const winOnly = { skip: !isWindowsX64 ? "BLOCKED: Guardian publication requires Windows x64" : false };
let publication;

test.before(async () => {
  if (isWindowsX64) publication = await buildWindowsBootstrapGuardian();
});

test("production builder freshly publishes exact Guardian and disposable fixture outputs", winOnly, async () => {
  assert.deepEqual((await readdir(guardianOutputRoot)).sort(), [helperFileName, manifestFileName].sort());
  assert.deepEqual((await readdir(new URL("../native/windows-bootstrap-guardian/.dist/fixtures/", import.meta.url))).sort(), [fixtureFileName, testGuardianFileName].sort());
  const helper = await readFile(publication.helperPath);
  const sha256 = createHash("sha256").update(helper).digest("hex");
  assert.equal(publication.sha256, sha256);
  assert.equal(await readFile(new URL(`../native/windows-bootstrap-guardian/.dist/win-x64/${manifestFileName}`, import.meta.url), "utf8"), canonicalManifest(sha256));
  assert.ok((await readFile(projectFile, "utf8")).includes("GameBuddy.WindowsBootstrapGuardian"));
  assert.ok((await readFile(fixtureProjectFile, "utf8")).includes("RoleRootFixture"));
});

test("fresh Guardian apphost has the fixed no-input fail-closed probe", winOnly, async () => {
  const result = await runProbe(publication.helperPath);
  assert.deepEqual(result, {
    code: 1,
    signal: null,
    stdout: "",
    stderr: "windows_bootstrap_guardian_invalid_request\n",
  });
});

test("fresh publication leaves no stale staging or replaced scratch and zero build warnings", winOnly, async () => {
  const root = new URL("../native/windows-bootstrap-guardian/.dist/", import.meta.url);
  const entries = (await readdir(root)).sort();
  assert.deepEqual(entries, ["fixtures", "win-x64"]);
  for (const project of [projectFile, fixtureProjectFile]) {
    // TreatWarningsAsErrors turns any warning into a build failure, so exit
    // code 0 is the zero-warning gate (localized summaries still repeat the
    // warning keyword and must not be parsed as text).
    const result = await runWarningsAsErrors(project);
    assert.equal(result.code, 0, `warnings-as-errors build failed: ${result.stderr}`);
  }
});

test("canonical manifest rejects non-hash input", () => {
  assert.throws(() => canonicalManifest("not-a-hash"), /helper_hash_invalid/);
});

function runProbe(executable) {
  return new Promise((resolveProbe, rejectProbe) => {
    const child = spawn(executable, [], {
      windowsHide: true,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    const timer = setTimeout(() => {
      child.kill();
      rejectProbe(new Error("windows_bootstrap_guardian_probe_timeout"));
    }, 10_000);
    child.once("error", (error) => {
      clearTimeout(timer);
      rejectProbe(error);
    });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      resolveProbe({ code, signal, stdout, stderr });
    });
  });
}

function runWarningsAsErrors(project) {
  return new Promise((resolveProbe, rejectProbe) => {
    // TreatWarningsAsErrors fails the build on any warning; the exit code is
    // the zero-warning gate. dotnet is resolved from the trusted fixed path
    // used by the publisher.
    const dotnet = "C:\\Program Files\\dotnet\\dotnet.exe";
    const child = spawn(dotnet, ["build", project, "--configuration", "Release", "-p:TreatWarningsAsErrors=true", "--nologo"], {
      windowsHide: true,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    const timer = setTimeout(() => {
      child.kill();
      rejectProbe(new Error("windows_bootstrap_guardian_build_warnings_timeout"));
    }, 180_000);
    child.once("error", (error) => {
      clearTimeout(timer);
      rejectProbe(error);
    });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      resolveProbe({ code, signal, stdout, stderr });
    });
  });
}
