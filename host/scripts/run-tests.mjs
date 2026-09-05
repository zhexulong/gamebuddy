import { lstat, readdir } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { runBoundedChild } from "@gamebuddy/game-action-devkit/process-supervisor";
import { assertHostVerificationArtifactManifest } from "./verification-artifact-manifest.mjs";

const hostRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const defaultTestRoot = resolve(hostRoot, "dist-test");
const defaultScriptTestRoot = resolve(hostRoot, "scripts");
const DEFAULT_TEST_BATCH_SIZE = 10;
// Windows release CI runs each compiled file in an isolated Node coordinator.
// The whole suite remains bounded, but 15 minutes cannot accommodate its
// measured serialized Windows baseline and can shrink a final child below its
// own startup/cleanup minimum. Keep one shared 25-minute deadline.
const DEFAULT_TEST_SUITE_TIMEOUT_MS = 25 * 60_000;

function configuredBatchSize(value, defaultValue = DEFAULT_TEST_BATCH_SIZE) {
  if (value === undefined) return defaultValue;
  if (typeof value !== "string" || !/^[1-9]\d*$/.test(value)) throw runnerError("invalid_test_batch_size", String(value));
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw runnerError("invalid_test_batch_size", value);
  return parsed;
}

function batchFilesForLog(paths) {
  return paths.map((path) => relative(hostRoot, path).replaceAll("\\", "/")).join(",");
}

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

/** Discover only regular test files below a real test root. */
export async function discoverTestFiles(root = defaultTestRoot, extension = ".test.js") {
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
      } else if (details.isFile() && entry.name.endsWith(extension)) {
        tests.push(path);
      }
    }
  }

  await walk(resolvedRoot);
  tests.sort((left, right) => left.localeCompare(right, "en"));
  if (tests.length === 0) throw runnerError("test_files_missing", resolvedRoot);
  return tests;
}

export async function runDiscoveredTests(paths, { node = process.execPath, runChild = runBoundedChild, timeoutMs = undefined, onHeartbeat = undefined } = {}) {
  if (!Array.isArray(paths) || paths.length === 0) throw runnerError("test_files_missing", defaultTestRoot);
  const args = [
    "--import",
    pathToFileURL(resolve(hostRoot, "scripts", "compiled-test-bootstrap.mjs")).href,
    "--test",
    "--test-concurrency=1",
    ...paths,
  ];
  // Tests deliberately resolve repository-owned source and test-only assets
  // relative to the Host package. Supplying an absolute test path does not
  // change Node's cwd, so keep this invariant in the shared runner.
  return await runChild({
    command: node,
    args,
    cwd: hostRoot,
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
    ...(onHeartbeat === undefined ? {} : { onHeartbeat }),
  });
}

function reportHeartbeat(suite) {
  return ({ pid, elapsedMs }) => {
    // Node's spec reporter often remains silent while a deliberately
    // serialized long-running test is active. This preserves the global
    // supervisor deadline while making liveness visible to CI and operators.
    console.error(`host_test_suite_heartbeat:suite=${suite}:pid=${pid ?? "unknown"}:elapsed_ms=${elapsedMs}`);
  };
}

export function chunkTestFiles(paths, batchSize = DEFAULT_TEST_BATCH_SIZE) {
  if (!Array.isArray(paths) || paths.length === 0) throw runnerError("test_files_missing", defaultTestRoot);
  if (!Number.isSafeInteger(batchSize) || batchSize < 1) throw runnerError("invalid_test_batch_size", String(batchSize));
  const batches = [];
  for (let index = 0; index < paths.length; index += batchSize) batches.push(paths.slice(index, index + batchSize));
  return batches;
}

/**
 * Run bounded, deterministic batches instead of giving every compiled test
 * file to one long-lived Node test coordinator. A test worker that fails to
 * release an inherited handle can then affect at most its own batch; the next
 * batch gets a fresh coordinator. The deadline belongs to the entire suite,
 * not to each batch.
 */
export async function runTestBatches(paths, {
  suite,
  batchSize = DEFAULT_TEST_BATCH_SIZE,
  timeoutMs = DEFAULT_TEST_SUITE_TIMEOUT_MS,
  run = runDiscoveredTests,
  now = Date.now,
} = {}) {
  if (typeof suite !== "string" || suite.length === 0) throw runnerError("invalid_test_suite", String(suite));
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100) throw runnerError("invalid_test_suite_timeout", String(timeoutMs));
  const batches = chunkTestFiles(paths, batchSize);
  const deadlineMs = now() + timeoutMs;
  for (const [index, batch] of batches.entries()) {
    const remainingMs = deadlineMs - now();
    if (remainingMs < 100) throw runnerError("test_suite_timeout", suite);
    const batchLabel = `${suite}:batch=${index + 1}/${batches.length}`;
    console.error(`host_test_suite_batch_start:suite=${batchLabel}:files=${batch.length}:paths=${batchFilesForLog(batch)}:remaining_ms=${remainingMs}`);
    await run(batch, { timeoutMs: remainingMs, onHeartbeat: reportHeartbeat(batchLabel) });
  }
}

export async function runCompiledTests({ batchSize = configuredBatchSize(process.env.GAMEBUDDY_HOST_TEST_COMPILED_BATCH_SIZE) } = {}) {
  if (!Number.isSafeInteger(batchSize) || batchSize < 1) throw runnerError("invalid_test_batch_size", String(batchSize));
  await assertHostVerificationArtifactManifest({ root: hostRoot, outputRoot: defaultTestRoot });
  return await runTestBatches(await discoverTestFiles(defaultTestRoot, ".test.js"), { suite: "compiled", batchSize });
}

export async function runScriptTests() {
  // Script tests run after the artifact lock is released. Some of them
  // intentionally invoke public package scripts to verify lock contention;
  // running them inside this process's build/test lock would self-deadlock.
  return await runTestBatches(await discoverTestFiles(defaultScriptTestRoot, ".test.mjs"), { suite: "scripts" });
}

async function main() {
  await runCompiledTests();
  await runScriptTests();
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error.stack ?? error.message);
    process.exitCode = 1;
  });
}
