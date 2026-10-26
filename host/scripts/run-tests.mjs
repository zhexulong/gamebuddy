import { lstat, readdir } from "node:fs/promises";
import { availableParallelism, cpus } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { runBoundedChild } from "./child-process-tool.mjs";
import { assertTestArtifactFreshness, assertTestArtifactInventory } from "./test-artifact-inventory.mjs";
import { assertHostVerificationArtifactManifest } from "./verification-artifact-manifest.mjs";

export const hostRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const defaultTestRoot = resolve(hostRoot, "dist-test");
const defaultScriptTestRoot = resolve(hostRoot, "scripts");
const DEFAULT_TEST_BATCH_SIZE = 10;
/** The highest default the machine's own capacity may raise concurrency to; see below. */
const MAX_DEFAULT_TEST_CONCURRENCY = 2;
// Each compiled file still gets its own Node coordinator, but spawning 230 of
// them one after another spends most of the run inside Node startup. A small
// bound lets one file's startup overlap its neighbours' work without a single
// leaked handle ever sharing a process. Two is the ceiling: it overlaps Node
// startup inside a batch while keeping the batch's tail short.
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
  Object.freeze({
    // The other half of the same doctrine: this file is individually FINE and only looks broken
    // under company. It stands up a real named-pipe bridge, drives the real client and the
    // product's frame path over it, so every round trip is a real syscall - and under a loaded
    // machine those round trips stop being microseconds. Measured 2026-10-17: 2s alone here,
    // and PASSING alone on the CI runner with a 60s per-test timeout, while the same file inside
    // a 2-way batch exceeded its 600s stall budget (heartbeats clean, no failing test). The
    // runner's own note above describes this exact signature, so it is the runner's job.
    name: "named-pipe-real-time-coordinator",
    pattern: /gameplay-task-subagent\.test\.js$/u,
  }),
  Object.freeze({
    // The same signature, measured 2026-10-26 on CI: 117 tests pass alone in 34.5 s, and in a two-file batch the
    // file reported 21 tests and then went silent for 27 minutes with no heartbeat and no failing test. It drives
    // the real Player Host and a real named-pipe bridge, so its round trips degrade under company exactly as the
    // group above does. Grouped by the runner rather than slowed by a bigger budget, because the reading that
    // distinguished the two - `silent_for_ms` - showed silence, not work.
    name: "stardew-player-host-lifecycle",
    pattern: /stardew-production-lifecycle-coordinator\.internal\.test\.js$/u,
  }),
]);

/** The declared exclusive groups a path belongs to, identified by its `dist-test`-relative shape. */
export function exclusiveGroupsFor(relativePath) {
  const normalized = String(relativePath).replaceAll("\\", "/");
  return EXCLUSIVE_FILE_GROUPS.filter((group) => group.pattern.test(normalized));
}

/**
 * The runner must not add parallelism the machine cannot absorb.
 *
 * Excess concurrency never reports itself as "the runner was too eager"; it reports itself as a
 * per-file stall-budget expiry or a loopback `ECONNRESET` on a file that is individually fine,
 * and both are then attributed to that file. Measured on the development machine: with ~60
 * unrelated node processes already running, `gameplay-task-subagent.test.js` exceeds a 180s
 * budget inside a batch although it takes 2s alone, and `tavern-management-dialogue-web.test.js`
 * returned `TypeError: fetch failed / read ECONNRESET` in a full run while passing 28/28 alone.
 *
 * So the default is derived from what THIS machine reports it can run, never from a constant.
 * `availableParallelism()` honours the process's own CPU affinity and CPU-group limits, so a
 * container restricted to one effective CPU decodes to 1 instead of to a constant 2; `cpus()`
 * is only the fallback because it reports hardware the process may not be allowed to use.
 * An explicit `GAMEBUDDY_HOST_TEST_COMPILED_CONCURRENCY` still wins, and an invalid one still
 * fails closed with `invalid_test_concurrency`.
 */
export function machineDefaultConcurrency(parallelism = availableParallelism?.() ?? cpus().length) {
  return Math.max(1, Math.min(MAX_DEFAULT_TEST_CONCURRENCY, parallelism));
}

const DEFAULT_TEST_CONCURRENCY = machineDefaultConcurrency();
/**
 * Per-file budget: a STALL detector, not a speed bound. It exists so a file that never
 * resolves is named and bounded instead of consuming the run; the suite deadline owns the real
 * bound. Sized generously because a legitimately slow file under load is otherwise reported as a
 * hang: measured here, `gameplay-task-subagent.test.js` takes 2s alone and exceeded a 180s budget
 * inside a 4-way batch on a machine already running ~60 other node processes.
 */
export const DEFAULT_TEST_FILE_TIMEOUT_MS = 600_000;
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
  // The children run under `node`. A compiled test that must spawn its own Node child (node:test's
  // module mocks, a Node-only realpath) cannot trust its own `process.execPath`, because under
  // `bun test` that is bun. Children inherit this environment, so publish the exact command this
  // coordinator runs them under; the resolution stays in one place instead of each test guessing.
  process.env.GAMEBUDDY_HOST_TEST_NODE = node;
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
  async function runBatchFiles({ batch, batchLabel, concurrency, deadlineMs, perFileMs, run, now, suite, keepGoing = false, retryEnvironmental = true }) {
    /**
     * The failure to report for one child, with the runner's own budget kill relabelled to name the
     * file and the budget - and with the killed child's captured output kept. One spelling for both
     * the first attempt and the retry: a second budget kill must still read the same way.
     */
    const describeRunFailure = (path, message, budgetMs, childOutput, silentForMs) =>
      message.startsWith("test_supervisor_timeout:")
        ? runnerError(
            "test_file_timeout",
            // `silent_for_ms` is the reading that distinguishes a stalled file from a slow one: an age close to
            // the budget means nothing has been printed since the child started, and a small age means the child
            // was still reporting when the budget ended. Without it the two read identically.
            `${relativePath(path)}:budget_ms=${budgetMs}:silent_for_ms=${silentForMs ?? "unknown"}${childOutput}`,
          )
        : new Error(message);
    const failures = new Array(batch.length);
    let nextIndex = 0;
    let stopped = false;
  // One backslash, so a Windows path is normalized exactly once: the literal had been written
  // with two, which matches nothing, so every path this produces kept its backslashes (messages
  // and heartbeat labels alike). `exclusiveGroupsFor` always wrote it correctly, which is why the
  // group matching worked while the message spelling did not.
  const relativePath = (path) => relative(hostRoot, path).replaceAll("\\", "/");
  const runOne = async (index) => {
    const path = batch[index];
    const fileRemainingMs = deadlineMs - now();
    if (fileRemainingMs < 100) {
        failures[index] = { path, error: runnerError("test_suite_timeout", suite) };
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
    // The child's own last sign of life. `reportHeartbeat` already prints it; keeping the timestamp is what lets the
    // failure say how long the file had been silent for.
    let lastHeartbeatAtMs = now();
    const heartbeat = reportHeartbeat(`${batchLabel}:file=${relativePath(path)}`);
    try {
      await run([path], {
        timeoutMs: budgetMs,
        onHeartbeat: (beat) => {
          lastHeartbeatAtMs = now();
          heartbeat(beat);
        },
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
        const silentForMs = Math.max(0, now() - lastHeartbeatAtMs);
        failures[index] = {
          path,
          budgetMs,
          error: describeRunFailure(path, message, budgetMs, childOutput, silentForMs),
        };
        // A batch stops at its first failure unless the caller asked to see everything. The
        // remaining files in the batch are still run under `--keep-going`, which exists because
        // this machine's environmental failures were costing whole batches of information.
        if (!keepGoing) stopped = true;
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
    // A failure that is the machine's - no assertion in the child's output, and a named transport or
    // budget cause - gets ONE retry, and it gets it here, after both pools have drained, so the
    // retry really is the file alone. Anything else, and anything that fails again, is a failure.
    //
    // A budget kill is only the machine's when the BATCH shortened the budget
    // (`Math.min(fileRemainingMs, perFileMs)`): then a slow-but-passing file was killed for the suite's
    // remaining time. A kill at the file's own full budget is the file being too slow or hung, and it is
    // reported by name rather than costing a second budget.
    if (retryEnvironmental) {
      for (const [index, failure] of failures.entries()) {
        if (failure === undefined || !isEnvironmentalFailure(failure.error)) continue;
        const budgetKill = (failure.error.message ?? "").startsWith("test_file_timeout:");
        if (budgetKill && failure.budgetMs === perFileMs) continue;
        const path = batch[index];
        const label = relativePath(path);
        const retryRemainingMs = deadlineMs - now();
        console.error(`host_test_suite_file_retry:suite=${batchLabel}:file=${label}:reason=environmental`);
        if (retryRemainingMs < 100) {
          console.error(`host_test_suite_file_retry_skipped:suite=${batchLabel}:file=${label}:reason=suite_deadline`);
          continue;
        }
        const retryBudgetMs = Math.min(retryRemainingMs, perFileMs);
        try {
          await run([path], { timeoutMs: retryBudgetMs });
          console.error(`host_test_suite_file_retry_outcome:suite=${batchLabel}:file=${label}:outcome=passed`);
          failures[index] = undefined;
        } catch (error) {
          // The second failure is what the run reports, and it keeps the child's own message: a
          // retry that fails for a different reason is that reason - relabelled the same way the
          // first attempt was, so a second budget kill still names the file and its budget.
          const message = error instanceof Error ? error.message : String(error);
          const childOutput = message.includes("\n") ? message.slice(message.indexOf("\n")) : "";
          console.error(`host_test_suite_file_retry_outcome:suite=${batchLabel}:file=${label}:outcome=failed`);
          failures[index] = { path, budgetMs: retryBudgetMs, error: describeRunFailure(path, message, retryBudgetMs, childOutput) };
        }
      }
    }
    // Report the earliest-launched failure so the batch stays deterministic
    // instead of surfacing whichever child happened to lose the race.
    return failures.filter((failure) => failure !== undefined);
  }

/**
 * Causes that mean the machine rather than the code, for the one bounded retry below.
 *
 * The rule is deliberately two-sided: a child whose output carries an assertion failure is NEVER
 * environmental, whatever else it printed, and a retry is bounded to one attempt - so a cause that
 * persists still fails the run. This exists because this machine resets loopback sockets under load
 * (a file that failed a batch with `read ECONNRESET` passed 10/10 on its own), and because two
 * publisher fixtures contend on one lock file in a temp root: the loser reports
 * `EPERM ... open '...\\.test-publisher.lock'` in a batch and passes when it runs alone. Without this
 * one such file hides every batch after it.
 *
 * `test_file_timeout` is here too, and that is deliberate: it is the relabel the runner applies when
 * **the supervisor killed the child** for its budget, not a judgement about the code - and a shortened
 * budget is what a batch gets when the suite deadline is near. The two-sided rule still holds: a child
 * whose captured output carries an assertion failure is never retried, so a file that asserted and
 * then hung keeps its own message.
 */
const ENVIRONMENTAL_FAILURE_CAUSES =
  /ECONNRESET|ECONNREFUSED|EPIPE|ETIMEDOUT|EAI_AGAIN|EPERM|EBUSY|test_file_timeout|ERR_[A-Z_]+/u;
const ASSERTION_FAILURE_CAUSES = /AssertionError|ERR_ASSERTION|Expected values to be strictly|not ok \d+/u;

/** Whether a batch failure is the machine's, by the rule above - and never a child that asserted. */
export function isEnvironmentalFailure(error) {
  const text = error instanceof Error ? error.message : String(error);
  return !ASSERTION_FAILURE_CAUSES.test(text) && ENVIRONMENTAL_FAILURE_CAUSES.test(text);
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
  keepGoing = false,
  retryEnvironmental = true,
  run = runDiscoveredTests,
  now = Date.now,
} = {}) {
  if (typeof suite !== "string" || suite.length === 0) throw runnerError("invalid_test_suite", String(suite));
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100) throw runnerError("invalid_test_suite_timeout", String(timeoutMs));
  if (!Number.isSafeInteger(concurrency) || concurrency < 1) throw runnerError("invalid_test_concurrency", String(concurrency));
  if (!Number.isSafeInteger(perFileMs) || perFileMs < 100) throw runnerError("invalid_test_file_timeout", String(perFileMs));
  const batches = chunkTestFiles(paths, batchSize);
  const deadlineMs = now() + timeoutMs;
  const allFailures = [];
  for (const [index, batch] of batches.entries()) {
    const remainingMs = deadlineMs - now();
    if (remainingMs < 100) throw runnerError("test_suite_timeout", suite);
    const batchLabel = `${suite}:batch=${index + 1}/${batches.length}`;
    console.error(`host_test_suite_batch_start:suite=${batchLabel}:files=${batch.length}:paths=${batchFilesForLog(batch)}:remaining_ms=${remainingMs}`);
    const failures = await runBatchFiles({
      batch,
      batchLabel,
      concurrency,
      deadlineMs,
      perFileMs,
      run,
      now,
      suite,
      keepGoing,
      retryEnvironmental,
    });
    if (failures.length === 0) continue;
    allFailures.push(...failures);
    // Without `--keep-going` the first failing batch still ends the run, and it ends it with the
    // child's own error rather than a summary: the message a reader needs is the one the failing
    // test produced, and that is what tonight's earlier fix to this function protects.
    if (!keepGoing) throw failures[0].error;
    console.error(
      `host_test_suite_batch_failed:suite=${batchLabel}:files=${failures
        .map((failure) => relative(hostRoot, failure.path).replaceAll("\\", "/"))
        .join(",")}:keeping_going=true`,
    );
    // The child's own message, for the same reason the single-failure path keeps it: with
    // `--keep-going` the run deliberately continues, so this line is the ONLY place a reader learns
    // why a file failed until the summary - and the summary would carry names but no reasons.
    for (const failure of failures) {
      const message = failure.error instanceof Error ? failure.error.message : String(failure.error);
      const bounded = message.length > 600 ? `${message.slice(0, 600)}…` : message;
      console.error(`host_test_suite_batch_failure:file=${relative(hostRoot, failure.path).replaceAll("\\", "/")}\n${bounded}`);
    }
  }
  if (allFailures.length > 0)
    throw runnerError(
      "test_suite_failed",
      `${allFailures.length} file(s): ${allFailures
        .map((failure) => relative(hostRoot, failure.path).replaceAll("\\", "/"))
        .join(", ")}`,
    );
}

/**
 * Fail fast unless `dist-test` is the complete, current artifact the builder published.
 *
 * The inventory check runs first on purpose: a half-written tree otherwise reports
 * as unrelated `ERR_MODULE_NOT_FOUND` failures that finish in tens of milliseconds,
 * which is the failure that was twice misread as a product defect. It is deliberately
 * light (counts and paths, no digests) and honest about absence: an artifact built
 * before the inventory existed warns once and still runs.
 *
 * The freshness check runs next, and before the verification manifest, for the same reason in
 * the other direction: a COMPLETE artifact is not a CURRENT one, and the manifest proves
 * currency only by hashing the whole source and dependency trees (measured: 13.4s) and then
 * reporting a bare mismatch with no path and no remedy. One walk of `stat` calls names the
 * source that is newer than the build and the command that fixes it, so the cheap, actionable
 * answer comes first.
 */
export async function preflightTestArtifact({
  root = hostRoot,
  outputRoot = resolve(root, "dist-test"),
  sourceRoot = resolve(hostRoot, "src"),
} = {}) {
  const inventory = await assertTestArtifactInventory({ outputRoot });
  const freshness = await assertTestArtifactFreshness({ outputRoot, sourceRoot });
  if (inventory.status === "absent")
    console.error("host_test_artifact_inventory_absent:no test-artifact inventory was recorded; run `pnpm build:test` to record one");
  else if (freshness.status === "unrecorded")
    console.error("host_test_artifact_freshness_unrecorded:this inventory records no source stamp, so whether the artifact is stale can only be settled by its content digest; run `pnpm build:test` to record one");
  await assertHostVerificationArtifactManifest({ root, outputRoot });
}

export async function runCompiledTests({
  batchSize = configuredBatchSize(process.env.GAMEBUDDY_HOST_TEST_COMPILED_BATCH_SIZE),
  concurrency = configuredConcurrency(process.env.GAMEBUDDY_HOST_TEST_COMPILED_CONCURRENCY),
  perFileMs = configuredCount(
    process.env.GAMEBUDDY_HOST_TEST_COMPILED_FILE_TIMEOUT_MS,
    DEFAULT_TEST_FILE_TIMEOUT_MS,
    "invalid_test_file_timeout",
  ),
  // `--keep-going` runs every batch and reports every failing file instead of stopping at the first
  // failing batch. The default stays as it was: nothing here becomes lax by accident.
  keepGoing = process.argv.includes("--keep-going"),
} = {}) {
  if (!Number.isSafeInteger(batchSize) || batchSize < 1) throw runnerError("invalid_test_batch_size", String(batchSize));
  if (!Number.isSafeInteger(concurrency) || concurrency < 1) throw runnerError("invalid_test_concurrency", String(concurrency));
  // Validated here, beside the other two knobs, so a bad value fails before this function
  // touches the artifact manifest or discovers files - a knob that is off must not cost a build.
  if (!Number.isSafeInteger(perFileMs) || perFileMs < 100)
    throw runnerError("invalid_test_file_timeout", String(perFileMs));
  await preflightTestArtifact();
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
    keepGoing,
  });
}

export async function runScriptTests({
  // Same knob as the compiled phase: `--keep-going` collects every failing script file instead of
  // stopping at the first one. It was missing here, which is why the first run that ever reached this
  // phase reported one file and abandoned the other three batches.
  keepGoing = process.argv.includes("--keep-going"),
} = {}) {
  // Script tests run after the artifact lock is released. Some of them
  // intentionally invoke public package scripts to verify lock contention, and
  // one of them removes dist-test on purpose; overlapping those would create
  // the contention they are asserting about, so they stay serialized.
  return await runTestBatches(await discoverTestFiles(defaultScriptTestRoot, ".test.mjs"), {
    suite: "scripts",
    concurrency: 1,
    keepGoing,
  });
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
