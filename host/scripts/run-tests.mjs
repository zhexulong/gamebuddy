import { lstat, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { runBoundedChild } from "./test-supervisor.mjs";
import { assertHostVerificationArtifactManifest } from "./verification-artifact-manifest.mjs";

const hostRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const defaultTestRoot = resolve(hostRoot, "dist-test");

function runnerError(code, path) {
  return new Error(`${code}:${path}`);
}

function assertContained(root, path) {
  const pathRelative = relative(root, path);
  if (isAbsolute(pathRelative) || pathRelative === ".." || pathRelative.startsWith(`..${sep}`)) {
    throw runnerError("test_path_traversal", path);
  }
}

async function assertDirectory(path) {
  let details;
  try {
    details = await lstat(path);
  } catch (error) {
    if (error?.code === "ENOENT") throw runnerError("test_root_missing", path);
    throw error;
  }
  if (details.isSymbolicLink()) throw runnerError("test_path_symlink_or_reparse", path);
  if (!details.isDirectory()) throw runnerError("test_root_not_directory", path);
}

/** Discover only regular JavaScript test files below a real test-output root. */
export async function discoverTestFiles(root = defaultTestRoot) {
  const resolvedRoot = resolve(root);
  await assertDirectory(resolvedRoot);
  const tests = [];

  async function walk(directory) {
    assertContained(resolvedRoot, directory);
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const path = resolve(directory, entry.name);
      assertContained(resolvedRoot, path);
      const details = await lstat(path);
      if (details.isSymbolicLink()) throw runnerError("test_path_symlink_or_reparse", path);
      if (details.isDirectory()) {
        await walk(path);
      } else if (details.isFile() && entry.name.endsWith(".test.js")) {
        tests.push(path);
      }
    }
  }

  await walk(resolvedRoot);
  tests.sort((left, right) => left.localeCompare(right, "en"));
  if (tests.length === 0) throw runnerError("test_files_missing", resolvedRoot);
  return tests;
}

export async function runDiscoveredTests(paths, { node = process.execPath, runChild = runBoundedChild, timeoutMs = undefined } = {}) {
  if (!Array.isArray(paths) || paths.length === 0) throw runnerError("test_files_missing", defaultTestRoot);
  const args = ["--test", "--test-concurrency=1", ...paths];
  await runChild({ command: node, args, cwd: hostRoot, ...(timeoutMs === undefined ? {} : { timeoutMs }) });
}

async function main() {
  await assertHostVerificationArtifactManifest({ root: hostRoot, outputRoot: defaultTestRoot });
  const paths = await discoverTestFiles();
  await runDiscoveredTests(paths);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error.stack ?? error.message);
    process.exitCode = 1;
  });
}
