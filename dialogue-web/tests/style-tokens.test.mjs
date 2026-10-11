/**
 * The stylesheet's own token contract.
 *
 * `var(--x)` whose `--x` is declared nowhere is not a fallback: the property it
 * feeds becomes invalid at computed-value time, so the declaration is dropped
 * and the element inherits - the stop button's destructive red, the drawer's
 * burgundy gradient and the model chip's gold all silently became accidents
 * that way. Every custom property the stylesheet reads has to be declared
 * somewhere in the stylesheet itself.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const STYLESHEET = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "style.css");

/** The custom properties a stylesheet reads, and the ones it declares. */
export function customProperties(css) {
  const body = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const referenced = new Set();
  const declared = new Set();
  for (const match of body.matchAll(/var\(\s*(--[A-Za-z0-9_-]+)/g)) referenced.add(match[1]);
  for (const match of body.matchAll(/(?:^|[;{\s])(--[A-Za-z0-9_-]+)\s*:/g)) declared.add(match[1]);
  return { referenced, declared };
}

test("every custom property the stylesheet reads is declared in it", () => {
  const css = readFileSync(STYLESHEET, "utf8");
  const { referenced, declared } = customProperties(css);
  const undeclared = [...referenced].filter((name) => !declared.has(name)).sort();
  assert.deepEqual(
    undeclared,
    [],
    "an undeclared custom property is guaranteed-invalid: the declaration that reads it is dropped instead of falling back",
  );
});
