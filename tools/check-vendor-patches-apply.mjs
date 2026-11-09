#!/usr/bin/env node
/**
 * Vendor patch gate: every patch under `patches/vendor-magic-context/` must still fit the submodule it
 * patches, must actually introduce the extension point it declares, and must be the only reason that
 * extension point exists.
 *
 * WHY (the accident this prevents)
 *
 * `vendor/magic-context` is a git submodule we do not own, and GameBuddy has to change it: the single
 * authority for assembling the outgoing message array lives inside it, so SillyTavern preset segments
 * cannot be honoured anywhere else (design/architecture/tavern-preset-compatibility.md §2.3). The
 * upgrade path is therefore a patch file, not a fork - and a patch file rots silently. Upstream moves a
 * line, `git apply` stops matching, and nothing notices until someone upgrades the pin and the feature
 * is simply gone. The gate is the thing that notices.
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
 * Each patch is then applied to a THROWAWAY copy - the touched files copied into a fresh `git init`
 * directory under the OS temp dir - so `vendor/**` is never written and the check needs no clean tree.
 *
 * THE THREE ASSERTIONS
 *
 *   (a) `git apply --check` succeeds against the CURRENT submodule content;
 *   (b) after applying, every declared `extension-point:` exists in the copy, and every touched
 *       TypeScript file still parses (TypeScript's own parser, diagnostics only - not a typecheck);
 *   (c) with no patch applied, every declared extension point is ABSENT (the patch is load-bearing).
 *
 * Output: one JSON verdict
 * `{"gate":"vendor-patches-apply","examined":N,"files":N,"extensionPoints":N,"violations":[],"status":...}`
 * and the line `examined N patch(es)`. `status` is `blocked` when there is nothing to measure (no
 * patches, no submodule, no TypeScript parser) and `failed` when a patch is wrong.
 *
 * Usage:
 *   node tools/check-vendor-patches-apply.mjs                    # this repository
 *   node tools/check-vendor-patches-apply.mjs --root <dir>       # a fixture tree
 *
 * red-proof: inject  change one context line of the patch (e.g. the `cacheTtlConfig` line it anchors on)
 *            -> `vendor_patch_does_not_apply:<patch>:packages/pi-plugin/src/context-handler.ts` with git's
 *            own `error: patch failed` text, exit 1. Restore -> `examined 1 patch(es)`, exit 0
 *            (tools/check-vendor-patches-apply.test.mjs drives the same function over fixture trees).
 */
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PATCH_DIRECTORY = ["patches", "vendor-magic-context"];
const SUBMODULE_DIRECTORY = ["vendor", "magic-context"];
const MAX_MODIFIED_LINES_PER_FILE = 10;
const PARSEABLE = /\.(?:ts|tsx|mts|cts)$/u;

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

function copyInto(targetRoot, submoduleDirectory, file) {
  const source = join(submoduleDirectory, file);
  if (!existsSync(source)) return false;
  const destination = join(targetRoot, file);
  mkdirSync(dirname(destination), { recursive: true });
  copyFileSync(source, destination);
  return true;
}

/** One throwaway tree per patch, so a failure in one patch cannot mask or corrupt the next. */
function applyToThrowawayCopy(patch, submoduleDirectory, files, created) {
  const root = mkdtempSync(join(tmpdir(), "vendor-patch-"));
  const git = (...args) =>
    execFileSync("git", ["-c", "core.autocrlf=false", ...args], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  try {
    const absent = files.filter((file) => !(created.has(file) || copyInto(root, submoduleDirectory, file)));
    git("init", "-q");
    let checkError = null;
    let applyError = null;
    if (absent.length === 0) {
      try {
        git("apply", "--check", patch);
      } catch (error) {
        checkError = `${String(error.stderr ?? "").trim() || String(error.message ?? error)}`.trim();
      }
      if (checkError === null) {
        try {
          git("apply", patch);
        } catch (error) {
          applyError = `${String(error.stderr ?? "").trim() || String(error.message ?? error)}`.trim();
        }
      }
    }
    return { root, absent, checkError, applyError };
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

/** A rule's own verdict: failed if it caught something, blocked if it never got to look. */
function ruleOutcome(rule) {
  if (rule.failed > 0) return "failed";
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
      ["header", "patch_header_declares_kind_and_size"],
      ["applies", "patch_applies_to_current_submodule"],
      ["present", "extension_point_present_after_apply"],
      ["parses", "patched_file_parses"],
      ["absent", "extension_point_absent_without_patch"],
    ].map(([rule, id]) => [rule, { id, measured: 0, failed: 0 }]),
  );
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
    checks: [],
    status: "blocked",
  };
  const finish = () => {
    result.checks = [...rules.values()].map((rule) => ({
      id: rule.id,
      status: ruleOutcome(rule),
      measured: rule.measured,
      failed: rule.failed,
    }));
    const clean = violations.length === 0 && result.checks.every((check) => check.status === "passed");
    if (result.examined === 0) result.status = "blocked";
    else result.status = clean ? "passed" : "failed";
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
    const copy = applyToThrowawayCopy(patch, submoduleDirectory, files, patchCreatedFiles(patch));
    try {
      for (const file of copy.absent) {
        fail("applies", {
          code: `vendor_patch_file_missing:${name}:${file}`,
          expected: join(submoduleDirectory, file),
          detail: "the patch targets a file the pinned submodule does not have",
        });
      }
      if (copy.checkError !== null) {
        fail("applies", {
          code: `vendor_patch_does_not_apply:${name}:${files.join(",")}`,
          expected: "git apply --check against the current submodule content",
          detail: copy.checkError,
        });
      } else if (copy.applyError !== null) {
        fail("applies", {
          code: `vendor_patch_apply_failed:${name}:${files.join(",")}`,
          expected: "git apply against a throwaway copy",
          detail: copy.applyError,
        });
      } else {
        measure("applies");
        // (b) the declared extension points exist in the applied copy, and it still parses.
        const applied = files
          .filter((file) => existsSync(join(copy.root, file)))
          .map((file) => ({ file, text: readFileSync(join(copy.root, file), "utf8") }));
        for (const point of declared.extensionPoints) {
          result.extensionPoints += 1;
          if (applied.some((entry) => entry.text.includes(point))) {
            measure("present");
            continue;
          }
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
        // (c) without the patch, the extension points are absent - the patch is load-bearing.
        const pristine = files
          .filter((file) => existsSync(join(submoduleDirectory, file)))
          .map((file) => ({ file, text: readFileSync(join(submoduleDirectory, file), "utf8") }));
        for (const point of declared.extensionPoints) {
          const carrier = pristine.find((entry) => entry.text.includes(point));
          if (carrier === undefined) {
            measure("absent");
            continue;
          }
          fail("absent", {
            code: `vendor_patch_extension_point_present_unpatched:${name}:${point}`,
            expected: `${point} absent from ${carrier.file}`,
            detail:
              "the pinned submodule already has it: delete this patch (upstream shipped the seam) rather than keep a patch that changes nothing",
          });
        }
      }
    } finally {
      rmSync(copy.root, { recursive: true, force: true });
    }
    for (const file of files) seenFiles.add(file);
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
  for (const check of result.checks) {
    err.write(`${check.id}: ${check.status} (measured ${check.measured}, failed ${check.failed})\n`);
  }
  err.write(
    `vendor_patches: examined ${result.examined} patch(es), ${result.files} file(s), ` +
      `${result.extensionPoints} extension point(s), ${result.violations.length} violation(s) [${result.status}]\n`,
  );
  out.write(`${JSON.stringify(result)}\n`);
  return result.status === "passed" ? 0 : 1;
}

function argumentAfter(argv, flag) {
  const index = argv.indexOf(flag);
  return index === -1 ? null : (argv[index + 1] ?? null);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  const root = argumentAfter(process.argv.slice(2), "--root") ?? REPOSITORY_ROOT;
  process.exitCode = report(checkVendorPatchesApply({ root }));
}
