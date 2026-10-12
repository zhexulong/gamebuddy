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
 * This file is the reviewer's Gate 2. The token assertion overlaps the earlier
 * `style-tokens.test.mjs`; both parse the same stylesheet and both must stay
 * green - the earlier file is the token lane's own regression, this one is the
 * gate.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const STYLESHEET = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "style.css");

/** The custom properties a stylesheet reads, and the ones it declares. */
export function customProperties(css) {
  const body = css.replace(/\/\*[\s\S]*?\*\//gu, "");
  const referenced = new Set();
  const declared = new Set();
  for (const match of body.matchAll(/var\(\s*(--[A-Za-z0-9_.-]+)/gu)) referenced.add(match[1]);
  for (const match of body.matchAll(/(?:^|[;{\s])(--[A-Za-z0-9_.-]+)\s*:/gu)) declared.add(match[1]);
  return { referenced, declared };
}

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

/**
 * The top-level items of the unlayered remainder: `@layer a, b;` statements
 * (order declarations, not rules) and, if any leaked, rulesets. Each item is
 * `{ prelude, ruleset }`, where a ruleset's prelude is its selector list.
 */
export function unlayeredItems(css) {
  const text = unlayeredText(css);
  const items = [];
  const depth = [];
  let start = 0;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (character === "{") {
      if (depth.length === 0) items.push({ prelude: text.slice(start, index).trim().replace(/\s+/gu, " "), ruleset: true });
      depth.push(index);
    } else if (character === "}") {
      depth.pop();
      start = index + 1;
    } else if (character === ";" && depth.length === 0) {
      const prelude = text.slice(start, index).trim().replace(/\s+/gu, " ");
      if (prelude.length > 0) items.push({ prelude, ruleset: false });
      start = index + 1;
    }
  }
  return items;
}

test("gate 2.1: every custom property the stylesheet reads is declared in it", (t) => {
  const css = readFileSync(STYLESHEET, "utf8");
  const { declared } = customProperties(css);
  const failures = [];
  let reads = 0;
  css.split("\n").forEach((line, index) => {
    // Ignore a comment tail the way the collector does: only a real consumption point counts.
    const code = line.replace(/\/\*.*?\*\//gu, " ");
    for (const match of code.matchAll(/var\(\s*(--[A-Za-z0-9_-]+)/gu)) {
      reads += 1;
      if (!declared.has(match[1])) failures.push(`src/style.css:${index + 1} reads undeclared ${match[1]}`);
    }
  });
  t.diagnostic(`gate 2.1: ${declared.size} declared properties, ${reads} read(s), ${failures.length} undeclared`);
  assert.deepEqual(
    failures,
    [],
    "an undeclared custom property is guaranteed-invalid: the declaration that reads it is dropped instead of falling back",
  );
});

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
  const leaked = items.filter(
    (item) => item.ruleset ? item.prelude !== ":root" : !item.prelude.startsWith("@layer "),
  );
  t.diagnostic(`gate 2.3: ${items.length} unlayered top-level item(s): ${items.map((item) => item.prelude).join(", ")}`);
  assert.deepEqual(
    leaked.map((item) => item.prelude),
    [],
    "an unlayered rule wins over every layered rule regardless of specificity; a component rule must name its layer, and only the token roots stay unlayered",
  );
});
