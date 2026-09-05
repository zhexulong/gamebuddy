import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  ACTION_SURFACE_ARTIFACT_RELATIVE_PATH,
  ACTION_SURFACE_CHECK_MAX_REPORT_BYTES,
  runActionSurfaceCheck,
} from "../src/action-surface-check.mjs";
import { readFixedPackageUtf8File } from "../src/package-safe-reader.mjs";

const directory = path.dirname(fileURLToPath(import.meta.url));
const packageDirectory = path.dirname(directory);
const sourcePath = path.join(packageDirectory, "src", "action-surface-check.mjs");

test("checks the exact package-relative generated action-surface artifact", async () => {
  const artifactPath = path.join(packageDirectory, ACTION_SURFACE_ARTIFACT_RELATIVE_PATH);
  const artifact = await readFile(artifactPath);
  const report = await runActionSurfaceCheck();
  assert.equal(report.schema, "gamebuddy-stardew-action-surface-check/v1");
  assert.equal(report.status, "valid");
  assert.equal(report.artifact, ACTION_SURFACE_ARTIFACT_RELATIVE_PATH);
  assert.ok(report.actions > 0);
  assert.equal(Buffer.byteLength(JSON.stringify(report), "utf8") <= ACTION_SURFACE_CHECK_MAX_REPORT_BYTES, true);
  assert.equal(artifact.byteLength <= 64 * 1024, true);
});

test("source has no parent discovery, shell, producer, runtime, or bridge boundary", async () => {
  const source = await readFile(sourcePath, "utf8");
  assert.doesNotMatch(source, /(?:from|import)\s+["'](?:\.\.\/){2,}/);
  assert.doesNotMatch(source, /(?:from|import)\s+["'][^"']*(?:host|mod|producer|runtime|bridge|game|export)[^"']*["']/i);
  assert.doesNotMatch(source, /\b(?:spawn|exec|shell)\b\s*:?/i);
  assert.match(source, /contracts[\\/]generated[\\/]action-surface\.v1\.json/);
});

async function withReaderFixture(callback) {
  const root = await mkdtemp(path.join(os.tmpdir(), "stardew-action-surface-reader-"));
  try {
    await callback(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function skipUnavailableWindowsSymlink(t, error) {
  if (process.platform === "win32" && ["EPERM", "EACCES"].includes(error?.code)) {
    t.skip(`symlink fixture unavailable on Windows: ${error.code}`);
    return true;
  }
  return false;
}

test("rejects non-canonical package-relative paths before filesystem access", async () => withReaderFixture(async (root) => {
  await writeFile(path.join(root, "surface.json"), "{}\n");
  for (const relativePath of ["../surface.json", "nested/../surface.json", "./surface.json", "nested//surface.json", "surface\\json", "/surface.json", "C:/surface.json", "surface\0json"]) {
    await assert.rejects(
      readFixedPackageUtf8File({ packageDirectory: root, relativePath, maxBytes: 1024, errorPrefix: "stardew_action_surface_check" }),
      /stardew_action_surface_check_invalid_package_relative_path/,
    );
  }
}));

test("rejects a symlink leaf package input", async (t) => withReaderFixture(async (root) => {
  const target = path.join(root, "target.json");
  const leaf = path.join(root, "linked.json");
  await writeFile(target, "{}\n");
  try {
    await symlink(target, leaf, "file");
  } catch (error) {
    if (skipUnavailableWindowsSymlink(t, error)) return;
    throw error;
  }
  await assert.rejects(
    readFixedPackageUtf8File({ packageDirectory: root, relativePath: "linked.json", maxBytes: 1024, errorPrefix: "stardew_action_surface_check" }),
    /stardew_action_surface_check_path_link_or_reparse/,
  );
}));

test("rejects a symlink ancestor package input", async (t) => withReaderFixture(async (root) => {
  const targetDirectory = path.join(root, "target-directory");
  const linkedDirectory = path.join(root, "linked-directory");
  await mkdir(targetDirectory);
  await writeFile(path.join(targetDirectory, "surface.json"), "{}\n");
  try {
    await symlink(targetDirectory, linkedDirectory, "dir");
  } catch (error) {
    if (skipUnavailableWindowsSymlink(t, error)) return;
    throw error;
  }
  await assert.rejects(
    readFixedPackageUtf8File({ packageDirectory: root, relativePath: "linked-directory/surface.json", maxBytes: 1024, errorPrefix: "stardew_action_surface_check" }),
    /stardew_action_surface_check_path_link_or_reparse/,
  );
}));

test("bounds bytes before allocation and rejects malformed UTF-8", async () => withReaderFixture(async (root) => {
  const file = path.join(root, "surface.json");
  await writeFile(file, Buffer.from([0xc3, 0x28]));
  await assert.rejects(
    readFixedPackageUtf8File({ packageDirectory: root, relativePath: "surface.json", maxBytes: 1, errorPrefix: "stardew_action_surface_check" }),
    /stardew_action_surface_check_bounds/,
  );
  await assert.rejects(
    readFixedPackageUtf8File({ packageDirectory: root, relativePath: "surface.json", maxBytes: 1024, errorPrefix: "stardew_action_surface_check" }),
    /stardew_action_surface_check_invalid_utf8/,
  );
}));
