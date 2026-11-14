/**
 * The duplication class can fail.
 *
 * A gate nobody has seen go red is a gate that reports green because it stopped looking. This file
 * proves the class three ways on a scratch tree built for it:
 *
 *  - green on a tree where every crowded decider is a constructor (one answer, so no two call sites
 *    can disagree);
 *  - red the moment a decider that answers two outcomes gains a second call site inside one surface,
 *    which is the case the class is named for;
 *  - green again once that second call site is removed, so the red is the class's reading and not a
 *    permanent complaint about the fixture.
 *
 * The fixture is deliberately not a copy of the product: the surfaces are derived from the layout
 * (`<workspace>/src/<first directory>`), so the tree here has to have that shape for the class to
 * read it at all.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { ADVISORY_READINGS, runAudit } from "./audit-totality.mjs";

function write(root, path, text) {
  const file = join(root, path);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text, "utf8");
}

/**
 * A tree with one surface per workspace and three deciders in it:
 *
 *  - `resolveLayout` answers one shape (a constructor) and is called from two modules of the same
 *    surface, which must NOT be a finding: a constructor cannot diverge;
 *  - `resolveModelRoute` answers three outcomes and is called from ONE module per surface, which is
 *    the shape this class wants;
 *  - `decideRetention` answers a boolean and is called from one module, so it is not crowded yet -
 *    the injection adds its second caller.
 *
 * The deciders live under `host/src/settings`, and the callers under `host/src/tavern` and
 * `host/src`, so the tree exercises both a crowded constructor and a crowded decision.
 */
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "totality-duplication-"));
  write(
    root,
    "host/src/settings/model-selection.ts",
    [
      "export type Layout = Readonly<{ root: string; agentDir: string }>;",
      "export type ModelRoute =",
      '  | Readonly<{ kind: "connection" }>',
      '  | Readonly<{ kind: "none" }>',
      '  | Readonly<{ kind: "unknown" }>;',
      "",
      "/** One shape, one answer: a constructor no two call sites can disagree about. */",
      "export function resolveLayout(runtimeRoot: string): Layout {",
      '  return Object.freeze({ root: runtimeRoot, agentDir: runtimeRoot + "/agent" });',
      "}",
      "",
      "/** Three outcomes a caller has to act on. */",
      "export async function resolveModelRoute(active: string | null): Promise<ModelRoute> {",
      '  if (active === null) return Object.freeze({ kind: "none" });',
      '  return Object.freeze({ kind: "connection" });',
      "}",
      "",
      "/** A boolean decision: two outcomes. */",
      "export function decideRetention(count: number): boolean {",
      "  return count > 0;",
      "}",
      "",
    ].join("\n"),
  );
  // A barrel, so the class has to follow a re-export to the module that declares the rule.
  write(
    root,
    "host/src/settings/index.ts",
    'export { resolveLayout, resolveModelRoute, decideRetention } from "./model-selection.js";\n',
  );
  write(
    root,
    "host/src/tavern/one-port.ts",
    [
      'import { resolveLayout, resolveModelRoute } from "../settings/index.js";',
      'export const layout = resolveLayout("/tmp/root");',
      "export const route = await resolveModelRoute(null);",
      "",
    ].join("\n"),
  );
  write(
    root,
    "host/src/tavern/two-port.ts",
    [
      'import { resolveLayout } from "../settings/index.js";',
      'export const otherLayout = resolveLayout("/tmp/other");',
      "",
    ].join("\n"),
  );
  // The single caller of the boolean decider. The injection adds a second one in this same surface.
  write(
    root,
    "host/src/retention-owner.ts",
    [
      'import { decideRetention } from "./settings/model-selection.js";',
      "export const retained = decideRetention(1);",
      "",
    ].join("\n"),
  );
  return root;
}

function duplication(root) {
  const result = runAudit({ root, only: ["duplication"] }).find((entry) => entry.id === "duplication");
  assert.notEqual(result, undefined, "duplication is a class");
  return result;
}

test("a crowded constructor is reported as unable to diverge, not as a finding", (t) => {
  const root = fixture();
  try {
    const result = duplication(root);
    assert.deepEqual(result.violations, [], `the clean fixture must be green:\n${result.notes.join("\n")}`);
    // The constructor is still counted and named: the reading is not "nothing is crowded", it is
    // "what is crowded cannot disagree", and the note has to say which.
    const construction = result.notes.find((note) => note.includes("crowded by construction"));
    assert.notEqual(
      construction,
      undefined,
      `the note must name the crowded constructors:\n${result.notes.join("\n")}`,
    );
    assert.match(construction, /resolveLayout/u);
    assert.doesNotMatch(construction, /resolveModelRoute/u, "one caller per surface is the shape the class wants");
    t.diagnostic(result.notes.join(" | "));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a two-outcome decider with a second caller module in one surface fails the class", (t) => {
  const root = fixture();
  const extra = "host/src/retention-auditor.ts";
  try {
    // The injection is a real second *place* - a second module inside the same surface (`host/src`)
    // - reaching the decider through the barrel, so the resolver has to follow the re-export to the
    // module that declares the rule. Two calls in one module would be one place and must not fire:
    // the class reports a second decider, never a second use.
    write(
      root,
      extra,
      'import { decideRetention } from "./settings/index.js";\nexport const reconsidered = decideRetention(2);\n',
    );
    try {
      const broken = duplication(root);
      assert.equal(broken.violations.length, 1, `one crowded decision is one finding:\n${broken.notes.join("\n")}`);
      const [violation] = broken.violations;
      assert.match(violation.message, /decideRetention/u);
      assert.match(violation.message, /2 outcomes/u, "the message must name how many outcomes it has");
      assert.match(violation.message, /host\/src\/retention-owner\.ts/u, "the message must name the call sites");
      assert.match(violation.message, /host\/src\/retention-auditor\.ts/u, "the message must name every call site");
      t.diagnostic(violation.message);
    } finally {
      rmSync(join(root, extra), { force: true });
    }
    assert.deepEqual(duplication(root).violations, [], "the class is green again once the second place is gone");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a union answer is as many outcomes as it has members", (t) => {
  const root = fixture();
  try {
    // `resolveModelRoute` has three outcomes and one caller per surface. A second caller in `host/src`
    // makes it crowded, and the finding must report three outcomes rather than two.
    write(
      root,
      "host/src/route-owner.ts",
      [
        'import { resolveModelRoute } from "./settings/model-selection.js";',
        'export const second = await resolveModelRoute("active");',
        "",
      ].join("\n"),
    );
    write(
      root,
      "host/src/other-route-owner.ts",
      [
        'import { resolveModelRoute } from "./settings/model-selection.js";',
        "export const third = await resolveModelRoute(null);",
        "",
      ].join("\n"),
    );
    const broken = duplication(root);
    const route = broken.violations.find((violation) => violation.message.includes("resolveModelRoute"));
    assert.notEqual(route, undefined, `a crowded three-outcome decider is a finding:\n${broken.notes.join("\n")}`);
    assert.match(route.message, /3 outcomes/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an optional answer is one answer, and a real second answer still fails", (t) => {
  const root = fixture();
  try {
    // The shape `resolveWindowsPowerShell` has: one answer, and `undefined` for "this environment names
    // none". All call sites apply the same fallback, so there is no rule two of them could state
    // differently. A crowded decider of that shape must stay green.
    write(
      root,
      "host/src/settings/executable.ts",
      [
        'import { join } from "node:path";',
        "export function resolveToolExecutable(environment: NodeJS.ProcessEnv): string | undefined {",
        "  const root = environment.SystemRoot ?? environment.SYSTEMROOT ?? environment.windir;",
        '  if (typeof root !== "string" || root.length === 0) return undefined;',
        '  return join(root, "Tool", "tool.exe");',
        "}",
        "",
      ].join("\n"),
    );
    write(
      root,
      "host/src/tavern/executable-one.ts",
      [
        'import { resolveToolExecutable } from "../settings/executable.js";',
        'export const tool = resolveToolExecutable({}) ?? "tool.exe";',
        "",
      ].join("\n"),
    );
    write(
      root,
      "host/src/tavern/executable-two.ts",
      [
        'import { resolveToolExecutable } from "../settings/executable.js";',
        'export const otherTool = resolveToolExecutable({}) ?? "tool.exe";',
        "",
      ].join("\n"),
    );
    const optional = duplication(root);
    assert.deepEqual(optional.violations, [], `an optional answer carries no choice:\n${optional.notes.join("\n")}`);
    const construction = optional.notes.find((note) => note.includes("crowded by construction"));
    assert.match(construction, /resolveToolExecutable/u, "the reading still counts it, and says why it cannot diverge");
    t.diagnostic(construction);

    // The other direction, so the rule cannot pass by calling everything one answer: a union of two real
    // answers is a decision, and a second crowded caller of it is still a finding.
    write(
      root,
      "host/src/settings/answer-pair.ts",
      [
        'export type AnswerPair = Readonly<{ kind: "first" }> | Readonly<{ kind: "second" }>;',
        "export function decideAnswerPair(flag: boolean): AnswerPair {",
        '  return flag ? Object.freeze({ kind: "first" }) : Object.freeze({ kind: "second" });',
        "}",
        "",
      ].join("\n"),
    );
    write(
      root,
      "host/src/tavern/pair-one.ts",
      'import { decideAnswerPair } from "../settings/answer-pair.js";\nexport const pairOne = decideAnswerPair(true);\n',
    );
    write(
      root,
      "host/src/tavern/pair-two.ts",
      'import { decideAnswerPair } from "../settings/answer-pair.js";\nexport const pairTwo = decideAnswerPair(false);\n',
    );
    const pairs = duplication(root);
    const finding = pairs.violations.find((violation) => violation.message.includes("decideAnswerPair"));
    assert.notEqual(finding, undefined, `a two-answer union is still a finding:\n${pairs.notes.join("\n")}`);
    assert.match(finding.message, /2 outcomes/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the class blocks: its promotion condition is the finding itself", () => {
  // It used to be advisory for the same reason `hygiene` still is - a ruling nobody had taken. That stopped being true
  // when the class learned that an optional answer is ONE answer: what is left is a crowded decider whose declared
  // answer admits two or more answers a caller has to tell apart, which is a defect and not a decision. The tree reports
  // zero of those today, so blocking costs nothing and a red from this class now names a real divergence.
  assert.deepEqual(
    ADVISORY_READINGS.filter((entry) => entry.className === "duplication"),
    [],
    "duplication must not be listed as an advisory reading: its findings are defects, not an unmade ruling",
  );
  const root = fixture();
  try {
    const crowded = runAudit({ root, only: ["duplication"] }).find((entry) => entry.id === "duplication");
    assert.notEqual(crowded, undefined);
    assert.equal(
      crowded.violations.some((violation) => violation.advisory === true),
      false,
      "no finding of this class may be marked advisory, or the exit code would ignore it",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
