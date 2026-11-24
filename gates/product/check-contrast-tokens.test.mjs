/**
 * The gate's falsifiers. Each case writes a throwaway `dialogue-web/src/style.css` and drives the exported function
 * over it, so the assertion is about what the gate READS rather than about this repository's current tokens (the
 * CLI run against the real stylesheet is the other half).
 *
 * red-proof: inject  `--ink-quiet` (#6a625a) paired with `--surface-card` (#201d1d) ->
 *            `contrast_below_min:ink-quiet on surface-card` at 2.80:1 (min 4.5), with the report-only run still
 *            exiting 0 and `--fail` exiting 1; `--ink-blended` declared `color-mix(...)` ->
 *            `token_unreadable:base:ink-blended on surface-canvas:ink-blended`; `pairs: []` -> `status:"blocked"` and
 *            exit 1 in both modes; a declared token no rule paints ->
 *            `pair_ink_unused:<label>` and `pair_surface_unused:<label>`; an `rgba()` ink is composited and
 *            measured (2.92:1) rather than called unreadable; a second appearance whose ink is one shade too pale ->
 *            the same pair named under that appearance while the base reading of it still passes; a
 *            `[data-theme="sepia"]` selector written outside the token-root shape -> `theme_selector_unread:sepia`;
 *            a light `--surface-canvas` of #f8f9fa (two code values from the card) -> every text pair still passes
 *            and `elevation_indistinct:light:surface-canvas->surface-card` names the rung at 1.01:1 with the three
 *            means it looked for; the same fog with a declared `--shadow-card` that the rule painting the raised layer
 *            applies as a `box-shadow` -> `verdict=pass means=shadow:shadow-card`; the same declaration NOT applied by
 *            that rule, while another rule still paints the token -> `elevation_shadow_unpainted`, which is the paper
 *            claim a means has to refuse; a rung naming a selector the sheet does not carry ->
 *            `elevation_shadow_rule_absent`, and one whose selector paints a different layer ->
 *            `elevation_shadow_off_surface`; with a declared `--border-control` painted as a border ->
 *            `means=boundary:border-control`, and that token darkened to a hairline ->
 *            `elevation_boundary_below_floor`; `rgba(0, 0, 0, 0)` as the shadow -> `elevation_shadow_invisible`; a
 *            `--surface-sheet` layer no rung raises -> `elevation_layer_without_rung`.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { checkContrastTokens, ELEVATION_STEPS, reportContrastTokens } from "./check-contrast-tokens.mjs";

/** The tokens the fixtures declare: a five-layer ladder, two live inks, and the inks the cases inject. */
const DECLARATIONS = [
  "--surface-canvas: #0c0b0b;",
  "--surface-panel: #161414;",
  "--surface-card: #201d1d;",
  "--surface-elevated: #282525;",
  "--surface-accent: #533137;",
  "--ground-unused: #101010;",
  "--ink-live: #f5f0e8;",
  "--ink-quiet: #6a625a;",
  "--ink-ghost: rgba(245, 240, 232, 0.35);",
  "--ink-blended: color-mix(in srgb, var(--ink-live) 60%, var(--surface-card));",
  "--ink-unused: #ffffff;",
  "--shadow-card: 0 1px 2px rgba(0, 0, 0, 0.4);",
];

/** Which of those tokens the sheet actually paints, and as what. */
const RULES = [
  ".shell { background-color: var(--surface-canvas); color: var(--ink-live); }",
  ".card { background-color: var(--surface-card); }",
  ".quiet { color: var(--ink-quiet); }",
  ".ghost { color: var(--ink-ghost); }",
  ".blend { color: var(--ink-blended); }",
  // The two rules the shipped rung claims name. A claim is credited only when the rule that paints the raised layer
  // applies the token, so a fixture without them would report every claim as a rule the sheet does not carry.
  ".memory-notebook { background-color: var(--surface-card); box-shadow: var(--shadow-card); }",
  ".message.companion .message-bubble { background-color: var(--surface-card); box-shadow: var(--shadow-card); }",
].join("\n");

/**
 * The shipped rung list with its means claims removed, for the cases whose subject is the luminance floor alone: with
 * the claims in place a fogged palette would be carried by the fixture's own shadow instead of being named.
 */
const BARE_STEPS = ELEVATION_STEPS.map(({ shadow, boundary, ...step }) => step);

/** A stylesheet at the real relative path inside its own temp root, which the caller removes. */
function stylesheet({ declarations = DECLARATIONS, rules = RULES, roots = [] } = {}) {
  const root = mkdtempSync(join(tmpdir(), "contrast-tokens-"));
  mkdirSync(join(root, "dialogue-web/src"), { recursive: true });
  const tokenRoot = (selector, lines) => `${selector} {\n${lines.map((line) => `  ${line}`).join("\n")}\n}\n`;
  writeFileSync(
    join(root, "dialogue-web/src/style.css"),
    `${tokenRoot(":root", declarations)}\n${roots.map((entry) => tokenRoot(entry.selector, entry.declarations)).join("\n")}\n${rules}\n`,
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
      ["contrast_below_min:base:ink-quiet on surface-card"],
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
      elevation: { examined: 4, layers: 5, floor: 1.05, status: "passed" },
      violations: [],
      checks: [
        { id: "every_declared_pair_meets_its_minimum", status: "passed" },
        { id: "every_elevation_rung_is_distinguishable", status: "passed" },
      ],
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
      ["token_unreadable:base:ink-blended on surface-canvas:ink-blended"],
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
    const result = checkContrastTokens({ root, pairs: [pair("ink-unused", "ground-unused")] });
    assert.equal(result.status, "failed");
    assert.deepEqual(
      result.violations.map((violation) => violation.code),
      ["pair_ink_unused:ink-unused on ground-unused", "pair_surface_unused:ink-unused on ground-unused"],
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

/**
 * The population is the appearances the sheet declares, so a second token root is a second reading of every pair -
 * not a set of values that overwrite the first in one table. The injected defect is the defect the two-theme work
 * exists for: a light tone that only *looks* right and drops one pair under AA while the dark reading still passes.
 */
test("a second appearance is measured separately, and a pale one is named while the base still passes", () => {
  const root = stylesheet({
    roots: [
      { selector: ':root[data-theme="light"]', declarations: ["--surface-card: #fdfaf4;", "--ink-live: #c9c2b8;"] },
    ],
  });
  try {
    const result = checkContrastTokens({ root, pairs: [pair("ink-live", "surface-card")] });
    assert.deepEqual(result.themes, ["base", "light"], "the sheet declares two appearances");
    assert.equal(result.examined, 2, "one pair in two appearances is two readings");
    assert.deepEqual(
      result.rows.map((row) => [row.theme, row.verdict]),
      [
        ["base", "pass"],
        ["light", "fail"],
      ],
      "the dark ink still passes on the dark card, and the light ink does not on the light one",
    );
    assert.deepEqual(
      result.violations.map((violation) => violation.code),
      ["contrast_below_min:light:ink-live on surface-card"],
      "the failing reading names the appearance it failed in",
    );
    const report = sink();
    reportContrastTokens(result, { out: report.stream, err: report.stream });
    const printed = report.lines.join("");
    assert.match(printed, /^contrast_tokens: 2 appearance\(s\): base, light$/mu);
    assert.match(
      printed,
      /^ {2}light ink-live on surface-card fg=#c9c2b8 bg=#fdfaf4 ratio=1\.6\d min=4\.5 verdict=fail$/mu,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/**
 * A token root written in a shape this parser does not read would drop that appearance from the population and the
 * gate would pass on the appearance that stayed. Naming the unread selector is what keeps the population honest.
 */
test("an appearance selector no token root claims is a violation, not a missing theme", () => {
  // `html[data-theme="sepia"]` is a perfectly valid rule and a perfectly invisible token root: it would drop that
  // appearance from the population while every pair measured in the appearances that remained still passed.
  const root = stylesheet({
    rules: `${RULES}\nhtml[data-theme="sepia"] { --ink-live: #101010; }`,
  });
  try {
    const result = checkContrastTokens({ root, pairs: [pair("ink-live", "surface-canvas")] });
    assert.deepEqual(
      result.violations.map((violation) => violation.code),
      ["theme_selector_unread:sepia"],
      "the appearance the sheet names and the gate cannot read is named back to its author",
    );
    assert.match(result.violations[0].detail, /write it as `:root\[data-theme="sepia"\] \{ \.\.\. \}`/u);
    assert.deepEqual(result.themes, ["base"], "and the population it did read is still reported");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/**
 * The palette the elevation cases inject: a light canvas of `#f8f9fa`, two code values from the `#fafafc` card. It is
 * the measured blind spot - every text pair on it passes, and the card has no edge at all.
 */
const FOG_ROOT = {
  selector: ':root[data-theme="light"]',
  declarations: [
    "--surface-canvas: #f8f9fa;",
    "--surface-panel: #f1f2f4;",
    "--surface-card: #fafafc;",
    "--surface-elevated: #e8eaee;",
    "--ink-live: #1c1e22;",
  ],
};

/** The same rung list with exactly one means declared on the `canvas->card` rung, which is where the fog lives. */
const rungClaiming = (means) =>
  ELEVATION_STEPS.map((step) =>
    step.beneath === "surface-canvas" && step.raised === "surface-card"
      ? { ...step, shadow: undefined, boundary: undefined, ...means }
      : step,
  );

/**
 * The blind spot, both ways in one run: the pair list is green on a palette whose card melts into the page, and the
 * ladder is what names it. A gate that only measured ink would call this sheet healthy.
 */
test("a canvas that melts into the card is named as a rung while every text pair on it still passes", () => {
  const root = stylesheet({ roots: [FOG_ROOT] });
  try {
    const result = checkContrastTokens({
      root,
      pairs: [pair("ink-live", "surface-canvas"), pair("ink-live", "surface-card")],
      steps: BARE_STEPS,
    });
    assert.deepEqual(
      result.rows.map((row) => row.verdict),
      ["pass", "pass", "pass", "pass"],
      "every ink pair passes in both appearances - this is what the gate could not see before the ladder",
    );
    const rung = result.elevation.rows.find(
      (row) => row.theme === "light" && row.label === "surface-canvas->surface-card",
    );
    assert.equal(rung.verdict, "fail");
    assert.equal(rung.ratio.toFixed(2), "1.01", "two code values apart, which is not a step");
    assert.deepEqual(rung.means, [], "no means held, so the row says so instead of inventing one");

    assert.deepEqual(
      result.violations.map((violation) => violation.code),
      ["elevation_indistinct:light:surface-canvas->surface-card"],
    );
    const [violation] = result.violations;
    assert.equal(violation.ratio, 1.01);
    assert.equal(violation.floor, 1.05);
    assert.equal(violation.beneath, "#f8f9fa");
    assert.equal(violation.raised, "#fafafc");
    assert.match(violation.detail, /reads 1\.01:1 on `--surface-canvas` in the light appearance/u);
    assert.match(violation.detail, /under the 1\.05:1 step floor/u);
    assert.match(violation.detail, /no shadow token is declared for the rung/u, "means (b) is named as missing");
    assert.match(
      violation.detail,
      /no boundary token reads 3:1 against --surface-canvas/u,
      "means (c) is named as missing",
    );

    assert.equal(
      reportContrastTokens(result, { out: sink().stream, err: sink().stream }),
      0,
      "a failing rung is reported, not enforced, without --fail",
    );
    assert.equal(
      reportContrastTokens(result, { fail: true, out: sink().stream, err: sink().stream }),
      1,
      "--fail is what turns the same reading into an exit code",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/** Means (b): the raised layer casts a declared shadow, so a rung under the floor is still an edge. */
test("a rung under the floor is carried by a declared shadow token, and the run prints the token that earned it", () => {
  const root = stylesheet({
    // The card rule already paints the card (`RULES`); this second `.card` rule is the declaration set the element
    // reads together, which is how the cascade composes it.
    rules: `${RULES}\n.card { box-shadow: 0 1px 2px var(--shadow-card); }`,
    roots: [FOG_ROOT],
  });
  try {
    const result = checkContrastTokens({
      root,
      pairs: [pair("ink-live", "surface-card")],
      steps: rungClaiming({ shadow: { token: "shadow-card", rule: ".card" } }),
    });
    const rung = result.elevation.rows.find(
      (row) => row.theme === "light" && row.label === "surface-canvas->surface-card",
    );
    assert.equal(rung.verdict, "pass", "the shadow is the means that carries the rung");
    assert.deepEqual(
      rung.means,
      [{ mean: "shadow", token: "shadow-card", rule: ".card" }],
      "luminance did not carry it and no boundary was claimed",
    );
    assert.deepEqual(result.violations, []);
    assert.equal(result.status, "passed");

    const report = sink();
    reportContrastTokens(result, { out: report.stream, err: report.stream });
    assert.match(
      report.lines.join(""),
      /light surface-canvas->surface-card beneath=#f8f9fa raised=#fafafc ratio=1\.01 floor=1\.05 means=shadow:shadow-card verdict=pass/u,
      "the printed rung says the ratio is under the floor and the shadow is what carried it",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/**
 * The declaration a means may not be paid with: a shadow token the theme declares and some rule paints, while the rule
 * that paints the raised layer applies nothing. The previous reading - "the sheet paints this token somewhere" - called
 * that a means; it is the paper excuse this gate exists to refuse, and it fails by name in every appearance.
 */
test("a shadow token the raised layer does not wear is named, even though another rule paints it", () => {
  const root = stylesheet({
    rules: `${RULES}\n.elsewhere { box-shadow: 0 1px 2px var(--shadow-card); }
.unshadowed { background-color: var(--surface-card); }`,
    roots: [FOG_ROOT],
  });
  try {
    const result = checkContrastTokens({
      root,
      pairs: [pair("ink-live", "surface-card")],
      steps: rungClaiming({ shadow: { token: "shadow-card", rule: ".unshadowed" } }),
    });
    assert.deepEqual(
      result.violations.map((violation) => violation.code),
      [
        "elevation_shadow_unpainted:base:surface-canvas->surface-card",
        "elevation_shadow_unpainted:light:surface-canvas->surface-card",
        "elevation_indistinct:light:surface-canvas->surface-card",
      ],
      "the token IS painted by `.elsewhere`, and that is exactly what the old reading could not tell apart",
    );
    assert.match(result.violations[0].detail, /applies no `box-shadow: var\(--shadow-card\)`/u);
    const rung = result.elevation.rows.find(
      (row) => row.theme === "light" && row.label === "surface-canvas->surface-card",
    );
    assert.equal(rung.verdict, "fail", "a claim that does not hold rescues nothing, not even a rung it cannot carry");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/** A claim naming a rule the sheet no longer has, or one that paints a different layer, is its own violation by name. */
test("a claim naming an absent rule or the wrong layer is named rather than quietly dropped", () => {
  const root = stylesheet({ roots: [FOG_ROOT] });
  try {
    const absent = checkContrastTokens({
      root,
      pairs: [pair("ink-live", "surface-card")],
      steps: rungClaiming({ shadow: { token: "shadow-card", rule: ".renamed-away" } }),
    });
    assert.equal(
      absent.violations.filter((violation) => violation.code.startsWith("elevation_shadow_rule_absent:")).length,
      2,
      "both appearances name the selector the sheet does not carry",
    );
    assert.match(absent.violations[0].detail, /no rule in the sheet carries that selector/u);

    const offSurface = checkContrastTokens({
      root,
      pairs: [pair("ink-live", "surface-card")],
      steps: rungClaiming({ shadow: { token: "shadow-card", rule: ".shell" } }),
    });
    assert.deepEqual(
      offSurface.violations.map((violation) => violation.code),
      [
        "elevation_shadow_off_surface:base:surface-canvas->surface-card",
        "elevation_shadow_off_surface:light:surface-canvas->surface-card",
        "elevation_indistinct:light:surface-canvas->surface-card",
      ],
      "`.shell` paints the canvas, so the shadow it casts is not the card's edge",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/**
 * Means (c): a boundary token at WCAG 1.4.11's 3:1. The same declaration over a token that only reads 1.09:1 on the
 * layer beneath is a claim the sheet does not keep, and it is named whether or not luminance rescued the rung.
 */
test("a boundary token carries a rung at 3:1, and a hairline the rule wears is named", () => {
  const root = stylesheet({
    declarations: [...DECLARATIONS, "--border-control: #787d85;"],
    rules: `${RULES}\n.card { border: 1px solid var(--border-control); }`,
    roots: [FOG_ROOT],
  });
  const hairline = stylesheet({
    declarations: [...DECLARATIONS, "--border-control: #161616;"],
    rules: `${RULES}\n.card { border: 1px solid var(--border-control); }`,
  });
  try {
    const carried = checkContrastTokens({
      root,
      pairs: [pair("ink-live", "surface-card")],
      steps: rungClaiming({ boundary: { token: "border-control", rule: ".card" } }),
    });
    const rung = carried.elevation.rows.find(
      (row) => row.theme === "light" && row.label === "surface-canvas->surface-card",
    );
    assert.equal(rung.verdict, "pass");
    assert.deepEqual(
      rung.means,
      [{ mean: "boundary", token: "border-control", rule: ".card" }],
      "#787d85 reads 3.93:1 on the injected canvas",
    );

    const claimed = checkContrastTokens({
      root: hairline,
      pairs: [pair("ink-live", "surface-card")],
      steps: rungClaiming({ boundary: { token: "border-control", rule: ".card" } }),
    });
    assert.deepEqual(
      claimed.violations.map((violation) => violation.code),
      ["elevation_boundary_below_floor:base:surface-canvas->surface-card"],
      "the claim fails on the dark canvas it is written against, even though luminance carries that rung",
    );
    assert.match(claimed.violations[0].detail, /`--border-control` reads 1\.09:1 on `--surface-canvas`/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(hairline, { recursive: true, force: true });
  }
});

/** A shadow token that paints nothing is a declaration the sheet does not keep, and it is named as such. */
test("a shadow token declared fully transparent is named rather than counted as a means", () => {
  const root = stylesheet({
    declarations: [...DECLARATIONS, "--shadow-card: 0 1px 2px rgba(0, 0, 0, 0);"],
    rules: `${RULES}\n.card { box-shadow: 0 1px 2px var(--shadow-card); }`,
  });
  try {
    const result = checkContrastTokens({
      root,
      pairs: [pair("ink-live", "surface-card")],
      steps: rungClaiming({ shadow: { token: "shadow-card", rule: ".card" } }),
    });
    assert.deepEqual(
      result.violations.map((violation) => violation.code),
      [
        "elevation_shadow_invisible:base:surface-panel->surface-card",
        "elevation_shadow_invisible:base:surface-canvas->surface-card",
      ],
      "the transparent token is named on every rung that claims it, rather than counted as a means",
    );
    assert.match(result.violations[0].detail, /strongest colour is fully transparent/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/**
 * The population is the sheet's own layers, so a sixth one cannot arrive unmeasured: it has to be given a rung or
 * declared a sibling, and until then the appearance that declares it is named.
 */
test("a layer no rung raises and no sibling declares is a violation, in every appearance that declares it", () => {
  const root = stylesheet({
    declarations: [...DECLARATIONS, "--surface-sheet: #101010;"],
    // A second appearance, so the violation is shown per appearance rather than once by accident. It restates the
    // unraised layer and nothing else, so every rung reads the same as the base appearance's.
    roots: [{ selector: ':root[data-theme="light"]', declarations: ["--surface-sheet: #101010;"] }],
  });
  try {
    const result = checkContrastTokens({ root, pairs: [pair("ink-live", "surface-card")] });
    assert.deepEqual(
      result.violations.map((violation) => violation.code),
      ["elevation_layer_without_rung:base:surface-sheet", "elevation_layer_without_rung:light:surface-sheet"],
      "the layer joins the population by being declared, and each appearance that declares it is named",
    );
    assert.match(result.violations[0].detail, /no rung raises it and no sibling names it/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/**
 * The other half of the suite: the real stylesheet. Its ladder is the shipped palette's, so this fails the moment a
 * token edit fogs two layers - the regression the pair list cannot see - and it is the run that prints the numbers.
 */
test("the shipped stylesheet's own ladder is green, and prints every rung with its means", () => {
  const root = fileURLToPath(new URL("../..", import.meta.url));
  const result = checkContrastTokens({ root });
  assert.deepEqual(result.violations, []);
  assert.equal(result.status, "passed");
  assert.deepEqual(result.themes, ["base", "dark", "light"]);

  const layers = new Set(result.elevation.layers.map((layer) => layer.layer));
  assert.deepEqual(
    [...layers].sort(),
    ["surface-accent", "surface-canvas", "surface-card", "surface-elevated", "surface-panel"],
    "the population is the sheet's five layers, derived from its token block",
  );
  assert.equal(
    result.elevation.examined,
    ELEVATION_STEPS.length * result.themes.length,
    "every rung is measured in every appearance, so a rung that quietly stopped being measured shows here",
  );

  for (const theme of result.themes) {
    const rungs = result.elevation.rows.filter((row) => row.theme === theme && row.verdict !== "sibling");
    assert.deepEqual(
      rungs.map((row) => row.label),
      [
        "surface-canvas->surface-panel",
        "surface-panel->surface-card",
        "surface-card->surface-elevated",
        "surface-canvas->surface-card",
      ],
      "the ladder is printed rung by rung, per appearance",
    );
    for (const rung of rungs) {
      assert.equal(rung.verdict, "pass", `${theme} ${rung.label} reads ${rung.ratio.toFixed(2)}:1`);
      assert.ok(rung.means.length > 0, `${theme} ${rung.label} names the means that carried it`);
      // The floor is not a pass on its own: a rung under it has to be carried by a declared means.
      if (rung.ratio < result.elevation.floor)
        assert.ok(
          rung.means.some((carried) => carried.mean !== "luminance"),
          `${theme} ${rung.label} reads ${rung.ratio.toFixed(2)}:1 and names what actually carried it`,
        );
    }
    const described = (label) =>
      rungs
        .find((row) => row.label === label)
        .means.map((carried) => (carried.token === null ? carried.mean : `${carried.mean}:${carried.token}`));
    assert.deepEqual(described("surface-canvas->surface-panel"), ["luminance"], `${theme} canvas->panel`);
    assert.deepEqual(described("surface-card->surface-elevated"), ["luminance"], `${theme} card->elevated`);
    assert.ok(
      described("surface-canvas->surface-card").includes("shadow:shadow-card"),
      `${theme} canvas->card names the card's own shadow beside its step`,
    );
    // The ruling this reads: in the light appearance the panel and the card are both #ffffff, so that rung is the one
    // no floor can carry and the shadow is the only means it has.
    assert.deepEqual(
      described("surface-panel->surface-card"),
      theme === "light" ? ["shadow:shadow-card"] : ["luminance", "shadow:shadow-card"],
      `${theme} panel->card`,
    );
    const sibling = result.elevation.rows.find(
      (row) => row.theme === theme && row.label === "surface-canvas->surface-accent",
    );
    assert.equal(sibling.verdict, "sibling", "the accent plate is printed with its reading and is not a verdict");
  }

  const report = sink();
  reportContrastTokens(result, { out: report.stream, err: report.stream });
  assert.match(
    report.lines.join(""),
    new RegExp(
      `^elevation_ladder: examined ${result.elevation.examined} rung\\(s\\) in 5 layer\\(s\\) over 3 appearance\\(s\\), ` +
        "step floor 1\\.05:1, boundary floor 3:1$",
      "mu",
    ),
  );
});
