#!/usr/bin/env node
/**
 * Vendor patch gate: every patch under `patches/vendor-magic-context/` must still fit the submodule it
 * patches - in BOTH states a checkout can be in - must actually introduce the extension point it declares,
 * and must be the only reason that extension point exists.
 *
 * WHY (the two accidents this prevents)
 *
 * `vendor/magic-context` is a git submodule we do not own, and GameBuddy has to change it: the single
 * authority for assembling the outgoing message array lives inside it, so SillyTavern preset segments
 * cannot be honoured anywhere else (design/architecture/tavern-preset-compatibility.md §2.3). The
 * upgrade path is therefore a patch file, not a fork - and a patch file rots silently. Upstream moves a
 * line, `git apply` stops matching, and nothing notices until someone upgrades the pin and the feature
 * is simply gone. The gate is the thing that notices.
 *
 * The second accident is quieter. The working tree is not what a clean checkout gets: an uncommitted edit
 * inside the submodule, or a checkout left on another commit, makes a patch fit HERE and stop fitting in
 * CI. A gate that reads only the working tree reports green until somebody else's build goes red, and the
 * answer it gives - "the patch applies" - is a fact about this machine, not about the pin.
 *
 * The third assertion is the one that expires the exemption: with NO patch applied, the extension point
 * must NOT exist. The day upstream ships an assembly seam of its own, that assertion turns red and names
 * the point - which is the signal to delete the patch, not to widen the gate.
 *
 * WHAT IS READ: THE POPULATION IS THE DIRECTORY, NOT A LIST
 *
 *   1. `patches/vendor-magic-context/*.patch` - every file, alphabetical. Zero files is `blocked`
 *      (`no_vendor_patches_found`), never `passed`: a gate whose population is empty agrees with itself.
 *   2. each patch's own header declares `kind:`, `added-lines:`, `modified-lines:` and one
 *      `extension-point:` per name it introduces; `kind: invasive` additionally requires
 *      `why-not-insertion:` (design §3.2).
 *   3. the patch's file list and line counts come from `git apply --numstat`, so the declared numbers are
 *      checked against the patch's real content rather than trusted.
 *
 * THE THREE READINGS, EACH WITH THE STATE IT READ
 *
 * Each patch is applied to a THROWAWAY copy - the pre-image written into a fresh `git init` directory under
 * the OS temp dir - so `vendor/**` is never written and the check needs no clean tree. The pre-image is read
 * TWICE, and that is the point of the gate:
 *
 *   - `applies-to-working-tree` seeds the copy from `vendor/magic-context` as this checkout has it ON DISK.
 *     This reading explains a red here and now.
 *   - `applies-to-pinned-commit` seeds it from the same files as `git show <pin>:<path>`, where `<pin>` is what
 *     the PARENT repository records for the submodule (`git ls-tree HEAD vendor/magic-context`). This reading
 *     is the one whose verdict travels to a clean checkout.
 *   - `extension-point` reads the applied copy for every declared hook, and the pre-image for their absence.
 *
 * Neither apply reading substitutes for the other, so neither is reported as the other: every reading prints
 * the state it read (`state=worktree`, `state=pin:e52ae3f8...`), and `<patch> <reading>: <verdict>` lines say
 * which verdict came from which state.
 *
 * NOT MEASURED IS ITS OWN VERDICT. A submodule with no git directory of its own (a source export), a parent
 * directory that is not a git repository, a HEAD that records no gitlink, or a pin naming an object the
 * submodule cannot read - each makes the pinned reading `not_measured` with that reason named
 * (`submodule_not_initialised`, `parent_git_unavailable`, `submodule_pin_unrecorded`,
 * `pin_commit_unreadable`). It is not a pass, and it is not a failure of the whole gate: the working-tree
 * reading still runs and still turns red on its own. The run then reports `status: not_measured` and prints
 * `vendor_patches_skipped: <reading> <reason>` on stdout, which `tools/prelive.mjs` counts as UNAVAILABLE
 * rather than passed.
 *
 * THE THREE ASSERTIONS
 *
 *   (a) `git apply --check` succeeds against BOTH states - the working tree and the pinned commit;
 *   (b) after applying, every declared `extension-point:` exists in the copy, and every touched
 *       TypeScript file still parses (TypeScript's own parser, diagnostics only - not a typecheck);
 *   (c) with no patch applied, every declared extension point is ABSENT (the patch is load-bearing).
 *
 * Output: one JSON verdict
 * `{"gate":"vendor-patches-apply","examined":N,"files":N,"extensionPoints":N,"violations":[],"readings":[],
 * "checks":[],"status":...}` - `readings` is one entry per patch per reading (`{patch, reading, state, status,
 * reason}`), so the report cannot say `passed` without saying which state it read - and the line
 * `vendor_patches: examined N patch(es), ... N reading(s) ...`. `status` is `blocked` when there is nothing to
 * measure (no patches, no submodule, no TypeScript parser), `not_measured` when the pin could not be read, and
 * `failed` when a patch is wrong. Exit 0 for `passed` and `not_measured`, 1 otherwise.
 *
 * Usage:
 *   node tools/check-vendor-patches-apply.mjs                    # this repository
 *   node tools/check-vendor-patches-apply.mjs --root <dir>       # a fixture tree
 *
 * red-proof: inject  edit one line of the WORKING-TREE copy of the seam file - the `cacheTtlConfig` context
 *            line the shipped patch's second hunk anchors on - in a fixture whose pinned commit still holds
 *            it. Observed, with the real patch and the real seam file (`.tmp/red-proof-pinned.mjs`):
 *
 *              exit 1
 *              vendor_patch_does_not_apply:0001-preset-assembly-seam.patch:packages/pi-plugin/src/context-handler.ts
 *              0001-preset-assembly-seam.patch applies-to-working-tree: failed (state=worktree)
 *              0001-preset-assembly-seam.patch applies-to-pinned-commit: passed (state=pin:7abcd8e3...)
 *              vendor_patches: examined 1 patch(es), ... 3 reading(s), 1 violation(s) [failed]
 *
 *            Restoring that one line: both readings `passed`, `0 violation(s)`, exit 0.
 *
 *            THAT ASYMMETRY IS THE DEFECT CLASS THIS READING CLOSES. The old gate read only the working
 *            tree, so the dirty checkout above was green here and red in CI. A second case drives the other
 *            direction - a pin that drifted away from a locally repaired working tree - where the pinned
 *            reading is the only red one. Both live in tools/check-vendor-patches-apply.test.mjs, beside
 *            the four not_measured reasons and the skip marker prelive reads.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PATCH_DIRECTORY = ["patches", "vendor-magic-context"];
const SUBMODULE_DIRECTORY = ["vendor", "magic-context"];
const MAX_MODIFIED_LINES_PER_FILE = 10;
const PARSEABLE = /\.(?:ts|tsx|mts|cts)$/u;
/** The three readings, by the name the report prints. One spelling, used by every site that names them. */
const READING = Object.freeze({
  workingTree: "applies-to-working-tree",
  pinned: "applies-to-pinned-commit",
  extensionPoint: "extension-point",
});

/** A patch's own declarations, read only from the mail body - never from the diff it carries. */
export function parseVendorPatchHeader(text) {
  // Cut at the mail separator OR at the first hunk header: a diff that ADDS a line spelling `kind: invasive`
  // inside a TypeScript file must not be able to rewrite the declaration this gate reads.
  const cuts = [text.indexOf("\n---\n"), text.indexOf("\ndiff --git ")].filter((index) => index !== -1);
  const body = cuts.length === 0 ? text : text.slice(0, Math.min(...cuts));
  const declared = { kind: null, addedLines: null, modifiedLines: null, extensionPoints: [], whyNotInsertion: null };
  for (const line of body.split(/\r?\n/u)) {
    const field = /^([a-z][a-z-]*):\s*(.*)$/u.exec(line.trim());
    if (field === null) continue;
    const [, name, value] = field;
    if (name === "kind") declared.kind = value.trim();
    else if (name === "added-lines") declared.addedLines = /^\d+$/u.test(value.trim()) ? Number(value) : Number.NaN;
    else if (name === "modified-lines")
      declared.modifiedLines = /^\d+$/u.test(value.trim()) ? Number(value) : Number.NaN;
    else if (name === "extension-point") declared.extensionPoints.push(value.trim());
    else if (name === "why-not-insertion") declared.whyNotInsertion = value.trim();
  }
  return declared;
}

/** Files the patch CREATES, from `git apply --summary` (they have no pre-image to find). */
function patchCreatedFiles(patchPath) {
  const summary = execFileSync("git", ["-c", "core.autocrlf=false", "apply", "--summary", patchPath], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  const created = new Set();
  for (const line of summary.split(/\r?\n/u)) {
    const match = /^\s*create mode \d+ (.+)$/u.exec(line);
    if (match !== null) created.add(match[1].trim());
  }
  return created;
}

/** `git apply --numstat`: the patch's own file list and per-file line counts. */
function patchNumstat(patchPath) {
  return execFileSync("git", ["-c", "core.autocrlf=false", "apply", "--numstat", patchPath], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  })
    .split(/\r?\n/u)
    .filter((line) => line.trim() !== "")
    .map((line) => {
      const [added, removed, ...rest] = line.split("\t");
      return { file: rest.join("\t"), added: Number(added), removed: Number(removed) };
    })
    .filter((entry) => Number.isFinite(entry.added) && Number.isFinite(entry.removed) && entry.file !== "");
}

/**
 * The TypeScript parser, resolved the way the product resolves it (through `host`), because the gate
 * reads `.ts` files and Node cannot. Absent, the gate is `not_measured`, never green.
 */
function resolveTypeScript(root) {
  const candidates = [
    join(root, "host", "package.json"),
    join(root, "package.json"),
    // A fixture tree borrows this checkout's parser: the parser is the gate's instrument, not its
    // subject, so a fixture does not have to carry a `node_modules` to be measurable.
    join(REPOSITORY_ROOT, "host", "package.json"),
    join(REPOSITORY_ROOT, "package.json"),
  ];
  for (const from of candidates) {
    if (!existsSync(from)) continue;
    try {
      return createRequire(from)("typescript");
    } catch {}
  }
  return null;
}

/** What git said, in its own words - the detail a violation carries instead of a paraphrase. */
function gitReason(error) {
  return `${String(error.stderr ?? "").trim() || String(error.message ?? error)}`.trim();
}

/** A git call that reports failure instead of throwing: the pin probe must tell "no git" from "no pin". */
function gitProbe(cwd, args) {
  try {
    return {
      ok: true,
      text: execFileSync("git", ["-c", "core.autocrlf=false", ...args], {
        cwd,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      }),
      error: null,
    };
  } catch (error) {
    return { ok: false, text: "", error: gitReason(error) };
  }
}

/**
 * The commit the PARENT repository records for the submodule - what a clean checkout gets - or the reason that
 * cannot be read. There is deliberately no fallback to the working tree: "could not read the pin" and "the pin
 * agrees" are different facts, and reporting the second as the first is the accident this reading exists for.
 */
function readSubmodulePin(root, submoduleDirectory) {
  const parent = gitProbe(root, ["rev-parse", "--git-dir"]);
  if (!parent.ok) return { sha: null, reason: "parent_git_unavailable", detail: parent.error };
  const entry = gitProbe(root, ["ls-tree", "HEAD", "--", "vendor/magic-context"]);
  if (!entry.ok) return { sha: null, reason: "submodule_pin_unrecorded", detail: entry.error };
  const line = entry.text.split(/\r?\n/u).find((candidate) => candidate.trim() !== "") ?? "";
  const match = /^160000 commit ([0-9a-f]{40})\t/u.exec(line);
  if (match === null) {
    return {
      sha: null,
      reason: "submodule_pin_unrecorded",
      detail: `git ls-tree HEAD -- vendor/magic-context printed ${JSON.stringify(line)}; a gitlink (mode 160000) is required`,
    };
  }
  const sha = match[1];
  // An empty submodule directory is still inside the PARENT work tree, so git answers cheerfully from there.
  // `--show-cdup` is empty only when the directory IS the root of a work tree of its own, which is the fact that
  // tells "this submodule is initialised" from "this path belongs to someone else's checkout".
  const cdup = gitProbe(submoduleDirectory, ["rev-parse", "--show-cdup"]);
  if (!cdup.ok) return { sha, reason: "submodule_not_initialised", detail: cdup.error };
  const levelsUp = cdup.text.trim();
  if (levelsUp !== "") {
    return {
      sha,
      reason: "submodule_not_initialised",
      detail: `${submoduleDirectory} is not the root of its own work tree: git puts it ${levelsUp} below the work tree it found`,
    };
  }
  const commit = gitProbe(submoduleDirectory, ["cat-file", "-e", `${sha}^{commit}`]);
  if (!commit.ok) return { sha, reason: "pin_commit_unreadable", detail: commit.error };
  return { sha, reason: null, detail: null };
}

/** The pinned text of the files the patch touches - as the pin has them, not as this checkout has them. */
function pinnedPreImage(submoduleDirectory, sha, files, created) {
  const seed = [];
  const missing = [];
  for (const file of files) {
    if (created.has(file)) continue;
    const object = `${sha}:${file}`;
    const shown = gitProbe(submoduleDirectory, ["show", object]);
    if (!shown.ok) {
      // `show` fails the same way for a path the pin does not have and for an object it cannot read.
      if (gitProbe(submoduleDirectory, ["cat-file", "-e", object]).ok) {
        return { seed: [], missing: [], reason: "pin_object_unreadable", detail: shown.error };
      }
      missing.push(file);
      continue;
    }
    seed.push({ file, text: shown.text });
  }
  return { seed, missing, reason: null, detail: null };
}

/**
 * One throwaway tree per reading per patch, so a failure in one cannot mask or corrupt the next: `git init`, the
 * pre-image written in from whichever state this reading reads, then the patch. `dryRun` stops after
 * `git apply --check`, which is all a reading needs when nothing downstream will read the applied result.
 */
function applyToThrowawayCopy(patch, seed, { dryRun = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), "vendor-patch-"));
  const git = (...args) =>
    execFileSync("git", ["-c", "core.autocrlf=false", ...args], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  try {
    for (const { file, text } of seed) {
      const destination = join(root, file);
      mkdirSync(dirname(destination), { recursive: true });
      writeFileSync(destination, text, "utf8");
    }
    git("init", "-q");
    let checkError = null;
    let applyError = null;
    try {
      git("apply", "--check", patch);
    } catch (error) {
      checkError = gitReason(error);
    }
    if (checkError === null && !dryRun) {
      try {
        git("apply", patch);
      } catch (error) {
        applyError = gitReason(error);
      }
    }
    return { root, checkError, applyError };
  } catch (error) {
    rmSync(root, { recursive: true, force: true });
    throw error;
  }
}

function parseFailure(typescript, file, text) {
  const transpiled = typescript.transpileModule(text, {
    fileName: file,
    reportDiagnostics: true,
    compilerOptions: { target: typescript.ScriptTarget.ESNext, module: typescript.ModuleKind.ESNext },
  });
  const errors = (transpiled.diagnostics ?? []).filter(
    (diagnostic) => diagnostic.category === typescript.DiagnosticCategory.Error,
  );
  if (errors.length === 0) return null;
  const first = errors[0];
  const where =
    first.file === undefined || typeof first.start !== "number"
      ? ""
      : `:${first.file.getLineAndCharacterOfPosition(first.start).line + 1}`;
  return `${file}${where}: ${typescript.flattenDiagnosticMessageText(first.messageText, " ")}`;
}

/**
 * A rule's own verdict. `not_measured` is its own answer - a prerequisite was absent, so the rule never got to look
 * and says why - and `blocked` is an empty population, which is not the same fact and must not be spelled the same.
 */
function ruleOutcome(rule) {
  if (rule.failed > 0) return "failed";
  if (rule.reasons.length > 0) return "not_measured";
  return rule.measured > 0 ? "passed" : "blocked";
}

export function checkVendorPatchesApply({ root = REPOSITORY_ROOT } = {}) {
  const patchDirectory = join(root, ...PATCH_DIRECTORY);
  const submoduleDirectory = join(root, ...SUBMODULE_DIRECTORY);
  const violations = [];
  // The rules this gate enumerates. Each reports its own outcome (with the population it measured), so
  // the default run's JSON is a self-verification report and not a summary sentence.
  const rules = new Map(
    [
      ["header", { id: "patch_header_declares_kind_and_size", state: null }],
      ["worktree", { id: "patch_applies_to_working_tree", state: "worktree" }],
      ["pinned", { id: "patch_applies_to_pinned_commit", state: "pin:unknown" }],
      ["present", { id: "extension_point_present_after_apply", state: "worktree" }],
      ["parses", { id: "patched_file_parses", state: "worktree" }],
      ["absent", { id: "extension_point_absent_without_patch", state: "worktree" }],
    ].map(([rule, spec]) => [rule, { ...spec, measured: 0, failed: 0, reasons: [] }]),
  );
  // Every reading prints the state it read, so a green verdict cannot be mistaken for a verdict about the pin.
  const readings = [];
  const record = (patchName, reading, state, status, reason = null) => {
    readings.push({ patch: patchName, reading, state, status, ...(reason === null ? {} : { reason }) });
  };
  const fail = (rule, violation) => {
    rules.get(rule).failed += 1;
    violations.push(violation);
  };
  const measure = (rule) => {
    rules.get(rule).measured += 1;
  };
  const patches = existsSync(patchDirectory)
    ? readdirSync(patchDirectory)
        .filter((entry) => entry.endsWith(".patch"))
        .sort()
    : [];
  const result = {
    gate: "vendor-patches-apply",
    examined: 0,
    files: 0,
    extensionPoints: 0,
    violations,
    readings,
    checks: [],
    status: "blocked",
  };
  const finish = () => {
    result.checks = [...rules.values()].map((rule) => ({
      id: rule.id,
      status: ruleOutcome(rule),
      measured: rule.measured,
      failed: rule.failed,
      state: rule.state,
      ...(rule.reasons.length === 0 ? {} : { reason: rule.reasons[0] }),
    }));
    const failed = violations.length > 0 || result.checks.some((check) => check.status === "failed");
    const unmeasured = result.checks.some((check) => check.status === "not_measured");
    if (result.examined === 0) result.status = "blocked";
    else if (failed) result.status = "failed";
    else if (unmeasured) result.status = "not_measured";
    else if (result.checks.every((check) => check.status === "passed")) result.status = "passed";
    else result.status = "blocked";
    return result;
  };

  if (patches.length === 0) {
    violations.push({
      code: "no_vendor_patches_found",
      expected: `${patchDirectory}/*.patch`,
      detail: "a patch gate with no patch has measured nothing; it has not passed",
    });
    return finish();
  }
  if (!existsSync(submoduleDirectory)) {
    violations.push({
      code: "vendor_submodule_missing",
      expected: submoduleDirectory,
      detail: "run `git submodule update --init vendor/magic-context`; without it no patch can be checked",
    });
    return finish();
  }
  const typescript = resolveTypeScript(root);
  if (typescript === null) {
    violations.push({
      code: "typescript_unavailable",
      expected: "typescript resolvable from host/package.json",
      detail: "assertion (b) needs a parser for the patched TypeScript; nothing was measured",
    });
    return finish();
  }

  const seenFiles = new Set();
  // The pin is read once, before any patch, and every reading prints the state it read. When it cannot be read the
  // reason is named on the rule, so the whole run reports `not_measured` rather than a verdict about the working tree.
  const pin = readSubmodulePin(root, submoduleDirectory);
  rules.get("pinned").state = pin.sha === null ? "pin:unavailable" : `pin:${pin.sha}`;
  for (const name of patches) {
    const patch = join(patchDirectory, name);
    const declared = parseVendorPatchHeader(readFileSync(patch, "utf8"));

    if (declared.kind !== "additive" && declared.kind !== "invasive") {
      fail("header", {
        code: `vendor_patch_kind_invalid:${name}`,
        expected: "kind: additive | kind: invasive",
        detail: `declared ${declared.kind === null ? "nothing" : `"${declared.kind}"`}; design §3.2 requires the kind`,
      });
      continue;
    }
    if (declared.addedLines === null || declared.modifiedLines === null) {
      fail("header", {
        code: `vendor_patch_line_counts_undeclared:${name}`,
        expected: "added-lines: <n> and modified-lines: <n> in the patch header",
        detail: "the numbers are what a reader uses to judge the patch's size before reading it",
      });
      continue;
    }
    if (declared.extensionPoints.length === 0) {
      fail("header", {
        code: `vendor_patch_extension_point_undeclared:${name}`,
        expected: "extension-point: <name>",
        detail: "assertions (b) and (c) have nothing to look for without it",
      });
      continue;
    }
    const nonIdentifier = declared.extensionPoints.filter((point) => !/^[A-Za-z_$][\w$]*$/u.test(point));
    for (const point of nonIdentifier) {
      fail("header", {
        code: `vendor_patch_extension_point_invalid:${name}:${point}`,
        expected: "a TypeScript identifier",
        detail: "declare the hook's name, not a description of it",
      });
    }
    if (nonIdentifier.length > 0) continue;

    let numstat;
    try {
      numstat = patchNumstat(patch);
    } catch (error) {
      fail("header", {
        code: `vendor_patch_unreadable:${name}`,
        expected: "a git-appliable patch",
        detail: `${String(error.stderr ?? "").trim() || String(error.message ?? error)}`.trim(),
      });
      continue;
    }
    if (numstat.length === 0) {
      fail("header", {
        code: `vendor_patch_touches_nothing:${name}`,
        expected: "at least one file in the diff",
        detail: "git parsed the patch and found no file to change",
      });
      continue;
    }
    result.examined += 1;

    const added = numstat.reduce((total, entry) => total + entry.added, 0);
    const modified = numstat.reduce((total, entry) => total + entry.removed, 0);
    if (added !== declared.addedLines) {
      fail("header", {
        code: `vendor_patch_declared_added_mismatch:${name}`,
        expected: `added-lines: ${added} (what the diff holds)`,
        detail: `the header says ${declared.addedLines}; a patch that miscounts itself cannot be trusted on kind`,
      });
    }
    if (modified !== declared.modifiedLines) {
      fail("header", {
        code: `vendor_patch_declared_modified_mismatch:${name}`,
        expected: `modified-lines: ${modified} (what the diff holds)`,
        detail: `the header says ${declared.modifiedLines}`,
      });
    }
    for (const entry of numstat.filter((candidate) => candidate.removed > MAX_MODIFIED_LINES_PER_FILE)) {
      fail("header", {
        code: `vendor_patch_modified_over_budget:${name}:${entry.file}`,
        expected: `at most ${MAX_MODIFIED_LINES_PER_FILE} modified lines in one file`,
        detail: `${entry.removed} removed here; design §3.2 says split the patch or change the design`,
      });
    }
    if (declared.kind === "additive" && modified !== 0) {
      fail("header", {
        code: `vendor_patch_additive_with_modifications:${name}`,
        expected: "kind: invasive",
        detail: `declared additive but ${modified} line(s) are removed or rewritten`,
      });
    }
    if (declared.kind === "invasive") {
      if (declared.whyNotInsertion === null || declared.whyNotInsertion === "") {
        fail("header", {
          code: `vendor_patch_invasive_without_reason:${name}`,
          expected: "why-not-insertion: <why insertion alone was impossible>",
          detail: "design §3.2 requires it for every invasive patch",
        });
      }
      if (modified === 0) {
        fail("header", {
          code: `vendor_patch_invasive_without_modifications:${name}`,
          expected: "kind: additive",
          detail: "nothing is modified, so nothing is invasive; the kind overstates the patch",
        });
      }
    }
    if (rules.get("header").failed === 0) measure("header");

    const files = numstat.map((entry) => entry.file);
    for (const file of files) seenFiles.add(file);
    const created = patchCreatedFiles(patch);

    // Reading 1: the state this checkout currently has on disk - the reading that explains a red here and now.
    const worktreeSeed = [];
    const worktreeMissing = [];
    for (const file of files) {
      if (created.has(file)) continue;
      const source = join(submoduleDirectory, file);
      if (!existsSync(source)) {
        worktreeMissing.push(file);
        continue;
      }
      worktreeSeed.push({ file, text: readFileSync(source, "utf8") });
    }
    const worktreeCopy = worktreeMissing.length === 0 ? applyToThrowawayCopy(patch, worktreeSeed) : null;
    try {
      let worktreeStatus = "failed";
      for (const file of worktreeMissing) {
        fail("worktree", {
          code: `vendor_patch_file_missing:${name}:${file}`,
          expected: join(submoduleDirectory, file),
          detail: "the patch targets a file the submodule working tree does not have",
        });
      }
      if (worktreeCopy !== null && worktreeCopy.checkError !== null) {
        fail("worktree", {
          code: `vendor_patch_does_not_apply:${name}:${files.join(",")}`,
          expected: "git apply --check against the submodule working tree",
          detail: worktreeCopy.checkError,
        });
      } else if (worktreeCopy !== null && worktreeCopy.applyError !== null) {
        fail("worktree", {
          code: `vendor_patch_apply_failed:${name}:${files.join(",")}`,
          expected: "git apply against a throwaway copy",
          detail: worktreeCopy.applyError,
        });
      } else if (worktreeCopy !== null) {
        measure("worktree");
        worktreeStatus = "passed";
      }
      record(name, READING.workingTree, "worktree", worktreeStatus);

      // Reading 2: the pinned commit - what a clean checkout gets, and the verdict that travels to CI. Its own
      // pre-image, from the submodule's own git, never from the files on disk beside it.
      let pinnedStatus = "not_measured";
      if (pin.sha === null || pin.reason !== null) {
        rules.get("pinned").reasons.push(`${pin.reason}: ${pin.detail}`);
        const state = pin.sha === null ? "pin:unavailable" : `pin:${pin.sha}`;
        record(name, READING.pinned, state, pinnedStatus, pin.reason);
      } else {
        const state = `pin:${pin.sha}`;
        const preImage = pinnedPreImage(submoduleDirectory, pin.sha, files, created);
        if (preImage.reason !== null) {
          rules.get("pinned").reasons.push(`${preImage.reason}: ${preImage.detail}`);
          record(name, READING.pinned, state, pinnedStatus, preImage.reason);
        } else if (preImage.missing.length > 0) {
          pinnedStatus = "failed";
          for (const file of preImage.missing) {
            fail("pinned", {
              code: `vendor_patch_file_missing_from_pin:${name}:${file}`,
              expected: `${pin.sha}:${file}`,
              detail: "the patch targets a file the pinned submodule commit does not have",
            });
          }
          record(name, READING.pinned, state, pinnedStatus);
        } else {
          const pinnedCopy = applyToThrowawayCopy(patch, preImage.seed, { dryRun: true });
          try {
            if (pinnedCopy.checkError !== null) {
              fail("pinned", {
                code: `vendor_patch_does_not_apply_to_pin:${name}:${files.join(",")}`,
                expected: `git apply --check against ${pin.sha}, the commit the parent repository records`,
                detail: pinnedCopy.checkError,
              });
              pinnedStatus = "failed";
            } else {
              measure("pinned");
              pinnedStatus = "passed";
            }
          } finally {
            rmSync(pinnedCopy.root, { recursive: true, force: true });
          }
          record(name, READING.pinned, state, pinnedStatus);
        }
      }

      // Reading 3, and assertions (b) and (c): what the patch introduces, read from the copy it was applied to.
      let extensionStatus = "blocked";
      if (worktreeStatus === "passed") {
        const applied = files
          .filter((file) => existsSync(join(worktreeCopy.root, file)))
          .map((file) => ({ file, text: readFileSync(join(worktreeCopy.root, file), "utf8") }));
        let extensionFailed = false;
        for (const point of declared.extensionPoints) {
          result.extensionPoints += 1;
          if (applied.some((entry) => entry.text.includes(point))) {
            measure("present");
            continue;
          }
          extensionFailed = true;
          fail("present", {
            code: `vendor_patch_extension_point_missing:${name}:${point}`,
            expected: `${point} present after applying`,
            detail: "declared, but no patched file contains it; the header and the diff disagree",
          });
        }
        for (const entry of applied.filter((candidate) => PARSEABLE.test(candidate.file))) {
          const failure = parseFailure(typescript, entry.file, entry.text);
          if (failure === null) {
            measure("parses");
            continue;
          }
          fail("parses", {
            code: `vendor_patch_parse_failed:${name}:${entry.file}`,
            expected: "the patched file parses",
            detail: failure,
          });
        }
        // (c) without the patch, the extension points are absent - the patch is load-bearing. Read from the
        // working tree, and the reading below says so.
        const pristine = files
          .filter((file) => existsSync(join(submoduleDirectory, file)))
          .map((file) => ({ file, text: readFileSync(join(submoduleDirectory, file), "utf8") }));
        for (const point of declared.extensionPoints) {
          const carrier = pristine.find((entry) => entry.text.includes(point));
          if (carrier === undefined) {
            measure("absent");
            continue;
          }
          extensionFailed = true;
          fail("absent", {
            code: `vendor_patch_extension_point_present_unpatched:${name}:${point}`,
            expected: `${point} absent from ${carrier.file}`,
            detail:
              "the submodule already has it: delete this patch (upstream shipped the seam) rather than keep a patch that changes nothing",
          });
        }
        extensionStatus = extensionFailed ? "failed" : "passed";
      }
      record(
        name,
        READING.extensionPoint,
        "worktree",
        extensionStatus,
        extensionStatus === "blocked"
          ? "the patch did not apply to the working tree, so no applied copy was read"
          : null,
      );
    } finally {
      if (worktreeCopy !== null) rmSync(worktreeCopy.root, { recursive: true, force: true });
    }
  }

  // A patch rejected at its header never reached an apply. It still gets its three readings, blocked and named: a
  // report that silently omitted them would read as a smaller population rather than an unreached one.
  for (const name of patches) {
    if (readings.some((entry) => entry.patch === name)) continue;
    const reason = "the patch was rejected before any apply was attempted";
    record(name, READING.workingTree, "worktree", "blocked", reason);
    record(name, READING.pinned, rules.get("pinned").state, "blocked", reason);
    record(name, READING.extensionPoint, "worktree", "blocked", reason);
  }

  result.files = seenFiles.size;
  return finish();
}

function report(result, out = process.stdout, err = process.stderr) {
  for (const violation of result.violations) {
    err.write(`${violation.code}\n`);
    err.write(`  expected: ${violation.expected}\n`);
    err.write(`  ${violation.detail}\n`);
  }
  // One line per patch per reading, each carrying the state it read: a verdict whose state is unstated is a verdict
  // the reader has to assume, and the whole point of the pinned reading is that the assumption was wrong before.
  for (const reading of result.readings) {
    err.write(
      `${reading.patch} ${reading.reading}: ${reading.status} (state=${reading.state})` +
        `${reading.reason === undefined ? "" : ` reason=${reading.reason}`}\n`,
    );
  }
  for (const check of result.checks) {
    err.write(
      `${check.id}: ${check.status} (measured ${check.measured}, failed ${check.failed})` +
        `${check.state === null ? "" : ` state=${check.state}`}` +
        `${check.reason === undefined ? "" : ` reason=${check.reason}`}\n`,
    );
  }
  if (result.status === "not_measured") {
    const reasons = result.checks
      .filter((check) => check.status === "not_measured")
      .map((check) => `${check.id} ${check.reason}`);
    out.write(`vendor_patches_skipped: ${reasons.join("; ")}\n`);
  }
  err.write(
    `vendor_patches: examined ${result.examined} patch(es), ${result.files} file(s), ` +
      `${result.extensionPoints} extension point(s), ${result.readings.length} reading(s), ` +
      `${result.violations.length} violation(s) [${result.status}]\n`,
  );
  out.write(`${JSON.stringify(result)}\n`);
  return result.status === "passed" || result.status === "not_measured" ? 0 : 1;
}

function argumentAfter(argv, flag) {
  const index = argv.indexOf(flag);
  return index === -1 ? null : (argv[index + 1] ?? null);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  const root = argumentAfter(process.argv.slice(2), "--root") ?? REPOSITORY_ROOT;
  process.exitCode = report(checkVendorPatchesApply({ root }));
}
