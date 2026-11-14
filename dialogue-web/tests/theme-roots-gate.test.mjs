/**
 * The two appearances declare one token set, and `color-scheme` is the roots' business.
 *
 * WHY
 *
 * Two defects arrived through this same door and both landed green.
 *
 * `color-scheme: dark` was written on exactly one business selector, `.form-select` (commits `1b06e0d6` ..
 * `bd49cc52^`), and on no root at all: `color-scheme` is what tells the platform which way round to draw the
 * widgets no rule of ours reaches - an `<option>` popup, a scrollbar, a date picker's calendar - so a control that
 * states `dark` for itself renders a dark popup on the light appearance. `bd49cc52` moved the declaration to the
 * two token roots, and `cb723b6d` moved it off the unlayered token roots into `theme.reset` (it is not a token),
 * which is where it belongs today. Nothing stops the next `.some-control { color-scheme: dark }`, and the runtime
 * proof - `color-scheme-follows-the-appearance.spec.ts`, which drives a browser - only runs in the mounted zone.
 *
 * The second is quieter. Everything in `dialogue-web/src/style.css` is declared in the DARK root (`:root`) and
 * re-stated in the light root (`:root[data-theme="light"]`) for the tokens whose colour the light canvas changes.
 * A token added to one root and forgotten in the other therefore lands green: the light appearance inherits a dark
 * literal, and the contrast gate measures the pairs it was given, so a pair whose ink and surface both survive
 * unchanged reads as a pass. That sentence was already written down in `tools/check-contrast-tokens.mjs` - which
 * pointed at `style-tokens-gate.test.mjs` as the gate holding it, and that file stopped doing so when the token
 * rule was delegated to stylelint. This is that gate.
 *
 * GATE A: LOCALITY
 *
 * `color-scheme` may be declared only on an appearance root - `:root`, or `:root[data-theme="…"]` - and each
 * appearance the product paints must state one. The appearance population is not this file's: it is the union
 * `export type Appearance` in `dialogue-web/src/appearance.ts`, so an appearance added there without a root here is
 * a finding rather than a silence, and a root deleted from the stylesheet cannot shrink the rule that judges it.
 * A named appearance whose own selector says nothing is satisfied by the base root only when the base asks for
 * that very appearance (`:root { color-scheme: dark }` already paints the dark appearance's widgets).
 *
 * The value must be ONE appearance keyword (`dark`, `light`, optionally `only light`), never the two-valued
 * `light dark` form: that form asks the platform's own `prefers-color-scheme` instead of this product's resolved
 * choice, which hands a player who picked light on a dark machine a dark popup - the repair `bd49cc52` rejected on
 * measurement. When the appearance is named by a keyword the platform already has, the keyword must be that one.
 *
 * `COLOR_SCHEME_EXEMPTIONS` is the mechanism for a third-party rule that genuinely has to state its own scheme:
 * `{ selector, reason }`, the selector written exactly as the sheet writes it. It is empty, and an entry that stops
 * matching is a finding (`color_scheme_exemption_expired`) - an allow-list that outlives its cause is how a gate
 * turns into a list of yesterday's decisions. A blanket entry is not possible: an entry names one selector.
 *
 * GATE B: KEY-SET PARITY
 *
 * Every appearance root must declare the same key set as the base root. The rule is stated as the property behind
 * it rather than as "the two lists must match", because they do NOT match today and must not: the light root
 * re-states only what the light canvas changes. So a key the base declares and an appearance does not is a finding
 * UNLESS its value carries no appearance at all:
 *
 *   - a pure alias (`var(--x)`) follows the literal it points at, and the whole chain is resolved: the aliased key
 *     must be re-stated in that appearance, or its own value must be appearance-neutral. An alias to a colour only
 *     the dark root declares is a dark colour in the light appearance, which is the defect, and it is named with
 *     the chain that produced it.
 *   - a length, a time, an easing or a font stack is appearance-neutral by nature: `--space-3: 12px` is the same
 *     12 px in every appearance, and re-stating it would make one fact two.
 *   - everything else - a colour, a shadow, and a percentage, because a share is measured against the canvas it
 *     sits on (which is why `--banner-wash` is 12% and 6%) - is appearance-bearing and must be re-stated. A key
 *     that is deliberately one-sided says so in `ONE_SIDED_TOKENS` with the appearance it is missing from and the
 *     reason, and an entry whose key is no longer one-sided is `one_sided_token_expired`.
 *
 * The other direction is unconditional: a key an appearance declares and the base does not is
 * `theme_token_orphan:<appearance>:<key>` - there is no appearance in which that key has an inherited value.
 *
 * WHAT THIS DOES NOT READ (named so the reading is not overclaimed)
 *
 *   - `style.css` only. An inline `style={{ colorScheme: "dark" }}` in a component, or a `color-scheme` in
 *     `index.html`, is outside this gate; the mounted spec is what sees the painted result.
 *   - the winning cascade. A root's scheme is the last declaration written for that appearance in source order;
 *     declarations spread across `@layer`s are read, but which layer wins is the browser's business.
 *   - whether a re-stated value is the RIGHT colour, or a pair is legible: `tools/check-contrast-tokens.mjs` owns
 *     the AA floor, and it holds each appearance's own table.
 *
 * The reading prints the population (appearances, key counts, the one-sided keys with their classification), so
 * "0 violation(s)" arrives with the number of keys it examined - a sheet with no appearance root at all is
 * `blocked` by the appearance union assertion, never green.
 *
 * RED PROOF, each rule seen red on a real injected violation
 *
 *   - `--surface-elevated` deleted from the light root -> `theme_token_not_restated:light:surface-elevated`, and the
 *     alias that reads it -> `theme_token_not_restated:light:surface-hover`, naming the chain
 *     `--surface-hover -> --surface-elevated`;
 *   - `color-scheme: dark` added to `.form-select` -> `color_scheme_off_theme_root:.form-select`;
 *   - the base root written as `light dark` -> `color_scheme_two_valued::root` and
 *     `color_scheme_root_undeclared:dark`;
 *   - the light root naming `dark` -> `color_scheme_disagrees_with_root:light`;
 *   - a token declared on the light root only -> `theme_token_orphan:light:<token>`;
 *   - an exemption matching no selector -> `color_scheme_exemption_expired:<selector>`, and one for a key both roots
 *     declare -> `one_sided_token_expired:light:<token>`;
 *   - history, through `pnpm replay:gate-on-history`: at `d7b214bd`, the revision that still carried the
 *     `.form-select` hardcode, the gate `fired` with four findings naming `.form-select` and the three roots that
 *     stated no scheme; at `bd49cc52`, the commit that moved the declaration to the roots, `did-not-fire`.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const DIALOGUE_WEB = join(dirname(fileURLToPath(import.meta.url)), "..");
const STYLESHEET = join(DIALOGUE_WEB, "src", "style.css");
/** The union that names every appearance this product paints. The stylesheet carries one root per member. */
const APPEARANCE_SOURCE = join(DIALOGUE_WEB, "src", "appearance.ts");

/** `:root`, or `:root[data-theme="name"]`: the only selectors an appearance may be stated on. */
const APPEARANCE_ROOT = /^:root(?:\[data-theme="([a-z0-9-]+)"\])?$/u;
const COLOR_SCHEME = "color-scheme";
/** `color-scheme` takes one appearance, or `only` plus one. `light dark` is the form this product rejected. */
const ONE_APPEARANCE = /^(?:only\s+)?(dark|light)$/u;
/** A token that is exactly one alias of another token. */
const ALIAS = /^var\(\s*--([a-z0-9-]+)\s*\)$/u;
/** A length, a time or an angle: geometry has no appearance, so no ramp can change it. */
const DIMENSION = /^-?(?:\d+|\d*\.\d+)(?:px|rem|em|ms|s|vh|vw|dvh|fr|deg|ch)$/u;
const EASING = /^(?:cubic-bezier\(|steps\(|ease|linear|step-start|step-end)/u;
/** One font family: a word or a quoted name. A stack is several of them, comma-separated. */
const FONT_FAMILY = /^(?:[A-Za-z0-9_-]+|"[^"]*"|'[^']*')$/u;
/** How many `var()` hops an alias may take before the chain is a loop. */
const MAX_ALIAS_DEPTH = 8;
/** The base root's name in the finding codes, so every report says which root it is about. */
const BASE = "base";

/**
 * Selectors that genuinely need their own `color-scheme`, as `{ selector, reason }`.
 *
 * Empty: every declaration in the sheet is on an appearance root, which is the invariant. An entry names ONE
 * selector exactly as the sheet writes it, carries the reason it cannot read the page's scheme, and is a finding
 * the moment that selector stops declaring the property.
 */
const COLOR_SCHEME_EXEMPTIONS = [];

/**
 * Tokens that are deliberately declared in one root only, as `{ token, missingFrom, reason }`.
 *
 * Empty: every one-sided key today is one-sided for a reason the gate can read off its own value (an alias, or a
 * value that carries no appearance), so nothing needs a written exception. An entry names ONE token and the
 * appearance that omits it, and stops being valid once the token is declared there.
 */
const ONE_SIDED_TOKENS = [];

/** The appearances this product paints, from the union that owns them. */
function readAppearances(source) {
  const union = /export type Appearance\s*=([^;]+);/u.exec(source);
  assert.ok(
    union !== null,
    `${APPEARANCE_SOURCE} no longer declares \`export type Appearance\`: this gate's appearance population comes ` +
      "from that union, and without it the population would be whatever the stylesheet happens to name",
  );
  const names = [...union[1].matchAll(/"([a-z0-9-]+)"/gu)].map((match) => match[1]);
  assert.ok(
    names.length > 0,
    `\`export type Appearance\` in ${APPEARANCE_SOURCE} names no appearance, so there is nothing for a root to be`,
  );
  return names;
}

/**
 * Every style rule in the sheet: its selector list, its declarations, and the at-rules it sits inside.
 *
 * Comments and quoted strings are skipped rather than blanked, because a token root's selector carries its
 * appearance in an attribute value (`[data-theme="light"]`) and blanking strings would erase it.
 */
export function readRules(css) {
  const rules = [];
  const open = [];
  let buffer = "";
  let index = 0;
  while (index < css.length) {
    const character = css[index];
    if (character === "/" && css[index + 1] === "*") {
      const end = css.indexOf("*/", index + 2);
      index = end < 0 ? css.length : end + 2;
      buffer += " ";
      continue;
    }
    if (character === '"' || character === "'") {
      let cursor = index + 1;
      while (cursor < css.length && css[cursor] !== character) cursor += css[cursor] === "\\" ? 2 : 1;
      buffer += css.slice(index, cursor + 1);
      index = cursor + 1;
      continue;
    }
    if (character === "{") {
      const prelude = buffer.trim();
      const atRule = prelude.startsWith("@");
      const rule = {
        prelude,
        atRule,
        selectors: atRule ? [] : prelude.split(",").map((selector) => selector.trim()),
        declarations: [],
        atRules: open.filter((entry) => entry.atRule).map((entry) => entry.prelude),
      };
      rules.push(rule);
      open.push(rule);
      buffer = "";
      index += 1;
      continue;
    }
    if (character === "}" || character === ";") {
      const rule = open.at(-1);
      const statement = buffer.trim();
      if (character === "}" && rule !== undefined && !rule.atRule && statement.length > 0) {
        const colon = statement.indexOf(":");
        if (colon > 0) rule.declarations.push({ property: statement.slice(0, colon).trim(), value: statement.slice(colon + 1).trim() });
      }
      if (character === "}" && open.length > 0) open.pop();
      if (character === ";" && rule !== undefined && !rule.atRule && statement.length > 0) {
        const colon = statement.indexOf(":");
        if (colon > 0) rule.declarations.push({ property: statement.slice(0, colon).trim(), value: statement.slice(colon + 1).trim() });
      }
      buffer = "";
      index += 1;
      continue;
    }
    buffer += character;
    index += 1;
  }
  return rules;
}

/** The rules written on appearance roots only - every selector in the list is `:root` or a named root. */
export function readAppearanceRoots(rules) {
  return rules.filter(
    (rule) =>
      !rule.atRule &&
      rule.selectors.length > 0 &&
      rule.selectors.every((selector) => APPEARANCE_ROOT.test(selector)),
  );
}

/** The appearance a selector names, or `base` for the bare `:root`. */
const appearanceOf = (selector) => APPEARANCE_ROOT.exec(selector)[1] ?? BASE;

/** True when the value carries no appearance: a dimension, an easing, or a font stack. */
export function isAppearanceNeutral(value) {
  if (value === "0" || DIMENSION.test(value)) return true;
  const parts = value.split(/\s+/u).filter((part) => part.length > 0);
  if (parts.length > 0 && parts.every((part) => part === "0" || DIMENSION.test(part))) return true;
  if (EASING.test(value)) return true;
  const families = value.split(",").map((family) => family.trim());
  return families.length > 1 && families.every((family) => FONT_FAMILY.test(family));
}

/**
 * Follow a token's alias chain to the literal it ends at: `{ chain, terminal, value }`, where `chain` is the alias
 * path (so a finding can quote it), `terminal` the token that writes a literal, and `value` that literal.
 */
export function resolveAlias(tokens, token) {
  const chain = [token];
  let current = token;
  for (let depth = 0; depth <= MAX_ALIAS_DEPTH; depth += 1) {
    const value = tokens.get(current);
    if (value === undefined) return { chain, terminal: current, value: undefined, loop: false };
    const alias = ALIAS.exec(value);
    if (alias === null) return { chain, terminal: current, value, loop: false };
    current = alias[1];
    chain.push(current);
  }
  return { chain, terminal: current, value: tokens.get(current), loop: true };
}

/**
 * Gate A over one sheet: every `color-scheme` is written on an appearance root, every appearance asks the platform
 * for its own widgets, and every exemption still matches something.
 */
export function colorSchemeFindings(rules, appearances) {
  const findings = [];
  const declared = new Map();
  const exemptions = new Map(COLOR_SCHEME_EXEMPTIONS.map((entry) => [entry.selector, entry]));
  const exempted = new Set();

  for (const rule of rules) {
    for (const declaration of rule.declarations) {
      if (declaration.property !== COLOR_SCHEME) continue;
      const subject = rule.selectors.join(", ");
      const offRoot = rule.selectors.filter((selector) => !APPEARANCE_ROOT.test(selector));
      if (offRoot.length > 0) {
        if (exemptions.has(subject)) {
          exempted.add(subject);
          continue;
        }
        findings.push({
          code: `color_scheme_off_theme_root:${offRoot.join(",")}`,
          selector: subject,
          atRules: rule.atRules,
          detail:
            `${subject} declares \`color-scheme: ${declaration.value}\`, so the platform's own widgets are drawn ` +
            `in that appearance whatever the page says: \`${COLOR_SCHEME}\` belongs on the appearance roots ` +
            "(`:root`, `:root[data-theme=\"…\"]`), which follow the appearance `appearance.ts` resolves",
        });
        continue;
      }
      const keyword = ONE_APPEARANCE.exec(declaration.value);
      if (keyword === null)
        findings.push({
          code: `color_scheme_two_valued:${subject}`,
          selector: subject,
          detail:
            `${subject} declares \`color-scheme: ${declaration.value}\`, which asks the platform's own ` +
            "prefers-color-scheme instead of this product's resolved appearance: a player who picks light on a " +
            "machine set to dark then gets dark platform widgets. Name the one appearance the root paints",
        });
      for (const selector of rule.selectors) {
        const appearance = appearanceOf(selector);
        if (!declared.has(appearance)) declared.set(appearance, []);
        declared.get(appearance).push({ value: declaration.value, keyword: keyword?.[1] ?? null, selector });
      }
    }
  }

  const base = declared.get(BASE)?.[0] ?? null;
  if (base === null)
    findings.push({
      code: `color_scheme_root_undeclared:${BASE}`,
      root: BASE,
      detail:
        "no `:root` rule declares `color-scheme`, so a document whose appearance has not been resolved yet leaves " +
        "the platform to draw its own widgets in whatever the operating system asks for",
    });

  for (const appearance of appearances) {
    const own = declared.get(appearance);
    if (own !== undefined) {
      const keyword = own.at(-1).keyword;
      if (keyword !== null && ONE_APPEARANCE.test(appearance) && keyword !== appearance)
        findings.push({
          code: `color_scheme_disagrees_with_root:${appearance}`,
          root: appearance,
          detail:
            `the ${appearance} root declares \`color-scheme: ${keyword}\`, so the page is painted in one ` +
            "appearance while the platform draws its own widgets in the other",
        });
      continue;
    }
    if (base !== null && base.keyword === appearance) continue;
    findings.push({
      code: `color_scheme_root_undeclared:${appearance}`,
      root: appearance,
      detail:
        `the ${appearance} appearance has no root that declares \`${COLOR_SCHEME}\`, so its platform widgets ` +
        (base === null
          ? "follow the operating system"
          : `inherit the base root's \`${base.value}\` while the page is painted ${appearance}`),
    });
  }

  for (const [selector, entry] of exemptions)
    if (!exempted.has(selector))
      findings.push({
        code: `color_scheme_exemption_expired:${selector}`,
        selector,
        detail: `\`${selector}\` no longer declares \`${COLOR_SCHEME}\`, so its exemption (${entry.reason}) has nothing left to excuse`,
      });
  for (const entry of COLOR_SCHEME_EXEMPTIONS)
    if (typeof entry.reason !== "string" || entry.reason.trim().length < 20)
      findings.push({
        code: `color_scheme_exemption_unreasoned:${entry.selector}`,
        selector: entry.selector,
        detail: "an exemption has to say why that selector cannot read the page's scheme, in a sentence",
      });

  return { findings, declared, base };
}

/** The token tables of the base root and of every appearance root. */
export function readTokenTables(rules) {
  const base = new Map();
  const appearances = new Map();
  for (const rule of readAppearanceRoots(rules)) {
    const names = rule.selectors.map(appearanceOf);
    const declaresBase = names.includes(BASE);
    for (const declaration of rule.declarations) {
      if (!declaration.property.startsWith("--")) continue;
      const token = declaration.property.slice(2);
      if (declaresBase) base.set(token, declaration.value);
      for (const name of names) {
        if (name === BASE) continue;
        if (!appearances.has(name)) appearances.set(name, new Map());
        appearances.get(name).set(token, declaration.value);
      }
    }
  }
  return { base, appearances };
}

/**
 * Gate B over one sheet: every appearance declares the base root's whole token set, minus the keys whose value
 * carries no appearance (an alias that lands on a re-stated literal, a length, a time, an easing, a font stack).
 */
export function tokenParityFindings(rules, expectedAppearances) {
  const findings = [];
  const { base, appearances } = readTokenTables(rules);
  const reading = [];

  for (const name of expectedAppearances) {
    const table = appearances.get(name);
    if (table === undefined) {
      findings.push({
        code: `appearance_root_missing:${name}`,
        appearance: name,
        detail:
          `\`export type Appearance\` in appearance.ts names \`${name}\`, and no \`:root[data-theme="${name}"]\` rule ` +
          "declares a token for it: that appearance would paint the base root's dark set",
      });
      continue;
    }
    const orphans = [...table.keys()].filter((token) => !base.has(token));
    for (const token of orphans)
      findings.push({
        code: `theme_token_orphan:${name}:${token}`,
        appearance: name,
        token,
        detail:
          `--${token} is declared on the ${name} root and on no base root, so there is no appearance in which it ` +
          "has a value: declare it in the base root and override it where the appearance changes it",
      });

    const oneSided = [...base.keys()].filter((token) => !table.has(token));
    const declared = ONE_SIDED_TOKENS.filter((entry) => entry.missingFrom === name);
    const consumed = new Set();
    /** Why each one-sided key is one-sided: `alias`, `neutral`, `declared`, or `violation`. */
    const kinds = new Map();
    for (const token of oneSided) {
      const value = base.get(token);
      const exemption = declared.find((entry) => entry.token === token);
      if (exemption !== undefined) {
        consumed.add(token);
        kinds.set(token, "declared");
        if (typeof exemption.reason !== "string" || exemption.reason.trim().length < 20)
          findings.push({
            code: `one_sided_token_unreasoned:${name}:${token}`,
            appearance: name,
            token,
            detail: `--${token} is one-sided in the ${name} root and its exception does not say why`,
          });
        continue;
      }
      const alias = ALIAS.exec(value);
      if (alias !== null) {
        const { chain, terminal, value: literal, loop } = resolveAlias(base, token);
        if (loop) {
          kinds.set(token, "violation");
          findings.push({
            code: `theme_token_alias_loop:${token}`,
            token,
            detail: `${chain.map((step) => `--${step}`).join(" -> ")} never reaches a literal`,
          });
          continue;
        }
        if (literal === undefined) {
          kinds.set(token, "violation");
          findings.push({
            code: `theme_token_alias_undeclared:${token}:${terminal}`,
            token,
            detail:
              `--${token} is \`var(--${terminal})\`, and --${terminal} is declared in no base root: in every ` +
              "appearance the alias feeds an invalid value",
          });
          continue;
        }
        if (table.has(terminal) || isAppearanceNeutral(literal)) {
          kinds.set(token, "alias");
          continue;
        }
        kinds.set(token, "violation");
        findings.push({
          code: `theme_token_not_restated:${name}:${token}`,
          appearance: name,
          token,
          detail:
            `the ${name} root declares no --${token}, and its alias chain lands on --${terminal}: ` +
            `${literal} - a dark literal this appearance inherits, because --${terminal} is not re-stated there. ` +
            `Chain: ${chain.map((step) => `--${step}`).join(" -> ")}`,
        });
        continue;
      }
      if (isAppearanceNeutral(value)) {
        kinds.set(token, "neutral");
        continue;
      }
      kinds.set(token, "violation");
      findings.push({
        code: `theme_token_not_restated:${name}:${token}`,
        appearance: name,
        token,
        detail:
          `the ${name} root declares no --${token} and the base root's value is \`${value}\`, which carries an ` +
          "appearance: state --" +
          token +
          ` on \`:root[data-theme="${name}"]\` in the same commit as this one`,
      });
    }
    for (const entry of declared)
      if (!consumed.has(entry.token))
        findings.push({
          code: `one_sided_token_expired:${name}:${entry.token}`,
          appearance: name,
          token: entry.token,
          detail: `--${entry.token} is declared on the ${name} root now, so its one-sided exception (${entry.reason}) has expired`,
        });

    const counts = { alias: 0, neutral: 0, declared: 0, violation: 0 };
    for (const kind of kinds.values()) counts[kind] += 1;
    reading.push({
      appearance: name,
      keys: table.size,
      shared: [...table.keys()].filter((token) => base.has(token)).length,
      oneSided,
      kinds,
      counts,
    });
  }

  return { findings, base, appearances, reading };
}

function describeTokenSet(base, reading) {
  const lines = [`theme_roots: base ${base.size} token(s)`];
  for (const entry of reading)
    lines.push(
      `theme_roots: ${entry.appearance} ${entry.keys} token(s), ${entry.shared} shared with the base, ` +
        `${entry.oneSided.length} one-sided -> ${entry.counts.alias} alias-follows-literal, ` +
        `${entry.counts.neutral} appearance-neutral, ${entry.counts.declared} declared, ` +
        `${entry.counts.violation} violation(s)`,
    );
  for (const entry of reading)
    lines.push(
      `theme_roots: ${entry.appearance} one-sided: ` +
        (entry.oneSided.length === 0
          ? "(none)"
          : entry.oneSided.map((token) => `--${token} (${entry.kinds.get(token)})`).join(", ")),
    );
  return lines;
}

test("gate: color-scheme is declared by the appearance roots and by nothing else", (t) => {
  const stylesheet = readFileSync(STYLESHEET, "utf8");
  const appearances = readAppearances(readFileSync(APPEARANCE_SOURCE, "utf8"));
  const rules = readRules(stylesheet);
  const roots = readAppearanceRoots(rules);

  const { findings, declared } = colorSchemeFindings(rules, appearances);
  t.diagnostic(`color_scheme: ${appearances.length} appearance(s) from appearance.ts: ${appearances.join(", ")}`);
  t.diagnostic(`color_scheme: ${roots.length} appearance root(s) in style.css, ${declared.size} stating a scheme`);
  t.diagnostic(`color_scheme: ${findings.length} violation(s)`);

  assert.ok(
    roots.length > 0,
    "style.css declares no appearance root at all: this gate would pass by having found nothing to read",
  );
  assert.deepEqual(
    findings.map((finding) => `${finding.code} - ${finding.detail}`),
    [],
    "color-scheme belongs to the appearance roots, one appearance keyword each, on every appearance the product paints",
  );
});

test("gate: every appearance declares the base root's whole token set", (t) => {
  const stylesheet = readFileSync(STYLESHEET, "utf8");
  const appearances = readAppearances(readFileSync(APPEARANCE_SOURCE, "utf8"));
  const { findings, base, reading } = tokenParityFindings(readRules(stylesheet), appearances);

  assert.ok(
    base.size > 0,
    "the sheet declares no custom property on its base root: this gate would pass by having found nothing to read",
  );
  for (const line of describeTokenSet(base, reading)) t.diagnostic(line);
  t.diagnostic(`theme_roots: ${findings.length} violation(s)`);

  assert.deepEqual(
    findings.map((finding) => `${finding.code} - ${finding.detail}`),
    [],
    "a token one appearance does not declare is a dark literal the other appearance inherits, unless its value " +
      "carries no appearance",
  );
});
