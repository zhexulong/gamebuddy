/**
 * The gate's falsifiers. Each case builds a throwaway tree (`patches/vendor-magic-context/*.patch` plus the
 * submodule content those patches speak about), so the assertion is about what the gate READS, not about this
 * repository's current state - the real-tree case below covers that.
 *
 * red-proof: inject  replace one context line of the shipped patch (the `cacheTtlConfig` anchor) with a line the
 *            submodule does not have -> `vendor_patch_does_not_apply:<patch>:<file>` carrying git's own
 *            `error: patch failed`, `patch_applies_to_current_submodule` failed, status `failed`. That is the
 *            upgrade accident this gate exists for: the pin moved and nothing noticed the feature was gone.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { checkVendorPatchesApply, parseVendorPatchHeader } from "./check-vendor-patches-apply.mjs";

const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SHIPPED_PATCH = join(REPOSITORY_ROOT, "patches", "vendor-magic-context", "0001-preset-assembly-seam.patch");
const SEAM_FILE = "packages/pi-plugin/src/context-handler.ts";

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

test("the shipped patch is green on this checkout, and all three assertions were measured", () => {
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
  const result = checkVendorPatchesApply({ root: REPOSITORY_ROOT });
  assert.equal(result.status, "passed", JSON.stringify(result.violations));
  assert.equal(result.examined, patchNames.length, "every patch in the directory was examined");
  assert.equal(result.extensionPoints, declaredPoints, "every declared extension point was looked for");
  assert.ok(result.examined > 0 && result.extensionPoints > 0, "the real tree has patches to examine");
  assert.equal(checkStatus(result, "patch_applies_to_current_submodule"), "passed");
  assert.equal(checkStatus(result, "extension_point_present_after_apply"), "passed");
  assert.equal(checkStatus(result, "extension_point_absent_without_patch"), "passed");
  assert.equal(checkStatus(result, "patched_file_parses"), "passed");
  assert.deepEqual(result.violations, []);
});

test("a context line the submodule no longer has turns assertion (a) red, and nothing else is claimed", () => {
  const real = readFileSync(SHIPPED_PATCH, "utf8");
  // The pre-image anchor of the first hunk in the shipped patch: replace it with a line no longer present.
  const drifted = real.replace(
    '\tcacheTtlConfig?: import("@magic-context/core/shared/model-cache-ttl").CacheTtlConfig;',
    '\tcacheTtlConfig?: import("@magic-context/core/shared/model-cache-ttl").RenamedTtlConfig;',
  );
  assert.notEqual(drifted, real, "the injection point must exist in the shipped patch");
  const root = tree({
    patches: { "0001-preset-assembly-seam.patch": drifted },
    submodule: {
      [SEAM_FILE]: readFileSync(join(REPOSITORY_ROOT, "vendor", "magic-context", SEAM_FILE), "utf8"),
    },
  });
  try {
    const result = checkVendorPatchesApply({ root });
    assert.equal(result.status, "failed");
    assert.ok(named(result).includes("vendor_patch_does_not_apply"), JSON.stringify(result.violations));
    const failure = result.violations.find((violation) => violation.code.startsWith("vendor_patch_does_not_apply"));
    assert.match(failure.detail, /patch failed|does not apply/iu, "the violation carries git's own reason");
    assert.equal(checkStatus(result, "patch_applies_to_current_submodule"), "failed");
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
  const root = tree({
    patches: { "0001.patch": patch({ file: SEAM_FILE, before, after }) },
    submodule: { [SEAM_FILE]: before },
  });
  try {
    const result = checkVendorPatchesApply({ root });
    assert.equal(result.status, "passed", JSON.stringify(result.violations));
    assert.deepEqual(
      result.checks.map((check) => [check.id, check.measured, check.failed]),
      [
        ["patch_header_declares_kind_and_size", 1, 0],
        ["patch_applies_to_current_submodule", 1, 0],
        ["extension_point_present_after_apply", 1, 0],
        ["patched_file_parses", 1, 0],
        ["extension_point_absent_without_patch", 1, 0],
      ],
    );
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
