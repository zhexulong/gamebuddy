/**
 * Every animation and every moving transition has a reduced-motion escape.
 *
 * This gate has to know the cascade to be honest, because the obvious version of
 * it is wrong. The stylesheet's universal escape -
 *
 *     @media (prefers-reduced-motion: reduce) { *, *::before, *::after { animation-duration: 0.01ms } }
 *
 * - sits in a lower layer and has the lowest possible specificity, so it does NOT
 * neutralise a class-keyed `animation:` in the same or a later layer: the class
 * selector beats `*` inside a layer, and a later layer beats an earlier one at
 * equal specificity. A gate that merely looked for "is there a reduce block" would
 * pass every one of those and catch nothing.
 *
 * So the rule is cascade-aware. A motion site is a rule declaring
 *   - `animation` (whose `@keyframes` animate a motion property), or
 *   - `transition` whose property list contains a motion property
 * (`all` counts only when the same rule also declares a motion property: the four
 * `transition: all` sites in this stylesheet are colour hovers, and calling them
 * motion would be the false positive that gets the gate disabled).
 *
 * The site is neutralised when a reduced-motion declaration sets the motion off
 * (`animation: none`, `animation-name: none`, `transition: none`,
 * `transition-property: none`, or a duration of 0.01ms or less), and that
 * declaration *wins the cascade* for the site: a higher layer, or the same layer
 * with greater-or-equal specificity and later source order. The neutraliser must
 * also cover the site's element - the universal selector covers everything, and
 * otherwise every class name it names must be one of the site's.
 *
 * Safe, explicitly listed transition properties (paint only, no movement, no
 * fade): color, background-color, border-color and the other `*-color` paint
 * properties, box-shadow, outline-color, fill, stroke, text-decoration-color.
 * Everything else in a transition - including anything this list does not name -
 * is treated as motion.
 *
 * The three findings below are real and are reported to the owner rather than
 * fixed here, because `dialogue-web/src/style.css` is another lane's file. The
 * gate asserts each still reproduces, so an entry cannot outlive its fix.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const STYLESHEET = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "style.css");

/** Transition properties that are paint only: no movement and no fade. */
const SAFE_TRANSITION_PROPERTIES = new Set([
  "color",
  "background-color",
  "border-color",
  "border-top-color",
  "border-right-color",
  "border-bottom-color",
  "border-left-color",
  "outline-color",
  "column-rule-color",
  "text-decoration-color",
  "caret-color",
  "box-shadow",
  "fill",
  "stroke",
  "stop-color",
  "flood-color",
  "lighting-color",
]);

/** Keyframe properties that move or fade something. */
const MOTION_PROPERTIES = /^(transform|translate|rotate|scale|opacity|filter|backdrop-filter|background-position|top|right|bottom|left|inset|margin|padding|width|height|max-height|min-height|flex|grid-template)/u;

/**
 * Properties that are motion *by themselves*, as opposed to layout properties that
 * `transition: all` would only animate if some rule changed them. `all` is treated
 * as motion when the rule (or another rule naming the same keyed class, i.e. a
 * hover/state rule) declares one of these - the four `transition: all` sites here
 * are colour hovers on buttons whose padding/height never change, and calling them
 * motion would be the false positive that gets the gate disabled.
 */
const INHERENT_MOTION_PROPERTIES = new Set([
  "transform",
  "translate",
  "rotate",
  "scale",
  "opacity",
  "filter",
  "backdrop-filter",
  "background-position",
  "top",
  "right",
  "bottom",
  "left",
  "inset",
]);

/**
 * Real findings this lane cannot fix (style.css belongs to another lane). Each is
 * `{ selector, kind, reason }`; the gate fails if one stops reproducing.
 */
const REPORTED_UNMUTED_MOTION = [
  {
    selector: ".skip-link",
    kind: "transition",
    reason:
      "the skip link slides in on focus (`top: -100px` -> `top: 0`) and no reduce rule names it; the universal reduce rule is lower-specificity and lives in the same layer",
  },
  {
    selector: '.status-dot[data-tone="progress"]',
    kind: "animation",
    reason:
      "a progress dot keeps pulsing under prefers-reduced-motion: the universal reduce rule is lower-specificity than this class rule, and no explicit reduce rule names it",
  },
  {
    selector: '.game-status[data-tone="progress"]::before',
    kind: "animation",
    reason: "same shape as the progress dot: the pulsing status dot has no explicit reduce rule",
  },
  {
    selector: ".custom-disclosure > summary > svg",
    kind: "transition",
    reason:
      "the disclosure chevron keeps its 150ms transform transition; the only reduce rules for transforms live in lower layers",
  },
];

/** Comments blanked with spaces so offsets and line numbers stay true. */
function blankComments(css) {
  return css.replace(/\/\*[\s\S]*?\*\//gu, (match) => " ".repeat(match.length));
}

/** The declared layer order, from the `@layer a, b, c;` statement. */
export function layerOrder(css) {
  const statement = /@layer\s+([^{}]*);/u.exec(blankComments(css));
  if (statement === null) return [];
  return statement[1]
    .split(",")
    .map((name) => name.trim())
    .filter((name) => name.length > 0);
}

function lineOf(css, index) {
  return css.slice(0, index).split("\n").length;
}

/** `{ a, b, c }` specificity of one selector list. */
export function specificityOf(selector) {
  const text = selector
    .replace(/::[a-z-]+/gu, " ")
    .replace(/\[[^\]]*\]/gu, " x")
    .replace(/:(?!:)[a-z-]+(\([^)]*\))?/gu, " x");
  const ids = (selector.match(/#[A-Za-z_-][\w-]*/gu) ?? []).length;
  const classes = (selector.match(/\.[A-Za-z_-][\w-]*/gu) ?? []).length + (text.match(/\bx\b/gu) ?? []).length;
  const types = (text.match(/(^|[\s>+~,(])([a-z][a-z0-9]*)\b/gu) ?? []).length;
  return { a: ids, b: classes, c: types };
}

function compareSpecificity(left, right) {
  if (left.a !== right.a) return left.a - right.a;
  if (left.b !== right.b) return left.b - right.b;
  return left.c - right.c;
}

export function isUniversal(selector) {
  return selector.split(",").every((part) => /^\s*(\*|svg)(::(before|after))?\s*$/u.test(part));
}

function classNames(selector) {
  return new Set(selector.match(/\.[A-Za-z_-][\w-]*/gu) ?? []);
}

/**
 * The rulesets, layer index per rule, media conditions, keyframes and the
 * reduced-motion declarations, parsed by brace matching.
 */
export function parseStylesheet(css) {
  const text = blankComments(css);
  const order = layerOrder(css);
  const rules = [];
  const keyframes = new Map();
  const reduceDeclarations = [];
  const stack = [];

  const layerIndexOf = (current) => {
    for (let index = current.length - 1; index >= 0; index -= 1) {
      const entry = current[index];
      if (entry.kind === "layer") {
        const found = order.indexOf(entry.name);
        return found === -1 ? order.length : found;
      }
    }
    return order.length; // unlayered code wins over every layer
  };
  const mediaStackOf = (current) => current.filter((entry) => entry.kind === "media").map((entry) => entry.condition);
  const insideKeyframes = (current) => current.some((entry) => entry.kind === "keyframes");

  let preludeStart = 0;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (character === "{") {
      const prelude = text.slice(preludeStart, index).trim().replace(/\s+/gu, " ");
      let entry = { prelude, start: index, layerIndex: layerIndexOf(stack), media: mediaStackOf(stack) };
      if (prelude.startsWith("@")) {
        if (/^@layer\s/u.test(prelude))
          entry = { ...entry, kind: "layer", name: prelude.replace(/^@layer\s+/u, "").trim() };
        else if (/^@media\s/u.test(prelude))
          entry = { ...entry, kind: "media", condition: prelude.replace(/^@media\s+/u, "").trim() };
        else if (/^@keyframes\s/u.test(prelude))
          entry = { ...entry, kind: "keyframes", name: prelude.replace(/^@keyframes\s+/u, "").trim() };
        else entry = { ...entry, kind: "at" };
      } else {
        entry = { ...entry, kind: "ruleset" };
      }
      stack.push(entry);
      preludeStart = index + 1;
      continue;
    }
    if (character === "}" || character === ";") {
      if (character === "}") {
        const entry = stack.pop();
        if (entry !== undefined) {
          const body = text.slice(entry.start + 1, index);
          if (entry.kind === "ruleset" && !insideKeyframes(stack)) {
            const declarations = declarationsOf(body);
            rules.push({
              selector: entry.prelude,
              declarations,
              layerIndex: entry.layerIndex,
              media: entry.media,
              offset: entry.start,
              line: lineOf(css, entry.start),
            });
            if (entry.media.some((condition) => /prefers-reduced-motion\s*:\s*reduce/u.test(condition))) {
              for (const [property, value] of declarations) reduceDeclarations.push({ selector: entry.prelude, property, value, layerIndex: entry.layerIndex, offset: entry.start, line: lineOf(css, entry.start) });
            }
          }
          if (entry.kind === "keyframes") {
            const properties = new Set();
            for (const match of body.matchAll(/([a-z-]+)\s*:/gu)) properties.add(match[1]);
            keyframes.set(entry.name, properties);
          }
        }
      }
      preludeStart = index + 1;
      continue;
    }
  }
  return { rules, keyframes, reduceDeclarations, order };
}

/** `[property, value]` pairs of a declaration body (nested blocks skipped). */
export function declarationsOf(body) {
  const out = [];
  for (const part of body.split(";")) {
    const trimmed = part.trim();
    if (trimmed.length === 0 || trimmed.includes("{")) continue;
    const separator = trimmed.indexOf(":");
    if (separator <= 0) continue;
    out.push([trimmed.slice(0, separator).trim(), trimmed.slice(separator + 1).trim().replace(/\s+/gu, " ")]);
  }
  return out;
}

function durationIsInstant(value) {
  return [...value.matchAll(/([\d.]+)\s*(ms|s)\b/gu)].some((match) =>
    match[2] === "ms" ? Number(match[1]) <= 0.01 : Number(match[1]) <= 0.00001,
  );
}

/** Does a reduced-motion declaration turn this animation/transition off? */
function neutralises(declaration, kind) {
  const property = declaration.property;
  const value = declaration.value;
  if (kind === "animation") {
    if (property === "animation" || property === "animation-name") return /\bnone\b/u.test(value) || durationIsInstant(value);
    if (property === "animation-duration") return durationIsInstant(value);
    return false;
  }
  if (property === "transition" || property === "transition-property")
    return /\bnone\b/u.test(value) || durationIsInstant(value);
  if (property === "transition-duration") return durationIsInstant(value);
  return false;
}

/** The neutralisers that actually beat the site in the cascade. */
export function applies(neutralizer, site) {
  if (neutralizer.layerIndex > site.layerIndex) return true;
  if (neutralizer.layerIndex < site.layerIndex) return false;
  if (neutralizer.offset <= site.offset) return false;
  return compareSpecificity(specificityOf(neutralizer.selector), specificityOf(site.selector)) >= 0;
}

function coversPart(part, siteSelector) {
  if (isUniversal(part)) return true;
  const named = classNames(part);
  if (named.size === 0) return false;
  const siteClasses = classNames(siteSelector);
  for (const name of named) if (!siteClasses.has(name)) return false;
  return true;
}

/**
 * The selectors of a (possibly comma-joined) neutraliser rule that cover the site.
 * A selector *list* is four selectors, not a union of their class names: the
 * reduce block's `.message-spinner` does not cover `.message-bubble`.
 */
function coveringParts(neutralizer, site) {
  return neutralizer.selector
    .split(",")
    .map((part) => part.trim())
    .filter((part) => coversPart(part, site.selector));
}

/** Does this selector, specifically, beat the site in the cascade? */
function appliesSelector(selector, neutralizer, site) {
  if (neutralizer.layerIndex > site.layerIndex) return true;
  if (neutralizer.layerIndex < site.layerIndex) return false;
  if (neutralizer.offset <= site.offset) return false;
  return compareSpecificity(specificityOf(selector), specificityOf(site.selector)) >= 0;
}

/** The motion sites of one stylesheet: `{ selector, kind, properties, line }`. */
export function motionSites(css) {
  const { rules, keyframes } = parseStylesheet(css);
  const sites = [];
  for (const rule of rules) {
    for (const [property, value] of rule.declarations) {
      if (property === "animation" || property === "animation-name") {
        if (/\bnone\b/u.test(value)) continue;
        const named = [...keyframes.entries()].find(([name]) => new RegExp(`(^|[\\s,])${name}([\\s,]|$)`, "u").test(value));
        const animated = named === undefined ? new Set() : named[1];
        const moving = [...animated].some((name) => MOTION_PROPERTIES.test(name));
        if (animated.size > 0 ? !moving : false) continue;
        sites.push({ ...rule, kind: "animation", properties: [...animated], value });
        continue;
      }
      if (property !== "transition" && property !== "transition-property") continue;
      const declared = value
        .split(",")
        .map((part) => part.trim().split(/\s+/u)[0])
        .filter((name) => /^[a-z-]+$/u.test(name) && name !== "none");
      const keyedClass = [...classNames(rule.selector)].pop();
      const familyMoves = rules.some(
        (other) =>
          other !== rule &&
          keyedClass !== undefined &&
          classNames(other.selector).has(keyedClass) &&
          other.declarations.some(([name]) => INHERENT_MOTION_PROPERTIES.has(name)),
      );
      const moving = declared.filter((name) => {
        if (name === "all")
          return (
            rule.declarations.some(([other]) => INHERENT_MOTION_PROPERTIES.has(other)) ||
            familyMoves
          );
        return !SAFE_TRANSITION_PROPERTIES.has(name);
      });
      if (moving.length === 0) continue;
      sites.push({ ...rule, kind: "transition", properties: moving, value });
    }
  }
  return sites;
}

/** Motion sites with no reduced-motion escape that wins the cascade. */
export function unmutedMotion(css) {
  const { reduceDeclarations } = parseStylesheet(css);
  const failures = [];
  for (const site of motionSites(css)) {
    const escaping = reduceDeclarations.some((declaration) => {
      if (!neutralises(declaration, site.kind)) return false;
      return coveringParts(declaration, site).some((part) => appliesSelector(part, declaration, site));
    });
    if (escaping) continue;
    failures.push({
      line: site.line,
      selector: site.selector,
      kind: site.kind,
      properties: site.properties,
      layerIndex: site.layerIndex,
    });
  }
  return failures;
}

/** The reported findings, matched by selector and kind. */
function isReported(failure) {
  return REPORTED_UNMUTED_MOTION.some(
    (entry) => entry.selector === failure.selector && entry.kind === failure.kind,
  );
}

test("motion.1: every animation and moving transition has a reduced-motion escape that wins", (t) => {
  const css = readFileSync(STYLESHEET, "utf8");
  const failures = [];
  for (const failure of unmutedMotion(css)) {
    if (isReported(failure)) continue;
    failures.push(
      `src/style.css:${failure.line} ${failure.kind} "${failure.properties.join(", ")}" on ${failure.selector} survives prefers-reduced-motion`,
    );
  }
  const reported = unmutedMotion(css).filter(isReported).length;
  t.diagnostic(
    `motion.1: ${motionSites(css).length} motion site(s), ${reported} reported finding(s), ${failures.length} unreported`,
  );
  assert.deepEqual(failures, [], "motion that ignores prefers-reduced-motion is an accessibility defect");
});

test("motion.2: every reported finding still reproduces", (t) => {
  const css = readFileSync(STYLESHEET, "utf8");
  const found = unmutedMotion(css);
  for (const entry of REPORTED_UNMUTED_MOTION) {
    assert.ok(
      found.some((failure) => failure.selector === entry.selector && failure.kind === entry.kind),
      `${entry.selector} no longer survives prefers-reduced-motion; remove the reported entry`,
    );
  }
  t.diagnostic(`motion.2: ${REPORTED_UNMUTED_MOTION.length} reported finding(s) still reproduce`);
});

test("motion.3: the paint-only sites are recognised and not reported", (t) => {
  const css = readFileSync(STYLESHEET, "utf8");
  const sites = motionSites(css);
  assert.equal(
    sites.some((site) => site.selector === ".nav-button"),
    false,
    "a transition: all that only changes colour is paint, not motion",
  );
  assert.ok(
    sites.some((site) => site.selector === ".voice-pulse-ring"),
    "the halo is motion and must be a site",
  );
  t.diagnostic(`motion.3: ${sites.length} motion site(s); colour-only transitions excluded`);
});

test("motion.4 (mutation): an animation and a transform transition with no escape both fail", (t) => {
  const mutated = `${readFileSync(STYLESHEET, "utf8")}
@keyframes gate-probe-spin {
  to { transform: rotate(360deg); }
}
.gate-probe-spinner {
  animation: gate-probe-spin 1s linear infinite;
}
.gate-probe-panel {
  transition: transform var(--motion-duration-fast) var(--motion-ease-out);
}
`;
  const failures = unmutedMotion(mutated).filter((failure) => failure.selector.startsWith(".gate-probe"));
  assert.deepEqual(
    failures.map((failure) => [failure.selector, failure.kind, failure.properties]),
    [
      [".gate-probe-spinner", "animation", ["transform"]],
      [".gate-probe-panel", "transition", ["transform"]],
    ],
  );
  t.diagnostic(`motion.4: injected spinner and transform transition reported at lines ${failures.map((f) => f.line).join(", ")}`);
});

test("motion.5 (mutation): the same site with a higher-layer escape is clean", (t) => {
  const mutated = `${readFileSync(STYLESHEET, "utf8")}
.gate-probe-panel {
  transition: transform var(--motion-duration-fast) var(--motion-ease-out);
}
@media (prefers-reduced-motion: reduce) {
  .gate-probe-panel {
    transition: none;
  }
}
`;
  const failures = unmutedMotion(mutated).filter((failure) => failure.selector.startsWith(".gate-probe"));
  assert.deepEqual(failures, []);
  t.diagnostic("motion.5: a later same-specificity reduce rule neutralises the site");
});

test("motion.6: the cascade reading is asserted on the real sheet", (t) => {
  const css = readFileSync(STYLESHEET, "utf8");
  const { order } = parseStylesheet(css);
  assert.deepEqual(order, ["theme.reset", "theme.surfaces", "theme.interactions", "theme.layout", "theme.legacy", "theme.polish"]);
  assert.ok(
    specificityOf(".status-dot[data-tone=\"progress\"]").b > specificityOf("*").b,
    "a class rule out-specifies the universal escape - this is why the gate cannot just look for a reduce block",
  );
  t.diagnostic(`motion.6: layer order read as ${order.join(" < ")}`);
});
