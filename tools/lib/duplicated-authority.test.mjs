import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import { DECLARED, findDuplicatedAuthorities, formatFinding } from "./duplicated-authority.mjs";

const roots = [];

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
    allowedOtherPaths: ["src/reader.mjs"],
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

test("formatFinding prints the gate's one-line finding", () => {
  assert.equal(
    formatFinding({ id: "synthetic-value", path: "src/alpha.mjs", line: 7, text: "" }),
    "duplicated_authority:synthetic-value:src/alpha.mjs:7",
  );
});
