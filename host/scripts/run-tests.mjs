import { lstat, readdir } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { runBoundedChild } from "./child-process-tool.mjs";
import { assertHostVerificationArtifactManifest } from "./verification-artifact-manifest.mjs";

const hostRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const defaultTestRoot = resolve(hostRoot, "dist-test");
const defaultScriptTestRoot = resolve(hostRoot, "scripts");
const DEFAULT_TEST_BATCH_SIZE = 10;
// Each compiled file still gets its own Node coordinator, but spawning 230 of
// them one after another spends most of the run inside Node startup. A small
// bound lets one file's startup overlap its neighbours' work without a single
// leaked handle ever sharing a process. Four stays within a 4-vCPU Windows CI
// runner and the compiled batch size, so a batch's tail stays short.
/**
 * Files that contend on one machine-global resource must not run at the same time, even
 * though every other file may. This is the runner's job because the runner is the only layer
 * that can serialize access to a machine-global resource; it is not a per-test concern.
 *
 * The case that produced it: four compiled files each spawn a real `dotnet test` against
 * `integrations/stardew/tests/GameBuddy.Stardew.Core.Tests/GameBuddy.Stardew.Core.Tests.csproj`,
 * whose `obj/`+`bin/` and shared MSBuild/Roslyn servers are machine-global; four simultaneous
 * cold builds killed three of them with `MSB3491 ... being used by another process` and
 * `CS2012 ... being used by another process`. Staggered starts never stalled, which is why it
 * only ever appeared under concurrency.
 *
 * `runCompiledTests` refuses to run when a declared group matches no compiled file, so a
 * declaration cannot outlive the files that justified it.
 */
export const EXCLUSIVE_FILE_GROUPS = Object.freeze([
  Object.freeze({
    name: "stardew-core-test-project-build",
    pattern: /stardew-(?:execution-request|snapshot|navigation|execution-receipt)-wire-parity\.test\.js$/u,
  }),
]);

/** The declared exclusive groups a path belongs to, identified by its `dist-test`-relative shape. */
export function exclusiveGroupsFor(relativePath) {
  const normalized = String(relativePath).replaceAll("\\", "/");
  return EXCLUSIVE_FILE_GROUPS.filter((group) => group.pattern.test(normalized));
}

const DEFAULT_TEST_CONCURRENCY = 4;
/**
 * Per-file budget. Far above the slowest legitimate file (tens of seconds) and far below
 * the suite deadline, so a file that never resolves is named and bounded instead of
 * consuming the run. Raise it with `GAMEBUDDY_HOST_TEST_COMPILED_FILE_TIMEOUT_MS` when a
 * deliberately long fixture is being run on purpose.
 */
const DEFAULT_TEST_FILE_TIMEOUT_MS = 180_000;
// Windows release CI runs each compiled file in an isolated Node coordinator.
// The whole suite remains bounded, but 15 minutes cannot accommodate its
// measured serialized Windows baseline and can shrink a final child below its
// own startup/cleanup minimum. Keep one shared 25-minute deadline.
const DEFAULT_TEST_SUITE_TIMEOUT_MS = 25 * 60_000;

function configuredCount(value, defaultValue, code) {
  if (value === undefined) return defaultValue;
  if (typeof value !== "string" || !/^[1-9]\d*$/.test(value)) throw runnerError(code, String(value));
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw runnerError(code, value);
  return parsed;
}

function configuredBatchSize(value, defaultValue = DEFAULT_TEST_BATCH_SIZE) {
  return configuredCount(value, defaultValue, "invalid_test_batch_size");
}

function configuredConcurrency(value, defaultValue = DEFAULT_TEST_CONCURRENCY) {
  return configuredCount(value, defaultValue, "invalid_test_concurrency");
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
 * Run one batch's files as isolated children, at most `concurrency` at a time.
 * A file that starts still sees the suite's remaining budget. A failure, or an
 * exhausted deadline, stops new files from starting; every already-started
 * child is awaited before this returns, so a batch cannot report success (or a
 * failure) while one of its children is still running.
 */
async function runBatchFiles({ batch, batchLabel, concurrency, deadlineMs, perFileMs, run, now, suite }) {
  const failures = new Array(batch.length);
  let nextIndex = 0;
  let stopped = false;
  const relativePath = (path) => relative(hostRoot, path).replaceAll("\\\\", "/");
  const runOne = async (index) => {
    const path = batch[index];
    const fileRemainingMs = deadlineMs - now();
    if (fileRemainingMs < 100) {
      failures[index] = { error: runnerError("test_suite_timeout", suite) };
      stopped = true;
      return;
    }
    // A file gets its own budget, not the suite's remaining deadline. A test that
    // never resolves is not a slow test - it is a run that never reports anything,
    // and with only a suite-wide deadline one such file consumes every remaining
    // minute and the suite disappears without a result. This bound is the difference
    // between "this file hung" (named, bounded) and silence; it is deliberately far
    // above the slowest legitimate test (tens of seconds).
    const budgetMs = Math.min(fileRemainingMs, perFileMs);
    try {
      await run([path], {
        timeoutMs: budgetMs,
        onHeartbeat: reportHeartbeat(`${batchLabel}:file=${relativePath(path)}`),
      });
    } catch (error) {
      // Only a child the supervisor had to KILL is a budget expiry. Anything else - a non-zero
      // exit, a spawn error - is the child's own failure and must keep its own message, output
      // and code: reporting a real failure as "the budget expired" hides the reason it failed,
      // and the budget is not even what ended it (`budgetMs === perFileMs` only says the per-file
      // bound was the smaller of the two).
      const message = error instanceof Error ? error.message : String(error);
      // Relabelling must not discard what the killed child had produced: the supervisor's own
      // message carries its bounded output after the first newline, and without it a budget
      // expiry is a name and a number with no clue what the file was doing when it was killed.
      const childOutput = message.includes("\n") ? message.slice(message.indexOf("\n")) : "";
      failures[index] = {
        error: message.startsWith("test_supervisor_timeout:")
          ? runnerError("test_file_timeout", `${relativePath(path)}:budget_ms=${budgetMs}${childOutput}`)
          : error,
      };
      stopped = true;
    }
  };
  // Files that contend on one machine-global resource run one at a time and only after the
  // concurrent pool has drained, so they can never overlap each other while everything else
  // keeps its parallelism.
  const exclusiveIndexes = batch.map((path, index) => index).filter((index) => exclusiveGroupsFor(relativePath(batch[index])).length > 0);
  const ordinaryIndexes = batch.map((path, index) => index).filter((index) => exclusiveGroupsFor(relativePath(batch[index])).length === 0);
  const worker = async () => {
    while (!stopped) {
      const index = ordinaryIndexes[nextIndex++];
      if (index === undefined) return;
      await runOne(index);
    }
  };
  const workers = [];
  for (let index = 0; index < Math.min(concurrency, ordinaryIndexes.length); index++) workers.push(worker());
  await Promise.all(workers);
  for (const index of exclusiveIndexes) {
    if (stopped) break;
    await runOne(index);
  }
  // Report the earliest-launched failure so the batch stays deterministic
  // instead of surfacing whichever child happened to lose the race.
  for (const failure of failures) {
    if (failure !== undefined) throw failure.error;
  }
}

/**
 * Run bounded, deterministic batches instead of giving every compiled test
 * file to one long-lived Node test coordinator. A test worker that fails to
 * release an inherited handle can then affect at most its own batch; the next
 * batch gets a fresh coordinator. The deadline belongs to the entire suite,
 * not to each batch.
 *
 * Batches stay sequential - that barrier is the isolation property - but the
 * files inside one batch are separate children, so up to `concurrency` Node
 * startups overlap instead of paying the whole serialized cost.
 *
 * Each file also gets its own budget (`perFileMs`). The suite deadline still bounds the
 * whole run; the per-file budget exists because a file that never resolves is a distinct
 * failure from a slow suite - without it, one hung test file consumes every remaining
 * minute, the run ends with no result at all, and the file that hung is never named.
 */
export async function runTestBatches(paths, {
  suite,
  batchSize = DEFAULT_TEST_BATCH_SIZE,
  concurrency = DEFAULT_TEST_CONCURRENCY,
  timeoutMs = DEFAULT_TEST_SUITE_TIMEOUT_MS,
  perFileMs = DEFAULT_TEST_FILE_TIMEOUT_MS,
  run = runDiscoveredTests,
  now = Date.now,
} = {}) {
  if (typeof suite !== "string" || suite.length === 0) throw runnerError("invalid_test_suite", String(suite));
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100) throw runnerError("invalid_test_suite_timeout", String(timeoutMs));
  if (!Number.isSafeInteger(concurrency) || concurrency < 1) throw runnerError("invalid_test_concurrency", String(concurrency));
  if (!Number.isSafeInteger(perFileMs) || perFileMs < 100) throw runnerError("invalid_test_file_timeout", String(perFileMs));
  const batches = chunkTestFiles(paths, batchSize);
  const deadlineMs = now() + timeoutMs;
  for (const [index, batch] of batches.entries()) {
    const remainingMs = deadlineMs - now();
    if (remainingMs < 100) throw runnerError("test_suite_timeout", suite);
    const batchLabel = `${suite}:batch=${index + 1}/${batches.length}`;
    console.error(`host_test_suite_batch_start:suite=${batchLabel}:files=${batch.length}:paths=${batchFilesForLog(batch)}:remaining_ms=${remainingMs}`);
    await runBatchFiles({ batch, batchLabel, concurrency, deadlineMs, perFileMs, run, now, suite });
  }
}

export async function runCompiledTests({
  batchSize = configuredBatchSize(process.env.GAMEBUDDY_HOST_TEST_COMPILED_BATCH_SIZE),
  concurrency = configuredConcurrency(process.env.GAMEBUDDY_HOST_TEST_COMPILED_CONCURRENCY),
  perFileMs = configuredCount(
    process.env.GAMEBUDDY_HOST_TEST_COMPILED_FILE_TIMEOUT_MS,
    DEFAULT_TEST_FILE_TIMEOUT_MS,
    "invalid_test_file_timeout",
  ),
} = {}) {
  if (!Number.isSafeInteger(batchSize) || batchSize < 1) throw runnerError("invalid_test_batch_size", String(batchSize));
  if (!Number.isSafeInteger(concurrency) || concurrency < 1) throw runnerError("invalid_test_concurrency", String(concurrency));
  // Validated here, beside the other two knobs, so a bad value fails before this function
  // touches the artifact manifest or discovers files - a knob that is off must not cost a build.
  if (!Number.isSafeInteger(perFileMs) || perFileMs < 100)
    throw runnerError("invalid_test_file_timeout", String(perFileMs));
  await assertHostVerificationArtifactManifest({ root: hostRoot, outputRoot: defaultTestRoot });
  const files = await discoverTestFiles(defaultTestRoot, ".test.js");
  for (const group of EXCLUSIVE_FILE_GROUPS) {
    const matched = files.filter((file) => group.pattern.test(relative(hostRoot, file).replaceAll("\\\\", "/")));
    // Self-invalidating: a group whose files are gone (renamed, deleted, folded into one
    // build-once step) must fail here rather than quietly keep serializing nothing.
    if (matched.length === 0) throw runnerError("exclusive_group_matches_nothing", group.name);
  }
  return await runTestBatches(files, {
    suite: "compiled",
    batchSize,
    concurrency,
    perFileMs,
  });
}

export async function runScriptTests() {
  // Script tests run after the artifact lock is released. Some of them
  // intentionally invoke public package scripts to verify lock contention, and
  // one of them removes dist-test on purpose; overlapping those would create
  // the contention they are asserting about, so they stay serialized.
  return await runTestBatches(await discoverTestFiles(defaultScriptTestRoot, ".test.mjs"), { suite: "scripts", concurrency: 1 });
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
