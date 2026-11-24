#!/usr/bin/env node
/**
 * Static WCAG contrast gate over the design tokens `dialogue-web/src/style.css` declares.
 *
 * WHY
 *
 * Three comments in that stylesheet cite the same measurement as if a gate produced it - "the runtime contrast gate
 * sampled it at 4.74:1 on the card" (line 2293), "the lowest body-text contrast in the product" (lines 701, 1666) - and
 * no static gate exists in this repository. The only contrast measurement is
 * `dialogue-web/tests/ui-hygiene-runtime.spec.ts`, which reads one rendered control's computed colour through
 * Playwright at two viewports. So a token edit that drops a pair below AA is caught by nothing until someone runs a
 * browser, and the numbers the sheet cites cannot be re-derived from the sheet itself.
 *
 * WHAT IS READ: THE POPULATION IS THE STYLESHEET, PER THEME
 *
 *   * every `--name: value` declaration in the file is the token table (comments stripped first), so a token joins
 *     the population when it is declared, not when this file remembers to list it;
 *   * a token root is a rule whose selector list is `:root`, optionally repeated with a `[data-theme="…"]` attribute:
 *     `:root`, `:root[data-theme="dark"]`, `:root[data-theme="light"]`. The THEME POPULATION is the attribute values
 *     those roots name, so a third appearance joins by being written into the stylesheet - never by being listed here.
 *     A sheet that names no appearance declares one and it is called `base`. A root applies to a theme when its
 *     selector list carries a bare `:root` (it is that theme's base) or names the theme itself, and later roots win,
 *     which is the cascade for one file. A `[data-theme="…"]` selector this parser did not read as a token root is a
 *     violation, so a token root written in a shape this gate would silently skip cannot shrink the population;
 *   * a pair names two of those tokens as `fg`/`bg` with its own `min` and a `why` naming the rule that paints that
 *     ink on that surface. The authored list is then held to the stylesheet: an `fg` the sheet never paints as
 *     `color:` and a `bg` it never paints as `background`/`background-color:` are violations. That is what keeps the
 *     list from drifting into invented combinations - when the rule behind a pair is deleted, the pair fails loudly
 *     instead of quietly measuring a pair no component wears;
 *   * every pair is measured once per theme, against that theme's own token table, at the same `min`. A pair that
 *     passes in one appearance and fails in the other fails the gate.
 *   * a token value this gate cannot read as a single colour - `color-mix(...)`, a gradient, a `var()` with a
 *     fallback - is reported as `token_unreadable`, named, with the value it saw. Never skipped, never guessed.
 *
 * A translucent ink (`rgba()`, alpha < 1) is composited over its pair's background, which is how CSS paints it. A
 * translucent *background* is `token_unreadable` instead: the surface beneath it is not something a pair names.
 *
 * THE ELEVATION LADDER: THE SAME BLIND SPOT, ONE LAYER DOWN
 *
 * The pair list measures ink on a surface, and it is complete for that claim. It is silent about two *surfaces*: a
 * palette can hold every text pair above AA while its layers melt into each other. Measured on this sheet before the
 * ladder existed: a light `--surface-canvas` of `#f8f9fa` read 1.01:1 against the `#fafafc` card - no visible edge, the
 * whole screen one white sheet - and all 24 pairs still passed. The shipped light palette now holds the same pair one
 * code value apart (`#f8f9fa` canvas, `#ffffff` card, 1.05:1), which is why the ladder also has to know the difference
 * between a declared edge and an applied one. So the ladder is a second population, derived the same way, over the
 * layers and the rungs between them.
 *
 *   * a LAYER is a `--surface-*` declaration in the theme's own table whose value is a colour of its own. An alias of
 *     another layer (`--surface-raised`, `--surface-hover`) is that layer, not a new one. A sixth layer joins by being
 *     written into the stylesheet, and then it has to be given a rung or a sibling - it cannot arrive unmeasured;
 *   * a RUNG names the layer beneath and the layer raised above it, with a `why` naming the rule that stacks them:
 *     `canvas->panel`, `panel->card`, `card->elevated`, and `canvas->card` for a card with no panel between it and the
 *     page;
 *   * a SIBLING is a layer painted at the depth of the surface it sits on rather than above it, declared with the
 *     layer it sits on and the reason it has no rung. Every layer must be a rung's member or a sibling, so the
 *     population cannot grow past the rules that decide how a layer separates from what is under it.
 *
 * A rung is distinguishable when ONE of three means holds, each of which is a declared token:
 *
 *   (a) LUMINANCE - the two layers read at or above `ELEVATION_STEP_FLOOR` (1.05:1). WCAG sets no floor for a fill:
 *       1.4.11's 3:1 is a BOUNDARY floor, which is means (c). What 1.05 is derived from is the measurement's own
 *       resolution. WCAG's ratio is `(L1+0.05)/(L2+0.05)`, and the ambient term compresses it at both ends, so a
 *       two-code-value sRGB change reads 1.011 near white and 1.009 near black - the fog this ladder exists for is
 *       exactly a two-code-value difference. 1.05 is a five-to-six-code-value change everywhere in the band this
 *       palette occupies (L* 7 to 98: `#131518 -> #191b1e` at the dark end, `#fafafc -> #f4f5f7` at the light one),
 *       i.e. dL* 1.9 to 2.9 - two to three of the classic one-unit dL* just-noticeable step for a large uniform field.
 *       Under it, two layers differ by less than a display is asked to render reliably, and the edge has to come from
 *       (b) or (c);
 *   (b) SHADOW - the rung names a shadow token AND the rule that casts it. That rule must paint the raised layer as its
 *       background and must apply the token as a `box-shadow`, the theme must declare the token, and its value must
 *       carry a colour that is not fully transparent. The rule is part of the claim because a declaration nothing
 *       reads is the paper excuse a gate like this has to refuse: a shadow token declared in the theme's table, or
 *       painted by some other component, is NOT an edge for this layer. What (b) does not do is measure the shadow's
 *       rendered contrast, which depends on the backdrop and the blur radius and which no token table can resolve;
 *   (c) BOUNDARY - the rung names a boundary token and the rule that wears it. That rule must paint the raised layer
 *       as its background and must apply the token as a border, and the token - composited over the layer beneath it,
 *       as CSS paints it - must read at or above `ELEVATION_BOUNDARY_FLOOR` (3:1, the WCAG 1.4.11 floor
 *       `--border-control` already follows).
 *
 * A rung holding none of the three is `elevation_indistinct`, naming the pair, its ratio, the floor and which means the
 * gate looked for and did not find. A declared means that does not hold is its own violation
 * (`elevation_shadow_*`, `elevation_boundary_*`), because a declaration the sheet does not keep is a false claim
 * whether or not luminance rescued the rung.
 *
 * The shipped sheet holds (b) exactly where it has to. The light appearance's panel and card are both `#ffffff`, so the
 * `panel->card` rung reads 1.00:1 and no luminance floor can carry it: `--shadow-card` is the card's only edge there,
 * and the claim names the rule that wears it (`.memory-notebook`). `canvas->card` claims the same token on its own rule
 * (`.message.companion .message-bubble`) even though it also clears the floor at 1.05:1, because a margin of 0.4% is
 * not the edge the reader sees. Nothing claims (c): the light `--border-subtle` reads 1.20:1 on every layer it borders
 * and `--border-control` - the one token that does read 3:1 - is worn by the controls the form and action rules paint,
 * not by the canonical member of any layer, and a claim a rule does not wear is a violation rather than a rescue. The
 * dark appearance declares the same token with the value its cards already painted, so a card wears one name in both;
 * its rungs are carried by luminance there (1.07-1.15:1), which is why the means printed per rung is the reading and
 * not a palette's reputation.
 *
 * WHAT IT DOES NOT MEASURE (named here so the reading is not overclaimed)
 *
 *   * combinations of the whole ink x surface cross product. Only pairs a rule justifies are measured.
 *   * tinted washes - `color-mix(in srgb, var(--danger) 12%, transparent)` behind `.error-banner`,
 *     `.warning-banner`, `.success-banner`, `.game-action.danger`, the delete confirmations. Their background is an
 *     expression over an inherited surface, not a token.
 *   * gradients (`.active-companion-card`), inline literals (`#fff` on `.stop-button`, `#e27575` on its hover,
 *     `color-mix(...)` as `.companion-current-badge`'s ink), and shadow/hairline colours.
 *   * tokens painted only as borders, outlines or focus geometry: `--border-subtle`, `--border-strong`,
 *     `--border-glass`, `--focus-ring`, `--palette-burgundy-border`. WCAG 1.4.11 needs 3:1 for those, which is a
 *     different floor and not what this gate declares.
 *   * tokens a theme does not restate. A light block that omits a colour token inherits the dark literal, which is a
 *     real defect and invisible here: this gate measures the pairs it is given, and a pair whose ink and surface both
 *     survive unchanged reads as a pass. The light set is held to the dark set's names by
 *     `dialogue-web/tests/theme-roots-gate.test.mjs`, not by this tool. The ladder's own version of this is a
 *     `verdict=not_measured` rung naming the layer the appearance does not declare, which is why a rung can print
 *     fewer readings than there are appearances;
 *   * the accent plate's edge. `--surface-accent` is a sibling: the player's own bubble sits on the canvas-painted
 *     timeline, and its separation from that canvas is chroma rather than luminance. None of the ladder's three means
 *     reads hue, so its ratio is printed as a sibling row on every run and is not a verdict.
 *
 * Output: `contrast_tokens: examined N pair(s) in M token(s) over K theme(s)`, one line per theme and pair
 * (`<theme> <label> fg=#rrggbb bg=#rrggbb ratio=17.33 min=4.5 verdict=pass|fail|unreadable`), then
 * `elevation_ladder: examined R rung(s) in L layer(s) over K appearance(s), step floor 1.05:1, boundary floor 3:1`, one
 * `  <theme> layers: surface-canvas=#rrggbb ...` line per appearance, and one line per rung or sibling
 * (`  <theme> surface-canvas->surface-card beneath=#rrggbb raised=#rrggbb ratio=1.15 floor=1.05
 * means=luminance+shadow:shadow-card verdict=pass|fail|unreadable|not_measured|sibling`), where a token-carrying means
 * names the token that earned it. The JSON verdict line carries both populations
 * (`{"gate":"contrast-tokens","examined":N,"tokens":M,"elevation":{...},"violations":[...],"status":...}`) and a
 * `checks` entry per rule. A pair below its minimum is REPORTED and exits 0 by default; `--fail` makes it exit 1. Zero
 * pairs, an unreadable stylesheet and a stylesheet with no custom property are `blocked` and exit 1 in every mode - a
 * gate that measured nothing has not passed.
 *
 * Usage:
 *   node tools/check-contrast-tokens.mjs            # report every pair and every rung, exit 0
 *   node tools/check-contrast-tokens.mjs --fail     # exit 1 when a pair or a rung is below its floor
 *   node tools/check-contrast-tokens.mjs --root <dir>   # a fixture tree holding the same stylesheet path
 *
 * red-proof: inject  `--text-disabled` set to #6a625a instead of #90877e ->
 *            `contrast_below_min:dark:text-disabled on surface-card` at 2.80:1 (min 4.5), exit 1 under `--fail`; a
 *            token declared `color-mix(...)` -> `token_unreadable:<theme>:<label>:<token>`; an empty pair list ->
 *            `status:"blocked"`, exit 1; a light root one shade too pale -> the same pair named under `light` while the
 *            `dark` reading of it still passes; a `[data-theme="sepia"]` root written outside the token-root shape ->
 *            `theme_selector_unread:sepia`; a light palette whose card is two code values from its canvas - every pair
 *            still passing - -> `elevation_indistinct:light:surface-canvas->surface-card` at 1.01:1
 *            (floor 1.05) with the three means it looked for and did not find, while the pair readings of that same run
 *            stay green; a rung carried by a declared `--shadow-card` painted as a `box-shadow` by the rule that paints
 *            its raised layer -> `verdict=pass means=shadow:shadow-card` at a ratio under the floor; the same token
 *            declared and painted by a DIFFERENT rule, or declared and not painted at all ->
 *            `elevation_shadow_unpainted` (the paper claim this extension exists for: a shadow nobody wears would have
 *            passed the previous gate, which only asked whether some rule somewhere painted the token); a rung claiming
 *            a rule the sheet does not have -> `elevation_shadow_rule_absent`, and one whose named rule paints a
 *            different layer -> `elevation_shadow_off_surface`; a rung carried by a `--border-control` painted as a
 *            border -> `means=boundary:border-control` at >= 3:1, and the same declaration over a 1.1:1 hairline ->
 *            `elevation_boundary_below_floor`; a `--surface-sheet` layer no rung raises and no sibling declares ->
 *            `elevation_layer_without_rung`; a shadow token declared as `rgba(...,0)` -> `elevation_shadow_invisible`
 *            (gates/product/check-contrast-tokens.test.mjs builds each in a temp dir).
 */

export const gateDeclaration = {
  id: "check-contrast-tokens",
  domain: "product",
  tier: "l0",
  kind: "contract",
};

import { rootFromArgv } from "../../tools/lib/gate-preamble.mjs";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { repositoryRoot } from "../../tools/lib/repository-root.mjs";

const REPOSITORY_ROOT = repositoryRoot(import.meta.url);
/** The one stylesheet this product's tokens live in. */
export const STYLESHEET = "dialogue-web/src/style.css";
/** WCAG 2.1 AA (1.4.3) for body text: 4.5:1. Every pair below carries text the player reads. */
const BODY_TEXT = 4.5;

/**
 * The pairs, each justified by the rule that wears it.
 *
 * `min` is the pair's own floor; every one here is body text, including `--text-disabled`, because that token is
 * still *painted* (`.swipe-btn:disabled`, `.read-only-badge`) and the sheet keeps it at the AA floor deliberately -
 * `.swipe-btn:disabled`'s own comment measures it at 4.74:1 on the card and calls that "the disabled state the rest
 * of the product ships".
 */
export const CONTRAST_PAIRS = [
  // The four-layer background system, with the ink the sheet paints on each layer.
  {
    fg: "text-primary",
    bg: "surface-canvas",
    min: BODY_TEXT,
    why: "the shell's own ink: `.tavern-app-shell` paints `--surface-canvas` and its text `--text-primary`",
  },
  {
    fg: "text-primary",
    bg: "surface-panel",
    min: BODY_TEXT,
    why: "the app bar paints `--surface-panel` and `.app-bar-brand-name` sets `--text-primary` inside it",
  },
  {
    fg: "text-primary",
    bg: "surface-card",
    min: BODY_TEXT,
    why: "the companion bubble is a card (`.message.companion .message-bubble`) and its speech is `--text-primary`",
  },
  {
    fg: "text-primary",
    bg: "surface-elevated",
    min: BODY_TEXT,
    why: "hovered controls: `.regenerate-btn:hover` paints `--surface-hover`, the alias of `--surface-elevated`",
  },
  {
    fg: "text-primary",
    bg: "palette-gray-700",
    min: BODY_TEXT,
    why: "hovered icon buttons: `.icon-button-small:hover` paints `--palette-gray-700` under `--text-primary`",
  },
  {
    fg: "text-primary",
    bg: "selection",
    min: BODY_TEXT,
    why:
      'a selected chip and the player\'s own bubble: `.memory-filter-chip[aria-pressed="true"]` and ' +
      "`.message.player .message-bubble` paint `--selection` under `--text-primary`",
  },
  // Secondary text: the row metadata, hints and captions the sheet moved off `--text-disabled`.
  {
    fg: "text-secondary",
    bg: "surface-canvas",
    min: BODY_TEXT,
    why: "the author line `.message-author` reads `--text-secondary` straight on the canvas",
  },
  {
    fg: "text-secondary",
    bg: "surface-panel",
    min: BODY_TEXT,
    why: "`.game-diagnostics-json` paints `--surface-panel` under `--text-secondary`",
  },
  {
    fg: "text-secondary",
    bg: "surface-card",
    min: BODY_TEXT,
    why: "`.message-bubble blockquote` and the row metadata (`.chat-item-meta`, `.memory-item-meta`) on the card",
  },
  {
    fg: "text-secondary",
    bg: "surface-elevated",
    min: BODY_TEXT,
    why: "`[data-import-history-counts] > li` paints the elevated tone under `--text-secondary`",
  },
  {
    fg: "text-secondary",
    bg: "selection",
    min: BODY_TEXT,
    why: "the beat `.message-bubble em.message-action` inside the player's own `--selection` bubble",
  },
  // The muted token, where it is still painted rather than moved off.
  {
    fg: "text-disabled",
    bg: "surface-panel",
    min: BODY_TEXT,
    why: "`.swipe-btn:disabled` and `.send-button:disabled`: the disabled glyph is still drawn, on the panel tone",
  },
  {
    fg: "text-disabled",
    bg: "surface-card",
    min: BODY_TEXT,
    why: "`.read-only-badge`: the muted token on the card tone, the product's lowest body-text pair",
  },
  // The accent and the brand family as ink.
  {
    fg: "accent",
    bg: "surface-card",
    min: BODY_TEXT,
    why: "`.avatar-large` paints the accent as ink inside a row painted `--surface-card`",
  },
  {
    fg: "accent",
    bg: "surface-elevated",
    min: BODY_TEXT,
    why: "`.game-guide-step::before`: the numbered step mark in `--accent` on the elevated tone",
  },
  {
    fg: "palette-gold-base",
    bg: "surface-card",
    min: BODY_TEXT,
    why: "`.surface-model-chip` and `.model-profile-chip`: the gold chip label on the card tone",
  },
  {
    fg: "palette-gold-base",
    bg: "palette-gray-700",
    min: BODY_TEXT,
    why: "`.entry-key-tag`: the world-book key chip, gold on the hover well",
  },
  {
    fg: "palette-teal-base",
    bg: "palette-gray-700",
    min: BODY_TEXT,
    why: "`.status-tag.active`: the live tag, teal on the hover well",
  },
  {
    fg: "palette-teal-base",
    bg: "surface-card",
    min: BODY_TEXT,
    why: "`.badge-active` paints teal, and the badge group paints `--surface-card` beneath it",
  },
  {
    fg: "palette-burgundy-base",
    bg: "palette-burgundy-dark",
    min: BODY_TEXT,
    why: "`.status-tag.permanent`: the accent rose on the burgundy plate the sheet keeps for it",
  },
  // Light ink on the filled accent controls.
  {
    fg: "on-accent",
    bg: "accent-solid",
    min: BODY_TEXT,
    why: "`.send-button`, `.app-bar-brand-mark`, `.game-action.primary`: ink on a filled accent control",
  },
  {
    fg: "on-accent",
    bg: "accent-solid-hover",
    min: BODY_TEXT,
    why: "the same control's hover: `.send-button:hover` paints `--accent-solid-hover` under the same ink",
  },
  // A status colour as ink on a surface it is actually written on.
  {
    fg: "danger",
    bg: "surface-card",
    min: BODY_TEXT,
    why: "`.connection-row [data-connection-failure]`: the failure reason inside the card-painted row",
  },
];

/**
 * The smallest luminance step that is an edge on its own, with no shadow and no boundary carrying it.
 *
 * Derived in the header: 1.05:1 is a five-to-six-code-value sRGB change across the band this palette occupies, i.e.
 * two to three just-noticeable dL* steps for a large uniform field, and it sits above the 1.01:1 that a two-code-value
 * difference - the measured fog - reads as. WCAG's own 3:1 is a boundary floor and is `ELEVATION_BOUNDARY_FLOOR`.
 */
export const ELEVATION_STEP_FLOOR = 1.05;

/** WCAG 2.1 1.4.11: the floor a boundary that identifies a component has to clear against what is behind it. */
export const ELEVATION_BOUNDARY_FLOOR = 3;

/**
 * The rungs: the layer beneath, the layer raised above it, and the rule that stacks them.
 *
 * `shadow` and `boundary` are the other two means a rung may claim, and each names a token the theme has to declare AND
 * the selector of the rule that has to wear it - the rule must paint the raised layer and apply the token. The two card
 * rungs claim `--shadow-card` because the light appearance's panel and card are both `#ffffff`: the card's edge there is
 * the shadow, and no luminance floor can stand in for it. Nothing claims a boundary: the light `--border-subtle` reads
 * 1.20:1 wherever it is drawn and `--border-control` is worn by the control rules, not by the canonical member of any
 * layer, so a boundary claim on these rungs would be false for the element each rung exists for.
 */
export const ELEVATION_STEPS = [
  {
    beneath: "surface-canvas",
    raised: "surface-panel",
    why: "`.app-bar` and `.context-panel` paint `--surface-panel` inside the shell that paints `--surface-canvas`",
  },
  {
    beneath: "surface-panel",
    raised: "surface-card",
    why: "`.memory-notebook` paints `--surface-card` inside the panel-painted `.context-panel` drawer",
    shadow: { token: "shadow-card", rule: ".memory-notebook" },
  },
  {
    beneath: "surface-card",
    raised: "surface-elevated",
    why: "`.message-bubble code` paints `--surface-elevated` inside the card-painted companion bubble",
  },
  {
    beneath: "surface-canvas",
    raised: "surface-card",
    why:
      "a card with no panel between it and the page: `.message.companion .message-bubble` and `.avatar-large` paint " +
      "`--surface-card` straight onto the canvas-painted `.chat-view`",
    shadow: { token: "shadow-card", rule: ".message.companion .message-bubble" },
  },
];

/**
 * A layer painted at the depth of the surface it sits on rather than above it, with the layer it sits on and the reason
 * it has no rung. A layer that is neither a rung's member nor declared here is a violation, so the population cannot
 * grow past the rules that decide how a layer separates from what is under it.
 */
export const ELEVATION_SIBLINGS = {
  "surface-accent": {
    on: "surface-canvas",
    why:
      "the accent plate (`--selection`): the player's own bubble sits on the canvas-painted timeline. Its edge is " +
      "chroma, not luminance - none of the ladder's three means reads hue - so its reading is printed and is not a rung",
  },
};

/** A layer token: a `--surface-*` declaration that is a colour of its own rather than an alias of another layer. */
const LAYER_TOKEN = /^surface-[a-z0-9-]+$/u;

const COMMENTS = /\/\*[\s\S]*?\*\//gu;
/** A declaration at the start of a statement, so `border-color:` and `outline-color:` cannot pass as an ink. */
const TOKEN_DECLARATION = /(?:^|[\s;{])(--[a-z0-9-]+)\s*:\s*([^;}]+)/gmu;
const INK = /(?:^|[\s;{])color:\s*var\(\s*--([a-z0-9-]+)\s*\)/gmu;
const SURFACE = /(?:^|[\s;{])background(?:-color)?:\s*var\(\s*--([a-z0-9-]+)\s*\)/gmu;
/** A token painted as a `box-shadow`, which is how a layer declares it casts one. */
const SHADOW = /(?:^|[\s;{])box-shadow:\s*[^;}]*var\(\s*--([a-z0-9-]+)\s*\)/gmu;
/** A token painted as a border, so `border-radius` and `border-collapse` cannot pass as an edge. */
const BOUNDARY =
  /(?:^|[\s;{])(?:border|border-(?:top|right|bottom|left|inline|block|color)(?:-[a-z]+)*):\s*[^;}]*var\(\s*--([a-z0-9-]+)\s*\)/gmu;
/** The three declarations a means can be kept by, read as property names off a parsed rule. */
const BACKGROUND = /^background(?:-color)?$/u;
const BOX_SHADOW = /^box-shadow$/u;
const BORDER = /^border(?:-(?:top|right|bottom|left|inline|block|color)(?:-[a-z]+)*)?$/u;
/** A token that is exactly one alias of another token. */
const ALIAS = /^var\(\s*--([a-z0-9-]+)\s*\)$/u;
const HEX = /^#([0-9a-f]{3}|[0-9a-f]{6})$/iu;
const FUNCTIONAL = /^rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*(?:,\s*([01](?:\.\d+)?)\s*)?\)$/iu;
/** How many `var()` hops a token may take before the chain is treated as a loop. */
const MAX_ALIAS_DEPTH = 8;

/** The name of the one appearance a stylesheet that names no `[data-theme]` declares. */
export const BASE_THEME = "base";

/**
 * A token root: a rule whose selector list is `:root`, optionally with a `[data-theme="…"]` attribute. The shape is
 * deliberately exact - it is what makes a block this parser cannot read a violation rather than a silent omission.
 */
const TOKEN_ROOT =
  /(?:^|[}\s;])(:root(?:\[data-theme="[a-z0-9-]+"\])?(?:\s*,\s*:root(?:\[data-theme="[a-z0-9-]+"\])?)*)\s*\{([^{}]*)\}/gu;
const BARE_ROOT = /^:root$/u;
const THEMED_ROOT = /^:root\[data-theme="([a-z0-9-]+)"\]$/u;
/** Every appearance selector anywhere in the sheet, so one written outside the token-root shape is named. */
const ANY_THEME_SELECTOR = /\[data-theme="([a-z0-9-]+)"\]/gu;

const stripComments = (css) => css.replace(COMMENTS, "");

/**
 * Every innermost rule of the sheet: its selector list and the declaration text under it.
 *
 * Only the innermost blocks are collected, so a rule inside `@layer` or `@media` is found and the at-rule around it is
 * not - which is what a means claim needs, because it names a selector and has to read the declarations that element
 * wears. A selector this parser cannot read is not a silent omission: a claim naming a selector no rule carries is
 * `elevation_*_rule_absent`.
 */
export function rulesOf(css) {
  const rules = [];
  for (const match of stripComments(css).matchAll(/([^{}]+)\{([^{}]*)\}/gu)) {
    const selectors = match[1]
      .split(",")
      .map((selector) => selector.trim().replace(/\s+/gu, " "))
      .filter((selector) => selector.length > 0);
    if (selectors.length === 0) continue;
    rules.push({ selectors, body: match[2] });
  }
  return rules;
}

/** One rule's declarations as `[property, value]` pairs. */
function declarationsIn(body) {
  const declarations = [];
  for (const statement of body.split(";")) {
    const colon = statement.indexOf(":");
    if (colon < 0) continue;
    declarations.push([statement.slice(0, colon).trim(), statement.slice(colon + 1).trim()]);
  }
  return declarations;
}

/**
 * The declarations an element wearing `selector` reads: every rule that names it, together, which is the set the cascade
 * composes. A selector no rule carries is `null` - a rule that is not there rather than a rule that says nothing.
 */
function wearOf(selector, rules) {
  const wanted = selector.trim().replace(/\s+/gu, " ");
  const bodies = rules.filter((rule) => rule.selectors.includes(wanted)).map((rule) => rule.body);
  return bodies.length === 0 ? null : bodies;
}

/** True when the element wearing these declarations sets `property` to a value that reads `--token`. */
function wears(bodies, property, token) {
  const tokenReference = new RegExp(`var\\(\\s*--${token}\\s*\\)`, "u");
  return bodies.some((body) =>
    declarationsIn(body).some(([name, value]) => property.test(name) && tokenReference.test(value)),
  );
}

/**
 * The token table of every appearance, and which tokens the sheet paints as ink and as a surface - the pair list's
 * own authority.
 *
 * A root applies to a theme when its selector list carries a bare `:root` (that theme's base) or names the theme;
 * later roots win, which is the cascade for one file. The theme population is the attribute values the roots name,
 * or `base` for a sheet that names none.
 */
export function readStylesheet(css) {
  const text = stripComments(css);
  const roots = [];
  for (const match of text.matchAll(TOKEN_ROOT)) {
    const declarations = new Map();
    for (const declaration of match[2].matchAll(TOKEN_DECLARATION))
      declarations.set(declaration[1].slice(2), declaration[2].trim());
    roots.push({ selectors: match[1].split(",").map((selector) => selector.trim()), declarations });
  }

  const named = new Set();
  for (const root of roots) {
    const themed = root.selectors
      .map((selector) => THEMED_ROOT.exec(selector)?.[1])
      .filter((name) => name !== undefined);
    for (const name of themed) named.add(name);
    // A root that is the bare `:root` and names no appearance is an appearance of its own.
    if (themed.length === 0 && root.selectors.some((selector) => BARE_ROOT.test(selector))) named.add(BASE_THEME);
  }
  const names = named.size === 0 ? [BASE_THEME] : [...named].sort();

  const themes = new Map();
  for (const name of names) {
    const table = new Map();
    for (const root of roots) {
      // A bare `:root` is every appearance's base; a themed selector speaks only for its own.
      if (!root.selectors.some((selector) => BARE_ROOT.test(selector) || THEMED_ROOT.exec(selector)?.[1] === name))
        continue;
      for (const [token, value] of root.declarations) table.set(token, value);
    }
    themes.set(name, table);
  }

  // An appearance selector this parser did not read as a token root would silently shrink the population.
  const unread = new Set();
  for (const match of text.matchAll(ANY_THEME_SELECTOR)) if (!named.has(match[1])) unread.add(match[1]);

  const tokens = new Map();
  for (const root of roots) for (const [token, value] of root.declarations) tokens.set(token, value);
  const painted = (pattern) => new Set([...text.matchAll(pattern)].map((match) => match[1]));
  return {
    themes,
    tokens,
    unread,
    rules: rulesOf(css),
    inks: painted(INK),
    surfaces: painted(SURFACE),
    shadows: painted(SHADOW),
    boundaries: painted(BOUNDARY),
  };
}

/** The layer population of one theme's token table, sorted so two runs print the same order. */
export function layersOf(tokens) {
  const layers = [];
  for (const [name, value] of tokens) {
    if (!LAYER_TOKEN.test(name)) continue;
    // `--surface-raised: var(--surface-card)` is the card under another name, not a sixth layer.
    const alias = ALIAS.exec(value);
    if (alias !== null && LAYER_TOKEN.test(alias[1])) continue;
    layers.push(name);
  }
  return layers.sort();
}

/** The strongest alpha a shadow value paints, or null when it names no colour at all. */
function shadowAlpha(value) {
  let strongest = null;
  for (const match of value.matchAll(/rgba?\(\s*[^)]*\)/gu)) {
    const parts = match[0]
      .slice(match[0].indexOf("(") + 1, -1)
      .split(",")
      .map((part) => part.trim());
    const alpha = parts.length > 3 ? Number(parts[3]) : 1;
    if (Number.isFinite(alpha)) strongest = Math.max(strongest ?? 0, alpha);
  }
  // A hex colour in the value is opaque; `0 1px 2px #000` casts a shadow whatever the rest of the list says.
  if (/#[0-9a-f]{3,8}/iu.test(value)) return 1;
  return strongest;
}

/**
 * One token as a colour, or the reason it is not one. `chain` is the alias path, so a report can say which literal
 * a semantic token actually reads.
 */
function colourOf(name, tokens, chain = [], depth = 0) {
  const raw = tokens.get(name);
  const path = [...chain, name];
  if (raw === undefined) return { unreadable: `--${name} is not declared in the stylesheet` };
  if (depth > MAX_ALIAS_DEPTH) return { unreadable: `${path.map((step) => `--${step}`).join(" -> ")} is a loop` };
  const alias = ALIAS.exec(raw);
  if (alias !== null) return colourOf(alias[1], tokens, path, depth + 1);
  const hex = HEX.exec(raw);
  if (hex !== null) {
    const digits = hex[1].length === 3 ? [...hex[1]].map((digit) => digit + digit).join("") : hex[1];
    return { rgb: [0, 2, 4].map((offset) => Number.parseInt(digits.slice(offset, offset + 2), 16)), alpha: 1 };
  }
  const functional = FUNCTIONAL.exec(raw);
  if (functional !== null)
    return {
      rgb: [1, 2, 3].map((index) => Number(functional[index])),
      alpha: functional[4] === undefined ? 1 : Number(functional[4]),
    };
  return { unreadable: `--${name} is \`${raw}\`, which is not a single colour` };
}

const channel = (value) => {
  const scaled = value / 255;
  return scaled <= 0.03928 ? scaled / 12.92 : ((scaled + 0.055) / 1.055) ** 2.4;
};

const luminance = ([red, green, blue]) => 0.2126 * channel(red) + 0.7152 * channel(green) + 0.0722 * channel(blue);

/** WCAG 2.1 contrast ratio. The verdict compares this unrounded value, so 4.496 is not reported as 4.50. */
export function contrastRatio(foreground, background) {
  const first = luminance(foreground);
  const second = luminance(background);
  return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05);
}

const hexOf = (rgb) => `#${rgb.map((value) => Math.round(value).toString(16).padStart(2, "0")).join("")}`;

/** The pixel CSS paints: a translucent ink over an opaque background. */
const over = ({ rgb, alpha }, background) => rgb.map((value, index) => value * alpha + background[index] * (1 - alpha));

const blockedReading = (reason) => ({
  gate: "contrast-tokens",
  examined: 0,
  tokens: 0,
  themes: [],
  rows: [],
  elevation: {
    floor: ELEVATION_STEP_FLOOR,
    boundaryFloor: ELEVATION_BOUNDARY_FLOOR,
    examined: 0,
    layers: [],
    rows: [],
    violations: [],
    status: "blocked",
  },
  pairsPassed: false,
  violations: [],
  status: "blocked",
  reason,
});

/**
 * The gate: every declared pair against its own minimum and every rung against its floor, in every appearance the
 * stylesheet declares, held to the stylesheet that declares its tokens.
 */
export function checkContrastTokens({
  root = REPOSITORY_ROOT,
  stylesheet = STYLESHEET,
  pairs = CONTRAST_PAIRS,
  steps = ELEVATION_STEPS,
} = {}) {
  let css;
  try {
    css = readFileSync(resolve(root, stylesheet), "utf8");
  } catch {
    return blockedReading(`${stylesheet} could not be read`);
  }
  if (pairs.length === 0) return blockedReading("no pair to measure");
  const { themes, tokens, unread, rules, inks, surfaces } = readStylesheet(css);
  if (tokens.size === 0) return blockedReading(`${stylesheet} declares no custom property`);

  const rows = [];
  const violations = [];
  // A pair nothing wears is a fact about the sheet, not about one appearance, so it is reported once.
  for (const pair of pairs) {
    const label = `${pair.fg} on ${pair.bg}`;
    if (!inks.has(pair.fg))
      violations.push({
        code: `pair_ink_unused:${label}`,
        label,
        token: pair.fg,
        detail:
          `the stylesheet never paints --${pair.fg} as \`color:\`, so nothing wears this pair: ` +
          "drop it, or point it at the token the rule paints now",
      });
    if (!surfaces.has(pair.bg))
      violations.push({
        code: `pair_surface_unused:${label}`,
        label,
        token: pair.bg,
        detail:
          `the stylesheet never paints --${pair.bg} as \`background:\`, so nothing sits on this surface: ` +
          "drop the pair, or point it at the surface the rule paints now",
      });
  }
  for (const theme of unread)
    violations.push({
      code: `theme_selector_unread:${theme}`,
      theme,
      detail:
        `the stylesheet names [data-theme="${theme}"] but no token root this gate reads declares it, so that ` +
        'appearance would be measured as if it did not exist: write it as `:root[data-theme="' +
        theme +
        '"] { ... }`',
    });

  for (const [theme, table] of themes) {
    for (const pair of pairs) rows.push(measurePair({ theme, pair, tokens: table }));
  }
  for (const row of rows)
    if (row.verdict === "fail")
      violations.push({
        code: `contrast_below_min:${row.theme}:${row.label}`,
        theme: row.theme,
        label: row.label,
        fg: row.fgHex,
        bg: row.bgHex,
        ratio: Number(row.ratio.toFixed(2)),
        min: row.min,
        detail: `reads ${row.ratio.toFixed(2)}:1 in the ${row.theme} appearance, below ${row.min}:1 - ${row.why}`,
      });
    else if (row.verdict === "unreadable")
      violations.push({
        code: `token_unreadable:${row.theme}:${row.label}:${row.token}`,
        theme: row.theme,
        label: row.label,
        token: row.token,
        detail: `${row.reason}; this pair cannot be measured until that token is one colour`,
      });

  const pairsPassed = violations.length === 0;
  const elevation = elevationOf({ themes, steps, rules });
  violations.push(...elevation.violations);

  return {
    gate: "contrast-tokens",
    examined: rows.length,
    tokens: new Set(pairs.flatMap((pair) => [pair.fg, pair.bg])).size,
    themes: [...themes.keys()],
    rows,
    pairsPassed,
    elevation,
    violations,
    status: violations.length === 0 ? "passed" : "failed",
    reason: null,
  };
}

/**
 * One pair in one appearance: its two colours, the ratio they paint, and the verdict its own minimum gives it.
 * `unreadable` carries the token that stopped the reading and the reason it did.
 */
function measurePair({ theme, pair, tokens }) {
  const row = {
    theme,
    label: `${pair.fg} on ${pair.bg}`,
    min: pair.min,
    why: pair.why,
    fgHex: null,
    bgHex: null,
    ratio: null,
    verdict: "unreadable",
    token: null,
    reason: null,
  };
  const foreground = colourOf(pair.fg, tokens);
  const background = colourOf(pair.bg, tokens);
  let unreadable = null;
  if (foreground.unreadable !== undefined) unreadable = { token: pair.fg, reason: foreground.unreadable };
  else row.fgHex = hexOf(foreground.rgb);
  if (unreadable === null && background.unreadable !== undefined)
    unreadable = { token: pair.bg, reason: background.unreadable };
  else if (background.unreadable === undefined) row.bgHex = hexOf(background.rgb);
  if (unreadable === null && background.alpha < 1)
    unreadable = {
      token: pair.bg,
      reason: `--${pair.bg} is translucent (alpha ${background.alpha}); the surface beneath it is not named here`,
    };

  if (unreadable !== null) {
    row.token = unreadable.token;
    row.reason = unreadable.reason;
    return row;
  }
  const painted = foreground.alpha < 1 ? over(foreground, background.rgb) : foreground.rgb;
  row.fgHex = hexOf(painted);
  row.ratio = contrastRatio(painted, background.rgb);
  row.verdict = row.ratio >= pair.min ? "pass" : "fail";
  return row;
}

/**
 * One rung in one appearance: the two layers, the ratio they paint, the means the rung holds, and the violations for any
 * declared means the sheet does not keep.
 */
function measureRung({ theme, step, tokens, rules }) {
  const label = `${step.beneath}->${step.raised}`;
  const row = {
    theme,
    label,
    why: step.why,
    beneathHex: null,
    raisedHex: null,
    ratio: null,
    means: [],
    verdict: "unreadable",
    reason: null,
  };
  const claims = [];
  const beneath = colourOf(step.beneath, tokens);
  const raised = colourOf(step.raised, tokens);
  const unreadable = layerUnreadable(step, beneath, raised);
  if (unreadable !== null) {
    row.token = unreadable.token;
    row.reason = unreadable.reason;
    claims.push({
      code: `token_unreadable:${theme}:${label}:${unreadable.token}`,
      theme,
      label,
      token: unreadable.token,
      detail: `${unreadable.reason}; this rung cannot be measured until that layer is one opaque colour`,
    });
    return { row, claims };
  }

  row.beneathHex = hexOf(beneath.rgb);
  row.raisedHex = hexOf(raised.rgb);
  row.ratio = contrastRatio(raised.rgb, beneath.rgb);
  if (row.ratio >= ELEVATION_STEP_FLOOR) row.means.push({ mean: "luminance", token: null, rule: null });

  if (step.shadow !== undefined) {
    const shadow = shadowClaim({ theme, label, step, tokens, rules });
    if (shadow.violation === null) row.means.push({ mean: "shadow", token: step.shadow.token, rule: step.shadow.rule });
    else claims.push(shadow.violation);
  }
  if (step.boundary !== undefined) {
    const boundary = boundaryClaim({ theme, label, step, tokens, rules, beneath });
    if (boundary.violation === null)
      row.means.push({ mean: "boundary", token: step.boundary.token, rule: step.boundary.rule });
    else claims.push(boundary.violation);
  }

  row.verdict = row.means.length > 0 ? "pass" : "fail";
  return { row, claims };
}

/** The layer that stopped a rung from being read, or null when both layers are one opaque colour. */
function layerUnreadable(step, beneath, raised) {
  if (beneath.unreadable !== undefined) return { token: step.beneath, reason: beneath.unreadable };
  if (raised.unreadable !== undefined) return { token: step.raised, reason: raised.unreadable };
  if (beneath.alpha >= 1 && raised.alpha >= 1) return null;
  const translucent = beneath.alpha < 1 ? step.beneath : step.raised;
  return { token: translucent, reason: `--${translucent} is translucent; a layer is an opaque surface` };
}

/**
 * Means (b) for one rung: a shadow token the theme declares, and the rule the rung names painting the raised layer and
 * applying the token as a `box-shadow`. A declared means that does not hold is a violation of its own, whether or not
 * luminance rescued the rung - and a token that is declared, or painted by some other rule, is not this layer's edge.
 */
function shadowClaim({ theme, label, step, tokens, rules }) {
  const token = step.shadow.token;
  const claim = (code, detail) => ({ violation: { code, theme, label, token, detail } });
  const value = tokens.get(token);
  if (value === undefined)
    return claim(
      `elevation_shadow_undeclared:${theme}:${label}`,
      `the rung claims \`--${token}\` as its shadow, and the ${theme} appearance does not declare it`,
    );
  const worn = wearOf(step.shadow.rule, rules);
  if (worn === null)
    return claim(
      `elevation_shadow_rule_absent:${theme}:${label}`,
      `the rung names \`${step.shadow.rule}\` as the rule that casts \`--${token}\`, and no rule in the sheet carries ` +
        "that selector",
    );
  if (!wears(worn, BACKGROUND, step.raised))
    return claim(
      `elevation_shadow_off_surface:${theme}:${label}`,
      `\`${step.shadow.rule}\` does not paint \`--${step.raised}\` as its background, so the shadow it casts is not ` +
        "this layer's",
    );
  if (!wears(worn, BOX_SHADOW, token))
    return claim(
      `elevation_shadow_unpainted:${theme}:${label}`,
      `\`${step.shadow.rule}\` paints \`--${step.raised}\` and applies no \`box-shadow: var(--${token})\`, so the ` +
        "token is declared and the layer it was declared for does not wear it",
    );
  if ((shadowAlpha(value) ?? 0) === 0)
    return claim(
      `elevation_shadow_invisible:${theme}:${label}`,
      `\`--${token}\` is \`${value}\`, whose strongest colour is fully transparent: it casts nothing`,
    );
  return { violation: null };
}

/**
 * Means (c) for one rung: a boundary token the theme declares, and the rule the rung names painting the raised layer and
 * applying the token as a border, at or above WCAG 1.4.11's 3:1 against the layer beneath. A translucent boundary is
 * composited over that layer, as CSS paints it.
 */
function boundaryClaim({ theme, label, step, tokens, rules, beneath }) {
  const token = step.boundary.token;
  const claim = (code, detail, ratio) => ({
    violation: { code, theme, label, token, detail, ...(ratio === undefined ? {} : { ratio }) },
  });
  const value = tokens.get(token);
  if (value === undefined)
    return claim(
      `elevation_boundary_undeclared:${theme}:${label}`,
      `the rung claims \`--${token}\` as its boundary, and the ${theme} appearance does not declare it`,
    );
  const worn = wearOf(step.boundary.rule, rules);
  if (worn === null)
    return claim(
      `elevation_boundary_rule_absent:${theme}:${label}`,
      `the rung names \`${step.boundary.rule}\` as the rule that wears \`--${token}\`, and no rule in the sheet carries ` +
        "that selector",
    );
  if (!wears(worn, BACKGROUND, step.raised))
    return claim(
      `elevation_boundary_off_surface:${theme}:${label}`,
      `\`${step.boundary.rule}\` does not paint \`--${step.raised}\` as its background, so the border it draws is not ` +
        "this layer's edge",
    );
  if (!wears(worn, BORDER, token))
    return claim(
      `elevation_boundary_unpainted:${theme}:${label}`,
      `\`${step.boundary.rule}\` paints \`--${step.raised}\` and applies no border from \`--${token}\`, so the token is ` +
        "declared and the layer it was declared for does not wear it",
    );
  const colour = colourOf(token, tokens);
  if (colour.unreadable !== undefined)
    return claim(
      `token_unreadable:${theme}:${label}:${token}`,
      `${colour.unreadable}; this boundary cannot be measured until it is one colour`,
    );
  const painted = colour.alpha < 1 ? over(colour, beneath.rgb) : colour.rgb;
  const ratio = contrastRatio(painted, beneath.rgb);
  if (ratio < ELEVATION_BOUNDARY_FLOOR)
    return claim(
      `elevation_boundary_below_floor:${theme}:${label}`,
      `\`--${token}\` reads ${ratio.toFixed(2)}:1 on \`--${step.beneath}\`, under the ` +
        `${ELEVATION_BOUNDARY_FLOOR}:1 a boundary that identifies a component needs`,
      Number(ratio.toFixed(2)),
    );
  return { violation: null };
}

/** The other two means named as missing, for a rung that luminance did not carry either. */
function missingMeans(row, step) {
  const held = (mean) => row.means.some((carried) => carried.mean === mean);
  const missing = [];
  if (!held("shadow"))
    missing.push(
      step.shadow === undefined
        ? "no shadow token is declared for the rung"
        : `--${step.shadow.token} does not carry it`,
    );
  if (!held("boundary"))
    missing.push(
      step.boundary === undefined
        ? `no boundary token reads ${ELEVATION_BOUNDARY_FLOOR}:1 against --${step.beneath}`
        : `--${step.boundary.token} does not carry it`,
    );
  return missing;
}

/** The violation a rung under its floor produces, naming the pair, the ratio, the floor and the means that are missing. */
function indistinctViolation({ theme, step, row }) {
  return {
    code: `elevation_indistinct:${theme}:${row.label}`,
    theme,
    label: row.label,
    beneath: row.beneathHex,
    raised: row.raisedHex,
    ratio: Number(row.ratio.toFixed(2)),
    floor: ELEVATION_STEP_FLOOR,
    detail:
      `\`--${step.raised}\` reads ${row.ratio.toFixed(2)}:1 on \`--${step.beneath}\` in the ${theme} appearance, ` +
      `under the ${ELEVATION_STEP_FLOOR}:1 step floor, and neither of the other two means carries it either: ` +
      `${missingMeans(row, step).join("; ")} - ${step.why}`,
  };
}

/** Every rung of one appearance, and the violations the rungs produce there. */
function rungRows({ theme, table, steps, population, rules }) {
  const rows = [];
  const violations = [];
  for (const step of steps) {
    const missing = [step.beneath, step.raised].find((layer) => !population.includes(layer));
    if (missing !== undefined) {
      rows.push({
        theme,
        label: `${step.beneath}->${step.raised}`,
        why: step.why,
        beneathHex: null,
        raisedHex: null,
        ratio: null,
        means: [],
        verdict: "not_measured",
        reason: `the ${theme} appearance does not declare --${missing}`,
      });
      continue;
    }
    const { row, claims } = measureRung({ theme, step, tokens: table, rules });
    rows.push(row);
    violations.push(...claims);
    if (row.verdict === "fail") violations.push(indistinctViolation({ theme, step, row }));
  }
  return { rows, violations };
}

/** Every sibling plate of one appearance, printed with its reading and never a verdict. */
function siblingRows({ theme, table, population }) {
  const rows = [];
  for (const [layer, sibling] of Object.entries(ELEVATION_SIBLINGS)) {
    const measured = population.includes(layer) && population.includes(sibling.on);
    if (!measured) continue;
    const beneath = colourOf(sibling.on, table);
    const plate = colourOf(layer, table);
    if (beneath.unreadable !== undefined || plate.unreadable !== undefined) continue;
    rows.push({
      theme,
      label: `${sibling.on}->${layer}`,
      why: sibling.why,
      beneathHex: hexOf(beneath.rgb),
      raisedHex: hexOf(plate.rgb),
      ratio: contrastRatio(plate.rgb, beneath.rgb),
      means: [],
      verdict: "sibling",
      reason: null,
    });
  }
  return rows;
}

/** The layers one appearance declares that no rung raises and no sibling names. */
function coverageViolations({ theme, population, steps }) {
  const violations = [];
  for (const layer of population) {
    const raised = steps.some((step) => step.beneath === layer || step.raised === layer);
    if (raised || ELEVATION_SIBLINGS[layer] !== undefined) continue;
    violations.push({
      code: `elevation_layer_without_rung:${theme}:${layer}`,
      theme,
      token: layer,
      detail:
        `the ${theme} appearance declares \`--${layer}\` and no rung raises it and no sibling names it: ` +
        "add the step that stacks it, or declare why it has no rung",
    });
  }
  return violations;
}

/** A rung or sibling naming a layer no appearance declares: this file's own lists have drifted from the sheet. */
function driftViolations(known, steps) {
  const violations = [];
  for (const step of steps)
    for (const layer of [step.beneath, step.raised])
      if (!known.has(layer))
        violations.push({
          code: `elevation_step_layer_undeclared:${layer}`,
          token: layer,
          detail: `a rung names \`--${layer}\`, which no appearance declares: the step list has drifted from the sheet`,
        });
  for (const [layer, sibling] of Object.entries(ELEVATION_SIBLINGS))
    for (const name of [layer, sibling.on])
      if (!known.has(name))
        violations.push({
          code: `elevation_sibling_layer_undeclared:${name}`,
          token: name,
          detail: `a sibling names \`--${name}\`, which no appearance declares: the sibling list has drifted from the sheet`,
        });
  return violations;
}

/**
 * The elevation ladder over every appearance: each rung's ratio and means, each sibling's printed reading, the layer
 * population of every appearance, and the violations the rungs and the population produce.
 */
function elevationOf({ themes, steps, rules }) {
  const layers = [];
  const rows = [];
  const violations = [];
  const known = new Set();
  for (const [, table] of themes) for (const layer of layersOf(table)) known.add(layer);
  violations.push(...driftViolations(known, steps));

  for (const [theme, table] of themes) {
    const population = layersOf(table);
    for (const layer of population) {
      const colour = colourOf(layer, table);
      layers.push({ theme, layer, hex: colour.unreadable === undefined ? hexOf(colour.rgb) : null });
    }
    const rungs = rungRows({ theme, table, steps, population, rules });
    rows.push(...rungs.rows, ...siblingRows({ theme, table, population }));
    violations.push(...rungs.violations, ...coverageViolations({ theme, population, steps }));
  }

  // A sibling's reading is printed beside the rungs and is not one of them, so it is not counted here.
  const examined = rows.filter((row) => row.verdict !== "sibling" && row.verdict !== "not_measured").length;
  let status = "passed";
  if (violations.length > 0) status = "failed";
  else if (examined === 0) status = "not_measured";
  return {
    floor: ELEVATION_STEP_FLOOR,
    boundaryFloor: ELEVATION_BOUNDARY_FLOOR,
    examined,
    layers,
    rows,
    violations,
    status,
  };
}

/**
 * One kept means as it is printed: `luminance`, or the means and the token that earned it (`shadow:shadow-card`).
 */
const describedMean = (carried) => (carried.token === null ? carried.mean : `${carried.mean}:${carried.token}`);

/**
 * Print the reading and return the exit code: `blocked` is always 1, a failing pair or rung is 1 only under `--fail`.
 */
export function reportContrastTokens(result, { fail = false, out = process.stdout, err = process.stderr } = {}) {
  out.write(`contrast_tokens: examined ${result.examined} pair(s) in ${result.tokens} token(s)\n`);
  if (result.themes.length > 0)
    out.write(`contrast_tokens: ${result.themes.length} appearance(s): ${result.themes.join(", ")}\n`);
  const width = Math.max(...result.themes.map((theme) => theme.length), 0);
  for (const row of result.rows)
    out.write(
      `  ${row.theme.padEnd(width)} ${row.label} fg=${row.fgHex ?? "-"} bg=${row.bgHex ?? "-"} ` +
        `ratio=${row.ratio === null ? "-" : row.ratio.toFixed(2)} min=${row.min} verdict=${row.verdict}\n`,
    );
  if (result.reason !== null) err.write(`contrast_tokens_blocked: ${result.reason}\n`);
  const elevation = result.elevation;
  out.write(
    `elevation_ladder: examined ${elevation.examined} rung(s) in ${new Set(elevation.layers.map((layer) => layer.layer)).size} layer(s) ` +
      `over ${result.themes.length} appearance(s), step floor ${elevation.floor}:1, boundary floor ${elevation.boundaryFloor}:1\n`,
  );
  for (const theme of result.themes) {
    const population = elevation.layers.filter((layer) => layer.theme === theme);
    if (population.length === 0) continue;
    out.write(
      `  ${theme.padEnd(width)} layers: ${population.map((layer) => `${layer.layer}=${layer.hex ?? "-"}`).join(" ")}\n`,
    );
  }
  for (const row of elevation.rows)
    out.write(
      `  ${row.theme.padEnd(width)} ${row.label} beneath=${row.beneathHex ?? "-"} raised=${row.raisedHex ?? "-"} ` +
        `ratio=${row.ratio === null ? "-" : row.ratio.toFixed(2)} floor=${elevation.floor} ` +
        `means=${row.means.length === 0 ? "none" : row.means.map(describedMean).join("+")} verdict=${row.verdict}` +
        `${row.reason === null ? "" : ` (${row.reason})`}\n`,
    );
  for (const violation of result.violations) err.write(`${violation.code}\n  ${violation.detail}\n`);
  if (result.violations.length > 0) err.write(`contrast_tokens: ${result.violations.length} violation(s)\n`);
  out.write(
    `${JSON.stringify({
      gate: result.gate,
      examined: result.examined,
      tokens: result.tokens,
      elevation: {
        examined: elevation.examined,
        layers: new Set(elevation.layers.map((layer) => layer.layer)).size,
        floor: elevation.floor,
        status: elevation.status,
      },
      violations: result.violations,
      // The rules this run verified, named, for the same reason the other gates name theirs: the harness has to be able
      // to tell a gate that asserted something from one that only printed a table.
      checks: [
        { id: "every_declared_pair_meets_its_minimum", status: result.pairsPassed ? "passed" : "failed" },
        { id: "every_elevation_rung_is_distinguishable", status: elevation.status },
      ],
      status: result.status,
    })}\n`,
  );
  if (result.status === "passed") return 0;
  if (result.status === "blocked") return 1;
  if (!fail) err.write("contrast_tokens: report-only, exit 0; pass --fail to make a failing pair exit 1\n");
  return fail ? 1 : 0;
}

function main(argv) {
  const root = rootFromArgv(argv, REPOSITORY_ROOT);
  return reportContrastTokens(checkContrastTokens({ root }), { fail: argv.includes("--fail") });
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  process.exitCode = main(process.argv.slice(2));
