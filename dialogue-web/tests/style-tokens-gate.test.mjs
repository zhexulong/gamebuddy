/**
 * The stylesheet's own contracts.
 *
 * The token contract: `var(--x)` whose `--x` is declared nowhere is not a
 * fallback - the property it feeds becomes invalid at computed-value time, so
 * the declaration is dropped and the element inherits. That is how the stop
 * button's destructive red, the drawer's burgundy gradient and the model chip's
 * gold silently became accidents.
 *
 * The layer contract: the stylesheet declares an explicit cascade order at the
 * top and writes every rule into a named `@layer`. A component rule that leaks
 * out of its layer wins for the wrong reason - an unlayered rule beats every
 * layered rule no matter how specific the layered one is - so the gate asserts
 * the whole structure twice: the audit's own named rules sit in `theme.polish`
 * and nowhere else, and the unlayered remainder holds nothing but the order
 * statement and the token roots (`:root`), which compete with no rule.
 *
 * This file now holds the layer rules only. The token rule (gate 2.1, "every
 * custom property the stylesheet reads is declared in it") is delegated to
 * `stylelint` with `csstools/value-no-unknown-custom-properties`: run
 * `pnpm run check:css` in this package, which is part of `test:static`. The
 * hand-written duplicate that lived here and in `style-tokens.test.mjs` is
 * gone, so there is exactly one mechanism for the rule.
 *
 * Gate 2.2 and gate 2.3 stay here: they assert cascade *structure* (a named
 * component rule sits inside its declared layer, and the unlayered remainder
 * holds only the order statement and the token roots). No off-the-shelf tool
 * expresses "this selector must be inside this `@layer` block"; stylelint
 * parses layers but has no rule for placing a selector in one.
 *
 * A token root is `:root`, optionally repeated with a `[data-theme="…"]`
 * attribute - one appearance per theme, layered by specificity rather than by
 * source order. Gate 2.3 accepts that selector shape and nothing else, and it
 * reads the rule's own body: a token root that declares anything but a custom
 * property is a component rule wearing a token root's selector.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const STYLESHEET = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "style.css");

/** Comments and quoted strings blanked, so a brace inside them is not a brace. */
function structural(css) {
  return css
    .replace(/\/\*[\s\S]*?\*\//gu, " ")
    .replace(/"(?:[^"\\]|\\.)*"/gu, '""')
    .replace(/'(?:[^'\\]|\\.)*'/gu, "''");
}

/** Top-level `@layer name { ... }` bodies, by brace matching. */
function layerBodies(css) {
  const text = structural(css);
  const bodies = new Map();
  const header = /@layer\s+([A-Za-z0-9_.-]+)\s*\{/gu;
  let match;
  while ((match = header.exec(text)) !== null) {
    const start = header.lastIndex;
    let depth = 1;
    let index = start;
    while (index < text.length && depth > 0) {
      if (text[index] === "{") depth += 1;
      else if (text[index] === "}") depth -= 1;
      index += 1;
    }
    bodies.set(match[1], text.slice(start, index - 1));
  }
  return bodies;
}

/** Everything outside every `@layer` block: the unlayered remainder. */
function unlayeredText(css) {
  const text = structural(css);
  const header = /@layer\s+([A-Za-z0-9_.-]+)\s*\{/gu;
  let result = "";
  let cursor = 0;
  let match;
  while ((match = header.exec(text)) !== null) {
    let depth = 1;
    let index = header.lastIndex;
    while (index < text.length && depth > 0) {
      if (text[index] === "{") depth += 1;
      else if (text[index] === "}") depth -= 1;
      index += 1;
    }
    result += text.slice(cursor, match.index);
    cursor = index;
    header.lastIndex = index;
  }
  return result + text.slice(cursor);
}

/** A token root's selector list: `:root` and `:root[data-theme="…"]`, comma-separated. Quoted strings are blanked. */
const TOKEN_ROOT_SELECTOR = /^:root(?:\[data-theme=""\])?(?:\s*,\s*:root(?:\[data-theme=""\])?)*$/u;

/**
 * A token root declares custom properties and nothing else. A `color:` inside one of these blocks would be a
 * component rule wearing a token root's selector, and it would win over every layered rule.
 */
function onlyCustomProperties(body) {
  return body
    .split(";")
    .map((declaration) => declaration.trim())
    .filter((declaration) => declaration.length > 0)
    .every((declaration) => declaration.startsWith("--"));
}

/**
 * The top-level items of the unlayered remainder: `@layer a, b;` statements
 * (order declarations, not rules) and, if any leaked, rulesets. Each item is
 * `{ prelude, body, ruleset }`, where a ruleset's prelude is its selector list.
 */
export function unlayeredItems(css) {
  const text = unlayeredText(css);
  const items = [];
  const depth = [];
  const opening = [];
  let start = 0;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (character === "{") {
      if (depth.length === 0) {
        items.push({ prelude: text.slice(start, index).trim().replace(/\s+/gu, " "), body: "", ruleset: true });
        opening.push(index);
      }
      depth.push(index);
    } else if (character === "}") {
      depth.pop();
      if (depth.length === 0) items.at(-1).body = text.slice(opening.pop() + 1, index).trim();
      start = index + 1;
    } else if (character === ";" && depth.length === 0) {
      const prelude = text.slice(start, index).trim().replace(/\s+/gu, " ");
      if (prelude.length > 0) items.push({ prelude, body: "", ruleset: false });
      start = index + 1;
    }
  }
  return items;
}

test("gate 2.2: a named component rule sits inside its declared layer, not unlayered", (t) => {
  const css = readFileSync(STYLESHEET, "utf8");
  const layers = layerBodies(css);
  const unlayered = unlayeredText(css);

  t.diagnostic(`gate 2.2: ${layers.size} layer block(s): ${[...layers.keys()].join(", ")}`);
  assert.ok(layers.has("theme.legacy"), "theme.legacy must be a named layer block");
  assert.ok(layers.has("theme.polish"), "theme.polish must be a named layer block");

  // One stable rule per layer, chosen because nothing else owns their names.
  assert.match(layers.get("theme.legacy"), /\.stop-button\b/u, ".stop-button must live in theme.legacy");
  assert.match(layers.get("theme.polish"), /\.composer-container\b/u, ".composer-container must live in theme.polish");

  assert.doesNotMatch(unlayered, /\.stop-button\b/u, ".stop-button must not be unlayered");
  assert.doesNotMatch(unlayered, /\.composer-container\b/u, ".composer-container must not be unlayered");

  // The rules authored after `theme.polish` was named - the disclosure, the two
  // data lists, the voice status and the three banners. Each one is the highest
  // layer's business: at `theme.legacy` the banner loses to a panel paragraph,
  // and unlayered it beats the layer its own author wrote it into.
  for (const selector of [
    ".custom-disclosure",
    "[data-world-book-list]",
    "[data-import-history-entries]",
    "[data-import-history-counts]",
    ".voice-status",
    ".error-banner",
    ".warning-banner",
    ".success-banner",
  ]) {
    const pattern = new RegExp(`${selector.replace(/[[\]]/gu, (character) => `\\${character}`)}(?![\\w-])`, "u");
    assert.match(layers.get("theme.polish"), pattern, `${selector} must live in theme.polish`);
    assert.doesNotMatch(unlayered, pattern, `${selector} must not be unlayered`);
  }
});

test("gate 2.3: the unlayered remainder is the order statement and the token roots only", (t) => {
  const css = readFileSync(STYLESHEET, "utf8");
  const items = unlayeredItems(css);
  const leaked = items.filter((item) => {
    if (!item.ruleset) return !item.prelude.startsWith("@layer ");
    return !TOKEN_ROOT_SELECTOR.test(item.prelude) || !onlyCustomProperties(item.body);
  });
  t.diagnostic(`gate 2.3: ${items.length} unlayered top-level item(s): ${items.map((item) => item.prelude).join(", ")}`);
  assert.ok(
    items.some((item) => item.ruleset),
    "examined 0 unlayered rule(s): this gate would pass by having found nothing",
  );
  assert.deepEqual(
    leaked.map((item) => item.prelude),
    [],
    "an unlayered rule wins over every layered rule regardless of specificity; a component rule must name its layer, " +
      "and only the token roots (`:root` and `:root[data-theme=\u2026]`, declaring custom properties only) stay unlayered",
  );
});
