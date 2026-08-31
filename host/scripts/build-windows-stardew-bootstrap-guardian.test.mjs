import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { spawn } from "node:child_process";
import test from "node:test";
import {
  buildWindowsStardewBootstrapGuardian,
  canonicalManifest,
  fixtureFileName,
  fixtureProjectFile,
  guardianOutputRoot,
  helperFileName,
  manifestFileName,
  projectFile,
} from "./build-windows-stardew-bootstrap-guardian.mjs";

const isWindowsX64 = process.platform === "win32" && process.arch === "x64";
const winOnly = { skip: !isWindowsX64 ? "BLOCKED: Guardian publication requires Windows x64" : false };
let publication;

test.before(async () => {
  if (isWindowsX64) publication = await buildWindowsStardewBootstrapGuardian();
});

test("production builder freshly publishes exact Guardian and disposable fixture outputs", winOnly, async () => {
  assert.deepEqual((await readdir(guardianOutputRoot)).sort(), [helperFileName, manifestFileName].sort());
  assert.deepEqual(await readdir(new URL("../native/windows-stardew-bootstrap-guardian/.dist/fixtures/", import.meta.url)), [fixtureFileName]);
  const helper = await readFile(publication.helperPath);
  const sha256 = createHash("sha256").update(helper).digest("hex");
  assert.equal(publication.sha256, sha256);
  assert.equal(await readFile(new URL(`../native/windows-stardew-bootstrap-guardian/.dist/win-x64/${manifestFileName}`, import.meta.url), "utf8"), canonicalManifest(sha256));
  assert.ok((await readFile(projectFile, "utf8")).includes("GameBuddy.WindowsStardewBootstrapGuardian"));
  assert.ok((await readFile(fixtureProjectFile, "utf8")).includes("RoleRootFixture"));
});

test("fresh Guardian apphost has the fixed no-input fail-closed probe", winOnly, async () => {
  const result = await runProbe(publication.helperPath);
  assert.deepEqual(result, {
    code: 1,
    signal: null,
    stdout: "",
    stderr: "windows_stardew_bootstrap_guardian_invalid_request\n",
  });
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
      rejectProbe(new Error("windows_stardew_bootstrap_guardian_probe_timeout"));
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
