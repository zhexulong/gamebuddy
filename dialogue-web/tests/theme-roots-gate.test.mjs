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
 * K_dark is the base root's key set (`:root`, 64 tokens today) and K_light the light root's (24). Two rules:
 *
 *   1. K_light ⊆ K_dark. A key the light root declares and the base root does not has a value in no appearance at
 *      all, so it is a finding even though the set is empty today: an assertion that only holds because nobody has
 *      written the defect yet is not an assertion.
 *   2. every k ∈ K_dark \ K_light is legal exactly when one of two properties holds:
 *
 *        P1 appearance-neutral. The value carries a unit or a family no appearance can change: a time or an easing
 *           (`150ms`, `0.2s`, `cubic-bezier(...)`, `steps(...)`, `ease`, `linear`), a length (`56px`, `0.1em`,
 *           `28rem`, `40ch`, `12cqi`), or a font-stack keyword (`monospace`, `system-ui`, `serif`, ...). The unit is
 *           what is matched, not the letter: `--font-mono`'s `monospace` is typography, never motion.
 *        P2 closed-loop alias. The value is exactly `var(--target)`, and following the chain from k to its terminal
 *           token must end on a token K_light re-states explicitly. An alias to a token only the dark root declares
 *           is a dark colour the light appearance inherits - the same defect, one indirection out.
 *
 *      Anything else fails, in the operator's own words:
 *
 *        `color_scheme_parity_failed: <k> declares a theme-dependent color literal (<value>) on the base root, but
 *         neither restates it in light root nor aliases an already-restated token.`
 *        `color_scheme_parity_failed: <k> aliases <target>, but the terminal token is missing from the light root.`
 *
 *      `<target>` is the terminal token - the one the second sentence then says is missing; a chain longer than one
 *      hop is printed beside its finding. A percentage is not neutral (a share is measured against the canvas it
 *      sits on, which is why `--banner-wash` is 12% and 6%), so a one-sided one fails through the literal message;
 *      "color literal" there means "a value that only fits the canvas it was written on".
 *
 * THE CHAIN IS BOUNDED. `MAX_ALIAS_HOPS` caps the walk. A token that reappears on its own chain is `alias_cycle`
 * and a chain that outlives the cap is `alias_chain_too_long`; neither may pass as "not an alias".
 *
 * NO EXEMPTION TABLE. The two properties are exhaustive by construction, so the table holds no row and the reading
 * prints `exemptions 0`. A third category would be a rule this gate cannot state - the honest repair for the next
 * one-sided token would be to restate the rule, not to name the key.
 *
 * WHAT THIS DOES NOT READ (named so the reading is not overclaimed)
 *
 *   - `style.css` only. An inline `style={{ colorScheme: "dark" }}` in a component, or a `color-scheme` in
 *     `index.html`, is outside this gate; the mounted spec is what sees the painted result.
 *   - the winning cascade. A root's scheme is taken as the last declaration written for that appearance in source
 *     order; declarations spread across `@layer`s are read, but which layer wins is the browser's business.
 *   - whether a re-stated value is the RIGHT colour, or a pair is legible: `tools/check-contrast-tokens.mjs` owns the
 *     AA floor, and it holds each appearance's own table.
 *   - an alias whose target nothing declares. Stylelint's `value-no-unknown-custom-properties` owns that; here it
 *     arrives as the alias message, because the terminal token is missing from the light root too.
 *
 * IF THE PALETTE MOVES TO `light-dark()`
 *
 * Then one root states both values and the light root keeps only its scheme, so every colour token becomes one-sided
 * with a colour literal - and this rule, whose premise is "each appearance re-states what it changes", would report
 * all of them. That migration is deliberately not here: it is a value change with its own risk, and `cb723b6d` kept
 * the custom properties on purpose. When it happens, this premise is what has to be restated with it - the property
 * to assert becomes "a colour token is declared once, as the `light-dark()` pair", which is a different reading of
 * the same sheet - rather than waived or exempted.
 *
 * RED PROOF, each rule seen red on a real injected violation
 *
 *   - `--card-border-glow: #3a2226` added to the base root -> `color_scheme_parity_failed: --card-border-glow
 *     declares a theme-dependent color literal (#3a2226) ...` (scenario A below, and on the real sheet);
 *   - `--badge-border: var(--palette-amber-base)` with the amber literal only on the base root ->
 *     `color_scheme_parity_failed: --badge-border aliases --palette-amber-base, but the terminal token is missing
 *     from the light root.` (scenario B below, and on the real sheet);
 *   - `--space-7: 28px` added to the base root -> green, `exemptions 0` (scenario C below, and on the real sheet);
 *   - `--surface-elevated` deleted from the light root -> the literal message for it, and for `--surface-hover` the
 *     alias message naming the terminal it can no longer follow;
 *   - two tokens aliasing each other -> `alias_cycle`; a chain past the cap -> `alias_chain_too_long`;
 *   - `color-scheme: dark` on `.form-select` -> `color_scheme_off_theme_root:.form-select`; `:root` written as
 *     `light dark` -> `color_scheme_two_valued::root`; the light root naming `dark` ->
 *     `color_scheme_disagrees_with_root:light`; a light-only token -> `light_root_declares_unknown_key`;
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
/** A token whose whole value is one alias of another token. */
const ALIAS = /^var\(\s*--([a-z0-9-]+)\s*\)$/u;
/** How many alias hops a chain may take before it is `alias_chain_too_long`. */
const MAX_ALIAS_HOPS = 8;
/** The base root's name in the finding codes, so every report says which root it is about. */
const BASE = "base";

/** A time or a duration: `150ms`, `0.2s`. The number is required, so `monospace`'s `s` is not a duration. */
const TIME = /(?:^|[^\w.-])\d*\.?\d+(?:ms|s)\b/u;
/** An easing: a function, or one of the keywords a transition accepts. */
const EASING = /(?:cubic-bezier|steps|linear)\(|(?:^|[^\w-])(?:ease|ease-in|ease-out|ease-in-out|linear|step-start|step-end)(?:$|[^\w-])/u;
/** A length: the units this sheet writes its geometry and typography in. */
const LENGTH = /(?:^|[^\w.-])\d*\.?\d+(?:px|rem|em|ch|cqi)\b/u;
/** A generic font family. `--font-mono`'s whole value is a stack of these. */
const FONT_FAMILY = /(?:^|[^\w-])(?:serif|sans-serif|monospace|system-ui|ui-monospace|ui-sans-serif|ui-serif|cursive|fantasy)(?:$|[^\w-])/u;

/**
 * Selectors that genuinely need their own `color-scheme`, as `{ selector, reason }`.
 *
 * Empty: every declaration in the sheet is on an appearance root, which is the invariant. An entry names ONE
 * selector exactly as the sheet writes it, carries the reason it cannot read the page's scheme, and is a finding
 * the moment that selector stops declaring the property.
 */
const COLOR_SCHEME_EXEMPTIONS = [];

/**
 * One-sided tokens the two properties below cannot express, as `{ token, missingFrom, reason }`.
 *
 * Empty, and it should stay empty: P1 (appearance-neutral value) and P2 (closed alias to a re-stated terminal) are
 * exhaustive by construction, so a row here would mean the rule is wrong rather than that a key is special. The
 * reading prints `exemptions 0` so a reader can see the claim rather than trust it.
 */
const PARITY_EXEMPTIONS = [];

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
  const declare = (rule, statement) => {
    const colon = statement.indexOf(":");
    if (colon <= 0) return;
    rule.declarations.push({ property: statement.slice(0, colon).trim(), value: statement.slice(colon + 1).trim() });
  };
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
      if (rule !== undefined && !rule.atRule && statement.length > 0) declare(rule, statement);
      if (character === "}" && open.length > 0) open.pop();
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

/**
 * The appearance-neutral family a value belongs to, or `null` when it carries an appearance.
 *
 * The families are the operator's three - `motion`, `geometry`, `typography` - and the order matters: a font stack
 * is read before the units, so `--font-mono`'s `monospace` is typography even though the value also contains the
 * letters `s` and `em` further along the stack.
 */
export function neutralFamily(value) {
  if (FONT_FAMILY.test(value)) return "typography";
  if (TIME.test(value) || EASING.test(value)) return "motion";
  if (LENGTH.test(value)) return "geometry";
  return null;
}

/**
 * Follow a token's alias chain to the literal it ends at.
 *
 * `fate` says how the walk ended: `literal` (a value that is not an alias), `cycle` (a token reappeared),
 * `too_long` (the walk outlived `MAX_ALIAS_HOPS`), or `literal` with no value (the target nothing declares). The
 * bound is stated once, here, so no caller can walk an unbounded chain.
 */
export function resolveTerminal(tokens, token) {
  const chain = [token];
  let current = token;
  for (let hop = 0; hop <= MAX_ALIAS_HOPS; hop += 1) {
    const value = tokens.get(current);
    const alias = value === undefined ? null : ALIAS.exec(value);
    if (alias === null) return { chain, terminal: current, literal: value, fate: "literal" };
    current = alias[1];
    if (chain.includes(current)) return { chain: [...chain, current], terminal: current, fate: "cycle" };
    chain.push(current);
  }
  return { chain, terminal: current, fate: "too_long" };
}

/** The operator's message for a one-sided key whose value carries an appearance and aliases nothing. */
export const parityLiteralMessage = (token, value) =>
  `color_scheme_parity_failed: --${token} declares a theme-dependent color literal (${value}) on the base root, ` +
  "but neither restates it in light root nor aliases an already-restated token.";

/** The operator's message for a one-sided key whose alias chain no longer ends on a re-stated token. */
export const parityAliasMessage = (token, terminal) =>
  `color_scheme_parity_failed: --${token} aliases --${terminal}, but the terminal token is missing from the light root.`;

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
 * Gate B over one sheet: K_light ⊆ K_dark, and every one-sided key is either appearance-neutral or an alias whose
 * terminal token the light root re-states. Returns the findings and, per appearance, the classification of every
 * one-sided key, so the reading prints the population rather than a count that could be a zero.
 */
export function tokenParityFindings(rules, expectedAppearances) {
  const findings = [];
  const { base, appearances } = readTokenTables(rules);
  const reading = [];

  if (base.size === 0)
    findings.push({
      code: "population_empty",
      message:
        "population_empty: the base root declares no custom property, so there is no token set to compare and this " +
        "gate would agree with itself",
    });

  for (const appearance of expectedAppearances) {
    const table = appearances.get(appearance);
    if (table === undefined) {
      findings.push({
        code: `appearance_root_missing:${appearance}`,
        message:
          `appearance_root_missing: no \`:root[data-theme="${appearance}"]\` rule declares a token, so the ` +
          `${appearance} appearance would paint the base root's dark set`,
      });
      continue;
    }

    const lightOnly = [...table.keys()].filter((token) => !base.has(token)).sort();
    for (const token of lightOnly)
      findings.push({
        code: `light_root_declares_unknown_key:${token}`,
        message:
          `light_root_declares_unknown_key: --${token} is declared on the ${appearance} root and on no base root, ` +
          "so there is no appearance in which it has a value",
      });

    const exemptions = PARITY_EXEMPTIONS.filter((entry) => entry.missingFrom === appearance);
    const exempted = new Set();
    const oneSided = [...base.keys()].filter((token) => !table.has(token));
    const kinds = new Map();
    for (const token of oneSided) {
      const value = base.get(token);
      const exemption = exemptions.find((entry) => entry.token === token);
      if (exemption !== undefined) {
        exempted.add(token);
        kinds.set(token, "exempt");
        continue;
      }
      const neutral = neutralFamily(value);
      if (neutral !== null) {
        kinds.set(token, `neutral:${neutral}`);
        continue;
      }
      const alias = ALIAS.exec(value);
      if (alias === null) {
        kinds.set(token, "literal");
        findings.push({ code: "color_scheme_parity_failed", token, message: parityLiteralMessage(token, value) });
        continue;
      }
      const { chain, terminal, fate } = resolveTerminal(base, token);
      if (fate === "cycle") {
        kinds.set(token, "alias:cycle");
        findings.push({
          code: "alias_cycle",
          token,
          message:
            `alias_cycle: ${chain.map((step) => `--${step}`).join(" -> ")} never reaches a literal, so no terminal ` +
            "token can be checked against the light root",
        });
        continue;
      }
      if (fate === "too_long") {
        kinds.set(token, "alias:too-long");
        findings.push({
          code: "alias_chain_too_long",
          token,
          message:
            `alias_chain_too_long: ${chain.map((step) => `--${step}`).join(" -> ")} outlives the ` +
            `${MAX_ALIAS_HOPS}-hop alias bound without reaching a literal`,
        });
        continue;
      }
      if (table.has(terminal)) {
        kinds.set(token, `alias\u2192--${terminal}\u2208light`);
        continue;
      }
      kinds.set(token, `alias\u2192--${terminal}\u2209light`);
      findings.push({
        code: "color_scheme_parity_failed",
        token,
        chain,
        message: parityAliasMessage(token, terminal),
      });
    }
    for (const entry of exemptions)
      if (!exempted.has(entry.token))
        findings.push({
          code: `one_sided_token_expired:${entry.token}`,
          message:
            `one_sided_token_expired: --${entry.token} is declared on the ${appearance} root now, so its exemption ` +
            `(${entry.reason}) has expired`,
        });

    reading.push({
      appearance,
      keys: table.size,
      shared: [...table.keys()].filter((token) => base.has(token)).length,
      lightOnly,
      oneSided,
      kinds,
      counts: countKinds(kinds),
    });
  }

  return { findings, base, appearances, reading };
}

/** How many one-sided keys fell into each classification, for the reading. */
function countKinds(kinds) {
  const counts = { motion: 0, geometry: 0, typography: 0, aliasClosed: 0, aliasOpen: 0, literal: 0, broken: 0 };
  for (const kind of kinds.values()) {
    if (kind === "neutral:motion") counts.motion += 1;
    else if (kind === "neutral:geometry") counts.geometry += 1;
    else if (kind === "neutral:typography") counts.typography += 1;
    else if (kind.endsWith("\u2208light")) counts.aliasClosed += 1;
    else if (kind.endsWith("\u2209light")) counts.aliasOpen += 1;
    else if (kind === "literal") counts.literal += 1;
    else counts.broken += 1;
  }
  return counts;
}

/** The reading: what was compared, how every one-sided key was classified, and how many exemptions exist. */
function describeTokenSet(base, reading) {
  const lines = [];
  for (const entry of reading) {
    const { counts } = entry;
    const neutral = counts.motion + counts.geometry + counts.typography;
    lines.push(
      `theme_roots: base ${base.size} token(s); ${entry.appearance} ${entry.keys} declared, ${entry.shared} shared ` +
        `with the base, ${entry.oneSided.length} one-sided, ${entry.lightOnly.length} not in the base`,
    );
    lines.push(
      `theme_roots: one-sided ${entry.oneSided.length} = neutral ${neutral} (motion ${counts.motion}, geometry ` +
        `${counts.geometry}, typography ${counts.typography}) + alias-closed ${counts.aliasClosed} + alias-open ` +
        `${counts.aliasOpen} + literal ${counts.literal} + broken ${counts.broken}`,
    );
    for (const token of entry.oneSided) lines.push(`theme_roots: --${token} ${entry.kinds.get(token)}`);
  }
  lines.push(
    `theme_roots: exemptions ${PARITY_EXEMPTIONS.length}` +
      (PARITY_EXEMPTIONS.length === 0 ? " (the two properties are exhaustive; no key needs a row)" : ""),
  );
  return lines;
}

/** The stylesheet with a declaration inserted at the top of the base root - the shape every scenario injects. */
function withBaseDeclaration(css, declaration) {
  const opening = /:root,\s*\n?[\w\s[\]=":-]*:root\[data-theme="[a-z0-9-]+"\]\s*\{/u.exec(css);
  assert.ok(opening !== null, "the stylesheet no longer opens a `:root, :root[data-theme=…]` block to inject into");
  const insertAt = opening.index + opening[0].length;
  return `${css.slice(0, insertAt)}\n  ${declaration}${css.slice(insertAt)}`;
}

/**
 * What one injected declaration adds to the parity findings, and how the light root classifies it.
 *
 * The comparison is a delta against the sheet as it stands, not the whole finding list: a scenario asserts what ITS
 * injection does, so an unrelated finding in the live stylesheet cannot make the scenario red for the wrong reason.
 */
function parityDelta(token, declaration) {
  const appearances = appearanceNames();
  const before = tokenParityFindings(readRules(stylesheetText()), appearances);
  const after = tokenParityFindings(readRules(withBaseDeclaration(stylesheetText(), declaration)), appearances);
  const known = new Set(before.findings.map((finding) => finding.message));
  return {
    added: after.findings.map((finding) => finding.message).filter((message) => !known.has(message)),
    kind: after.reading.find((entry) => entry.appearance === "light")?.kinds.get(token),
  };
}

const stylesheetText = () => readFileSync(STYLESHEET, "utf8");
const appearanceNames = () => readAppearances(readFileSync(APPEARANCE_SOURCE, "utf8"));

test("gate: color-scheme is declared by the appearance roots and by nothing else", (t) => {
  const appearances = appearanceNames();
  const rules = readRules(stylesheetText());
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
  const { findings, base, reading } = tokenParityFindings(readRules(stylesheetText()), appearanceNames());

  for (const line of describeTokenSet(base, reading)) t.diagnostic(line);
  t.diagnostic(`theme_roots: ${findings.length} violation(s)`);

  assert.ok(
    base.size > 0,
    "the base root declares no custom property: this gate would pass by having found nothing to read",
  );
  assert.ok(
    reading.length > 0,
    "appearance.ts names no appearance in a root this sheet carries: there is no key set to compare",
  );
  assert.deepEqual(
    findings.map((finding) => finding.message),
    [],
    "a one-sided key must be appearance-neutral or alias a token the light root re-states",
  );
});

test("scenario A: a colour literal the light root does not restate fails parity", (t) => {
  const { added, kind } = parityDelta("card-border-glow", "--card-border-glow: #3a2226;");
  t.diagnostic(`scenario A: +${added.length} finding(s), classified ${kind} - ${added.join(" | ")}`);

  assert.deepEqual(
    added,
    [
      "color_scheme_parity_failed: --card-border-glow declares a theme-dependent color literal (#3a2226) on the " +
        "base root, but neither restates it in light root nor aliases an already-restated token.",
    ],
    "--card-border-glow is a dark literal the light appearance would inherit",
  );
});

test("scenario B: an alias whose terminal token the light root does not restate fails parity", (t) => {
  const { added } = parityDelta(
    "badge-border",
    "--palette-amber-base: #f0b429;\n  --badge-border: var(--palette-amber-base);",
  );
  t.diagnostic(`scenario B: +${added.length} finding(s) - ${added.join(" | ")}`);

  assert.deepEqual(
    added,
    [
      // The injected literal is itself one-sided, so the pair reports both members - the terminal first, because it
      // is declared first on the base root.
      "color_scheme_parity_failed: --palette-amber-base declares a theme-dependent color literal (#f0b429) on the " +
        "base root, but neither restates it in light root nor aliases an already-restated token.",
      "color_scheme_parity_failed: --badge-border aliases --palette-amber-base, but the terminal token is missing " +
        "from the light root.",
    ],
    "--badge-border's chain ends on a token the light root does not re-state",
  );
});

test("scenario C: a neutral addition is legal and needs no exemption", (t) => {
  const { added, kind } = parityDelta("space-7", "--space-7: 28px;");
  t.diagnostic(
    `scenario C: +${added.length} finding(s), space-7 classified ${kind}, exemptions ${PARITY_EXEMPTIONS.length}`,
  );

  assert.deepEqual(added, [], "a length carries no appearance, so a one-sided geometry token is legal");
  assert.equal(kind, "neutral:geometry", "--space-7: 28px is geometry, and P1 is what lets it stay one-sided");
  assert.equal(PARITY_EXEMPTIONS.length, 0, "scenario C must not need an exemption row");
});

test("gate: an alias chain is bounded, and a cycle or an overlong chain is named", (t) => {
  const cycle = withBaseDeclaration(stylesheetText(), "--loop-a: var(--loop-b);\n  --loop-b: var(--loop-a);");
  const cycleMessages = tokenParityFindings(readRules(cycle), appearanceNames()).findings.map((f) => f.message);
  t.diagnostic(`alias bound: cycle - ${cycleMessages.filter((m) => m.startsWith("alias_cycle")).length} cycle finding(s)`);
  assert.ok(
    cycleMessages.some((message) => message.startsWith("alias_cycle: --loop-a -> --loop-b -> --loop-a")),
    "two tokens aliasing each other must be reported as alias_cycle, naming the chain",
  );

  const hops = Array.from({ length: 12 }, (_, index) =>
    index === 11 ? "--hop-12: 28px;" : `--hop-${index + 1}: var(--hop-${index + 2});`,
  ).join("\n  ");
  const longMessages = tokenParityFindings(readRules(withBaseDeclaration(stylesheetText(), hops)), appearanceNames())
    .findings.map((f) => f.message);
  t.diagnostic(
    `alias bound: overlong - ${longMessages.filter((m) => m.startsWith("alias_chain_too_long")).length} too-long finding(s)`,
  );
  assert.ok(
    longMessages.some((message) => message.startsWith("alias_chain_too_long: --hop-1 -> ")),
    "a chain past MAX_ALIAS_HOPS must be reported as alias_chain_too_long, not pass as a non-alias",
  );
});
