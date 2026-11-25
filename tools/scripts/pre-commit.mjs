import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, extname, join, relative } from "node:path";
import { SOURCE_TREES } from "../../gates/arch/check-code-duplication.mjs";
import { materializeIndexTree } from "../lib/index-tree.mjs";
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
 *   - Read the complexity and duplication ratchets over the tree this commit is about to create, using the gates' own
 *     measurement and their own comparison, and refuse a commit that makes a record disagree with the tree while
 *     leaving the re-record behind for the next author (see THE RECORD TRAVELS WITH THE CHANGE, below).
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

// -----------------------------------------------------------------------------------------------------------
// THE RECORD TRAVELS WITH THE CHANGE
// -----------------------------------------------------------------------------------------------------------

/**
 * The complexity and duplication ratchets measure the tree, so the commit that moves the tree has to move the record.
 *
 * Measured 2026-11-19: `l0` reached `48 gates, 0 red` and went red again three times, each time after a CORRECT commit
 * - `sizes cs:ModEntry` 17274 -> 17387 lines / 371 -> 374 members, `ts:host/src/protocol.ts#isValidActionDescriptor`
 * 224 -> 221. Re-recording is a separate manual `--update`, so the number was corrected by whichever lane committed
 * next: the ratchet's number was edited by someone who did not cause the change, and the tree was red in between. The
 * hook is the only place that sees the change and the record side by side, so it reads them together.
 *
 * NOT A SECOND AUTHORITY. The reading is `gates/arch/check-cognitive-complexity.mjs`'s exported `measure` and its
 * exported `evaluate`, and `gates/arch/check-code-duplication.mjs`'s exported `checkCodeDuplication`; this file only
 * names what those returned. A comparison copied here would agree today and disagree with the gate the day either
 * moves - the defect this section exists to end, not one to add.
 *
 * THE TREE IS THE INDEX. The worktree holds several lanes' work in flight, and this hook may only speak about the
 * bytes about to be committed, so the index is checked out into a throwaway tree (`tools/lib/index-tree.mjs`, which
 * honours `GIT_INDEX_FILE`, so a lane's private index is the tree read here) and the gates read that tree - the record
 * files included as staged, so a re-record is judged where it will land. The SAME module builds the tree `--update`,
 * `--write-baseline` and `--record-shrinks` measure, because two readings disagreeing about which tree they measure is
 * what made a re-record impossible to satisfy (measured 2026-11-25: the hook refused
 * `complexity_baseline_stale_for_this_commit:<file>` for a record `--update` had just written from the worktree).
 *
 * THE SCOPE IS THE COMMIT. A finding blocks only when it names a path this commit touches, or when the record carrying
 * it is itself staged: a tree already red from an earlier commit must not block the next author. That is the scoping
 * `host/scripts/check-staged-test-typecheck.mjs` uses, for the same reason.
 *
 * FAILS CLOSED: a record that cannot be read, a reading the gate blocks, or a finding this hook cannot attach to an
 * entry is a refusal with the reason, never a pass.
 */
const COMPLEXITY_RECORD = "tools/cognitive-complexity-baseline.json";
const DUPLICATION_RECORD = "tools/duplicate-code-baseline.json";
const DUPLICATION_DECLARATIONS = "tools/duplicate-code-declarations.json";
const RATCHET_CONFIGS = ["jscpd.json", "biome.json"];

/** A path either ratchet measures: the trees the duplication gate scans, plus the two configs it reads at the root. */
const ratchetMeasures = (path) =>
  RATCHET_CONFIGS.includes(path) || SOURCE_TREES.some((tree) => path === tree || path.startsWith(`${tree}/`));

/** The record as this commit stages it, with the reason it cannot be read instead of a stack trace. */
const readRecord = (root, path) => {
  let text;
  try {
    text = readFileSync(join(root, path), "utf8");
  } catch (error) {
    throw new Error(`${path} could not be read (${error.message})`);
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`${path} is not readable JSON (${error.message})`);
  }
};

/**
 * The entry a finding is about: the longest recorded or measured identity its detail begins with.
 *
 * The gates key a member by its qualified signature and a class by its qualified name, so `cs:ModEntry` is a prefix
 * of `cs:ModEntry.Save(...)`; taking the longest match is what keeps a class finding from being read as a member one.
 * A detail no identity matches is a finding this hook cannot name, and it refuses rather than printing a guess.
 */
const identityOf = (detail, identities) =>
  identities
    .filter((identity) => detail === identity || detail.startsWith(`${identity} `) || detail.startsWith(`${identity}:`))
    .sort((left, right) => right.length - left.length)[0];

const sizeReading = (entry) => (entry === undefined ? "unrecorded" : `${entry.lines} lines/${entry.methods} methods`);

/** The file this commit touched among an entry's files, else the first one the entry names. */
const fileOf = (files, touched) => files.find((file) => touched.has(file)) ?? files[0] ?? "(no file recorded)";

const attributedToCommit = (files, touched, record) => touched.has(record) || files.some((file) => touched.has(file));

/**
 * The complexity half: every recorded member, class and type size judged against the tree this commit creates.
 *
 * The two numbers in each row are read from the gate's own measurement and from the record, never parsed out of the
 * finding's prose: `function_grew` prints its detail with `formatComplexity`, and a saturated ts reading is a floor
 * (`>=255`), so a message assembled from a copy of those rules would print a count where the gate prints a floor.
 */
const complexityDisagreements = async (root, touched) => {
  const gate = await import("../../gates/arch/check-cognitive-complexity.mjs");
  const measured = await gate.measure(root);
  if (measured.error !== undefined) return { blocked: measured.error };
  let baseline;
  try {
    baseline = readRecord(root, COMPLEXITY_RECORD);
  } catch (error) {
    return { blocked: error.message };
  }
  for (const field of ["members", "classes", "sizes"])
    if (baseline[field] !== undefined && !Array.isArray(baseline[field]))
      return { blocked: `${COMPLEXITY_RECORD} is unreadable: ${field} is not a list` };

  const members = new Map(measured.members.map((member) => [member.id, member]));
  const types = new Map(measured.types.map((type) => [type.id, type]));
  const namedTypes = new Map(measured.types.map((type) => [type.name, type]));
  const recordedMembers = new Map((baseline.members ?? []).map((entry) => [entry.id, entry]));
  const recordedClasses = new Map((baseline.classes ?? []).map((entry) => [entry.id, entry]));
  const recordedSizes = new Map((baseline.sizes ?? []).map((entry) => [entry.id, entry]));
  const identities = [
    ...members.keys(),
    ...types.keys(),
    ...namedTypes.keys(),
    ...recordedMembers.keys(),
    ...recordedClasses.keys(),
    ...recordedSizes.keys(),
  ];

  const rows = [];
  const verdict = gate.evaluate({
    members: measured.members,
    types: measured.types,
    baseline,
    bounds: measured.bounds,
  });
  for (const finding of verdict.findings) {
    const identity = identityOf(finding.detail, identities);
    if (identity === undefined)
      return { blocked: `the complexity gate named no entry this hook can attach: ${finding.detail}` };
    const member = members.get(identity);
    const type = types.get(identity) ?? namedTypes.get(identity);
    const recordedMember = recordedMembers.get(identity);
    const recordedClass = recordedClasses.get(identity);
    const recordedSize = recordedSizes.get(identity);
    const numbers = {
      function_grew: () => [gate.formatComplexity(recordedMember), gate.formatComplexity(member)],
      function_over_bound: () => ["unrecorded", gate.formatComplexity(member)],
      class_grew: () => [`${recordedClass.value}`, `${type.value}`],
      class_complexity_over_bound: () => ["unrecorded", `${type.value}`],
      class_size_grew: () => [sizeReading(recordedSize), sizeReading(type)],
      class_size_record_stale: () => [sizeReading(recordedSize), sizeReading(type)],
      class_lines_over_ceiling: () => ["unrecorded", sizeReading(type)],
      class_methods_over_ceiling: () => ["unrecorded", sizeReading(type)],
      stale_complexity_baseline: () => [
        recordedMember === undefined
          ? `${recordedClass?.value ?? "unrecorded"}`
          : gate.formatComplexity(recordedMember),
        "gone from the tree",
      ],
      stale_class_ceiling: () => [sizeReading(recordedSize), "below the class lines/methods ceiling"],
    }[finding.code];
    if (numbers === undefined)
      return {
        blocked: `the complexity gate reported ${finding.code}, which this hook cannot name: ${finding.detail}`,
      };
    const files = [
      ...new Set(
        [member?.file, ...(type?.files ?? []), recordedMember?.file, recordedClass?.file, recordedSize?.file].filter(
          (file) => typeof file === "string",
        ),
      ),
    ];
    if (!attributedToCommit(files, touched, COMPLEXITY_RECORD)) continue;
    const [recorded, current] = numbers();
    rows.push({
      gate: "complexity",
      recordable: true,
      line: `complexity_baseline_stale_for_this_commit:${fileOf(files, touched)}:${identity}:${recorded}->${current}`,
    });
  }
  for (const entry of measured.drift) {
    if (!touched.has(entry.file)) continue;
    rows.push({
      gate: "complexity",
      recordable: true,
      line: `complexity_member_unmeasured_for_this_commit:${entry.file}:${entry.kind}`,
    });
  }
  return { rows };
};

/** A recorded site is `file:line`, and only the file is a path this hook can compare with the commit. */
const siteFile = (site) => site.slice(0, site.lastIndexOf(":"));

/**
 * The duplication half: every recorded group and declaration judged against the groups the tree still holds.
 *
 * The ratchet on this record only goes down (`--record-shrinks` lowers or deletes an entry and can never add one),
 * so a group that is new or grew is not a re-record: it is a copy to remove, and the row says so.
 */
const duplicationDisagreements = async (root, touched) => {
  const gate = await import("../../gates/arch/check-code-duplication.mjs");
  let reading;
  let baseline;
  let declarations;
  try {
    reading = gate.checkCodeDuplication({ root });
    if (reading.status !== "blocked") {
      baseline = gate.readBaseline({ root });
      declarations = gate.readDeclarations({ root });
    }
  } catch (error) {
    return { blocked: `${DUPLICATION_RECORD} or ${DUPLICATION_DECLARATIONS} could not be read (${error.message})` };
  }
  if (reading.status === "blocked") return { blocked: reading.reason };

  const groups = new Map((reading.counted ?? []).map((group) => [group.hash, group]));
  const recorded = new Map((baseline?.groups ?? []).map((entry) => [entry.hash, entry]));
  const declared = new Map((declarations ?? []).map((entry) => [entry.hash, entry]));
  const rows = [];
  for (const finding of reading.findings) {
    const group = groups.get(finding.hash);
    const entry = recorded.get(finding.hash);
    const declaration = declared.get(finding.hash);
    const sites = group === undefined ? (entry?.sites ?? []).map(siteFile) : group.sites.map((site) => site.file);
    if (!(attributedToCommit(sites, touched, DUPLICATION_RECORD) || touched.has(DUPLICATION_DECLARATIONS))) continue;
    const measured = group === undefined ? undefined : group.sites.length;
    const numbers = {
      clone_group: () => ["unrecorded", `${measured} sites at ${group.tokens} tokens`],
      clone_group_grew: () => [
        `${declaration === undefined ? entry.sites.length : declaration.sites} sites`,
        `${measured} sites at ${group.tokens} tokens`,
      ],
      stale_clone_baseline: () => [
        `${entry.sites.length} sites`,
        measured === undefined ? "gone from the tree" : `${measured} sites`,
      ],
      stale_clone_declaration: () => [
        `${declaration.sites} sites (declared)`,
        measured === undefined ? "gone from the tree" : `${measured} sites`,
      ],
      facade_only_clone_baselined: () => [`${entry.sites.length} sites`, "read as a declaration, not duplication"],
      syntax_floor_clone_baselined: () => [`${entry.sites.length} sites`, "read as the syntax floor"],
    }[finding.code];
    if (numbers === undefined)
      return {
        blocked: `the duplication gate reported ${finding.code}, which this hook cannot name: ${finding.detail}`,
      };
    const [recordedText, currentText] = numbers();
    rows.push({
      gate: "duplication",
      recordable: finding.code !== "clone_group" && finding.code !== "clone_group_grew",
      line: `duplication_baseline_stale_for_this_commit:${fileOf(sites, touched)}:${finding.hash}:${recordedText}->${currentText}`,
    });
  }
  return { rows };
};

const ratchetRecordCommands = (rows) => {
  const commands = [];
  if (rows.some((row) => row.gate === "complexity"))
    commands.push(
      `re-record: node gates/arch/check-cognitive-complexity.mjs --update, then \`git add ${COMPLEXITY_RECORD}\``,
    );
  if (rows.some((row) => row.gate === "duplication" && row.recordable))
    commands.push(
      `re-record the shrink: node gates/arch/check-code-duplication.mjs --record-shrinks, then \`git add ${DUPLICATION_RECORD}\``,
    );
  if (rows.some((row) => row.gate === "duplication" && !row.recordable))
    commands.push(
      "a new or grown clone is not a re-record: remove the copy or fold the copies behind one seam; the duplication record may only shrink",
    );
  return commands;
};

/**
 * The step: the records are read over the index tree this commit creates, and a disagreement that names a touched path
 * refuses the commit.
 *
 * THE COST, measured on this tree on 2026-11-25 (4275 tracked files, repeated runs): 1.8-2.9s to check the index out and
 * 0.34-0.52s to remove it, 1.00-1.10s to make that tree a repository (the duplication gate asks git which files the index
 * does not hold, and a directory that is not a repository cannot answer), 4.4-5.9s for the complexity measurement (565
 * `.cs` through tree-sitter and biome over the 316 `host/src` modules) and 5.0-5.2s for the duplication scan - 13-18s
 * end to end, and only on a commit that touches a measured tree. Two thirds of that is the gates measuring the whole
 * tree, which is what these two ratchets ARE: a class is its partials and a clone is its sites, so a reading of the
 * changed files alone is not the gate's reading. Nothing is cached between runs: a reading kept from an earlier commit is
 * a reading of an earlier tree, which is the staleness this step exists to catch, and a reading cached per file would be
 * wrong for a class the last commit grew in a different partial.
 *
 * WHY NOTHING NARROWER IS READ, measured over the last 60 commits before this landed: a path a record row names is
 * touched by 30% of them, but the rows that matter are MERGED - `cs:ModEntry` is 61 files and its row names one,
 * `cs:ExecutionManager` 54 - so a trigger keyed on the row's path takes the fast exit exactly on the commit that grows
 * one of the other 60, which is the shape that produced tonight's `sizes cs:ModEntry` 17274 -> 17387. Scoping the
 * measurement to the staged files is not an option either: 3 of 24 size rows and 3 of 10 class rows are merged from
 * partials, and 88 of 115 clone groups have sites in more than one file (widest 19), so a per-file reading compares one
 * partial against a merged total. A trigger keyed on the recorded NAMES takes no fast exit at all (100% of commits
 * mention one, and the generic member names match everywhere). So the whole tree is read, and the only exit is the
 * honest one: a commit that stages no measured path at all. If 12-17s is still too much, the lever is to run the two
 * readings concurrently (they are independent) - not to remember a verdict.
 */
const checkRatchetRecords = async (touched) => {
  const measured = touched.filter(ratchetMeasures);
  if (measured.length === 0) {
    console.log("pre-commit: ratchet records not checked: no touched path is measured by them (files examined 0)");
    return;
  }
  const started = Date.now();
  const rows = [];
  const blockers = [];
  const index = materializeIndexTree({ root: process.cwd(), repository: true });
  try {
    if (index.error !== undefined) throw new Error(index.error);
    const touchedSet = new Set(touched);
    for (const read of [complexityDisagreements, duplicationDisagreements]) {
      const outcome = await read(index.root, touchedSet);
      if (outcome.blocked !== undefined) blockers.push(outcome.blocked);
      rows.push(...(outcome.rows ?? []));
    }
  } catch (error) {
    blockers.push(`the reading could not be taken (${error instanceof Error ? error.message : String(error)})`);
  } finally {
    index.dispose();
  }

  const elapsed = Date.now() - started;
  if (blockers.length === 0 && rows.length === 0) {
    console.log(`pre-commit: the complexity and duplication records agree with this commit (${elapsed}ms)`);
    return;
  }
  for (const blocker of blockers) console.error(`ratchet_record_unreadable_for_this_commit:${blocker}`);
  for (const row of rows) console.error(row.line);
  if (rows.length > 0) {
    console.error(
      "pre-commit: a record measures the tree, so the commit that moves the tree carries its re-record: the numbers " +
        `above are the recorded reading and this commit's (${rows.length} entr${rows.length === 1 ? "y" : "ies"}, read ` +
        `in ${elapsed}ms).`,
    );
    for (const command of ratchetRecordCommands(rows)) console.error(`  ${command}`);
  }
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
    console.error(
      `pre-commit: could not inspect the staged diff, so added suppressions cannot be ruled out\n${error.message}`,
    );
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
await checkRatchetRecords(
  execFileSync("git", ["diff", "--cached", "--name-only", "-z", "--ignore-submodules=all"], {
    encoding: "utf8",
    maxBuffer: 1 << 26,
  })
    .split("\0")
    .filter((path) => path.length > 0),
);
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
