import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { DECLARED, findDuplicatedAuthorities, formatFinding, GATE_PATHS } from "./duplicated-authority.mjs";

// red-proof: inject - a literal spelled in two modules outside its declared owner; the gate reports
// both paths with line and text (`a literal in two modules is caught, with path, line and text`).
// Its own control case above it is the green half: the same literal owned and imported is [] .

const roots = [];

/** The repository the declaration was read from, so an exemption can be checked against a real file. */
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** A throwaway repo tree whose every file is written explicitly. */
function makeRepo(files) {
  const root = mkdtempSync(join(tmpdir(), "duplicated-authority-"));
  roots.push(root);
  for (const [relativePath, contents] of Object.entries(files)) {
    const full = join(root, relativePath);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, contents, "utf8");
  }
  return root;
}

test.after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

const SYNTHETIC = [
  {
    id: "synthetic-value",
    description: "test value",
    ownerPath: "src/owner.mjs",
    valuePattern: "sentinel-value",
    allowedOtherPaths: [{ path: "src/reader.mjs", reason: "the synthetic reader this test declares" }],
  },
];

const rule = (id) => DECLARED.find((entry) => entry.id === id);

test("a good tree passes: the value lives only in its owner and allowed paths", () => {
  const root = makeRepo({
    "src/owner.mjs": 'export const value = "sentinel-value";\n',
    "src/reader.mjs": 'import { value } from "./owner.mjs";\n',
  });
  assert.deepEqual(findDuplicatedAuthorities(root, SYNTHETIC), []);
});

test("a literal in two modules is caught, with path, line and text", () => {
  const root = makeRepo({
    "src/owner.mjs": 'export const value = "sentinel-value";\n',
    "src/reader.mjs": 'export const read = "sentinel-value";\n',
    "src/alpha.mjs": 'export const alpha = "sentinel-value";\n',
    "src/beta.mjs": '// first line\nexport const beta =\n  "sentinel-value";\n',
  });
  const findings = findDuplicatedAuthorities(root, SYNTHETIC);
  assert.deepEqual(
    findings.map((finding) => finding.path),
    ["src/alpha.mjs", "src/beta.mjs"],
  );
  assert.deepEqual(
    findings.map((finding) => finding.id),
    ["synthetic-value", "synthetic-value"],
  );
  assert.equal(findings[0].line, 1);
  assert.equal(findings[0].text, 'export const alpha = "sentinel-value";');
  assert.equal(findings[1].line, 3);
  assert.equal(findings[1].text, '"sentinel-value";');
});

test("the owner file is exempt", () => {
  const root = makeRepo({
    "src/owner.mjs": 'export const value = "sentinel-value";\n',
    "src/other.mjs": 'export const other = "sentinel-value";\n',
  });
  const findings = findDuplicatedAuthorities(root, SYNTHETIC);
  assert.equal(findings.length, 1);
  assert.ok(findings.every((finding) => finding.path !== "src/owner.mjs"));
});

test("a literal in a comment is not a finding", () => {
  const root = makeRepo({
    "src/owner.mjs": 'export const value = "sentinel-value";\n',
    "src/commented.mjs":
      "// sentinel-value is the value\nconst a = 1;\n/* sentinel-value */\nconst b = 2;\n# sentinel-value\n",
  });
  assert.deepEqual(findDuplicatedAuthorities(root, SYNTHETIC), []);
});

// red-proof: fixture  a synthetic tree whose value is spelled as `http://127.0.0.1:8317/v1`
// -> with `//` matched wherever it appears, the scanner starts a "comment" at the second slash and
// reports only `[[ 'src/url.mjs', 2 ]]`: the value on the marker's own line is reported nowhere. With
// the string-literal rule the same tree reports `[ [ 'src/same-line.mjs', 1 ], [ 'src/url.mjs', 2 ] ]`.
// Both halves are asserted below, including the control: a real `//` comment after a URL string is
// still a comment.
test("a // inside a string literal does not start a comment", () => {
  const root = makeRepo({
    "src/owner.mjs": 'export const value = "sentinel-value";\n',
    "src/url.mjs": 'const url = "http://127.0.0.1:8317/v1";\nconst copy = "sentinel-value";\n',
    "src/same-line.mjs": 'const url = "http://127.0.0.1:8317/v1"; const copy = "sentinel-value";\n',
  });
  assert.deepEqual(
    findDuplicatedAuthorities(root, SYNTHETIC).map((finding) => [finding.path, finding.line]),
    [
      ["src/same-line.mjs", 1],
      ["src/url.mjs", 2],
    ],
  );
});

test("a // comment that follows a URL string is still a comment", () => {
  const root = makeRepo({
    "src/owner.mjs": 'export const value = "sentinel-value";\n',
    "src/commented.mjs": 'const url = "http://127.0.0.1:8317/v1"; // sentinel-value\n',
  });
  assert.deepEqual(findDuplicatedAuthorities(root, SYNTHETIC), []);
});

test("a literal inside a larger token (an excluded string) is not a finding", () => {
  const root = makeRepo({
    "src/owner.mjs": 'export const value = "sentinel-value";\n',
    "src/other.mjs": 'export const a = "sentinel-value-plus";\nexport const b = "pre-sentinel-value";\n',
  });
  assert.deepEqual(findDuplicatedAuthorities(root, SYNTHETIC), []);
});

test("the bridge-pipe rule catches a hardcoded pipe name, not a different pipe name", () => {
  const root = makeRepo({
    "tools/probe.mjs":
      'const a = { PipeName: "gamebuddy-stardew" };\nconst b = { PipeName: "gamebuddy-stardew-portfolio" };\n',
  });
  const findings = findDuplicatedAuthorities(root, [rule("stardew-bridge-pipe-name")]);
  assert.deepEqual(
    findings.map((finding) => [finding.id, finding.path, finding.line]),
    [["stardew-bridge-pipe-name", "tools/probe.mjs", 1]],
  );
});

test("the transient-window rule catches a re-declared window number", () => {
  const root = makeRepo({
    "host/probe.ts": 'const windowMs = evidenceField(detail, "retry_window_ms") ?? "2000";\n',
  });
  const findings = findDuplicatedAuthorities(root, [rule("world-transient-retry-window-ms")]);
  assert.deepEqual(
    findings.map((finding) => finding.path),
    ["host/probe.ts"],
  );
});

test("the published-action-id-list rule catches a hand-written id list, not a single reference", () => {
  const root = makeRepo({
    "tools/probe.mjs":
      'const IDS = ["move_to_tile", "equip_tool", "travel", "till_soil", "water_crop"];\n' +
      'if (action === "equip_tool") return true;\n',
  });
  const findings = findDuplicatedAuthorities(root, [rule("published-action-id-list")]);
  assert.deepEqual(
    findings.map((finding) => finding.path),
    ["tools/probe.mjs"],
  );
  assert.equal(findings.length, 1);
});

test("the provider-id rule catches a harness literal and exempts a test that asserts on it", () => {
  // The rule exists because a harness that spells the id again can file the credential under one provider and read the
  // entry under another; each half valid, the pair silent. A TEST that pins what a resolver answers has to name the
  // value, which is why the exemption is the test-file class and not one entry per suite.
  const root = makeRepo({
    "host/src/tavern/provider-catalog.ts": 'export const TAVERN_ENVIRONMENT_PROVIDER_ID = "cpa-oai" as const;\n',
    "tools/harness.mjs": 'const provider = "cpa-oai";\n',
    "tools/harness.test.mjs": 'assert.equal(resolved, "cpa-oai");\n',
  });
  const findings = findDuplicatedAuthorities(root, [rule("operator-gateway-provider-id")]);
  assert.deepEqual(
    findings.map((finding) => [finding.path, finding.line]),
    [["tools/harness.mjs", 1]],
    "the harness is reported; the test asserting on the value is not",
  );
});

test("a scratch-named file is not scanned, and the same literal under a tracked name is", () => {
  // The exclusion is by NAME, so it covers a scratch FILE at a tracked root - a git-ignored `.tmp-*.ts` used to be
  // read, and its literals were reported against rules the author of a throwaway probe never touched.
  const root = makeRepo({
    "src/owner.mjs": 'export const value = "sentinel-value";\n',
    ".tmp-probe.mjs": 'const scratch = "sentinel-value";\n',
    "src/probe.mjs": 'const real = "sentinel-value";\n',
  });
  assert.deepEqual(
    findDuplicatedAuthorities(root, SYNTHETIC).map((finding) => finding.path),
    ["src/probe.mjs"],
  );
});

/**
 * Every declared exemption that points at a real file other than the gate's own
 * two. One falsifier per exemption: the occurrence it waives must still be in
 * that file (a stale exemption fails), and that very text one directory over
 * must still be reported (an exemption that widened into a rule repeal fails).
 */
for (const { rule: declared, exemption } of DECLARED.flatMap((entry) =>
  (entry.allowedOtherPaths ?? [])
    .filter((candidate) => !GATE_PATHS.includes(candidate.path))
    .map((candidate) => ({ rule: entry, exemption: candidate })),
)) {
  test(`an exemption is earned and scoped: ${declared.id}:${exemption.path}`, () => {
    const absolute = join(repoRoot, exemption.path);
    assert.ok(existsSync(absolute), `${exemption.path} is gone, so the exemption no longer earns its place`);
    const occurrence = [...readFileSync(absolute, "utf8").matchAll(new RegExp(declared.valuePattern, "gu"))][0]?.[0];
    assert.ok(
      occurrence !== undefined,
      `${exemption.path} no longer holds ${declared.id}, so the exemption no longer earns its place`,
    );
    assert.equal(exemption.reason.trim(), exemption.reason, `${exemption.path} needs a trimmed one-line reason`);
    assert.ok(
      exemption.reason.length > 0 && !exemption.reason.includes("\n"),
      `${exemption.path} needs a one-line reason saying why the repeat is legitimate`,
    );
    const decoy = join(dirname(exemption.path), "unexempted-decoy.mjs");
    const root = makeRepo({ [exemption.path]: `${occurrence}\n`, [decoy]: `${occurrence}\n` });
    assert.deepEqual(
      findDuplicatedAuthorities(root, [declared]).map((finding) => finding.path),
      [decoy.split(sep).join("/")],
    );
  });
}

test("formatFinding prints the gate's one-line finding", () => {
  assert.equal(
    formatFinding({ id: "synthetic-value", path: "src/alpha.mjs", line: 7, text: "" }),
    "duplicated_authority:synthetic-value:src/alpha.mjs:7",
  );
});
