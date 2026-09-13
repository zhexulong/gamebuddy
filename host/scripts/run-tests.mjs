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
const STRICT_TEST_DISPOSITION = process.env.GAMEBUDDY_HOST_TEST_STRICT_DISPOSITION === "1";
const RELEASE_SCRIPT_TEST_SUFFIX = ".release.test.mjs";
const ALLOWED_RELEASE_PLATFORM_SKIPS = Object.freeze([
  Object.freeze({
    testName: "Windows reparse helper classifies an actual directory symbolic link where permitted",
    platform: "win32",
    reason: "platform_non_applicable: Windows directory symbolic-link creation requires Developer Mode or SeCreateSymbolicLinkPrivilege; junction and AF_UNIX probes cover this runner's release reparse detection",
  }),
  Object.freeze({
    testName: "non-Windows synthetic acquisition retains isolated test scratch behavior",
    platform: "win32",
    reason: "platform_non_applicable: synthetic non-Windows scratch behavior is covered off Windows",
  }),
  Object.freeze({
    testName: "strict identity is explicitly unavailable on non-Windows",
    platform: "win32",
    reason: "platform_non_applicable: strict identity is unavailable on non-Windows",
  }),
  Object.freeze({
    testName: "non-Windows builder fails closed before browser composition or publication while approved runtime acquisition is unavailable",
    platform: "win32",
    reason: "platform_non_applicable: non-Windows runtime acquisition gate",
  }),
  Object.freeze({
    testName: "normal withPathLock use fails closed at release on non-Windows without any capability binding",
    platform: "win32",
    reason: "platform_non_applicable: Windows production locking mints the fixed helper pair; this documents the non-Windows default",
  }),
  Object.freeze({
    testName: "non-Windows browser composition failure cannot create a current pointer while runtime acquisition is unavailable",
    platform: "win32",
    reason: "platform_non_applicable: non-Windows runtime acquisition gate",
  }),
  ...["EPERM", "EACCES", "ENOTSUP"].map((code) => Object.freeze({
    testName: "rejects fixture workers broadly, tampering, orphans, symlinks, and invalid start entry names",
    platform: "win32",
    reason: `symlink unavailable: ${code}`,
  })),
  ...["EPERM", "EACCES", "ENOTSUP"].map((code) => Object.freeze({
    testName: "browser composition rejects reparse/link staging entries",
    platform: "win32",
    reason: `platform_non_applicable: Windows file-link fixture unavailable: ${code}`,
  })),
]);

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

function parseTestDisposition(output) {
  const summary = typeof output === "string"
    ? /# tests (\d+)\r?\n# suites (\d+)\r?\n# pass (\d+)\r?\n# fail (\d+)\r?\n# cancelled (\d+)\r?\n# skipped (\d+)\r?\n# todo (\d+)/m.exec(output)
    : null;
  if (summary === null) throw runnerError("test_disposition_summary_missing", defaultTestRoot);
  const skippedTests = typeof output === "string"
    ? [...output.matchAll(/^ok \d+ - (.+?) # SKIP(?:[ \t]+(.*))?$/gm)].map((match) => Object.freeze({ testName: match[1], reason: match[2]?.trim() ?? "" }))
    : [];
  return Object.freeze({
    tests: Number(summary[1]),
    suites: Number(summary[2]),
    passed: Number(summary[3]),
    failed: Number(summary[4]),
    cancelled: Number(summary[5]),
    skipped: Number(summary[6]),
    skippedTests: Object.freeze(skippedTests),
    skippedReasons: Object.freeze(skippedTests.map(({ reason }) => reason)),
    todo: Number(summary[7]),
  });
}

export function assertTestDisposition(output, { strict = STRICT_TEST_DISPOSITION, platform = process.platform } = {}) {
  const disposition = parseTestDisposition(output);
  if (strict && disposition.skipped > 0) {
    if (disposition.skippedTests.length !== disposition.skipped) {
      throw runnerError("test_disposition_skip_reasons_missing", JSON.stringify(disposition));
    }
    const disallowedSkippedReasons = disposition.skippedTests.filter(
      (skipped) => !ALLOWED_RELEASE_PLATFORM_SKIPS.some((allowed) => allowed.platform === platform && allowed.testName === skipped.testName && allowed.reason === skipped.reason),
    );
    if (disallowedSkippedReasons.length > 0) {
      throw runnerError(
        "test_disposition_not_release_green",
        JSON.stringify({ ...disposition, disallowedSkippedReasons }),
      );
    }
  }
  if (disposition.failed !== 0 || disposition.cancelled !== 0 || disposition.todo !== 0) {
    throw runnerError("test_disposition_not_release_green", JSON.stringify(disposition));
  }
  return disposition;
}

export async function runDiscoveredTests(paths, { node = process.execPath, runChild = runBoundedChild, timeoutMs = undefined, onHeartbeat = undefined, strictDisposition = STRICT_TEST_DISPOSITION, platform = process.platform } = {}) {
  if (!Array.isArray(paths) || paths.length === 0) throw runnerError("test_files_missing", defaultTestRoot);
  const args = [
    "--import",
    pathToFileURL(resolve(hostRoot, "scripts", "compiled-test-bootstrap.mjs")).href,
    "--test",
    "--test-concurrency=1",
    ...(strictDisposition ? ["--test-reporter=tap"] : []),
    ...paths,
  ];
  // Tests deliberately resolve repository-owned source and test-only assets
  // relative to the Host package. Supplying an absolute test path does not
  // change Node's cwd, so keep this invariant in the shared runner.
  const result = await runChild({
    command: node,
    args,
    cwd: hostRoot,
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
    ...(onHeartbeat === undefined ? {} : { onHeartbeat }),
  });
  if (!strictDisposition) return result;
  if (result?.code !== 0 || result?.signal !== null) {
    throw runnerError("test_disposition_process_failed", JSON.stringify({ code: result?.code, signal: result?.signal }));
  }
  const disposition = assertTestDisposition(`${result?.stdout ?? result?.output ?? ""}\n${result?.stderr ?? ""}`, { strict: true, platform });
  return Object.freeze({ ...result, disposition });
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
  strictDisposition = STRICT_TEST_DISPOSITION,
  platform = process.platform,
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
    for (const path of batch) {
      const fileRemainingMs = deadlineMs - now();
      if (fileRemainingMs < 100) throw runnerError("test_suite_timeout", suite);
      await run([path], {
        timeoutMs: fileRemainingMs,
        onHeartbeat: reportHeartbeat(`${batchLabel}:file=${relative(hostRoot, path).replaceAll("\\\\", "/")}`),
        strictDisposition,
        platform,
      });
    }
  }
}

export async function runCompiledTests({ batchSize = configuredBatchSize(process.env.GAMEBUDDY_HOST_TEST_COMPILED_BATCH_SIZE) } = {}) {
  if (!Number.isSafeInteger(batchSize) || batchSize < 1) throw runnerError("invalid_test_batch_size", String(batchSize));
  await assertHostVerificationArtifactManifest({ root: hostRoot, outputRoot: defaultTestRoot });
  return await runTestBatches(await discoverTestFiles(defaultTestRoot, ".test.js"), { suite: "compiled", batchSize });
}

export function selectScriptTests(paths, { releaseOnly = false } = {}) {
  if (!Array.isArray(paths) || paths.length === 0) throw runnerError("test_files_missing", defaultScriptTestRoot);
  const tests = paths.filter((path) => path.endsWith(RELEASE_SCRIPT_TEST_SUFFIX) === releaseOnly);
  if (tests.length === 0) throw runnerError("test_files_missing", defaultScriptTestRoot);
  return tests;
}

export async function runScriptTests({ releaseOnly = false } = {}) {
  // Script tests run after the artifact lock is released. Some of them
  // intentionally invoke public package scripts to verify lock contention;
  // running them inside this process's build/test lock would self-deadlock.
  const discovered = await discoverTestFiles(defaultScriptTestRoot, ".test.mjs");
  return await runTestBatches(selectScriptTests(discovered, { releaseOnly }), { suite: releaseOnly ? "release-scripts" : "scripts" });
}

export async function runReleaseScriptTests() {
  return await runScriptTests({ releaseOnly: true });
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
