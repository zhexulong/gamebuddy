#!/usr/bin/env node
/**
 * Aggregate entry point for the `tools/**` suite corpus.
 *
 * Every root `test:*` script that runs `node --test` over files under `tools/`
 * and is invoked by no other entry point lands here. That corpus is large (67
 * scripts, 72 files, ~600 tests) and, before this step, no CI job ran a single
 * one of them, so a suite could rot - or be deleted - without anything noticing.
 *
 * The corpus is DERIVED from package.json on every run, never pinned: a new
 * `test:` script over a `tools/` suite is wired in by existing. Scripts that
 * another entry point already runs (`ci.yml`, `release-windows.yml`,
 * `quality:check`, `test`, `test:all`, `test:dialogue-web`, `typecheck`) are not
 * this step's business, and neither are the `integrations/stardew/action-development`
 * suites, which `ci.yml`'s stardew-scaffold job runs through its own package.
 *
 * Suites that already need an environment prerequisite skip themselves with a
 * named reason (`{ skip }` on the test). A suite that is red for an attributed
 * reason stays out of the run through `tool-test-corpus-quarantine.json`; that
 * file is a list of defects with owners, not a mute button, so each entry must
 * name a corpus file and must still fail on its own. An entry that starts
 * passing fails this step until someone deletes it.
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PER_TEST_TIMEOUT = "--test-timeout=120000";
const CORPUS_TIMEOUT_MS = 15 * 60_000;
const QUARANTINE_PATH = "tools/tool-test-corpus-quarantine.json";
const ENTRY_POINT_FILES = Object.freeze([".github/workflows/ci.yml", ".github/workflows/release-windows.yml"]);

function readIfPresent(relative) {
  try {
    return readFileSync(resolve(ROOT, relative), "utf8");
  } catch {
    return "";
  }
}

function invokedByAnEntryPoint(scriptName, entryPointBlob) {
  const escaped = scriptName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^\\w:-])${escaped}([^\\w:-]|$)`).test(entryPointBlob);
}

/** The `test:*` scripts that reach a `tools/` suite and that nothing else runs. */
function corpusFiles() {
  const pkg = JSON.parse(readFileSync(resolve(ROOT, "package.json"), "utf8"));
  const entryPoints = [
    ...ENTRY_POINT_FILES.map(readIfPresent),
    pkg.scripts["quality:check"],
    pkg.scripts.test,
    pkg.scripts["test:all"],
    pkg.scripts["test:dialogue-web"],
    pkg.scripts.typecheck,
  ].join("\n");
  const files = new Set();
  for (const [name, command] of Object.entries(pkg.scripts)) {
    if (!name.startsWith("test:")) continue;
    const match = /^node --test (.+)$/.exec(command);
    if (!match) continue;
    const paths = match[1].trim().split(/\s+/);
    if (!paths.every((path) => path.startsWith("tools/"))) continue;
    if (invokedByAnEntryPoint(name, entryPoints)) continue;
    for (const path of paths) files.add(path);
  }
  return [...files].sort();
}

/** Run `node --test` over `files`; returns the exit status (null if it was killed). */
function runTests(files, stdio) {
  return spawnSync(process.execPath, ["--test", PER_TEST_TIMEOUT, ...files], {
    cwd: ROOT,
    stdio,
    timeout: CORPUS_TIMEOUT_MS,
  }).status;
}

function main() {
  const quarantine = JSON.parse(readFileSync(resolve(ROOT, QUARANTINE_PATH), "utf8")).exclusions;
  const corpus = corpusFiles();
  const quarantined = new Set(quarantine.map((entry) => entry.file));
  const unknown = quarantine.filter((entry) => !corpus.includes(entry.file));
  const runnable = corpus.filter((file) => !quarantined.has(file));
  process.stderr.write(`tool_test_corpus suites=${runnable.length} quarantined=${quarantine.length}\n`);
  const corpusStatus = runTests(runnable, "inherit");
  // The quarantine may only hold defects that are still there: run each excluded
  // suite alone and refuse the step if one has gone green.
  const stale = quarantine.filter((entry) => runTests([entry.file], "pipe") === 0);
  if (unknown.length > 0) {
    process.stderr.write(`tool_test_corpus_quarantine_unknown_file:${unknown.map((entry) => entry.file).join(",")}\n`);
  }
  for (const entry of stale) {
    process.stderr.write(
      `tool_test_corpus_quarantine_stale:${entry.file} passes now; delete it from ${QUARANTINE_PATH}\n`,
    );
  }
  return corpusStatus === 0 && unknown.length === 0 && stale.length === 0 ? 0 : 1;
}

process.exitCode = main();
