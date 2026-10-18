#!/usr/bin/env node
/**
 * Every compiled host test file, one bounded process each - the question the suite cannot answer.
 *
 * `run-test-suite.mjs` runs files in batches and **stops at the first failing batch**, so a single
 * failure hides every batch after it. On this machine that costs real information: the suite once
 * reported `[TypeError: fetch failed] { cause: ECONNRESET }` for a file that passes 10/10 on its own,
 * which stopped a run at batch 12 of 25 and said nothing about batches 13-25.
 *
 * This asks the other question: **which files fail when they have the machine to themselves.** A file
 * that fails here is a file to fix; a file that only fails inside a batch is a machine to look at.
 *
 *   node host/scripts/sweep-compiled-tests.mjs                 # every compiled test file
 *   node host/scripts/sweep-compiled-tests.mjs --file bound    # only paths containing "bound"
 *   node host/scripts/sweep-compiled-tests.mjs --concurrency 3 --timeout-ms 300000
 *
 * It discovers its file list through the runner's own `discoverTestFiles` and runs each file through
 * the runner's own `runDiscoveredTests` (absolute `file://` bootstrap, Host cwd, bounded child), so
 * there is one authority for "what the compiled tests are" and one for "how one is run".
 */
import { relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  DEFAULT_TEST_FILE_TIMEOUT_MS,
  discoverTestFiles,
  hostRoot,
  machineDefaultConcurrency,
  preflightTestArtifact,
  runDiscoveredTests,
} from "./run-tests.mjs";
import { resolve as resolvePath } from "node:path";

/** Causes the suite reports for a child that died of transport or budget, not of an assertion. */
const ENVIRONMENTAL_CAUSES = /ECONNRESET|ECONNREFUSED|EPIPE|ETIMEDOUT|ERR_[A-Z_]+|test_file_timeout/u;
/** A failure the code itself produced. If the output has one of these, the file is not "environmental". */
const ASSERTION_CAUSES = /AssertionError|ERR_ASSERTION|Expected values to be strictly equal|not ok \d+/u;

function usage() {
  return "usage: node host/scripts/sweep-compiled-tests.mjs [--phase compiled|scripts|all] [--concurrency N] [--timeout-ms N] [--file <substring>] [--verbose]";
}

function parseArguments(argv) {
  const options = {
    concurrency: machineDefaultConcurrency(),
    timeoutMs: DEFAULT_TEST_FILE_TIMEOUT_MS,
    phase: "all",
    filter: undefined,
    verbose: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (flag === "--phase") {
      options.phase = value;
      index += 1;
    } else if (flag === "--concurrency") {
      options.concurrency = Number(value);
      index += 1;
    } else if (flag === "--timeout-ms") {
      options.timeoutMs = Number(value);
      index += 1;
    } else if (flag === "--file") {
      options.filter = value;
      index += 1;
    } else if (flag === "--verbose") {
      options.verbose = true;
    } else {
      throw new Error(`unknown argument ${flag}: ${usage()}`);
    }
  }
  if (!Number.isSafeInteger(options.concurrency) || options.concurrency < 1)
    throw new Error(`invalid_concurrency: ${usage()}`);
  if (!["all", "compiled", "scripts"].includes(options.phase))
    throw new Error(`invalid_phase: ${usage()}`);
  if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1000)
    throw new Error(`invalid_timeout_ms: ${usage()}`);
  return options;
}

/**
 * What one child said, as the sweep reports it.
 *
 * The failure names come from node's own `✖` lines and are deduplicated: a failing test is printed
 * once in the progress list and once under `✖ failing tests:`, and reporting it twice reads as two
 * problems. The cause line is the first line that looks like a reason, so a reader sees why without
 * opening the log.
 */
export function summarizeChildOutput(output) {
  const lines = output.split(/\r?\n/);
  const names = [];
  for (const line of lines) {
    const match = /^✖\s+(.*)$/u.exec(line.trim());
    if (match === null) continue;
    // node prints the duration beside the name (`✖ drops the bound (2ms)`); the name is the fact.
    const name = match[1].trim().replace(/\s+\(\d+(?:\.\d+)?ms\)$/u, "");
    if (name === "failing tests:" || name.length === 0) continue;
    if (!names.includes(name)) names.push(name);
  }
  const tally = {};
  for (const line of lines) {
    const match = /^ℹ (tests|pass|fail|cancelled|skipped) (\d+)$/u.exec(line.trim());
    if (match !== null) tally[match[1]] = Number(match[2]);
  }
  const causeLine =
    lines.find((line) => ASSERTION_CAUSES.test(line)) ??
    lines.find((line) => ENVIRONMENTAL_CAUSES.test(line)) ??
    lines.find((line) => /Error/u.test(line)) ??
    "";
  return {
    names,
    tally,
    cause: causeLine.trim().slice(0, 200),
    asserted: ASSERTION_CAUSES.test(output),
    environmental: !ASSERTION_CAUSES.test(output) && ENVIRONMENTAL_CAUSES.test(output),
  };
}

/**
 * The two phases the suite runs, discovered the way each phase discovers them: compiled files under
 * `dist-test`, script files under `scripts/`. `--phase` picks one; the default is both, because a
 * sweep that silently covers half the tree is the failure mode this tool exists to remove.
 */
async function discoveredFilesFor(phase) {
  if (phase === "compiled") return await discoverTestFiles(undefined, ".test.js");
  if (phase === "scripts") return await discoverTestFiles(resolvePath(hostRoot, "scripts"), ".test.mjs");
  return [
    ...(await discoveredFilesFor("compiled")),
    ...(await discoveredFilesFor("scripts")),
  ];
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  // The artifact preflight is the runner's: a sweep of a half-built tree would report the missing
  // modules as failures in whichever files happened to need them.
  await preflightTestArtifact();
  const discovered = await discoveredFilesFor(options.phase);
  const files = options.filter === undefined ? discovered : discovered.filter((file) => file.includes(options.filter));
  if (files.length === 0) throw new Error(`no compiled test file matched: ${options.filter ?? "(all)"}`);

  console.log(
    `host_test_sweep_start:phase=${options.phase}:files=${files.length}:concurrency=${options.concurrency}:timeout_ms=${options.timeoutMs}`,
  );
  const failures = [];
  const slow = [];
  let cursor = 0;
  let completed = 0;

  const runOne = async (file) => {
    const label = relative(hostRoot, file).replaceAll("\\", "/");
    const startedAt = Date.now();
    const result = await runDiscoveredTests([file], { timeoutMs: options.timeoutMs });
    const elapsedMs = Date.now() - startedAt;
    const summary = summarizeChildOutput(result.output ?? "");
    if (elapsedMs > 60_000) slow.push({ label, elapsedMs });
    completed += 1;
    if (result.code !== 0) {
      failures.push({ label, elapsedMs, signal: result.signal, ...summary });
      const tally = Object.entries(summary.tally)
        .map(([key, value]) => `${key} ${value}`)
        .join(" · ");
      console.error(`host_test_sweep_file_failed:${label}:ms=${elapsedMs}:${tally}`);
      for (const name of summary.names) console.error(`    ✖ ${name}`);
      if (summary.cause.length > 0) console.error(`    ${summary.cause}`);
    } else if (options.verbose) {
      console.log(`ok ${label} (${elapsedMs}ms)`);
    }
  };

  const worker = async () => {
    while (cursor < files.length) {
      const file = files[cursor];
      cursor += 1;
      await runOne(file);
    }
  };
  await Promise.all(Array.from({ length: Math.min(options.concurrency, files.length) }, () => worker()));

  for (const item of slow) console.log(`host_test_sweep_slow:${item.label}:ms=${item.elapsedMs}`);
  const assertedFailures = failures.filter((failure) => failure.asserted);
  const environmentalFailures = failures.filter((failure) => !failure.asserted && failure.environmental);
  const otherFailures = failures.filter((failure) => !failure.asserted && !failure.environmental);
  console.log(
    `host_test_sweep_done:files=${files.length}:completed=${completed}:failed=${failures.length}:` +
      `asserted=${assertedFailures.length}:environmental=${environmentalFailures.length}:other=${otherFailures.length}`,
  );
  for (const failure of environmentalFailures)
    console.log(`  environmental (a file that fails alone is not the same as one that fails in a batch): ${failure.label}`);
  for (const failure of otherFailures) console.log(`  failed without an assertion or a known cause: ${failure.label}`);
  if (failures.length > 0) console.log("summary: rerun a failing file alone with `node --import <abs bootstrap> --test <file>`");
  process.exitCode = failures.length === 0 ? 0 : 1;
}

/**
 * Only the entry point sweeps; the module is imported by its own test, which must not run 120
 * children just by importing `summarizeChildOutput`.
 */
const invokedDirectly =
  process.argv[1] !== undefined && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;

if (invokedDirectly) {
  await main();
}
