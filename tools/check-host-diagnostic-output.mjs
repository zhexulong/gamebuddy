#!/usr/bin/env node
/**
 * Gate for "a live-run debug print shipped in production code".
 *
 * The incident: commit 77bd0a6a added 19 `process.stderr.write("[DEBUG-chat-live-p4c] ...")`
 * narration sites to `host/src/tavern/p4-provider-start-execution.ts` and
 * `host/src/tavern/chat-pipeline-service.ts`. They were instrumentation for somebody's live
 * run, never removed, and they shipped: a later lane saw `[DEBUG-chat-live-p4c]` on a real
 * child's stderr, could not tell whether it came from its own work or from the product, and had
 * to read the file to find out. The markers were also unbounded in count and shape - one per
 * phase of the P4c start, plus `native_rejected_${reason}` - so a reader learns nothing they
 * could not have learned from the durable ledger, and an operator learns nothing at all.
 *
 * That is different from a bounded operational record, which the product genuinely needs:
 *
 *   `[memory] read failed: ${boundedReason(error)}`  (tavern/memory-management/memory-management.ts)
 *
 * says *which* store operation failed, with a bounded reason and no stack or content, on the one
 * process whose log an operator reads. A print like that is kept and is in the recorded set
 * below. What is gated is the class, not that judgement call. The whole surviving set, and why
 * each one is a record rather than narration:
 *
 *   bootstrap/entry/desktop-host-entry.internal.ts:29  a bounded failure code for a boot that ends
 *   continuity-semantic-...-construction.internal.ts:388  a world-book entry is omitted because a
 *     macro cannot resolve: a content gap the player would otherwise see as a contradiction
 *   host-service.ts:811                                a bounded native-ingress phase, no identifier,
 *     prompt or model output
 *   main.ts:51                                         one line when dead-owner recovery completed
 *   runtime-core.internal.ts:114/122/1467/1477          the historian's fixture fold channel and
 *     a missing/refused embedded historian binding, both otherwise silent gaps
 *   stardew-integration-launcher-body-program.internal.ts:191/237  the same native-ingress phase
 *   tavern/chat-pipeline-service.ts:578                which store operation failed, message only,
 *     sliced to 200 characters, no stack or content
 *   tavern/memory-management/memory-management.ts:340/348  the shape above
 *
 * Two real sinks are deliberately outside both arms because their first argument is not text:
 * `bootstrap/wire/desktop-runtime-bootstrap.internal.ts` writes child-stdin bytes, and
 * `farmhand-companion-preview.ts` writes the exported readiness marker a supervisor waits on.
 *
 * There are two arms, because "the print is diagnostic rather than operational" is not decidable
 * from the syntax alone, and a rule that guesses gets deleted:
 *
 *   Arm A - a self-declared diagnostic marker in the message text (`DEBUG`, `XDEBUG`, `TRACE`,
 *     `DBG`, as a whole word) is a hard failure with no baseline and no escape hatch. A message
 *     that calls itself debug output is debug output. This arm needs no list to rot; a message
 *     that merely *discusses* those words has to be reworded.
 *
 *   Arm B - a per-file ratchet over every diagnostic print *site*: `console.log/error/warn/info/
 *     debug/trace(...)` and `process.stderr|stdout.write(...)` whose first argument is text (a
 *     string or template literal). The baseline records the committed count per file, so adding
 *     narration to a production file is a deliberate act that updates the baseline in the same
 *     change, and removing it never fails. This catches the unmarked half of the same class,
 *     which Arm A cannot see.
 *
 * What it deliberately does not claim:
 *
 *   - A print whose first argument is an identifier (`process.stdout.write(bytes, cb)` - the
 *     bootstrap's child-stdin channel) is not text and is not counted. A debug message routed
 *     through a helper variable is therefore invisible here; it is also invisible to a reader,
 *     which is why the two arms above are aimed at the literal forms that were actually used.
 *   - Comments are not stripped: a commented-out print is still a site, and a commented-out
 *     `[DEBUG]` is still reported. Dead code belongs removed rather than hidden from the gate,
 *     which is also why removing narration from the tree is the only way to lower the baseline.
 *   - Uncommitted files are not inspected at all - neither arm. Several lanes work in one
 *     worktree; a lane's in-flight print is not a shipped print, and a gate that fires on it is a
 *     gate that gets deleted. On a clean checkout there is nothing to exclude, which is what CI and
 *     `--include-dirty` see.
 *   - Test and fixture sources are out of scope by construction: the file set comes from
 *     `tools/lib/host-production-sources.mjs`, which mirrors `host/tsconfig.json`'s production
 *     includes, so a `*.test.ts`, a `test-fixtures/**` helper or a `*fixture-worker.ts` child
 *     double may print whatever a test needs.
 *
 * Usage:
 *   node tools/check-host-diagnostic-output.mjs                 # both arms
 *   node tools/check-host-diagnostic-output.mjs --update        # re-record Arm B, in its own commit
 *   node tools/check-host-diagnostic-output.mjs --include-dirty  # raw Arm B predicate (what CI runs)
 *   node tools/check-host-diagnostic-output.mjs <scopeDir> [--baseline <file>]
 *     Both are for the gate's own test: a throwaway scope with a planted violation, and the
 *     baseline it is compared against.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { isProductionSource, listSources, sourcePath } from "./lib/host-production-sources.mjs";

const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const HOST_SOURCE = join(REPOSITORY_ROOT, "host", "src");
const BASELINE_PATH = join(REPOSITORY_ROOT, "tools", "host-diagnostic-output-baseline.json");

/** A message that declares itself debug/trace output. Whole words only, case-insensitive. */
export const MARKER = /\b(?:DEBUG|XDEBUG|TRACE|DBG)\b/iu;
/** `console.<level>(` and `process.<stream>.write(` - the two text sinks this gate knows. */
const PRINT_CALL = /(?:console\.(?:log|error|warn|info|debug|trace)|process\.(?:stderr|stdout)\.write)\s*\(/gu;
const TEXT_ARGUMENT = /[`"']/u;
const CLOSERS = { "`": "`", '"': '"', "'": "'" };

/**
 * Production sources, mirroring `host/tsconfig.json`'s production includes: tests, test support,
 * fixtures and fixture workers are not shipped, so their prints are not the product's.
 */
export { isProductionSource };

/** The line number of a character offset, for a 0-based offset into `text`. */
function lineOf(text, offset) {
  let line = 1;
  for (let index = 0; index < offset; index += 1) if (text[index] === "\n") line += 1;
  return line;
}

/**
 * The literal text of a text-first print call starting at `open`, or `undefined` when the first
 * argument is not text. Skips only whitespace between the parenthesis and the literal.
 */
function literalAt(text, open) {
  let index = open;
  while (index < text.length && /\s/u.test(text[index])) index += 1;
  const quote = text[index];
  if (quote === undefined || !TEXT_ARGUMENT.test(quote)) return undefined;
  const closer = CLOSERS[quote];
  let literal = "";
  for (index += 1; index < text.length; index += 1) {
    const character = text[index];
    if (character === "\\") {
      // An escape is kept verbatim: the report quotes the source text, so the reader sees the
      // literal that is in the file rather than a decoded approximation of it.
      literal += character + (text[index + 1] ?? "");
      index += 1;
      continue;
    }
    if (character === closer) return literal;
    if (character === "\n" && closer !== "`") return undefined;
    literal += character;
  }
  return undefined;
}

/**
 * Every diagnostic print site in a production file: `{ line, literal }` for each call whose first
 * argument is text. A file that is not production source yields nothing.
 */
export function diagnosticPrints(relativePath, text) {
  if (!isProductionSource(relativePath)) return [];
  const sites = [];
  PRINT_CALL.lastIndex = 0;
  for (let match = PRINT_CALL.exec(text); match !== null; match = PRINT_CALL.exec(text)) {
    const literal = literalAt(text, PRINT_CALL.lastIndex);
    if (literal === undefined) continue;
    sites.push({ line: lineOf(text, match.index), literal });
  }
  return sites;
}

/**
 * Both arms over a tree: marker violations from Arm A and the per-file counts Arm B ratchets.
 * `uncommitted` optionally names files (source-relative, forward slashes) that are skipped by both
 * arms while a lane is still editing them.
 */
export function inspect({ root = HOST_SOURCE, uncommitted = new Set() } = {}) {
  const violations = [];
  const counts = {};
  for (const file of listSources(root)) {
    const rel = sourcePath(root, file);
    if (!isProductionSource(rel)) continue;
    if (uncommitted.has(rel)) continue;
    const sites = diagnosticPrints(rel, readFileSync(file, "utf8"));
    if (sites.length === 0) continue;
    counts[rel] = sites.length;
    for (const site of sites)
      if (MARKER.test(site.literal))
        violations.push({
          file: rel,
          line: site.line,
          form: "debug_marker",
          literal: site.literal.replace(/\s+/gu, " ").trim().slice(0, 120),
        });
  }
  return { violations, counts };
}

/** `host/`-relative paths of every file git reports as changed or untracked, as `src/...`. */
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

/** The files whose diagnostic print count grew past the recorded baseline. */
export function ratchet({ baseline, counts }) {
  return Object.keys(counts)
    .filter((file) => counts[file] > (baseline.counts[file] ?? 0))
    .sort();
}

/** The positional scope directory and `--baseline <file>`, both for the gate's own test. */
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

function main(argv) {
  const update = argv.includes("--update");
  const includeDirty = update || argv.includes("--include-dirty");
  const { root, baselinePath } = parseArguments(argv);
  const uncommitted = includeDirty ? new Set() : uncommittedSources();
  const { violations, counts } = inspect({ root, uncommitted });

  if (update) {
    const baseline = {
      note: "Diagnostic print sites per production host/src file. Update deliberately, in its own commit, when a new bounded operational record is added.",
      revision: execFileSync("git", ["rev-parse", "--short", "HEAD"], {
        cwd: REPOSITORY_ROOT,
        encoding: "utf8",
        windowsHide: true,
      }).trim(),
      total: Object.values(counts).reduce((sum, count) => sum + count, 0),
      counts,
    };
    writeFileSync(baselinePath, `${JSON.stringify(baseline, null, 2)}\n`);
    process.stdout.write(`host_diagnostic_output_recorded total=${baseline.total} revision=${baseline.revision}\n`);
    return violations.length === 0 ? 0 : failMarkers(violations);
  }

  const baseline = JSON.parse(readFileSync(baselinePath, "utf8"));
  const grew = ratchet({ baseline, counts });
  if (violations.length === 0 && grew.length === 0) {
    process.stdout.write(
      `host_diagnostic_output_ok sites=${Object.values(counts).reduce((sum, count) => sum + count, 0)} files=${Object.keys(counts).length}\n`,
    );
    return 0;
  }
  if (violations.length > 0) failMarkers(violations);
  for (const file of grew)
    process.stdout.write(
      `  ${file}: ${baseline.counts[file] ?? 0} -> ${counts[file]} diagnostic print site(s)\n`,
    );
  if (grew.length > 0)
    process.stdout.write(
      "new diagnostic output in production host/src; use a bounded operational record (which store operation failed, and why) or re-record deliberately with: node tools/check-host-diagnostic-output.mjs --update\n",
    );
  return 1;
}

function failMarkers(violations) {
  process.stdout.write(`host_diagnostic_output_failed markers=${violations.length}\n`);
  for (const violation of violations)
    process.stdout.write(`  ${violation.file}:${violation.line} prints "${violation.literal}"\n`);
  process.stdout.write("a message that calls itself debug output is not a shipped operational record; remove it\n");
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
