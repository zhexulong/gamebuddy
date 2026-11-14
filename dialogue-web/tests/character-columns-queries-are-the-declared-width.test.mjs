/**
 * The character sheet's two column breaks are the declared column width's arithmetic.
 *
 * `[data-characters-panel]` lays its cards out with `columns: var(--characters-column-width)`, and
 * two `@container` blocks force which card begins a new column. A `@container` condition cannot
 * take a custom property, so the thresholds have to be literals - and a literal that is not the
 * token's arithmetic is the same defect the media queries were: a number that stops describing the
 * box it governs the moment the box changes. Nobody notices, because it keeps working at the widths
 * someone looked at.
 *
 * So this gate reads BOTH numbers out of the sheet and asserts the relation:
 *
 *   three columns need   3 * width + 2 * gap
 *   two columns need     2 * width +      gap
 *
 * The population is every `@container` block in `style.css` that forces a column break inside
 * `[data-characters-panel]`, read from the sheet rather than listed here - a third break added to
 * the panel is measured by the "every threshold is one of the declared arithmetics" assertion, and
 * a break whose block was deleted leaves this gate with nothing to check, which it refuses.
 *
 * red-proof: inject  set `--characters-column-width: 400px` -> "the 1284px threshold is not
 *   3*420 + 2*12 = 1284 and not 2*420 + 12 = 852: the sheet declares a 400px column".
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const DIALOGUE_WEB = join(dirname(fileURLToPath(import.meta.url)), "..");
const SHEET = join(DIALOGUE_WEB, "src", "style.css");
const PANEL = "[data-characters-panel] >";

export function declaredToken(css, name) {
  const match = new RegExp(`--${name}:\\s*(\\d+)px;`, "u").exec(css);
  return match === null ? null : Number(match[1]);
}

/**
 * Every `@container` block that forces a column break on one of the panel's cards.
 *
 * Braces are counted rather than matched with a regex: the blocks nest inside a `@layer`, and a
 * regex that stops at the first `}` would end the block at the first declaration's parent.
 */
export function breakThresholds(css) {
  const found = [];
  const lines = css.split("\n");
  const opening = /^(\s*)@container \(min-width: (\d+)px\)(?: and \(max-width: (\d+)px\))? \{/u;
  for (let index = 0; index < lines.length; index += 1) {
    const match = opening.exec(lines[index]);
    if (match === null) continue;
    const indent = match[1];
    let depth = 1;
    let cursor = index + 1;
    const body = [];
    for (; cursor < lines.length && depth > 0; cursor += 1) {
      const line = lines[cursor];
      for (const character of line) {
        if (character === "{") depth += 1;
        else if (character === "}") depth -= 1;
      }
      if (depth > 0) body.push(line);
    }
    const text = body.join("\n");
    if (text.includes(PANEL) && text.includes("break-before: column"))
      found.push({
        line: index + 1,
        indent,
        min: Number(match[2]),
        max: match[3] === undefined ? null : Number(match[3]),
        selectors: body.filter((line) => line.includes(PANEL)).map((line) => line.trim()),
      });
    index = cursor - 1;
  }
  return found;
}

test("char.1: the column breaks' thresholds are the declared column width's arithmetic", (t) => {
  const css = readFileSync(SHEET, "utf8");
  const width = declaredToken(css, "characters-column-width");
  const gap = declaredToken(css, "characters-column-gap");
  assert.ok(width !== null, "--characters-column-width is declared in style.css");
  assert.ok(gap !== null, "--characters-column-gap is declared in style.css");
  assert.ok(
    /columns:\s*var\(--characters-column-width\)/u.test(css),
    "the panel's `columns` reads the token, so the token is the column width and not a second copy of it",
  );

  const threeAt = 3 * width + 2 * gap;
  const twoAt = 2 * width + gap;
  const thresholds = breakThresholds(css);
  t.diagnostic(
    `char.1: column ${width}px + gap ${gap}px -> three at ${threeAt}px, two at ${twoAt}px; ` +
      `thresholds ${JSON.stringify(thresholds.map((entry) => [entry.min, entry.max]))}`,
  );
  assert.ok(
    thresholds.length > 0,
    "no forced column break on [data-characters-panel] was found in style.css: the population is empty, so this " +
      "gate agrees with itself rather than with the sheet",
  );

  const arithmetic = new Set([threeAt, twoAt]);
  for (const threshold of thresholds) {
    assert.ok(
      arithmetic.has(threshold.min),
      `the ${threshold.min}px threshold at style.css:${threshold.line} is neither 3*${width} + 2*${gap} = ${threeAt} ` +
        `nor 2*${width} + ${gap} = ${twoAt}: the sheet declares a ${width}px column with a ${gap}px gap, so a ` +
        "threshold that is not one of those is a number that stopped describing this panel",
    );
  }
  // The upper bound of the two-column band is the three-column threshold minus one pixel: an overlap
  // would apply both breaks, which is how the panel overflowed by 760 px when the breaks were
  // unscoped.
  const threeColumn = thresholds.find((entry) => entry.min === threeAt);
  const twoColumn = thresholds.find((entry) => entry.min === twoAt);
  assert.ok(threeColumn !== undefined, `no threshold at the three-column width (${threeAt}px)`);
  assert.ok(twoColumn !== undefined, `no threshold at the two-column width (${twoAt}px)`);
  assert.equal(
    twoColumn.max,
    threeAt - 1,
    `the two-column band ends at ${twoColumn.max}px and the three-column one starts at ${threeColumn.min}px: the two ` +
      "bands must meet without overlapping",
  );
  assert.equal(threeColumn.max, null, "the three-column band has no upper bound: above it the panel is still three");
});

test("char.2 (mutation): a threshold that is not the declared arithmetic is reported by number", (t) => {
  const drifted = [
    "@layer theme.components {",
    "  :root {",
    "    --characters-column-width: 400px;",
    "    --characters-column-gap: 12px;",
    "  }",
    "  @container (min-width: 1284px) {",
    "    [data-characters-panel] > [data-persona-editor] {",
    "      break-before: column;",
    "    }",
    "  }",
    "}",
  ].join("\n");
  const found = breakThresholds(drifted);
  assert.deepEqual(
    found.map((entry) => entry.min),
    [1284],
  );
  const width = declaredToken(drifted, "characters-column-width");
  assert.equal(width, 400);
  assert.ok(!new Set([3 * width + 2 * 12, 2 * width + 12]).has(1284));
  t.diagnostic("char.2: a 400px column with a 1284px threshold is a drift this gate reports by number");
});
