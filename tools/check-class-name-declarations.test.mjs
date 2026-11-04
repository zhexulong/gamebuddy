import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  checkClassNameDeclarations,
  declaredClassNames,
  EXEMPT_NAMES,
  formatFinding,
  UNREADABLE_GAPS,
  verdict,
} from "./lib/class-name-declarations.mjs";

// red-proof: inject  a `className` written in a `.tsx` file with no rule and no exemption ->
// `undeclared_class:<that file>:<line>:visually-hidden-input-label`
// ("a name with no rule is a finding" below); the unreadable half is falsified too - the expression the
// gate cannot read is reported rather than skipped, and an exemption whose name is declared now fails.
// red-proof: history  the revision before 4d0a2cc9, where `visually-hidden-input-label` was written
// on two selects' labels and declared nowhere -> `undeclared_class:` names it at both sites
// ("the pre-fix tree is reported" below, reading the real commit's own files).

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const roots = [];

function makeRoot(files) {
  const root = mkdtempSync(join(tmpdir(), "class-name-declarations-"));
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

/** A synthetic tree with no declarations of its own, so a test states exactly what it plants. */
function readSynthetic(files) {
  return checkClassNameDeclarations({ repoRoot: makeRoot(files), exempt: [], gaps: [] });
}

test("a name with no rule is a finding", () => {
  const readout = readSynthetic({
    "dialogue-web/src/a.tsx": 'export const A = () => <label className="visually-hidden-input-label">x</label>;\n',
    "dialogue-web/src/style.css": ".something-else {\n  color: red;\n}\n",
  });
  assert.equal(readout.undeclared.length, 1);
  assert.equal(readout.undeclared[0].className, "visually-hidden-input-label");
  assert.equal(
    formatFinding({ ...readout.undeclared[0].sites[0], className: readout.undeclared[0].className }),
    "undeclared_class:dialogue-web/src/a.tsx:1:visually-hidden-input-label",
  );
  assert.equal(verdict(readout), true);
});

test("a declared name is not a finding, however the selector reaches it", () => {
  const readout = readSynthetic({
    "dialogue-web/src/a.tsx":
      'export const A = () => (\n  <div className="row">\n    <span className="named" />\n    <span className="island" />\n  </div>\n);\n',
    "dialogue-web/src/style.css": ".row .named {\n  color: red;\n}\n\n:is(.row, .island) {\n  margin: 0;\n}\n",
  });
  assert.deepEqual(readout.undeclared, []);
  assert.equal(verdict(readout), false);
});

test("a name in a comment is neither a usage nor a declaration", () => {
  const readout = readSynthetic({
    "dialogue-web/src/a.tsx":
      '/* The old markup was <div className="ghost">. */\nexport const A = () => <div className="real" />;\n',
    "dialogue-web/src/style.css": "/* .ghost was removed */\n.real {\n  color: red;\n}\n",
  });
  assert.deepEqual(readout.undeclared, []);
  assert.deepEqual([...declaredClassNames(["/* .ghost */ .real { color: red; }"])], ["real"]);
});

test("both branches of a conditional are read", () => {
  const readout = readSynthetic({
    "dialogue-web/src/a.tsx":
      'export const A = ({ on }: { on: boolean }) => <div className={on ? "banner ok" : "banner missing"} />;\n',
    "dialogue-web/src/style.css": ".banner,\n.ok {\n  color: red;\n}\n",
  });
  assert.deepEqual(
    readout.undeclared.map((entry) => entry.className),
    ["missing"],
  );
});

test("an expression the gate cannot read is named, not skipped", () => {
  const readout = readSynthetic({
    "dialogue-web/src/a.tsx":
      "import styles from './a.module.css';\nexport const A = () => <div className={styles[0]} />;\n",
    "dialogue-web/src/style.css": ".banner {\n  color: red;\n}\n",
  });
  assert.equal(readout.unreadable.length, 1);
  assert.equal(readout.unreported.length, 1);
  assert.equal(verdict(readout), true);
});

test("a readable template still counts the static names beside the gap", () => {
  const readout = readSynthetic({
    "dialogue-web/src/a.tsx":
      "export const A = ({ extra }: { extra: string }) => <div className={`avatar ${extra}`} />;\n",
    "dialogue-web/src/style.css": ".other {\n  color: red;\n}\n",
  });
  assert.equal(readout.unreadable.length, 1);
  // `avatar` is a name the gate can still read, so it is reported as undeclared rather than excused
  // by the gap beside it.
  assert.deepEqual(
    readout.undeclared.map((entry) => entry.className),
    ["avatar"],
  );
});

test("an exemption that is no longer needed fails", () => {
  const declaredNow = checkClassNameDeclarations({
    repoRoot: makeRoot({
      "dialogue-web/src/a.tsx": 'export const A = () => <div className="umbrella" />;\n',
      "dialogue-web/src/style.css": ".umbrella {\n  color: red;\n}\n",
    }),
    exempt: [{ className: "umbrella", reason: "planted" }],
    gaps: [],
  });
  assert.deepEqual(declaredNow.staleExemptions, [{ code: "exemption_declared_now", className: "umbrella" }]);
  assert.equal(verdict(declaredNow), true);

  const unused = checkClassNameDeclarations({
    repoRoot: makeRoot({
      "dialogue-web/src/a.tsx": 'export const A = () => <div className="umbrella" />;\n',
      "dialogue-web/src/style.css": ".umbrella {\n  color: red;\n}\n",
    }),
    exempt: [
      { className: "umbrella", reason: "planted" },
      { className: "gone", reason: "planted" },
    ],
    gaps: [],
  });
  assert.deepEqual(unused.staleExemptions, [
    { code: "exemption_declared_now", className: "umbrella" },
    { code: "exemption_unused", className: "gone" },
  ]);
});

test("a gap whose witness is gone is a problem, not a pass", () => {
  const readout = checkClassNameDeclarations({
    repoRoot: makeRoot({
      "dialogue-web/src/a.tsx": "export const A = () => <div className={styles[0]} />;\n",
      "dialogue-web/src/style.css": ".banner {\n  color: red;\n}\n",
    }),
    exempt: [],
    gaps: [{ path: "dialogue-web/src/a.tsx", witness: "someOtherExpression(", reason: "planted", sites: 1 }],
  });
  assert.deepEqual(
    readout.problems.map((problem) => problem.code),
    ["gap_count_drift"],
  );
});

test("the pre-fix tree is reported", () => {
  const root = makeRoot({});
  for (const path of ["dialogue-web/src/components/management-panels.tsx", "dialogue-web/src/style.css"]) {
    const shown = spawnSync("git", ["show", `4d0a2cc9^:${path}`], { cwd: repoRoot, encoding: "utf8" });
    assert.equal(shown.status, 0, `git show ${path}: ${shown.stderr}`);
    const full = join(root, path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, shown.stdout, "utf8");
  }
  const readout = checkClassNameDeclarations({ repoRoot: root, exempt: [], gaps: [] });
  const reported = readout.undeclared.find((entry) => entry.className === "visually-hidden-input-label");
  assert.ok(reported, "the class the fix declared is reported on the tree that lacked the rule");
  assert.deepEqual(
    reported.sites.map((site) => site.line).sort((left, right) => left - right),
    [929, 947],
  );
});

test("the real tree is green with its declarations", () => {
  const readout = checkClassNameDeclarations({ repoRoot });
  assert.deepEqual(readout.undeclared, []);
  assert.deepEqual(readout.staleExemptions, []);
  assert.deepEqual(readout.problems, []);
  assert.deepEqual(readout.unreported, []);
  assert.ok(EXEMPT_NAMES.length > 0);
  assert.ok(UNREADABLE_GAPS.length > 0);
  assert.equal(verdict(readout), false);
});
