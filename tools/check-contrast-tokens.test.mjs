/**
 * The gate's falsifiers. Each case writes a throwaway `dialogue-web/src/style.css` and drives the exported function
 * over it, so the assertion is about what the gate READS rather than about this repository's current tokens (the
 * CLI run against the real stylesheet is the other half).
 *
 * red-proof: inject  `--ink-quiet` (#6a625a) paired with `--surface-card` (#201d1d) ->
 *            `contrast_below_min:ink-quiet on surface-card` at 2.80:1 (min 4.5), with the report-only run still
 *            exiting 0 and `--fail` exiting 1; `--ink-blended` declared `color-mix(...)` ->
 *            `token_unreadable:ink-blended on surface-canvas:ink-blended`; `pairs: []` -> `status:"blocked"` and
 *            exit 1 in both modes; a declared token no rule paints ->
 *            `pair_ink_unused:<label>` and `pair_surface_unused:<label>`; an `rgba()` ink is composited and
 *            measured (2.92:1) rather than called unreadable.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { checkContrastTokens, reportContrastTokens } from "./check-contrast-tokens.mjs";

/** The tokens the fixtures declare: two surfaces, one live ink, and the four inks the cases inject. */
const DECLARATIONS = [
  "--surface-canvas: #0c0b0b;",
  "--surface-card: #201d1d;",
  "--surface-unused: #101010;",
  "--ink-live: #f5f0e8;",
  "--ink-quiet: #6a625a;",
  "--ink-ghost: rgba(245, 240, 232, 0.35);",
  "--ink-blended: color-mix(in srgb, var(--ink-live) 60%, var(--surface-card));",
  "--ink-unused: #ffffff;",
];

/** Which of those tokens the sheet actually paints, and as what. */
const RULES = [
  ".shell { background-color: var(--surface-canvas); color: var(--ink-live); }",
  ".card { background-color: var(--surface-card); }",
  ".quiet { color: var(--ink-quiet); }",
  ".ghost { color: var(--ink-ghost); }",
  ".blend { color: var(--ink-blended); }",
].join("\n");

/** A stylesheet at the real relative path inside its own temp root, which the caller removes. */
function stylesheet({ declarations = DECLARATIONS, rules = RULES } = {}) {
  const root = mkdtempSync(join(tmpdir(), "contrast-tokens-"));
  mkdirSync(join(root, "dialogue-web/src"), { recursive: true });
  writeFileSync(
    join(root, "dialogue-web/src/style.css"),
    `:root {\n${declarations.map((line) => `  ${line}`).join("\n")}\n}\n\n${rules}\n`,
    "utf8",
  );
  return root;
}

/** A writer the report can be handed, plus the text it collected. */
function sink() {
  const lines = [];
  return { lines, stream: { write: (chunk) => lines.push(String(chunk)) } };
}

const pair = (fg, bg, why = "a fixture rule paints this ink on this surface") => ({ fg, bg, min: 4.5, why });

test("a pair under its minimum is reported by label with its ratio, and exits 0 until --fail", () => {
  const root = stylesheet();
  try {
    const result = checkContrastTokens({ root, pairs: [pair("ink-quiet", "surface-card")] });
    assert.equal(result.status, "failed");
    assert.equal(result.examined, 1);
    assert.equal(result.rows[0].verdict, "fail");
    assert.equal(result.rows[0].ratio.toFixed(2), "2.80", "the quiet ink on the card tone measures 2.80:1");
    assert.deepEqual(
      result.violations.map((violation) => violation.code),
      ["contrast_below_min:ink-quiet on surface-card"],
    );
    assert.equal(result.violations[0].ratio, 2.8);

    const report = sink();
    assert.equal(
      reportContrastTokens(result, { out: report.stream, err: report.stream }),
      0,
      "a failing pair is reported, not enforced, without --fail",
    );
    const printed = report.lines.join("");
    assert.match(printed, /^contrast_tokens: examined 1 pair\(s\) in 2 token\(s\)$/mu);
    assert.match(printed, /ink-quiet on surface-card fg=#6a625a bg=#201d1d ratio=2\.80 min=4\.5 verdict=fail/u);
    assert.equal(
      reportContrastTokens(result, { fail: true, out: sink().stream, err: sink().stream }),
      1,
      "--fail is what turns the same reading into an exit code",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the JSON verdict line carries the population, the violations and the status", () => {
  const root = stylesheet();
  try {
    const result = checkContrastTokens({ root, pairs: [pair("ink-live", "surface-canvas")] });
    const report = sink();
    reportContrastTokens(result, { out: report.stream, err: report.stream });
    const verdict = JSON.parse(report.lines.at(-1));
    assert.deepEqual(verdict, {
      gate: "contrast-tokens",
      examined: 1,
      tokens: 2,
      violations: [],
      status: "passed",
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a token declared with color-mix is named unreadable for the pair that needs it, not skipped", () => {
  const root = stylesheet();
  try {
    const result = checkContrastTokens({ root, pairs: [pair("ink-blended", "surface-canvas")] });
    assert.equal(result.status, "failed");
    assert.equal(result.rows[0].verdict, "unreadable");
    assert.equal(result.rows[0].ratio, null, "no ratio is invented for a value that is not one colour");
    assert.deepEqual(
      result.violations.map((violation) => violation.code),
      ["token_unreadable:ink-blended on surface-canvas:ink-blended"],
    );
    assert.match(result.violations[0].detail, /--ink-blended is `color-mix\(/u, "the value it saw is quoted back");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a translucent ink is composited over its background and measured, not called unreadable", () => {
  const root = stylesheet();
  try {
    const result = checkContrastTokens({ root, pairs: [pair("ink-ghost", "surface-canvas")] });
    assert.equal(result.rows[0].verdict, "fail");
    assert.equal(result.rows[0].ratio.toFixed(2), "2.92", "35% of the live ink over the canvas is #5e5b58");
    assert.equal(result.rows[0].fgHex, "#5e5b58");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an empty pair list is blocked in every mode, never a pass", () => {
  const root = stylesheet();
  try {
    const result = checkContrastTokens({ root, pairs: [] });
    assert.equal(result.status, "blocked");
    assert.equal(result.examined, 0);
    assert.equal(result.reason, "no pair to measure");
    assert.equal(reportContrastTokens(result, { out: sink().stream, err: sink().stream }), 1);
    assert.equal(
      reportContrastTokens(result, { fail: true, out: sink().stream, err: sink().stream }),
      1,
      "--fail makes no difference: a blocked reading is never exit 0",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a stylesheet that declares no custom property is blocked, so an empty token table is not a pass", () => {
  const root = stylesheet({ declarations: [], rules: "" });
  try {
    const result = checkContrastTokens({ root, pairs: [pair("ink-live", "surface-canvas")] });
    assert.equal(result.status, "blocked");
    assert.match(result.reason, /declares no custom property/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a pair whose ink or surface the stylesheet never paints is reported against that token", () => {
  const root = stylesheet();
  try {
    const result = checkContrastTokens({ root, pairs: [pair("ink-unused", "surface-unused")] });
    assert.equal(result.status, "failed");
    assert.deepEqual(
      result.violations.map((violation) => violation.code),
      ["pair_ink_unused:ink-unused on surface-unused", "pair_surface_unused:ink-unused on surface-unused"],
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a missing stylesheet is blocked rather than an empty pass", () => {
  const root = mkdtempSync(join(tmpdir(), "contrast-tokens-"));
  try {
    const result = checkContrastTokens({ root, pairs: [pair("ink-live", "surface-canvas")] });
    assert.equal(result.status, "blocked");
    assert.match(result.reason, /could not be read/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
