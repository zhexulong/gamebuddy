/**
 * The falsifier for `tools/check-switch-exhaustiveness.mjs`: every verdict seen red once, on a real tree.
 *
 * Each case builds a throwaway workspace - a `tsconfig.json` and one `src/` file that declares its own
 * union and its own never-guard, so nothing resolves outside the fixture - and drives the gate's own
 * reader over it. The red cases are the two shapes the gate exists for: a union switch missing a member,
 * and a switch that covers every member but whose `default` answers with a value instead of asserting.
 * The exemption pair covers both directions of the stated-open-vocabulary rule.
 *
 * red-proof: inject  a union switch that handles two of three members -> `switch_not_exhaustive` names
 *                    `fixture.ts:7:kind does not handle "gamma"`; an exhaustive switch whose `default` returns a
 *                    value -> `switch_default_does_not_assert_never`; a `default` asserting a different union ->
 *                    still `switch_default_does_not_assert_never`; an open-vocabulary subject with no stated
 *                    exemption -> `exemption_missing`, an exemption that names nothing -> `exemption_expired`, a
 *                    count that disagrees -> `exemption_count_mismatch`; an empty `src` -> `blocked` with exit 1.
 */
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { checkSwitchExhaustiveness } from "./check-switch-exhaustiveness.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const workspaces = [];

after(() => {
  for (const workspace of workspaces) rmSync(workspace, { recursive: true, force: true });
});

const TS_CONFIG = JSON.stringify({
  compilerOptions: {
    target: "ES2022",
    module: "ESNext",
    moduleResolution: "Bundler",
    strict: true,
    noEmit: true,
    skipLibCheck: true,
  },
  include: ["src"],
});

/** One workspace whose `src/fixture.ts` is the given source, named `fixture` so paths are readable. */
function workspace(source) {
  const parent = mkdtempSync(join(tmpdir(), "switch-exhaustiveness-"));
  workspaces.push(parent);
  const webRoot = join(parent, "dialogue-web");
  mkdirSync(join(webRoot, "src"), { recursive: true });
  writeFileSync(join(webRoot, "tsconfig.json"), TS_CONFIG);
  writeFileSync(join(webRoot, "src", "fixture.ts"), source);
  return webRoot;
}

const codes = (verdict) => verdict.findings.map((entry) => entry.code);

/** A union of three members with two handled, guarding the third through a local never-typed helper. */
const MISSING_MEMBER = `
function assertNever(value: never): never {
  throw new Error(String(value));
}
type Kind = "alpha" | "beta" | "gamma";
export function read(kind: Kind): string {
  switch (kind) {
    case "alpha":
      return "a";
    case "beta":
      return "b";
    default:
      return assertNever(kind);
  }
}
`;

/** The same union with all three members handled: the green twin of `MISSING_MEMBER`. */
const COMPLETE = MISSING_MEMBER.replace(
  "    default:\n      return assertNever(kind);",
  '    case "gamma":\n      return "c";\n    default:\n      return assertNever(kind);',
);

test("a union switch missing a member is named, with the member", () => {
  const verdict = checkSwitchExhaustiveness({ webRoot: workspace(MISSING_MEMBER), exemptions: [] });
  assert.equal(verdict.status, "failed");
  assert.equal(verdict.examined, 1);
  const entry = verdict.findings.find((finding) => finding.code === "switch_not_exhaustive");
  assert.ok(entry, `expected switch_not_exhaustive, read ${codes(verdict).join(",")}`);
  assert.match(entry.detail, /fixture\.ts:7:kind/u);
  assert.match(entry.detail, /does not handle "gamma"/u);
});

test("the same switch with the third case is exhaustive", () => {
  const verdict = checkSwitchExhaustiveness({ webRoot: workspace(COMPLETE), exemptions: [] });
  assert.equal(verdict.status, "passed", JSON.stringify(verdict.findings));
  assert.equal(verdict.examined, 1);
  assert.equal(verdict.counts.literal_union, 1);
});

test("a switch covering every member whose default answers a value is not an assertion", () => {
  const source = MISSING_MEMBER.replace(
    "    default:\n      return assertNever(kind);",
    '    case "gamma":\n      return "c";\n    default:\n      return "?";',
  );
  const verdict = checkSwitchExhaustiveness({ webRoot: workspace(source), exemptions: [] });
  assert.equal(verdict.status, "failed");
  assert.deepEqual(codes(verdict), ["switch_default_does_not_assert_never"]);
  assert.match(verdict.findings[0].detail, /fixture\.ts:7:kind/u);
});

test("a default asserting a different union does not discharge this switch", () => {
  const source = `
function assertNever(value: never): never {
  throw new Error(String(value));
}
type Kind = "alpha" | "beta";
type Other = "one" | "two";
declare const other: Other;
export function read(kind: Kind): string {
  switch (kind) {
    case "alpha":
      return "a";
    case "beta":
      return assertNever(other as never);
    default:
      return assertNever(other);
  }
}
`;
  const verdict = checkSwitchExhaustiveness({ webRoot: workspace(source), exemptions: [] });
  assert.equal(verdict.status, "failed", JSON.stringify(verdict));
  assert.deepEqual(codes(verdict), ["switch_default_does_not_assert_never"]);
});

test("a subject that is not a closed union is named, and needs a stated exemption", () => {
  const source = `
export function read(code: string): string {
  switch (code) {
    case "known":
      return "k";
    default:
      return code;
  }
}
`;
  const webRoot = workspace(source);
  const bare = checkSwitchExhaustiveness({ webRoot, exemptions: [] });
  assert.equal(bare.status, "failed");
  assert.deepEqual(codes(bare), ["exemption_missing"]);
  assert.equal(bare.counts.open_vocabulary, 1);

  const stated = checkSwitchExhaustiveness({
    webRoot,
    exemptions: [
      {
        file: "dialogue-web/src/fixture.ts",
        subject: "code",
        count: 1,
        reason: "the Host publishes codes this build has no sentence for",
      },
    ],
  });
  assert.equal(stated.status, "passed", JSON.stringify(stated.findings));
});

test("a stated exemption that names nothing has expired", () => {
  const verdict = checkSwitchExhaustiveness({
    webRoot: workspace(COMPLETE),
    exemptions: [{ file: "dialogue-web/src/fixture.ts", subject: "code", count: 1, reason: "a switch no longer here" }],
  });
  assert.equal(verdict.status, "failed");
  assert.deepEqual(codes(verdict), ["exemption_expired"]);
});

test("a stated exemption that found fewer switches than it declares is a mismatch, not a pass", () => {
  const source = `${COMPLETE}\nexport function readAgain(code: string): string {\n  switch (code) {\n    case "known":\n      return "k";\n    default:\n      return code;\n  }\n}\n`;
  const verdict = checkSwitchExhaustiveness({
    webRoot: workspace(source),
    exemptions: [{ file: "dialogue-web/src/fixture.ts", subject: "code", count: 2, reason: "two refusals" }],
  });
  assert.equal(verdict.status, "failed");
  assert.deepEqual(codes(verdict), ["exemption_count_mismatch"]);
});

test("an empty population is blocked, never passed", () => {
  const parent = mkdtempSync(join(tmpdir(), "switch-exhaustiveness-empty-"));
  workspaces.push(parent);
  const webRoot = join(parent, "dialogue-web");
  mkdirSync(join(webRoot, "src"), { recursive: true });
  writeFileSync(join(webRoot, "tsconfig.json"), TS_CONFIG);
  const verdict = checkSwitchExhaustiveness({ webRoot, exemptions: [] });
  assert.equal(verdict.status, "blocked");
  assert.equal(verdict.examined, 0);
});

test("the real workspace is the population the default run reads", () => {
  const verdict = checkSwitchExhaustiveness();
  assert.ok(verdict.examined > 0, "the default run must examine the real switches");
  assert.equal(verdict.findings.length === 0, true, JSON.stringify(verdict.findings));
  assert.equal(resolve("dialogue-web/src/assert-never.ts"), join(ROOT, "dialogue-web", "src", "assert-never.ts"));
});
