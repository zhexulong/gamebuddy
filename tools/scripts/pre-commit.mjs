import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, extname, join, relative } from "node:path";

import { cleanOutputLines } from "../lib/subprocess-output.mjs";
import { CEILINGS_BY_EXTENSION, verdict as complexityVerdict } from "./check-file-complexity-gate.mjs";

/**
 * Pre-commit hook: format staged blobs in the index and run fast, index-scoped quality checks before HEAD advances.
 *
 * EVERYTHING THIS HOOK BLOCKS READS THE STAGED INDEX, NEVER THE WORKTREE:
 *   - Format staged formattable blobs in an isolated scratch tree (`biome format --write`) and write changed blobs
 *     back into the index via `git update-index --cacheinfo` while leaving worktree files untouched (`d8567157` safety)
 *     and refusing any formatting output that alters non-ASCII codepoints (`✖`/`✔`/`ℹ`).
 *   - Reject staged scratch/debris paths and unresolved merge conflict markers across staged UTF-8 blobs.
 *   - Lint the staged script/module files in the same scratch tree against `lint-baseline.json`, failing only on errors
 *     newly introduced or exceeding the baseline on staged files.
 *   - Check staged file line counts against `CEILINGS_BY_EXTENSION` and `file-complexity-baseline.json` (the same
 *     authority CI's `check-file-complexity-gate.mjs` owns).
 *   - Run conditional domain checks when staged paths touch Host sources, lockfiles, `package.json`/workflows, or
 *     Stardew multiday task authorities.
 *
 * Escape hatch is git's own: `git commit --no-verify`.
 */
const FORMATTABLE = /\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs|json|jsonc|css|md)$/i;
const LINTABLE = /\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs)$/i;
const BIOME = "node_modules/@biomejs/biome/bin/biome";
const REGULAR_FILE_MODES = new Set(["100644", "100755"]);
const DEBRIS_PATH_RE = /(?:^|\/)\.tmp\/|(?:^|\/)scratch\/|^(?:diag|read)-[^/]+\.(?:mjs|js|ts|ps1)$/i;
const CONFLICT_BLOCK_RE = /^<{7} .+\r?\n[\s\S]*?^={7}\r?\n[\s\S]*?^>{7} /mu;
const SUPPRESSION_RE = /@ts-ignore|@ts-nocheck|biome-ignore|eslint-disable/;
const SCRIPT_ENTRY_TRIGGER_RE = /(?:^|\/)package\.json$|^\.github\/workflows\/.+\.ya?ml$/i;
const STARDEW_TASK_AUTHORITIES = new Set([
  "tools/lib/multiday-daily-tasks.mjs",
  "tools/lib/task-purpose.mjs",
  "tools/live-run/game/run-stardew-native-local-agent-ab-live.mjs",
  "integrations/stardew/action-development/contracts/generated/action-surface.v1.json",
]);

const git = (args, options = {}) =>
  execFileSync("git", args, { encoding: "utf8", maxBuffer: 1 << 26, ...options }).trim();

const readJsonIfPresent = (path, fallback) => {
  if (!existsSync(path)) return fallback;
  return JSON.parse(readFileSync(path, "utf8"));
};

const indexEntries = (paths) => {
  if (paths.length === 0) return [];
  const listing = execFileSync("git", ["ls-files", "-s", "-z", "--", ...paths], {
    encoding: "utf8",
    maxBuffer: 1 << 26,
  });
  return listing
    .split("\0")
    .filter((record) => record.length > 0)
    .map((record) => {
      const tab = record.indexOf("\t");
      const [mode, blob] = record.slice(0, tab).split(" ");
      return { mode, blob, path: record.slice(tab + 1) };
    });
};

const changedCharacter = (before, after) => {
  const from = [...before].filter((character) => character.codePointAt(0) > 0x7f);
  const to = [...after].filter((character) => character.codePointAt(0) > 0x7f);
  for (let index = 0; index < Math.max(from.length, to.length); index += 1) {
    if (from[index] === to[index]) continue;
    const describe = (character) =>
      character === undefined
        ? "nothing"
        : `U+${character.codePointAt(0).toString(16).toUpperCase().padStart(4, "0")} (${character})`;
    return `${describe(from[index])} -> ${describe(to[index])}`;
  }
  return null;
};

const formatMirroredFile = (mirrored, path, scratch) => {
  try {
    execFileSync(
      "node",
      [BIOME, "format", "--write", "--max-diagnostics=none", `--config-path=${join(scratch, "biome.json")}`, mirrored],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
  } catch (error) {
    const detail = `${error.stdout ?? ""}${error.stderr ?? ""}`;
    if (/were provided but ignored|No files were processed/i.test(detail)) return null;
    console.error(`pre-commit: the formatter failed on ${path}\n${detail}`);
    process.exit(1);
  }
  return readFileSync(mirrored);
};

const readStagedTexts = (entries) => {
  const stagedTexts = new Map();
  const conflictFiles = [];
  for (const entry of entries) {
    if (!REGULAR_FILE_MODES.has(entry.mode)) continue;
    const raw = execFileSync("git", ["cat-file", "blob", entry.blob], { maxBuffer: 1 << 26 });
    const text = raw.toString("utf8");
    if (!Buffer.from(text, "utf8").equals(raw)) continue;
    if (!/test-fixtures?\//i.test(entry.path) && CONFLICT_BLOCK_RE.test(text)) {
      conflictFiles.push(entry.path);
    }
    stagedTexts.set(entry.path, { entry, raw, text });
  }
  if (conflictFiles.length > 0) {
    console.error(`pre-commit: unresolved conflict marker(s) in staged blob(s): ${conflictFiles.join(", ")}`);
    process.exit(1);
  }
  return stagedTexts;
};

const formatStagedBlobs = (entries, stagedTexts, scratch) => {
  const rewritten = [];
  const excluded = [];
  const preserved = [];
  const lintMirrored = [];
  for (const entry of entries) {
    const record = stagedTexts.get(entry.path);
    if (record === undefined) continue;
    const mirrored = join(scratch, entry.path);
    mkdirSync(dirname(mirrored), { recursive: true });
    writeFileSync(mirrored, record.raw);
    const formatted = formatMirroredFile(mirrored, entry.path, scratch);
    if (formatted === null) {
      excluded.push(entry.path);
      continue;
    }
    if (LINTABLE.test(entry.path)) lintMirrored.push(mirrored);
    if (formatted.equals(record.raw)) continue;
    const formattedText = formatted.toString("utf8");
    const changed = changedCharacter(record.text, formattedText);
    if (changed !== null) {
      writeFileSync(mirrored, record.raw);
      preserved.push(`${entry.path} (${changed})`);
      continue;
    }
    const blob = execFileSync("git", ["hash-object", "-w", "--stdin"], { input: formatted }).toString("utf8").trim();
    git(["update-index", "--cacheinfo", entry.mode, blob, entry.path]);
    stagedTexts.set(entry.path, { entry, raw: formatted, text: formattedText });
    rewritten.push(entry.path);
  }
  return { rewritten, excluded, preserved, lintMirrored };
};

const lintMirroredFiles = (lintMirrored, scratch) => {
  if (lintMirrored.length === 0) return;
  let stdout;
  try {
    stdout = execFileSync(
      "node",
      [BIOME, "lint", "--reporter=json", `--config-path=${join(scratch, "biome.json")}`, ...lintMirrored],
      { encoding: "utf8", maxBuffer: 1 << 26, stdio: ["ignore", "pipe", "pipe"] },
    );
  } catch (error) {
    if (typeof error.status !== "number") {
      console.error(`pre-commit: staged lint failed to run: ${error.message}`);
      process.exit(1);
    }
    stdout = error.stdout ?? "";
  }
  let report;
  try {
    report = JSON.parse(stdout);
  } catch {
    console.error(`pre-commit: staged lint emitted unreadable JSON:\n${stdout.slice(0, 1000)}`);
    process.exit(1);
  }
  const counts = new Map();
  const sampleMessages = new Map();
  for (const diagnostic of report.diagnostics ?? []) {
    if (diagnostic.severity !== "error") continue;
    const rawFile = diagnostic.location?.path?.file;
    if (typeof rawFile !== "string" || rawFile.length === 0) continue;
    const rel = relative(scratch, rawFile).replace(/\\/gu, "/");
    counts.set(rel, (counts.get(rel) ?? 0) + 1);
    if (!sampleMessages.has(rel) && typeof diagnostic.description === "string") {
      sampleMessages.set(rel, diagnostic.description);
    }
  }
  const baseline = readJsonIfPresent("tools/scripts/lint-baseline.json", { files: {} }).files ?? {};
  const regressions = [];
  for (const [file, count] of counts) {
    const allowed = baseline[file] ?? 0;
    if (count > allowed) regressions.push({ file, count, allowed, sample: sampleMessages.get(file) ?? "" });
  }
  if (regressions.length > 0) {
    console.error("pre-commit: staged file(s) contain new lint error(s):");
    for (const row of regressions) {
      const sample = row.sample ? ` (${row.sample})` : "";
      console.error(`  ${row.file}: ${row.count} error(s) (baseline ${row.allowed})${sample}`);
    }
    process.exit(1);
  }
  console.log(`pre-commit: staged lint clean (${lintMirrored.length} file(s))`);
};

const checkStagedLineCeilings = (stagedTexts) => {
  const sizes = new Map();
  for (const [path, record] of stagedTexts) {
    if (!CEILINGS_BY_EXTENSION.has(extname(path))) continue;
    sizes.set(path, record.text.split("\n").length);
  }
  if (sizes.size === 0) return;
  const baseline = readJsonIfPresent("tools/scripts/file-complexity-baseline.json", { sizes: {} }).sizes ?? {};
  const scopedRecorded = Object.fromEntries(
    [...sizes.keys()].filter((file) => file in baseline).map((file) => [file, baseline[file]]),
  );
  const { overCeiling, grew } = complexityVerdict({ recorded: scopedRecorded, sizes, ceilings: CEILINGS_BY_EXTENSION });
  if (overCeiling.length === 0 && grew.length === 0) return;
  for (const { file, lines, ceiling } of overCeiling) console.error(`file_over_ceiling:${file}:${lines}:${ceiling}`);
  for (const { file, lines, recorded } of grew) console.error(`baselined_file_grew:${file}:${lines}:${recorded}`);
  process.exit(1);
};

const rejectAddedSuppressions = () => {
  let diff;
  try {
    diff = execFileSync("git", ["diff", "--cached", "-U0", "--no-color", "--ignore-submodules=all"], {
      encoding: "utf8",
      maxBuffer: 1 << 26,
    });
  } catch (error) {
    console.error(`pre-commit: could not inspect the staged diff, so added suppressions cannot be ruled out\n${error.message}`);
    process.exit(1);
  }
  const flagged = new Map();
  let current = null;
  for (const line of diff.split(/\r?\n/u)) {
    if (line.startsWith("+++ b/")) {
      current = line.slice("+++ b/".length);
      continue;
    }
    if (!line.startsWith("+") || line.startsWith("+++")) continue;
    if (current === null || current.startsWith("tools/scripts/pre-commit")) continue;
    if (!SUPPRESSION_RE.test(line.slice(1))) continue;
    const existing = flagged.get(current) ?? [];
    existing.push(line.slice(1).trim());
    flagged.set(current, existing);
  }
  if (flagged.size === 0) return;
  for (const [file, directives] of flagged) {
    for (const directive of directives) console.error(`suppression_directive_added:${file}:${directive}`);
  }
  console.error(
    "pre-commit: a new suppression directive is refused. State what the compiler cannot express here, or fix the code it silences; `@ts-expect-error` with the error text is the one form that stays honest, because it fails when the error goes away.",
  );
  process.exit(1);
};

const runBlockingStep = (label, args) => {
  try {
    const output = execFileSync("node", args, {
      encoding: "utf8",
      maxBuffer: 1 << 26,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const last = cleanOutputLines(output.trim())
      .filter((line) => line.length > 0)
      .slice(-1)[0];
    if (last) console.log(`pre-commit: ${last}`);
  } catch (error) {
    const detail = `${error.stdout ?? ""}${error.stderr ?? ""}`.trim();
    if (typeof error.status !== "number") {
      console.error(`pre-commit: could not run ${label}\n${detail || error.message}`);
      process.exit(1);
    }
    console.error(`pre-commit: ${label} failed\n${detail}`);
    process.exit(1);
  }
};

const staged = execFileSync(
  "git",
  ["diff", "--cached", "--name-only", "-z", "--diff-filter=ACMR", "--ignore-submodules=all"],
  { encoding: "utf8", maxBuffer: 1 << 26 },
)
  .split("\0")
  .filter((path) => path.length > 0);

const summary = staged
  .slice(0, 25)
  .map((path) => `  ${path}`)
  .join("\n");
console.log(
  `pre-commit: staging ${staged.length} file(s):\n${summary}${staged.length > 25 ? `\n  …and ${staged.length - 25} more` : ""}`,
);
const owners = [...new Set(staged.map((path) => path.split("/")[0]))];
if (owners.length > 1) {
  console.log(
    `pre-commit: this commit spans ${owners.length} top-level directories (${owners.join(", ")}) - if only some of them are yours, commit with an explicit pathspec (\`git commit -F <msg> -- <paths>\`)`,
  );
}

const debris = staged.filter((path) => DEBRIS_PATH_RE.test(path));
if (debris.length > 0) {
  console.error(`pre-commit: refusing staged scratch/debris path(s): ${debris.join(", ")}`);
  process.exit(1);
}

const allEntries = indexEntries(staged);
const stagedTexts = readStagedTexts(allEntries);
const targets = staged.filter((path) => FORMATTABLE.test(path));
const targetEntries = allEntries.filter((entry) => FORMATTABLE.test(entry.path));

if (targets.length === 0) {
  console.log("pre-commit: nothing formattable staged");
} else {
  const scratch = mkdtempSync(join(tmpdir(), "pre-commit-format-"));
  try {
    copyFileSync("biome.json", join(scratch, "biome.json"));
    const { rewritten, excluded, preserved, lintMirrored } = formatStagedBlobs(targetEntries, stagedTexts, scratch);
    if (rewritten.length === 0) {
      console.log(`pre-commit: the staged content of ${targets.length - excluded.length} file(s) is already formatted`);
    } else {
      console.log(`pre-commit: formatted ${rewritten.length} staged file(s) in the index: ${rewritten.join(", ")}`);
      console.log(
        `pre-commit: the worktree copy is untouched - sync with: node ${BIOME} format --write ${rewritten.join(" ")}`,
      );
    }
    for (const site of preserved) {
      console.log(
        `pre-commit: NOT reformatting ${site}: the formatter changed a character this file contains, so the staged bytes are committed as written`,
      );
    }
    if (excluded.length > 0) {
      console.log(
        `pre-commit: biome.json's files.includes does not select ${excluded.join(", ")} - there is nothing to format there`,
      );
    }
    lintMirroredFiles(lintMirrored, scratch);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

checkStagedLineCeilings(stagedTexts);
rejectAddedSuppressions();

runBlockingStep("the test project typecheck", ["host/scripts/check-staged-test-typecheck.mjs"]);
runBlockingStep("the lockfile freeze check", ["tools/scripts/check-lockfile-freeze.mjs"]);

const stagedDeleted = execFileSync(
  "git",
  ["diff", "--cached", "--name-only", "-z", "--diff-filter=D", "--ignore-submodules=all"],
  { encoding: "utf8", maxBuffer: 1 << 26 },
)
  .split("\0")
  .filter((path) => path.length > 0);

if (
  (staged.some((path) => SCRIPT_ENTRY_TRIGGER_RE.test(path)) || stagedDeleted.length > 0) &&
  existsSync("tools/scripts/check-script-entry-existence.mjs")
) {
  runBlockingStep("the script-entry existence check", [
    "tools/scripts/check-script-entry-existence.mjs",
    "--index",
    "--ratchet",
  ]);
}

const stardewTouched = staged.filter((path) => STARDEW_TASK_AUTHORITIES.has(path));
if (
  stardewTouched.length > 0 &&
  existsSync("tools/check-stardew-task-action-coverage.mjs") &&
  existsSync("tools/check-stardew-multiday-task-families.mjs") &&
  existsSync("tools/check-stardew-task-gap-reasons.mjs")
) {
  const unstaged = git(["diff", "--name-only", "--ignore-submodules=all", "--", ...stardewTouched]);
  if (unstaged.length > 0) {
    console.log(
      `pre-commit: skipping stardew task-consistency checks because worktree holds unstaged edits to ${unstaged.split(/\r?\n/u).join(", ")}`,
    );
  } else {
    runBlockingStep("stardew task-action coverage", ["tools/check-stardew-task-action-coverage.mjs"]);
    runBlockingStep("stardew multiday task families", ["tools/check-stardew-multiday-task-families.mjs"]);
    runBlockingStep("stardew task gap reasons", ["tools/check-stardew-task-gap-reasons.mjs"]);
  }
}
