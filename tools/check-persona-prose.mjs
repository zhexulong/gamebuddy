#!/usr/bin/env node
/**
 * Persona prose: the shipped identity cannot change without a deliberate marker.
 *
 * WHY (measured 2026-11-10). The shipped persona prose was rewritten twice inside one hour, by two lanes, and both
 * rewrites arrived as a side effect of a preset lane rather than as a product decision:
 *   - the 18649d9e / aead2ca2 era left an uncommitted rewrite of `assets/tavern/presets/default-companion/card.json`:
 *     `system_prompt` 560 -> 204 characters, `post_history_instructions` 269 -> 67, `mes_example` 1220 -> 1533, and
 *     the worldbook gained entries 8/9/10 with dozens of keywords. `assets/tavern/presets/amber-deepseek-v4.1.json`
 *     lost "系统总纲与角色扮演框架" for "…具身角色扮演框架" and had its `main` content replaced outright.
 *   - lane b71a8161 wrote it AGAIN after the first rewrite had been restored and the boundary had been stated in bold.
 * Both were restored twice, and `git hash-object` matched `HEAD` again each time. Nothing in this tree said "that file
 * is the product", so nothing refused the edit. This gate is that refusal.
 *
 * POPULATION (derived from the presets directory on every run, never listed). Every `*.json` under
 * `assets/tavern/presets/**`, in one of two shapes chosen by file name:
 *   - `card.json` / `worldbook.json`: every scalar leaf of the document, keyed by its JSON path, so
 *     `data.system_prompt`, `entries.3.content` and `entries.3.keys.2` are all prose. One subtree is excluded and the
 *     exclusion is declared below: `data.extensions.*` is the Host binding and the farmer's gameplay preferences
 *     (appearance, loved items, stamina threshold, curfew), which is a different decision from her words.
 *   - any other preset document: `prompts[<i>].name` and `prompts[<i>].content`, i.e. the words and the headings the
 *     assembly mounts. `temperature` and the sampler block are not prose and are not read here.
 * `files examined N · prose fields M` opens every run, followed by one line per file with its field count, because the
 * population is the reading: a file contributing 0 fields is visible rather than absent.
 *
 * RULE. A diff that changes any of those fields is allowed only when the SAME commit - or the pending commit, in the
 * two uncommitted modes - carries `[persona]` in its message AND updates
 * `assets/tavern/presets/PERSONA-REVISION.md` (one line per deliberate change: `date · commit · field · why · who
 * asked`). Both or neither: a marker without the record is red, a record without the marker is red. Every red names
 * the drifting member as `persona_prose_changed_without_decision:<file>:<field>:<oldLen>-><newLen>`, with the lengths
 * of the JSON leaf's own text - so the 560 -> 204 rewrite above reads as exactly that. The comparison is on the TEXT,
 * so a rewrite that keeps the length is a change too; the lengths are only how the finding prints.
 *
 * MODES, because the question has to be askable on both sides of a commit:
 *   (default)          the working tree against `HEAD`: the rewrite that has not been staged yet, which is the shape
 *                      both incidents took, and the one a lane meets before it commits anything.
 *   --staged           the index against `HEAD`: the commit being made. The message comes from the caller
 *                      (`--message`, or `--message-file` for the form a `commit-msg` hook holds); a prose change with
 *                      no message supplied is red and says `persona_commit_message_not_supplied` instead of reading a
 *                      stale `.git/COMMIT_EDITMSG`, which is last night's message deciding tonight's verdict.
 *   --range <a>..<b>   history, one commit at a time, each judged against its own message and its own tree. This is
 *                      the form that proves the gate red on real history; a range is asked for deliberately, not
 *                      walked over the whole history, because every persona commit before this register existed is a
 *                      red this gate would report forever.
 * ZERO POPULATION is blocked (exit 2): no readable prose file on either side means the gate measured nothing, and a
 * gate that measured nothing must not read as green. So is a document that is not JSON, and a range that is empty.
 *
 * THE MECHANISM THIS HOUR EXPOSED, written in the gate's own header because this is where the next lane looks: a glob
 * in a brief is not a permission to rewrite prose. `assets/tavern/presets/**` in a delegation's bounds means "you may
 * touch the preset seam"; it does not mean the words are yours to shorten, retitle or replace, and a rewrite that
 * reads better is still an unrequested product decision. The bounds that let both lanes through were the delegating
 * agent's own prose rather than a mechanism here: `not_verified` - no shared helper in this tree expands a lane's
 * bounds. Searching for one (`git grep -n -i -E "allowed_paths|pathGlobs|fileGlobs|writeScope|lane.*bounds"`) finds
 * nothing under `tools/`; `tools/lib/stardew-lane-scope.mjs` derives a live run's fixture roots, not a worker's write
 * scope, and inventing a second one to name here would be the same mistake one layer down.
 *
 * WHAT CALLS IT. `tools/prelive.mjs` L0 runs the default form, so a checkout about to start a live run reads it. The
 * staged form is what a `commit-msg` hook or a committer's preflight would run, and nothing invokes it today: the
 * repository's hook (`tools/git-hooks/pre-commit` -> `tools/scripts/pre-commit.mjs`) formats the staged set and gates
 * two per-commit facts, and naming this gate there is one line in a file this gate does not own.
 *
 * red-proof: history  `--range 796f701a^..796f701a` on this repository's own history - a shipped rewrite of the
 *                    companion's prose, committed long before this register existed - exits 1 with
 *                    `persona_prose_changed_without_decision:assets/tavern/presets/default-companion/card.json:...`
 *                    (tools/check-persona-prose.test.mjs)
 * red-proof: inject   a throwaway `git init` repository whose second commit rewrites `data.system_prompt` from 20
 *                    characters to 8 with no `[persona]` message exits 1; the same commit carrying the marker and a
 *                    PERSONA-REVISION.md line exits 0 (tools/check-persona-prose.test.mjs)
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** The shipped persona prose, and the file a deliberate change records itself in. */
const PRESETS_DIRECTORY = "assets/tavern/presets";
const PERSONA_REVISION_FILE = "assets/tavern/presets/PERSONA-REVISION.md";
const DELIBERATE_CHANGE_MARKER = "[persona]";

/** The finding every red prints, in the format this gate is read by. */
export const VIOLATION = "persona_prose_changed_without_decision";

/** Documents whose every scalar leaf is persona prose, by file name; every other preset document carries `prompts`. */
const DOCUMENT_PRESETS = new Set(["card.json", "worldbook.json"]);

/** The one card subtree that is not prose: the Host binding and the farmer's gameplay preferences. */
const NON_PROSE_PATHS = new Set(["data.extensions"]);

const childPath = (path, key) => (path === "" ? String(key) : `${path}.${key}`);
const fieldKey = (path, field) => `${path}\u0000${field}`;

//
// What counts as persona prose.
//

/**
 * Every scalar leaf of a JSON document as `path -> the text a reader would see`, pruning the declared non-prose
 * subtree. Numbers and booleans render as their JSON text so a changed `priority` or `scan_depth` is a change too;
 * a leaf that disappears reads as a removed field rather than as a silent `0`.
 */
export function documentLeaves(value, path = "", leaves = new Map()) {
  if (typeof value === "string") {
    leaves.set(path, value);
    return leaves;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    leaves.set(path, JSON.stringify(value));
    return leaves;
  }
  if (value === null || value === undefined) return leaves;
  if (Array.isArray(value)) {
    value.forEach((element, index) => documentLeaves(element, childPath(path, index), leaves));
    return leaves;
  }
  for (const [key, element] of Object.entries(value)) {
    const child = childPath(path, key);
    if (NON_PROSE_PATHS.has(child)) continue;
    documentLeaves(element, child, leaves);
  }
  return leaves;
}

/** A preset document's prose: the words and headings the assembly mounts, and nothing from the sampler block. */
export function presetPromptLeaves(document, leaves = new Map()) {
  const prompts = Array.isArray(document?.prompts) ? document.prompts : [];
  prompts.forEach((prompt, index) => {
    if (prompt === null || typeof prompt !== "object") return;
    for (const key of ["name", "content"])
      if (typeof prompt[key] === "string") leaves.set(`prompts.${index}.${key}`, prompt[key]);
  });
  return leaves;
}

/** The persona prose one file carries, as `field -> text`. Throws on a document that is not JSON. */
function proseFieldsOfPath(path, text) {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const document = JSON.parse(text);
  return DOCUMENT_PRESETS.has(name) ? documentLeaves(document) : presetPromptLeaves(document);
}

/** One side of a comparison: `Map<file\0field, { path, field, text }>`, plus the files that could not be read. */
function readSide(files) {
  const prose = new Map();
  const unreadable = [];
  let examined = 0;
  for (const file of files) {
    if (file.text === null || file.text === undefined) continue;
    examined += 1;
    try {
      for (const [field, text] of proseFieldsOfPath(file.path, file.text))
        prose.set(fieldKey(file.path, field), { path: file.path, field, text });
    } catch (error) {
      unreadable.push(`${file.path}: ${error.message}`);
    }
  }
  return { prose, unreadable, files: examined };
}

/** Every field whose TEXT differs between the two sides, ordered by file and field. */
export function changedProse(before, after) {
  const changes = [];
  for (const [key, entry] of after) {
    const previous = before.get(key);
    if (previous === undefined)
      changes.push({ path: entry.path, field: entry.field, oldLen: 0, newLen: entry.text.length });
    else if (previous.text !== entry.text)
      changes.push({
        path: entry.path,
        field: entry.field,
        oldLen: previous.text.length,
        newLen: entry.text.length,
      });
  }
  for (const [key, entry] of before)
    if (!after.has(key)) changes.push({ path: entry.path, field: entry.field, oldLen: entry.text.length, newLen: 0 });
  return changes.sort(
    (left, right) =>
      left.path.localeCompare(right.path) || left.field.localeCompare(right.field, "en", { numeric: true }),
  );
}

/**
 * The rule, as a function of the four facts it reads, so every arm can be driven without a repository: `changes`
 * (what drifted), `message` (the pending commit's message, or null when the caller supplied none), and
 * `revisionRecordUpdated` (did the same diff touch PERSONA-REVISION.md). Both or neither.
 */
export function judge({ changes, message, revisionRecordUpdated, label }) {
  if (changes.length === 0) return { status: "passed", findings: [] };
  const drifting = changes.map(
    (change) => `${VIOLATION}:${change.path}:${change.field}:${change.oldLen}->${change.newLen}`,
  );
  const marker = typeof message === "string" && message.includes(DELIBERATE_CHANGE_MARKER);
  if (marker && revisionRecordUpdated) return { status: "passed", findings: [], deliberate: true };
  const missing = [];
  if (typeof message !== "string" || message.trim() === "")
    missing.push(`persona_commit_message_not_supplied:${label}`);
  else if (!marker) missing.push(`persona_commit_without_marker:${label}`);
  if (!revisionRecordUpdated) missing.push(`persona_commit_without_revision_record:${label}`);
  return { status: "failed", findings: [...drifting, ...missing] };
}

//
// Reading the two sides of a commit. Every git call is one process (a Windows `git` spawn costs ~600 ms here), so
// object contents are read in one `git cat-file --batch` per side-pair rather than one `git show` per file.
//

const gitBytes = (root, args, options = {}) =>
  execFileSync("git", args, { cwd: root, maxBuffer: 1 << 26, stdio: ["pipe", "pipe", "pipe"], ...options });

const gitText = (root, args) => gitBytes(root, args, { encoding: "utf8" });

/** NUL-separated path lists come back trimmed of the trailing separator git appends. */
const nulSeparated = (text) =>
  text
    .split("\u0000")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);

const isJson = (path) => path.toLowerCase().endsWith(".json");

/**
 * Object contents in one `git cat-file --batch` process, as `spec -> text`; `null` for a spec the object store has
 * not got (`HEAD:<path>` before a path exists). Sliced by the byte length in the header, because these documents are
 * UTF-8 with Chinese dialogue in them and a character count would cut them.
 */
export function batchContents(root, specs) {
  if (specs.length === 0) return new Map();
  const batch = gitBytes(root, ["cat-file", "--batch"], { input: `${specs.join("\n")}\n` });
  const contents = new Map();
  let offset = 0;
  for (const spec of specs) {
    const headerEnd = batch.indexOf(0x0a, offset);
    if (headerEnd < 0) throw new Error(`persona_prose_object_unreadable:${spec}`);
    const header = batch.toString("utf8", offset, headerEnd);
    if (header.endsWith(" missing")) {
      contents.set(spec, null);
      offset = headerEnd + 1;
      continue;
    }
    const size = Number(header.split(" ")[2]);
    if (!Number.isFinite(size)) throw new Error(`persona_prose_object_unreadable:${spec}`);
    const start = headerEnd + 1;
    contents.set(spec, batch.toString("utf8", start, start + size));
    offset = start + size + 1;
  }
  return contents;
}

/** The JSON documents a revision carries under the presets directory, or `[]` when the revision does not exist. */
function pathsAtRevision(root, revision) {
  try {
    return nulSeparated(
      gitText(root, ["ls-tree", "-r", "-z", "--name-only", revision, "--", PRESETS_DIRECTORY]),
    ).filter(isJson);
  } catch {
    return [];
  }
}

/**
 * The prose of one revision AND the register's text at that revision, from ONE batch. `pathsAtRevision` is the durable
 * set: a path the revision has dropped is absent from the returned prose, which is how a deletion becomes a removed
 * field rather than a silence.
 */
function closureAt(root, revision) {
  const paths = pathsAtRevision(root, revision);
  const specs = [...paths.map((path) => `${revision}:${path}`), `${revision}:${PERSONA_REVISION_FILE}`];
  const contents = batchContents(root, specs);
  return {
    side: readSide(paths.map((path) => ({ path, text: contents.get(`${revision}:${path}`) }))),
    record: contents.get(`${revision}:${PERSONA_REVISION_FILE}`),
  };
}

const emptyClosure = () => ({ side: { prose: new Map(), unreadable: [], files: 0 }, record: null });

/** One side of a batch already read, under the prefix its specs carried (`HEAD:` or `:` for the index). */
const sideFrom = (contents, prefix, paths) =>
  readSide(paths.map((path) => ({ path, text: contents.get(`${prefix}${path}`) })));

/** The prose files the working tree has, as git sees them: tracked plus untracked-but-not-ignored. */
const worktreePaths = (root) =>
  nulSeparated(
    gitText(root, ["ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", PRESETS_DIRECTORY]),
  ).filter(isJson);

/** The prose files the index has: the commit being made. */
const indexPaths = (root) =>
  nulSeparated(gitText(root, ["ls-files", "-z", "--cached", "--", PRESETS_DIRECTORY])).filter(isJson);

/** The register's text in the working tree, or `null` when the disk has not got it. */
const recordOnDisk = (root) => {
  const path = join(root, PERSONA_REVISION_FILE);
  return existsSync(path) ? readFileSync(path, "utf8") : null;
};

//
// The run.
//

const fileBreakdown = (side) => {
  const counts = new Map();
  for (const entry of side.prose.values()) counts.set(entry.path, (counts.get(entry.path) ?? 0) + 1);
  return [...counts.entries()].sort().map(([path, count]) => `  ${path} ${count} field(s)`);
};

const blocked = (reason, lines = []) => ({ status: "blocked", reason, lines, findings: [] });

/**
 * The two uncommitted modes: `HEAD` on one side and either the index (the commit being made) or the working tree (the
 * rewrite nobody has staged yet) on the other. `--message`/`--message-file` is the pending commit's message.
 */
export function runCheck({ root = REPOSITORY_ROOT, mode = "worktree", range = null, message = null } = {}) {
  if (mode === "range") return range === null ? blocked("persona_prose_range_missing") : runRange({ root, range });
  const headPaths = pathsAtRevision(root, "HEAD");
  const paths = mode === "staged" ? indexPaths(root) : worktreePaths(root);
  const specs = [
    ...headPaths.map((path) => `HEAD:${path}`),
    `HEAD:${PERSONA_REVISION_FILE}`,
    ...(mode === "staged" ? [...paths.map((path) => `:${path}`), `:${PERSONA_REVISION_FILE}`] : []),
  ];
  const contents = batchContents(root, specs);
  const before = sideFrom(contents, "HEAD:", headPaths);
  const after =
    mode === "staged"
      ? sideFrom(contents, ":", paths)
      : readSide(
          paths.map((path) => ({
            path,
            text: existsSync(join(root, path)) ? readFileSync(join(root, path), "utf8") : null,
          })),
        );
  const changes = changedProse(before.prose, after.prose);
  const lines = [
    `files examined ${after.files} · prose fields ${after.prose.size} · mode ${
      mode === "staged" ? "staged_vs_HEAD" : "worktree_vs_HEAD"
    } · changed ${changes.length}`,
    ...fileBreakdown(after),
  ];
  const unreadable = [...before.unreadable, ...after.unreadable];
  if (unreadable.length > 0) return blocked(`persona_prose_unreadable:${unreadable.join("; ")}`, lines);
  if (after.files === 0 && before.files === 0)
    return blocked(`persona_prose_population_empty:no *.json under ${PRESETS_DIRECTORY} on either side`, lines);
  const pendingRecord = mode === "staged" ? contents.get(`:${PERSONA_REVISION_FILE}`) : recordOnDisk(root);
  const verdict = judge({
    changes,
    message,
    revisionRecordUpdated: pendingRecord !== contents.get(`HEAD:${PERSONA_REVISION_FILE}`),
    label: mode === "staged" ? "the staged commit" : "the working tree",
  });
  return { status: verdict.status, reason: null, lines: [...lines, ...verdict.findings], findings: verdict.findings };
}

/**
 * One committed range, judged commit by commit. The commit's message, its parent and its own tree are the evidence for
 * its diff, so a range walks history rather than comparing one `HEAD` against one worktree.
 */
function runRange({ root, range }) {
  const [base, head = "HEAD"] = String(range).split("..");
  if (base === undefined || base === "") return blocked(`persona_prose_range_malformed:${range}`);
  const commits = historyOf(root, `${base}..${head}`);
  if (commits.length === 0) return blocked(`persona_prose_range_empty:${base}..${head}`);
  const findings = [];
  const unreadable = [];
  let proseCommits = 0;
  let changed = 0;
  let tip = emptyClosure().side;
  for (const commit of commits) {
    const before = commit.parent === null ? emptyClosure() : closureAt(root, commit.parent);
    const after = closureAt(root, commit.sha);
    unreadable.push(...before.side.unreadable, ...after.side.unreadable);
    tip = after.side;
    const changes = changedProse(before.side.prose, after.side.prose);
    if (changes.length === 0) continue;
    proseCommits += 1;
    changed += changes.length;
    const verdict = judge({
      changes,
      message: commit.message,
      revisionRecordUpdated: after.record !== before.record,
      label: commit.sha.slice(0, 8),
    });
    if (verdict.status !== "failed") continue;
    findings.push(`persona_prose_commit:${commit.sha.slice(0, 8)}:${changes.length} field(s)`);
    findings.push(...verdict.findings);
  }
  const lines = [
    `files examined ${tip.files} · prose fields ${tip.prose.size} · mode range · commits examined ${commits.length} · prose commits ${proseCommits} · changed ${changed}`,
    ...fileBreakdown(tip),
    ...findings,
  ];
  if (unreadable.length > 0) return blocked(`persona_prose_unreadable:${unreadable.join("; ")}`, lines);
  return { status: findings.length > 0 ? "failed" : "passed", reason: null, lines, findings };
}

/** `[{ sha, parent, message }]` for a range, in order, from ONE `git log`: four spawns per commit would dominate. */
export function historyOf(root, range) {
  const text = gitText(root, ["log", "--reverse", "--format=%x01%H%x01%P%x01%B%x01", range]);
  const parts = text.split("\u0001");
  const commits = [];
  for (let index = 1; index + 3 <= parts.length; index += 4)
    commits.push({
      sha: parts[index].trim(),
      parent: parts[index + 1].trim().split(" ")[0] || null,
      message: parts[index + 2],
    });
  return commits.filter((commit) => commit.sha !== "");
}

export function parseArgs(argv) {
  const value = (name) => {
    const index = argv.indexOf(name);
    return index >= 0 && argv[index + 1] !== undefined ? argv[index + 1] : null;
  };
  const messageFile = value("--message-file");
  const message = value("--message");
  if (messageFile !== null && message !== null) throw new Error("persona_prose_message_given_twice");
  const range = value("--range");
  const staged = argv.includes("--staged");
  if (staged && range !== null) throw new Error("persona_prose_staged_and_range");
  const root = value("--root") === null ? REPOSITORY_ROOT : resolve(value("--root"));
  return {
    root,
    mode: range !== null ? "range" : staged ? "staged" : "worktree",
    range,
    message: messageFile !== null ? readFileSync(messageFile, "utf8") : message,
  };
}

function main(argv) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 2;
    return;
  }
  let result;
  try {
    result = runCheck(options);
  } catch (error) {
    const cause = String(error?.stderr ?? "")
      .split("\n")
      .find((line) => line.trim().length > 0);
    console.log(`persona_prose_not_measured:${cause === undefined ? error.message : cause.trim()}`);
    process.exitCode = 2;
    return;
  }
  for (const line of result.lines) console.log(line);
  if (result.status === "blocked") {
    console.log(result.reason);
    process.exitCode = 2;
    return;
  }
  if (result.status === "failed") {
    console.log(
      `persona_prose_decision_missing: a commit that changes this prose carries \`${DELIBERATE_CHANGE_MARKER}\` in its message and adds one line to ${PERSONA_REVISION_FILE}; if this change is not yours to make, restore the file instead.`,
    );
    process.exitCode = 1;
    return;
  }
  console.log("persona_prose_unchanged");
  process.exitCode = 0;
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url)))
  main(process.argv.slice(2));
