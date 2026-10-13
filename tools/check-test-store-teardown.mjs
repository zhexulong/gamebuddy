#!/usr/bin/env node
/**
 * Gate for "a test opened a file-handle resource and never closed it".
 *
 * The incident: every test in `host/src/tavern/chat-thread-store.presentation.test.ts` opened its
 * own chat-thread store and none of them was ever closed. `removeTestRoot` then called a recursive
 * `fs.rm` on a directory holding the live continuity SQLite files (`tavern.sqlite`, `-wal`, `-shm`),
 * and on Windows that `rm` neither failed nor resolved: it sat pending for 12 s, then 60 s+, while
 * `node:test` waited for the first test to finish. The runner printed `TAP version 13` and hung for
 * four minutes with no result line at all - a cleanup slip that reads as a hung test runner. That
 * file now opens every store through one `openStore()` helper that registers it, and closes them all
 * before the root is deleted: 11 tests, 11 pass.
 *
 * The class is "a test owns a resource that holds a file handle". What makes that decidable without
 * a hand-written list of constructors is that the set of *openers* is derived:
 *
 *   - a production module that constructs a file-backed SQLite handle (`new DatabaseSync(<path>)`,
 *     never `:memory:`) contributes its exported declarations that contain that construction -
 *     today `createChatThreadStore` (tavern/chat-thread-store.ts) and `openProductionContinuityStore`
 *     (continuity-semantic-store/continuity-semantic-production-store.ts). A third store module is
 *     covered the day it lands, with no gate change;
 *   - a `*.test.ts` that opens the SQLite file itself (`new DatabaseSync(path)`) is counted the same
 *     way.
 *
 * The rule is a per-file ratchet: the baseline records how many store-opening lines each committed
 * test file has today, a file may not exceed its recorded count, and a file with no baseline entry
 * has an allowance of zero. So a new test cannot open a store at all until someone records the
 * opening deliberately - which is the point: an opener belongs either in a registered helper (and
 * the recording names it) or in a `*.test-support.ts` module, which is out of scope because owning
 * a registry is the *fix*, not the defect.
 *
 * The one exemption, and it is the false-positive boundary: a construction inside an argument to
 * `assert.throws(...)` / `assert.rejects(...)` is not counted. The construction is expected to
 * throw - `assert.throws(() => openProductionContinuityStore({ runtimeRoot: root }),
 * /unsupported_production_store_schema/)` - so no handle escapes to be closed. That is the only
 * shape where constructing a store inside a test is right; anything else must be registered.
 *
 * What it deliberately does not claim:
 *
 *   - The count is per file, not per handle. A file whose recorded count is higher than one may add
 *     another store without a baseline change as long as it stays under the number, and a file that
 *     already closes what it opens is not proven to close the *next* one. Matching each handle to
 *     its close site needs dataflow analysis, and its false findings are what gets a gate deleted;
 *     this one is a ratchet on the class, and it stops the class from growing.
 *   - The recorded counts include the files that leak today. This gate does not fix them: each of
 *     those test files belongs to another change, and a rule that is red on arrival for twenty-five
 *     files gets turned off. Growth is what fails, reductions are free.
 *   - A construction site is one source *line*, so two openings written on one line count once (the
 *     incident file's ternary is one line and one registered helper). Under-counting by formatting
 *     is deliberate; over-counting would churn on a reflow.
 *   - The derivation needs the construction to sit inside an exported `function`/`const` declaration
 *     whose body brace follows its parameter list. A store opened by some other shape is not derived
 *     - the gate's suite asserts the derived set for this tree, so a widening is visible.
 *   - Uncommitted test files are skipped: a lane's in-flight file is not a landed one, and several
 *     lanes work in one worktree. `--include-dirty` runs the raw predicate, which is what CI sees.
 *
 * Usage:
 *   node tools/check-test-store-teardown.mjs                   # ratchet
 *   node tools/check-test-store-teardown.mjs --update           # re-record, in its own commit
 *   node tools/check-test-store-teardown.mjs --include-dirty    # raw predicate (what CI runs)
 *   node tools/check-test-store-teardown.mjs <scopeDir> [--baseline <file>]
 *     Both are for the gate's own test: a throwaway scope with a planted construction, and the
 *     baseline it is compared against.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { isProductionSource, isTestSource, listSources, sourcePath } from "./lib/host-production-sources.mjs";

const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const HOST_SOURCE = join(REPOSITORY_ROOT, "host", "src");
const BASELINE_PATH = join(REPOSITORY_ROOT, "tools", "test-store-teardown-baseline.json");

/** A SQLite handle on a real file; `:memory:` holds no file handle to leak. */
const FILE_BACKED_CONSTRUCTION = "new\\s+DatabaseSync\\s*\\(\\s*(?![\"'`]:memory:)";
/** Exported `function`/`const` declarations, whose text is searched for the construction. */
const EXPORTED_DECLARATION =
  /\bexport\s+(?:async\s+)?(?:function\s+([A-Za-z_$][\w$]*)|const\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:function\b|\(|[A-Za-z_$][\w$]*\s*=>))/gu;
/** A construction whose throw is the assertion: no handle escapes, so it is not an opening. */
const THROW_ASSERTION = /\bassert\.(?:throws|rejects)\s*\(/gu;
const CLOSE_SITE = /\.close\s*\??\.?\s*\(/gu;

/** The index of the closer matching the opener at `open`, or `text.length`. */
function matchingIndex(text, open, opener, closer) {
  let depth = 0;
  for (let index = open; index < text.length; index += 1) {
    const character = text[index];
    if (character === opener) depth += 1;
    else if (character === closer && --depth === 0) return index;
  }
  return text.length;
}

/**
 * The body of a declaration, from its opening brace to the matching close. The brace is found by
 * taking the first `{` after the parameter list whose match ends the line - a return-type literal
 * such as `Readonly<{ ... }>` closes into `>` and is skipped.
 */
function declarationSpan(text, start) {
  const paren = text.indexOf("(", start);
  if (paren < 0 || paren - start > 2000) return text.slice(start, start + 2000);
  const parametersEnd = matchingIndex(text, paren, "(", ")");
  for (let brace = text.indexOf("{", parametersEnd); brace >= 0 && brace < text.length; brace = text.indexOf("{", brace + 1)) {
    const end = matchingIndex(text, brace, "{", "}");
    if (/^[ \t]*\r?\n/u.test(text.slice(end + 1, end + 6))) return text.slice(start, end + 1);
  }
  return text.slice(start, start + 2000);
}

/** A 1-based line number for a character offset. */
function lineOf(text, offset) {
  let line = 1;
  for (let index = 0; index < offset; index += 1) if (text[index] === "\n") line += 1;
  return line;
}

/**
 * The store openers of a production tree: `module -> exported declaration names` that contain a
 * file-backed SQLite construction, plus the union of those names.
 */
export function deriveStoreOpeners(root) {
  const construction = new RegExp(FILE_BACKED_CONSTRUCTION, "u");
  const modules = new Map();
  const names = new Set();
  for (const file of listSources(root)) {
    const rel = sourcePath(root, file);
    if (!isProductionSource(rel)) continue;
    const text = readFileSync(file, "utf8");
    if (!construction.test(text)) continue;
    const found = [];
    EXPORTED_DECLARATION.lastIndex = 0;
    for (let match = EXPORTED_DECLARATION.exec(text); match !== null; match = EXPORTED_DECLARATION.exec(text)) {
      if (!construction.test(declarationSpan(text, match.index))) continue;
      const name = match[1] ?? match[2];
      found.push(name);
      names.add(name);
    }
    if (found.length > 0) modules.set(rel, found);
  }
  return { modules, names };
}

/** The line numbers of every `.close(...)` call site in a source, for the reader's context. */
export function closeLines(text) {
  const lines = [];
  CLOSE_SITE.lastIndex = 0;
  for (let match = CLOSE_SITE.exec(text); match !== null; match = CLOSE_SITE.exec(text)) lines.push(lineOf(text, match.index));
  return lines;
}

/** Character offsets that lie inside an `assert.throws(...)` / `assert.rejects(...)` argument. */
function throwAssertionRanges(text) {
  const ranges = [];
  THROW_ASSERTION.lastIndex = 0;
  for (let match = THROW_ASSERTION.exec(text); match !== null; match = THROW_ASSERTION.exec(text)) {
    const open = text.indexOf("(", match.index);
    ranges.push([open, matchingIndex(text, open, "(", ")")]);
  }
  return ranges;
}

/** The 1-based lines of a source that open a store, excluding asserted throws. */
export function openingLines(text, openers) {
  const construction = new RegExp(FILE_BACKED_CONSTRUCTION, "gu");
  const patterns = [construction];
  if (openers.length > 0) patterns.unshift(new RegExp(`\\b(?:${[...openers].sort().join("|")})\\s*\\(`, "gu"));
  const ranges = throwAssertionRanges(text);
  const offsets = new Set();
  for (const pattern of patterns)
    for (let match = pattern.exec(text); match !== null; match = pattern.exec(text)) offsets.add(match.index);
  return [...offsets]
    .filter((offset) => !ranges.some(([start, end]) => offset > start && offset < end))
    .map((offset) => lineOf(text, offset))
    .filter((line, index, lines) => lines.indexOf(line) === index)
    .sort((left, right) => left - right);
}

/** Every test file's store-opening lines, keyed by source-relative path. */
export function inspect({ root = HOST_SOURCE, uncommitted = new Set() } = {}) {
  const { modules, names } = deriveStoreOpeners(root);
  const openers = [...names].sort();
  const openings = {};
  const closes = {};
  for (const file of listSources(root)) {
    const rel = sourcePath(root, file);
    if (!isTestSource(rel) || uncommitted.has(rel)) continue;
    const text = readFileSync(file, "utf8");
    const lines = openingLines(text, openers);
    if (lines.length === 0) continue;
    openings[rel] = lines;
    closes[rel] = closeLines(text).length;
  }
  return { modules, openers, openings, closes };
}

/** The files whose store-opening line count grew past the recorded one. */
export function ratchet({ baseline, openings }) {
  return Object.keys(openings)
    .filter((file) => openings[file].length > (baseline.openings[file] ?? 0))
    .sort();
}

/** `host/src`-relative paths of every file git reports as changed or untracked. */
export function uncommittedSources({ repo = REPOSITORY_ROOT } = {}) {
  const status = execFileSync("git", ["status", "--porcelain", "--untracked-files=all"], {
    cwd: repo,
    encoding: "utf8",
    windowsHide: true,
  });
  const files = new Set();
  for (const line of status.split(/\r?\n/u)) {
    if (line.length < 4) continue;
    let path = line.slice(3).trim();
    const arrow = path.indexOf(" -> ");
    if (arrow >= 0) path = path.slice(arrow + 4);
    path = path.replace(/^"|"$/gu, "").replace(/\\/gu, "/");
    if (path.startsWith("host/src/")) files.add(path.slice("host/src/".length));
  }
  return files;
}

function parseArguments(argv) {
  let scope;
  let baselinePath = BASELINE_PATH;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--baseline") {
      baselinePath = resolve(argv[++index]);
      continue;
    }
    if (argument.startsWith("--")) continue;
    scope ??= resolve(argument);
  }
  return { root: scope ?? HOST_SOURCE, baselinePath };
}

function counts(entries) {
  const result = {};
  for (const [file, lines] of Object.entries(entries)) result[file] = lines.length;
  return result;
}

function main(argv) {
  const update = argv.includes("--update");
  const includeDirty = update || argv.includes("--include-dirty");
  const { root, baselinePath } = parseArguments(argv);
  const uncommitted = includeDirty ? new Set() : uncommittedSources();
  const { modules, openers, openings, closes } = inspect({ root, uncommitted });

  process.stdout.write(`test_store_teardown_openers=${openers.length} ${openers.join(",")}\n`);
  for (const [module, names] of modules) process.stdout.write(`  ${module}: ${names.join(", ")}\n`);

  if (update) {
    const baseline = {
      note: "Store-opening source lines per committed host/src test file. Update deliberately, in its own commit; a file with no entry has an allowance of zero.",
      revision: execFileSync("git", ["rev-parse", "--short", "HEAD"], {
        cwd: REPOSITORY_ROOT,
        encoding: "utf8",
        windowsHide: true,
      }).trim(),
      files: Object.keys(openings).length,
      openings: counts(openings),
    };
    writeFileSync(baselinePath, `${JSON.stringify(baseline, null, 2)}\n`);
    process.stdout.write(`test_store_teardown_recorded files=${baseline.files} revision=${baseline.revision}\n`);
    return 0;
  }

  const baseline = JSON.parse(readFileSync(baselinePath, "utf8"));
  const grew = ratchet({ baseline, openings });
  if (grew.length === 0) {
    process.stdout.write(`test_store_teardown_ok files=${Object.keys(openings).length}\n`);
    return 0;
  }
  process.stdout.write(`test_store_teardown_failed new=${grew.length}\n`);
  for (const file of grew)
    process.stdout.write(
      `  ${file}: ${baseline.openings[file] ?? 0} -> ${openings[file].length} store-opening line(s), at ${openings[file].join(",")} (${closes[file]} close site(s) in the file)\n`,
    );
  process.stdout.write(
    "a test that opens a store must register it for teardown: open every handle through one helper that closes them all before the test root is removed, keep that helper outside *.test.ts when it is shared, or record the opening deliberately with: node tools/check-test-store-teardown.mjs --update\n",
  );
  return 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 2;
  }
}
