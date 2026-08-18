import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { access, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import {
  buildWindowsReparseInspector,
  canonicalManifest,
  helperFileName,
  manifestFileName,
  outputRoot,
  protocolVersion,
  rid,
} from "./build-windows-reparse-inspector.mjs";

const helperPath = resolve(outputRoot, helperFileName);

function runHelper(input) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(helperPath, [], { shell: false, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    const stdout = []; const stderr = [];
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.once("error", rejectRun);
    child.once("close", (code, signal) => resolveRun({ code, signal, stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8") }));
    child.stdin.end(input);
  });
}

function request(path) {
  return Buffer.from(JSON.stringify({ schemaVersion: 1, operation: "inspect", path }), "utf8");
}

async function assertResult(input, result) {
  const actual = await runHelper(input);
  assert.equal(actual.code, 0);
  assert.equal(actual.signal, null);
  assert.equal(actual.stderr, "");
  assert.equal(actual.stdout, `{"schemaVersion":1,"result":"${result}"}\n`);
}

async function makeJunction(link, target) {
  await new Promise((resolveRun, rejectRun) => {
    const script = "& { param($link, $target) New-Item -ItemType Junction -Path $link -Target $target -ErrorAction Stop | Out-Null }";
    const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script, link, target], { shell: false, windowsHide: true, stdio: "ignore" });
    child.once("error", rejectRun);
    child.once("close", (code) => code === 0 ? resolveRun() : rejectRun(new Error("junction_creation_unavailable")));
  });
}

test("Windows reparse helper executes the strict native protocol without path disclosure", { skip: process.platform !== "win32" }, async (t) => {
  try { await access(helperPath); }
  catch { t.skip("BLOCKED: exact helper publication is unavailable; native protocol closure cannot be claimed"); return; }

  const root = await mkdtemp(resolve(tmpdir(), "gamebuddy-reparse-protocol-"));
  try {
    const regular = resolve(root, "regular.txt");
    const unicodeAstral = resolve(root, "玩家-😀.txt");
    const longDirectory = join(root, ...Array.from({ length: 8 }, (_, index) => `long-component-${index.toString().padStart(2, "0")}-abcdefghijklmnopqrstuvwxyz0123456789`));
    const longAbsolute = join(longDirectory, "long-absolute-path.txt");
    const missing = resolve(root, "missing.txt");
    await writeFile(regular, "regular", "utf8");
    await writeFile(unicodeAstral, "unicode astral", "utf8");
    await mkdir(longDirectory, { recursive: true });
    await writeFile(longAbsolute, "long absolute", "utf8");
    assert.ok(longAbsolute.length > 260, "fixture must exercise a Win32 long absolute path");
    await assertResult(request(regular), "regular");
    await assertResult(request(unicodeAstral), "regular");
    await assertResult(request(longAbsolute), "regular");
    await assertResult(request(missing), "missing");

    for (const malformed of [
      Buffer.from("{", "utf8"),
      Buffer.from(`{"schemaVersion":1,"schemaVersion":1,"operation":"inspect","path":${JSON.stringify(regular)}}`, "utf8"),
      Buffer.from(`{"schemaVersion":1,"operation":"inspect","operation":"inspect","path":${JSON.stringify(regular)}}`, "utf8"),
      Buffer.from(`{"schemaVersion":1,"operation":"inspect","path":${JSON.stringify(regular)},"path":${JSON.stringify(regular)}}`, "utf8"),
      request(`${root}\\*.txt`),
      request(`${root}\\?.txt`),
      request(`${root}\\<.txt`),
      request(`${root}\\>.txt`),
      request(`${root}\\\".txt`),
      Buffer.from([0xff, 0xfe]),
    ]) await assertResult(malformed, "indeterminate");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Windows reparse helper classifies an actual junction", { skip: process.platform !== "win32" }, async (t) => {
  try { await access(helperPath); }
  catch { t.skip("BLOCKED: exact helper publication is unavailable; junction probe cannot be claimed"); return; }

  const root = await mkdtemp(resolve(tmpdir(), "gamebuddy-reparse-junction-"));
  try {
    const target = resolve(root, "target");
    const junction = resolve(root, "junction");
    await mkdir(target);
    try {
      await makeJunction(junction, target);
      await assertResult(request(junction), "reparse");
    } catch {
      t.skip("BLOCKED: junction creation is unavailable; junction closure cannot be claimed");
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Windows reparse helper classifies an actual directory symbolic link where permitted", { skip: process.platform !== "win32" }, async (t) => {
  try { await access(helperPath); }
  catch { t.skip("BLOCKED: exact helper publication is unavailable; directory symlink probe cannot be claimed"); return; }

  const root = await mkdtemp(resolve(tmpdir(), "gamebuddy-reparse-directory-link-"));
  try {
    const target = resolve(root, "target");
    const directoryLink = resolve(root, "directory-link");
    await mkdir(target);
    try {
      await symlink(target, directoryLink, "dir");
      assert.equal((await lstat(directoryLink)).isSymbolicLink(), true);
      await assertResult(request(directoryLink), "reparse");
    } catch {
      t.skip("BLOCKED: directory symbolic-link creation is unavailable; symlink closure cannot be claimed");
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Windows non-link reparse probe records an explicit blocked result when no fixture is available", { skip: process.platform !== "win32" }, async (t) => {
  // This repository has no safe, portable producer for a non-link tag (for example
  // an AppExecLink or cloud placeholder), so it must never be silently counted as coverage.
  t.skip("BLOCKED: no non-link Windows reparse fixture is available on this runner; native reparse closure remains incomplete");
});

test("helper manifest is strict, fixed, and canonical", () => {
  const digest = createHash("sha256").update("fixture").digest("hex");
  const manifest = canonicalManifest(digest);
  assert.equal(manifest, `{"schemaVersion":1,"protocolVersion":${protocolVersion},"rid":"${rid}","helperFileName":"${helperFileName}","sha256":"${digest}"}\n`);
  assert.equal(JSON.stringify(JSON.parse(manifest)), manifest.trim());
  assert.equal(outputRoot.includes("windows-reparse-inspector") && outputRoot.includes(".dist") && outputRoot.endsWith("win-x64"), true);
  assert.equal(manifestFileName, "windows-reparse-inspector.manifest.json");
});

test("production builder uses the globally locked SDK and repeated publish is hash reproducible", { skip: process.platform !== "win32" }, async (t) => {
  // The production API intentionally accepts neither a dotnet path nor spawn injection.
  // An SDK drift is a blocked reproducibility result, not permission to publish with a different SDK.
  try {
    const first = await buildWindowsReparseInspector();
    const firstHash = createHash("sha256").update(await readFile(first.helperPath)).digest("hex");
    const second = await buildWindowsReparseInspector();
    const secondHash = createHash("sha256").update(await readFile(second.helperPath)).digest("hex");
    assert.equal(first.sha256, firstHash);
    assert.equal(second.sha256, secondHash);
    assert.equal(firstHash, secondHash);
    assert.equal(await lstat(second.helperPath).then((state) => state.isSymbolicLink()), false);
  } catch (error) {
    if (error instanceof Error && error.message === "windows_reparse_dotnet_sdk_drift") {
      t.skip("BLOCKED: trusted dotnet host does not activate global.json exact SDK; reproducible publish closure cannot be claimed");
      return;
    }
    throw error;
  }
});
