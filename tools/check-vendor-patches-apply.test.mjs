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
 */
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { checkVendorPatchesApply, parseVendorPatchHeader } from "./check-vendor-patches-apply.mjs";
import { NOT_MEASURED_MARKER } from "./prelive.mjs";

const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const GATE = join(REPOSITORY_ROOT, "tools", "check-vendor-patches-apply.mjs");
const SHIPPED_PATCH = join(REPOSITORY_ROOT, "patches", "vendor-magic-context", "0001-preset-assembly-seam.patch");
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

const named = (result) => result.violations.map((violation) => violation.code.split(":")[0]);
const checkStatus = (result, id) => result.checks.find((check) => check.id === id)?.status;

test("the shipped patch is green on this checkout, and every reading names the state it read", () => {
  // The population is the directory, and the expected extension points are the patch's own declaration:
  // a second patch joining the directory must not turn this case red for the wrong reason.
  const patchNames = readdirSync(join(REPOSITORY_ROOT, "patches", "vendor-magic-context")).filter((name) =>
    name.endsWith(".patch"),
  );
  const declaredPoints = patchNames.reduce(
    (total, name) =>
      total +
      parseVendorPatchHeader(readFileSync(join(REPOSITORY_ROOT, "patches", "vendor-magic-context", name), "utf8"))
        .extensionPoints.length,
    0,
  );
  // The expected pin comes from the parent repository's own record, not from a copy written into this test.
  const recordedPin = /^160000 commit ([0-9a-f]{40})\t/u.exec(
    git(REPOSITORY_ROOT, "ls-tree", "HEAD", "--", "vendor/magic-context"),
  )?.[1];
  assert.match(String(recordedPin), /^[0-9a-f]{40}$/u, "this checkout records a submodule pin");

  const result = checkVendorPatchesApply({ root: REPOSITORY_ROOT });
  assert.equal(result.status, "passed", JSON.stringify(result.violations));
  assert.equal(result.examined, patchNames.length, "every patch in the directory was examined");
  assert.equal(result.extensionPoints, declaredPoints, "every declared extension point was looked for");
  assert.ok(result.examined > 0 && result.extensionPoints > 0, "the real tree has patches to examine");
  assert.equal(checkStatus(result, "patch_applies_to_working_tree"), "passed");
  assert.equal(checkStatus(result, "patch_applies_to_pinned_commit"), "passed");
  assert.equal(checkStatus(result, "extension_point_present_after_apply"), "passed");
  assert.equal(checkStatus(result, "extension_point_absent_without_patch"), "passed");
  assert.equal(checkStatus(result, "patched_file_parses"), "passed");
  assert.deepEqual(result.violations, []);
  assert.deepEqual(
    result.readings.map((reading) => [reading.reading, reading.state, reading.status]),
    patchNames.flatMap(() => [
      ["applies-to-working-tree", "worktree", "passed"],
      ["applies-to-pinned-commit", `pin:${recordedPin}`, "passed"],
      ["extension-point", "worktree", "passed"],
    ]),
    "each patch reports three readings, each naming the state it read",
  );
});

test("a context line the submodule no longer has turns both apply readings red, and nothing else is claimed", () => {
  const real = readFileSync(SHIPPED_PATCH, "utf8");
  // The pre-image anchor the shipped patch's second hunk matches on: replace it with a line no longer present.
  const drifted = real.replace(
    SEAM_ANCHOR,
    '\tcacheTtlConfig?: import("@magic-context/core/shared/model-cache-ttl").RenamedTtlConfig;',
  );
  assert.notEqual(drifted, real, "the injection point must exist in the shipped patch");
  const { root } = sealedTree({
    patches: { "0001-preset-assembly-seam.patch": drifted },
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

test("no patch at all is blocked with no_vendor_patches_found, never passed", () => {
  const root = tree({ submodule: { [SEAM_FILE]: "export const seam = 1;\n" } });
  try {
    const result = checkVendorPatchesApply({ root });
    assert.equal(result.status, "blocked");
    assert.equal(result.examined, 0);
    assert.deepEqual(named(result), ["no_vendor_patches_found"]);
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
    patches: { "0001-preset-assembly-seam.patch": readFileSync(SHIPPED_PATCH, "utf8") },
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
    patches: { "0001-preset-assembly-seam.patch": readFileSync(SHIPPED_PATCH, "utf8") },
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

test("the shipped seam is additive in the ways a reader would check it by hand", () => {
  // Structural, and stated as such: executing this call site needs the vendor's own build and a live Pi
  // session, which a patch gate must not require. What IS asserted here is the property the additive claim
  // rests on - both fields optional, the call guarded by both, the unguarded path handing back the very
  // array the handler already had, and the seam sitting before the card's closing direction.
  const work = mkdtempSync(join(tmpdir(), "vendor-patch-apply-"));
  try {
    mkdirSync(dirname(join(work, SEAM_FILE)), { recursive: true });
    copyFileSync(join(REPOSITORY_ROOT, "vendor", "magic-context", SEAM_FILE), join(work, SEAM_FILE));
    git(work, "init", "-q");
    git(work, "apply", SHIPPED_PATCH);
    const applied = readFileSync(join(work, SEAM_FILE), "utf8");
    assert.match(applied, /presetSegments\?: PiPresetSegments;/u);
    assert.match(applied, /assemblePresetSegments\?: \(\n\t\tinput:/u);
    assert.match(applied, /options\.presetSegments && options\.assemblePresetSegments/u);
    assert.match(applied, /if \(presetAssembly\)\n\t\t\t\toutputMessages = presetAssembly\.messages/u);
    assert.ok(
      applied.indexOf("const presetAssembly =") < applied.indexOf("appendPostHistoryInstructions("),
      "the preset seam runs before the card's closing direction, which stays the last text",
    );
    assert.ok(
      applied.indexOf("const presetAssembly =") > applied.indexOf("captureServedEvidence(sessionId, outputMessages"),
      "the preset seam runs after the served-array capture, so its bytes never enter the LKG snapshot",
    );
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});
