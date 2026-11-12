/**
 * The gate's falsifiers. Each case builds a throwaway tree (`patches/vendor-magic-context/*.patch` plus the
 * submodule content those patches speak about), so the assertion is about what the gate READS, not about this
 * repository's current state - the real-tree case below covers that.
 *
 * A `sealedTree` fixture carries BOTH states the way a checkout does: `vendor/magic-context` is a git repository
 * whose committed content is the pin, the parent repository records that commit as a gitlink, and the files on
 * disk are the working tree - identical to the pin unless the case is about a dirty submodule.
 *
 * red-proof: inject  edit one context line of the WORKING-TREE copy of the seam file (the `cacheTtlConfig` anchor
 *            the shipped patch matches on) while the pin still holds it -> `applies-to-working-tree: failed`
 *            with git's own `error: patch failed` (`vendor_patch_does_not_apply`), `applies-to-pinned-commit:
 *            passed (state=pin:<sha>)`, status `failed`. Restoring the line turns both green. The mirror case -
 *            a pin that drifted away from a locally repaired working tree - is the same asymmetry inverted: the
 *            pinned reading is the only red one, and it is the verdict a clean checkout would get.
 *
 *            THE SEALED POPULATION: leave the sealed counter at the patch count (`result.examined` still 0 while
 *            every declared extension point is verified at the pin) -> the shared judge answers
 *            `gate_zero_population_allowed:vendor-patches-apply:examined` for a run that passed, and the case
 *            "a pin carrying the seam is passed" fails on `assertNonVacuous(reported)?.status` expecting
 *            `passed`. That is the census entry this file now refuses: a green sealed run is a measurement of
 *            `MERGED_SEAMS`, not a zero with a reason attached.
 */
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  MERGED_SEAMS,
  MERGED_SEAM_REASON,
  checkVendorPatchesApply,
  parseVendorPatchHeader,
} from "./check-vendor-patches-apply.mjs";
import { NOT_MEASURED_MARKER } from "./prelive.mjs";
import { assertNonVacuous } from "./lib/assert-non-vacuous.mjs";

const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const GATE = join(REPOSITORY_ROOT, "tools", "check-vendor-patches-apply.mjs");
const PATCH_DIRECTORY = join(REPOSITORY_ROOT, "patches", "vendor-magic-context");
const SEAM_FILE = "packages/pi-plugin/src/context-handler.ts";
/** The context line the shipped patch's second hunk anchors on: one edit here is one drifted line, nothing more. */
const SEAM_ANCHOR = '\tcacheTtlConfig?: import("@magic-context/core/shared/model-cache-ttl").CacheTtlConfig;';
const GIT_IDENTITY = ["-c", "user.email=gate@example.invalid", "-c", "user.name=gate"];

const git = (cwd, ...args) =>
  execFileSync("git", ["-c", "core.autocrlf=false", ...args], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });

/** One throwaway root: `patches/vendor-magic-context/*.patch` and the submodule files those patches name. */
function tree({ patches = {}, submodule = {} } = {}) {
  const root = mkdtempSync(join(tmpdir(), "vendor-patches-"));
  mkdirSync(join(root, "patches", "vendor-magic-context"), { recursive: true });
  for (const [name, text] of Object.entries(patches)) {
    writeFileSync(join(root, "patches", "vendor-magic-context", name), text, "utf8");
  }
  for (const [file, text] of Object.entries(submodule)) {
    const absolute = join(root, "vendor", "magic-context", file);
    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, text, "utf8");
  }
  return root;
}

/** Write `{relative path: text}` under one base directory, creating parents. */
function writeFiles(base, entries) {
  for (const [file, text] of Object.entries(entries)) {
    const absolute = join(base, file);
    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, text, "utf8");
  }
}

/** Record `sha` as the submodule gitlink the parent repository carries at HEAD. */
function recordGitlink(root, sha) {
  git(root, "init", "-q");
  git(root, "update-index", "--add", "--cacheinfo", `160000,${sha},vendor/magic-context`);
  git(root, ...GIT_IDENTITY, "commit", "-q", "-m", "the pin this checkout records");
}

/**
 * A fixture that has BOTH states, the way a real checkout does: `vendor/magic-context` is a git repository whose
 * committed content is the pin (`pinned`), the parent repository records that commit as a gitlink, and `workingTree`
 * is what sits on disk afterwards - the same as the pin unless the case is about a dirty submodule.
 */
function sealedTree({ patches = {}, pinned = {}, workingTree = pinned } = {}) {
  const root = tree({ patches });
  const submodule = join(root, "vendor", "magic-context");
  mkdirSync(submodule, { recursive: true });
  writeFiles(submodule, pinned);
  git(submodule, "init", "-q");
  git(submodule, "add", "-A");
  git(submodule, ...GIT_IDENTITY, "commit", "-q", "-m", "pinned");
  const sha = git(submodule, "rev-parse", "HEAD").trim();
  writeFiles(submodule, workingTree);
  recordGitlink(root, sha);
  return { root, sha };
}

/**
 * Every declared seam file, as this checkout's submodule has it: the population `MERGED_SEAMS` names, read whole.
 *
 * A sealed fixture that pinned ONE of the four left the other three `vendor_seam_file_missing_from_pin`, which is
 * a fixture defect that read exactly like the loss the gate exists to catch - and it made two cases red at HEAD.
 */
function seamFiles() {
  const files = {};
  for (const seam of MERGED_SEAMS) {
    files[seam.file] = readFileSync(join(REPOSITORY_ROOT, "vendor", "magic-context", seam.file), "utf8");
  }
  return files;
}

/** The diff for `before -> after` in one file, produced by git rather than by hand. */
function diff({ file, before, after }) {
  const work = mkdtempSync(join(tmpdir(), "vendor-patch-source-"));
  try {
    mkdirSync(dirname(join(work, file)), { recursive: true });
    writeFileSync(join(work, file), before, "utf8");
    git(work, "init", "-q");
    git(work, "add", "-A");
    git(work, "-c", "user.email=gate@example.invalid", "-c", "user.name=gate", "commit", "-q", "-m", "base");
    writeFileSync(join(work, file), after, "utf8");
    return git(work, "diff");
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

/** A patch file: declared header (counts taken from the diff unless the case deliberately lies) + the diff. */
function patch({
  file,
  before,
  after,
  kind = "additive",
  points = ["seam"],
  why,
  addedLines,
  modifiedLines,
  header = "",
}) {
  const body = diff({ file, before, after });
  const numstat = execFileSync("git", ["apply", "--numstat"], { input: body, encoding: "utf8" });
  const [added, removed] = numstat.trim().split("\t");
  const lines = [
    header,
    `kind: ${kind}`,
    `added-lines: ${addedLines ?? added}`,
    `modified-lines: ${modifiedLines ?? removed}`,
    ...points.map((point) => `extension-point: ${point}`),
    ...(why === undefined ? [] : [`why-not-insertion: ${why}`]),
    "",
    "",
    body,
  ];
  return lines.join("\n");
}
/**
 * A patch built on the REAL pin content: one optional member added beside the context line the seam's own history
 * anchored on, so drift injected at that line is drift in a file a patch would have to match. The shipped patch
 * file is gone - its seam is in the pin - but this keeps the patch-mode readings anchored on real content.
 */
function seamPatch(points = ["seamAnchor"]) {
  const pinned = readFileSync(join(REPOSITORY_ROOT, "vendor", "magic-context", SEAM_FILE), "utf8");
  return patch({
    file: SEAM_FILE,
    before: pinned,
    after: pinned.replace(SEAM_ANCHOR, `${SEAM_ANCHOR}\n\tseamAnchor?: 1;`),
    points,
  });
}
const named = (result) => result.violations.map((violation) => violation.code.split(":")[0]);
const checkStatus = (result, id) => result.checks.find((check) => check.id === id)?.status;

test("this checkout is sealed: the patch directory is empty and the report declares why, beside the pin it read", () => {
  // The population is the directory and the expectation is this repository's own record: no patch is left once the
  // seam lives in the pin, and the pin comes from the parent repository's gitlink rather than a copy written here.
  const patchNames = existsSync(PATCH_DIRECTORY)
    ? readdirSync(PATCH_DIRECTORY).filter((name) => name.endsWith(".patch"))
    : [];
  const recordedPin = /^160000 commit ([0-9a-f]{40})\t/u.exec(
    git(REPOSITORY_ROOT, "ls-tree", "HEAD", "--", "vendor/magic-context"),
  )?.[1];
  assert.match(String(recordedPin), /^[0-9a-f]{40}$/u, "this checkout records a submodule pin");
  const declaredPoints = MERGED_SEAMS.reduce((total, seam) => total + seam.points.length, 0);

  const result = checkVendorPatchesApply({ root: REPOSITORY_ROOT });
  assert.deepEqual(patchNames, [], "the seam ships by pin, so the directory holds no patch to apply or to excuse");
  assert.equal(result.examined, declaredPoints, "the sealed population is every declared extension point");
  assert.equal(
    assertNonVacuous(result)?.status,
    "passed",
    "a sealed run that read its whole population is a measurement, not a zero with a reason",
  );
  assert.equal(result.allowEmpty, MERGED_SEAM_REASON, "the empty population is declared, never silent");
  assert.equal(result.pin, recordedPin, "the pin reported is the parent repository's own record");
  assert.equal(result.extensionPoints, declaredPoints, "every declared extension point was looked for at that pin");
  assert.deepEqual(result.readings, [], "sealed mode has no patch, so it makes no apply reading");
  assert.deepEqual(
    result.checks.map((check) => check.state),
    [`pin:${recordedPin}`],
    "the only state sealed mode read is the pin, and the report says which",
  );
  assert.equal(
    checkStatus(result, "merged_seam_present_at_pin"),
    result.status,
    "one rule decides the run: the pin carries the seam, or the run is red",
  );
  for (const violation of result.violations) {
    assert.match(
      violation.code,
      /^vendor_seam_absent_at_pin:/u,
      "a pin without the seam is the only red possible here",
    );
  }
});

test("a context line the submodule no longer has turns both apply readings red, and nothing else is claimed", () => {
  const real = seamPatch();
  // The pre-image anchor the patch matches on as a context line: replace it with a line no longer present.
  const drifted = real.replace(
    SEAM_ANCHOR,
    '\tcacheTtlConfig?: import("@magic-context/core/shared/model-cache-ttl").RenamedTtlConfig;',
  );
  assert.notEqual(drifted, real, "the injection point must exist in the patch");
  const { root } = sealedTree({
    patches: { "0001.patch": drifted },
    pinned: { [SEAM_FILE]: readFileSync(join(REPOSITORY_ROOT, "vendor", "magic-context", SEAM_FILE), "utf8") },
  });
  try {
    const result = checkVendorPatchesApply({ root });
    assert.equal(result.status, "failed");
    assert.ok(named(result).includes("vendor_patch_does_not_apply"), JSON.stringify(result.violations));
    assert.ok(named(result).includes("vendor_patch_does_not_apply_to_pin"), JSON.stringify(result.violations));
    const failure = result.violations.find((violation) => violation.code.startsWith("vendor_patch_does_not_apply:"));
    assert.match(failure.detail, /patch failed|does not apply/iu, "the violation carries git's own reason");
    assert.equal(checkStatus(result, "patch_applies_to_working_tree"), "failed");
    assert.equal(checkStatus(result, "patch_applies_to_pinned_commit"), "failed");
    assert.equal(checkStatus(result, "extension_point_present_after_apply"), "blocked");
    assert.equal(checkStatus(result, "extension_point_absent_without_patch"), "blocked");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a pin carrying the seam is passed, and the report prints the reason and the pin it verified", () => {
  const { root, sha } = sealedTree({ pinned: seamFiles() });
  try {
    const run = spawnSync(process.execPath, [GATE, "--root", root], { encoding: "utf8" });
    assert.equal(run.status, 0, run.stderr);
    const points = MERGED_SEAMS.reduce((total, entry) => total + entry.points.length, 0);
    const expectedLine =
      `vendor_patches_allow_empty: ${MERGED_SEAM_REASON} ` +
      `(pin=${sha}, ${MERGED_SEAMS.length} merged seam file(s), ${points}/${points} extension point(s) present)`;
    assert.ok(run.stdout.split("\n").includes(expectedLine), run.stdout);
    const reported = JSON.parse(run.stdout.split("\n").find((line) => line.startsWith("{")));
    assert.equal(reported.status, "passed");
    assert.equal(reported.allowEmpty, MERGED_SEAM_REASON, "the reason travels in the JSON, not only in the print");
    assert.equal(reported.pin, sha, "and so does the pin it was verified against");
    assert.equal(reported.examined, points, "the population read is every declared extension point");
    assert.equal(
      assertNonVacuous(reported)?.status,
      "passed",
      "the shared judge reads this run as a measurement, so the census cannot file it as reported not measured",
    );
    assert.deepEqual(reported.violations, []);
    assert.deepEqual(reported.checks, [
      { id: "merged_seam_present_at_pin", status: "passed", measured: points, failed: 0, state: `pin:${sha}` },
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a pin that lost the seam is red and names the member, even though the patch set is empty", () => {
  // The defect class sealed mode exists for: the patch that would have said so is deleted (it would have changed
  // nothing), so the pin is the only place the seam can be lost - and one renamed field is that loss.
  const seam = readFileSync(join(REPOSITORY_ROOT, "vendor", "magic-context", SEAM_FILE), "utf8");
  const renamed = seam.replaceAll("assemblePresetSegments", "assembleSegmentsForPreset");
  assert.notEqual(renamed, seam, "the injection point must exist in the seam file");
  const { root, sha } = sealedTree({ pinned: { ...seamFiles(), [SEAM_FILE]: renamed } });
  try {
    const run = spawnSync(process.execPath, [GATE, "--root", root], { encoding: "utf8" });
    assert.equal(run.status, 1);
    assert.match(run.stderr, new RegExp(`vendor_seam_absent_at_pin:${SEAM_FILE}:assemblePresetSegments`, "u"));
    assert.match(
      run.stdout,
      new RegExp(`^vendor_patches_allow_empty: ${MERGED_SEAM_REASON} \\(pin=${sha}`, "mu"),
      "the exemption is still declared when it is red",
    );
    const reported = JSON.parse(run.stdout.split("\n").find((line) => line.startsWith("{")));
    assert.equal(reported.status, "failed");
    assert.equal(
      reported.examined,
      MERGED_SEAMS.reduce((total, entry) => total + entry.points.length, 0),
      "a red sealed run still examined its whole population, so it is not a zero-with-a-reason either",
    );
    assert.deepEqual(
      reported.violations.map((violation) => violation.code),
      [`vendor_seam_absent_at_pin:${SEAM_FILE}:assemblePresetSegments`],
    );
    assert.deepEqual(reported.checks, [
      // Seven of the eight declared points are present at this pin: the fixture carries every declared seam file, and
      // the one renamed field is the single loss. `measured` was 2 while the fixture pinned one seam file of four.
      { id: "merged_seam_present_at_pin", status: "failed", measured: 7, failed: 1, state: `pin:${sha}` },
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a missing submodule is blocked, and says which command fetches it", () => {
  const root = tree({
    patches: {
      "0001.patch": patch({
        file: SEAM_FILE,
        before: "export const a = 1;\n",
        after: "export const a = 1;\nexport const seam = 1;\n",
      }),
    },
  });
  try {
    const result = checkVendorPatchesApply({ root });
    assert.equal(result.status, "blocked");
    assert.deepEqual(named(result), ["vendor_submodule_missing"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a green fixture patch reports every rule measured once, so the report cannot pass on an empty population", () => {
  const before = "export const alpha = 1;\n";
  const after = "export const alpha = 1;\nexport const seam = 2;\n";
  const { root } = sealedTree({
    patches: { "0001.patch": patch({ file: SEAM_FILE, before, after }) },
    pinned: { [SEAM_FILE]: before },
  });
  try {
    const result = checkVendorPatchesApply({ root });
    assert.equal(result.status, "passed", JSON.stringify(result.violations));
    assert.deepEqual(
      result.checks.map((check) => [check.id, check.measured, check.failed]),
      [
        ["patch_header_declares_kind_and_size", 1, 0],
        ["patch_applies_to_working_tree", 1, 0],
        ["patch_applies_to_pinned_commit", 1, 0],
        ["extension_point_present_after_apply", 1, 0],
        ["patched_file_parses", 1, 0],
        ["extension_point_absent_without_patch", 1, 0],
      ],
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an uncommitted edit inside the submodule turns the working-tree reading red and leaves the pinned reading green", () => {
  // The defect class this reading closes: the gate used to be green here and red in CI. One uncommitted line in
  // `vendor/magic-context` is all it takes, and the two readings must disagree out loud.
  const pinned = readFileSync(join(REPOSITORY_ROOT, "vendor", "magic-context", SEAM_FILE), "utf8");
  const dirty = pinned.replace(
    SEAM_ANCHOR,
    '\tcacheTtlConfig?: import("@magic-context/core/shared/model-cache-ttl").LocalTtlConfig;',
  );
  assert.notEqual(dirty, pinned, "the injection point must exist in the seam file");
  const { root, sha } = sealedTree({
    patches: { "0001.patch": seamPatch() },
    pinned: { [SEAM_FILE]: pinned },
    workingTree: { [SEAM_FILE]: dirty },
  });
  try {
    const result = checkVendorPatchesApply({ root });
    assert.equal(result.status, "failed");
    assert.deepEqual(
      result.readings.map((reading) => [reading.reading, reading.state, reading.status]),
      [
        ["applies-to-working-tree", "worktree", "failed"],
        ["applies-to-pinned-commit", `pin:${sha}`, "passed"],
        ["extension-point", "worktree", "blocked"],
      ],
    );
    assert.deepEqual(named(result), ["vendor_patch_does_not_apply"], "only the working-tree reading is red");
    assert.equal(checkStatus(result, "patch_applies_to_working_tree"), "failed");
    assert.equal(checkStatus(result, "patch_applies_to_pinned_commit"), "passed");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a pin that drifted away from the working tree turns the pinned reading red while the working tree stays green", () => {
  // The other direction, and the one CI meets: the checkout was repaired locally, the pin was not.
  const clean = readFileSync(join(REPOSITORY_ROOT, "vendor", "magic-context", SEAM_FILE), "utf8");
  const drifted = clean.replace(
    SEAM_ANCHOR,
    '\tcacheTtlConfig?: import("@magic-context/core/shared/model-cache-ttl").PinnedTtlConfig;',
  );
  assert.notEqual(drifted, clean);
  const { root, sha } = sealedTree({
    patches: { "0001.patch": seamPatch() },
    pinned: { [SEAM_FILE]: drifted },
    workingTree: { [SEAM_FILE]: clean },
  });
  try {
    const result = checkVendorPatchesApply({ root });
    assert.equal(result.status, "failed");
    assert.deepEqual(
      result.readings.map((reading) => [reading.reading, reading.state, reading.status]),
      [
        ["applies-to-working-tree", "worktree", "passed"],
        ["applies-to-pinned-commit", `pin:${sha}`, "failed"],
        ["extension-point", "worktree", "passed"],
      ],
    );
    assert.deepEqual(named(result), ["vendor_patch_does_not_apply_to_pin"], "only the pinned reading is red");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// The four ways the pin cannot be read. Each is `not_measured` with its own reason - never `passed`, never a hard
// failure of the whole gate - and the working-tree reading still counts in every one of them.
test("a submodule with no git directory of its own is not_measured for the pinned reading", () => {
  const before = "export const alpha = 1;\n";
  const root = tree({
    patches: {
      "0001.patch": patch({ file: SEAM_FILE, before, after: "export const alpha = 1;\nexport const seam = 2;\n" }),
    },
    submodule: { [SEAM_FILE]: before },
  });
  recordGitlink(root, "1".repeat(40));
  try {
    const result = checkVendorPatchesApply({ root });
    assert.deepEqual(result.violations, []);
    assert.equal(result.status, "not_measured");
    const pinned = result.readings.find((reading) => reading.reading === "applies-to-pinned-commit");
    assert.equal(pinned.status, "not_measured");
    assert.equal(pinned.reason, "submodule_not_initialised");
    assert.equal(pinned.state, `pin:${"1".repeat(40)}`);
    assert.equal(checkStatus(result, "patch_applies_to_working_tree"), "passed");
    assert.equal(checkStatus(result, "patch_applies_to_pinned_commit"), "not_measured");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a parent repository that records no gitlink is not_measured, and says what it printed", () => {
  const before = "export const alpha = 1;\n";
  const root = tree({
    patches: {
      "0001.patch": patch({ file: SEAM_FILE, before, after: "export const alpha = 1;\nexport const seam = 2;\n" }),
    },
    submodule: { [SEAM_FILE]: before },
  });
  git(root, "init", "-q");
  git(root, ...GIT_IDENTITY, "commit", "-q", "--allow-empty", "-m", "no submodule recorded");
  try {
    const result = checkVendorPatchesApply({ root });
    assert.equal(result.status, "not_measured");
    const pinned = result.readings.find((reading) => reading.reading === "applies-to-pinned-commit");
    assert.equal(pinned.reason, "submodule_pin_unrecorded");
    assert.equal(pinned.state, "pin:unavailable");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a checkout with no parent git at all is not_measured for the pinned reading, not passed", () => {
  const before = "export const alpha = 1;\n";
  const root = tree({
    patches: {
      "0001.patch": patch({ file: SEAM_FILE, before, after: "export const alpha = 1;\nexport const seam = 2;\n" }),
    },
    submodule: { [SEAM_FILE]: before },
  });
  try {
    const result = checkVendorPatchesApply({ root });
    assert.equal(result.status, "not_measured");
    assert.deepEqual(named(result), []);
    const pinned = result.readings.find((reading) => reading.reading === "applies-to-pinned-commit");
    assert.equal(pinned.status, "not_measured");
    assert.equal(pinned.reason, "parent_git_unavailable");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a gitlink naming an object the submodule cannot read is not_measured, not a green pin", () => {
  const before = "export const alpha = 1;\n";
  const { root } = sealedTree({
    patches: {
      "0001.patch": patch({ file: SEAM_FILE, before, after: "export const alpha = 1;\nexport const seam = 2;\n" }),
    },
    pinned: { [SEAM_FILE]: before },
  });
  // A pin whose object is gone from the submodule: the commit exists in the parent's record, not in this clone.
  const submodule = join(root, "vendor", "magic-context");
  git(submodule, ...GIT_IDENTITY, "commit", "-q", "--allow-empty", "-m", "the pin, before it was lost");
  const lost = git(submodule, "rev-parse", "HEAD").trim();
  git(submodule, "reset", "-q", "--hard", "HEAD~1");
  git(submodule, "reflog", "expire", "--expire=now", "--all");
  git(submodule, "gc", "--quiet", "--prune=now");
  recordGitlink(root, lost);
  try {
    const result = checkVendorPatchesApply({ root });
    assert.deepEqual(result.violations, []);
    assert.equal(result.status, "not_measured");
    const pinned = result.readings.find((reading) => reading.reading === "applies-to-pinned-commit");
    assert.equal(pinned.status, "not_measured");
    assert.equal(pinned.reason, "pin_commit_unreadable");
    assert.equal(pinned.state, `pin:${lost}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an unmeasurable pin exits 0 with the skip marker the L0 rung counts as UNAVAILABLE", () => {
  // The marker is what tools/prelive.mjs reads, so it is asserted with prelive's own regex rather than a copy.
  const before = "export const alpha = 1;\n";
  const root = tree({
    patches: {
      "0001.patch": patch({ file: SEAM_FILE, before, after: "export const alpha = 1;\nexport const seam = 2;\n" }),
    },
    submodule: { [SEAM_FILE]: before },
  });
  try {
    const run = spawnSync(process.execPath, [GATE, "--root", root], { encoding: "utf8" });
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, /^vendor_patches_skipped: patch_applies_to_pinned_commit parent_git_unavailable/mu);
    assert.match(run.stdout, NOT_MEASURED_MARKER, "prelive reads this marker as not_measured");
    const reported = JSON.parse(run.stdout.split("\n").find((line) => line.startsWith("{")));
    assert.equal(reported.status, "not_measured");
    assert.equal(reported.readings.length, 3);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a declared extension point the diff never adds is assertion (b) red", () => {
  const before = "export const alpha = 1;\n";
  const root = tree({
    patches: {
      "0001.patch": patch({
        file: SEAM_FILE,
        before,
        after: "export const alpha = 1;\nexport const other = 2;\n",
        points: ["seam"],
      }),
    },
    submodule: { [SEAM_FILE]: before },
  });
  try {
    const result = checkVendorPatchesApply({ root });
    assert.equal(result.status, "failed");
    assert.ok(named(result).includes("vendor_patch_extension_point_missing"));
    assert.equal(checkStatus(result, "extension_point_present_after_apply"), "failed");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an extension point the pinned submodule already has is assertion (c) red - the patch stopped being load-bearing", () => {
  const before = "export const alpha = 1;\nexport const seam = 0;\n";
  const root = tree({
    patches: {
      "0001.patch": patch({
        file: SEAM_FILE,
        before,
        after: `${before}export const unrelated = 2;\n`,
        points: ["seam"],
      }),
    },
    // Upstream shipped the seam: the pre-image already carries the name.
    submodule: { [SEAM_FILE]: before },
  });
  try {
    const result = checkVendorPatchesApply({ root });
    assert.equal(result.status, "failed");
    assert.deepEqual(named(result), ["vendor_patch_extension_point_present_unpatched"]);
    assert.match(
      result.violations[0].detail,
      /delete this patch/iu,
      "the message tells the next agent what to do about it",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a patch that only parses until it is applied is caught after applying", () => {
  const before = "export const alpha = 1;\n";
  const after = "export const alpha = 1;\nexport const seam = ;\n";
  const root = tree({
    patches: { "0001.patch": patch({ file: SEAM_FILE, before, after }) },
    submodule: { [SEAM_FILE]: before },
  });
  try {
    const result = checkVendorPatchesApply({ root });
    assert.equal(result.status, "failed");
    assert.deepEqual(named(result), ["vendor_patch_parse_failed"]);
    assert.match(result.violations[0].detail, /Expression expected/u, "the parser's own words, not a paraphrase");
    assert.equal(checkStatus(result, "patched_file_parses"), "failed");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the header's numbers are checked against the diff, not trusted", () => {
  const before = "export const alpha = 1;\n";
  const root = tree({
    patches: {
      "0001.patch": patch({
        file: SEAM_FILE,
        before,
        after: "export const alpha = 1;\nexport const seam = 2;\n",
        addedLines: 5,
        modifiedLines: 0,
        points: ["seam"],
      }),
    },
    submodule: { [SEAM_FILE]: before },
  });
  try {
    const result = checkVendorPatchesApply({ root });
    assert.equal(result.status, "failed");
    assert.deepEqual(named(result), ["vendor_patch_declared_added_mismatch"]);
    assert.equal(result.violations[0].expected, "added-lines: 1 (what the diff holds)");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("kind: additive with a rewritten line, and kind: invasive without a reason, are both named", () => {
  const before = "export const alpha = 1;\nexport const beta = 2;\n";
  const after = "export const alpha = 1;\nexport const seam = 3;\n";
  const additiveRoot = tree({
    patches: { "0001.patch": patch({ file: SEAM_FILE, before, after, points: ["seam"] }) },
    submodule: { [SEAM_FILE]: before },
  });
  const invasiveRoot = tree({
    patches: { "0001.patch": patch({ file: SEAM_FILE, before, after, points: ["seam"], kind: "invasive" }) },
    submodule: { [SEAM_FILE]: before },
  });
  try {
    const additive = checkVendorPatchesApply({ root: additiveRoot });
    assert.ok(
      named(additive).includes("vendor_patch_additive_with_modifications"),
      JSON.stringify(additive.violations),
    );
    const invasive = checkVendorPatchesApply({ root: invasiveRoot });
    assert.ok(named(invasive).includes("vendor_patch_invasive_without_reason"), JSON.stringify(invasive.violations));
    assert.equal(checkStatus(invasive, "patch_header_declares_kind_and_size"), "failed");
  } finally {
    rmSync(additiveRoot, { recursive: true, force: true });
    rmSync(invasiveRoot, { recursive: true, force: true });
  }
});

test("a header line inside the diff cannot rewrite the declaration", () => {
  const declared = parseVendorPatchHeader(
    [
      "kind: additive",
      "added-lines: 1",
      "modified-lines: 0",
      "extension-point: seam",
      "",
      "",
      "diff --git a/x.ts b/x.ts",
      "@@ -1,0 +1,2 @@",
      "+kind: invasive",
      "+export const seam = 1;",
      "",
    ].join("\n"),
  );
  assert.equal(declared.kind, "additive");
  assert.deepEqual(declared.extensionPoints, ["seam"]);
});

test("the seam the vendored package carries is additive in the ways a reader would check it by hand", () => {
  // Structural, and stated as such: executing this call site needs the vendor's own build and a live Pi
  // session, which a patch gate must not require. What IS asserted here is the property the additive claim
  // rests on - both fields optional, the call guarded by both, the unguarded path handing back the very
  // array the handler already had, and the seam sitting before the card's closing direction. Read from the
  // vendored file itself: no patch stands between the seam and what the Host compiles any more.
  const seam = readFileSync(join(REPOSITORY_ROOT, "vendor", "magic-context", SEAM_FILE), "utf8");
  assert.match(seam, /presetSegments\?: PiPresetSegments;/u);
  assert.match(seam, /assemblePresetSegments\?: \(\n\t\tinput:/u);
  assert.match(seam, /options\.presetSegments && options\.assemblePresetSegments/u);
  assert.match(seam, /if \(presetAssembly\)\n\t\t\t\toutputMessages = presetAssembly\.messages/u);
  assert.ok(
    seam.indexOf("const presetAssembly =") < seam.indexOf("appendPostHistoryInstructions("),
    "the preset seam runs before the card's closing direction, which stays the last text",
  );
  assert.ok(
    seam.indexOf("const presetAssembly =") > seam.indexOf("captureServedEvidence(sessionId, outputMessages"),
    "the preset seam runs after the served-array capture, so its bytes never enter the LKG snapshot",
  );
});
