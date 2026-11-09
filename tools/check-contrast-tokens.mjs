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
 *     `dialogue-web/tests/style-tokens-gate.test.mjs`, not by this tool.
 *
 * Output: `contrast_tokens: examined N pair(s) in M token(s) over K theme(s)`, one line per theme and pair
 * (`<theme> <label> fg=#rrggbb bg=#rrggbb ratio=17.33 min=4.5 verdict=pass|fail|unreadable`), and one JSON verdict line
 * `{"gate":"contrast-tokens","examined":N,"tokens":M,"violations":[...],"status":"passed"|"failed"|"blocked"}`.
 * A pair below its minimum is REPORTED and exits 0 by default; `--fail` makes it exit 1. Zero pairs, an unreadable
 * stylesheet and a stylesheet with no custom property are `blocked` and exit 1 in every mode - a gate that measured
 * nothing has not passed.
 *
 * Usage:
 *   node tools/check-contrast-tokens.mjs            # report every pair, exit 0
 *   node tools/check-contrast-tokens.mjs --fail     # exit 1 when a pair is below its minimum
 *   node tools/check-contrast-tokens.mjs --root <dir>   # a fixture tree holding the same stylesheet path
 *
 * red-proof: inject  `--text-disabled` set to #6a625a instead of #90877e ->
 *            `contrast_below_min:dark:text-disabled on surface-card` at 2.80:1 (min 4.5), exit 1 under `--fail`; a
 *            token declared `color-mix(...)` -> `token_unreadable:<theme>:<label>:<token>`; an empty pair list ->
 *            `status:"blocked"`, exit 1; a light root one shade too pale -> the same pair named under `light` while the
 *            `dark` reading of it still passes; a `[data-theme="sepia"]` root written outside the token-root shape ->
 *            `theme_selector_unread:sepia` (tools/check-contrast-tokens.test.mjs builds each in a temp dir).
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
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

const COMMENTS = /\/\*[\s\S]*?\*\//gu;
/** A declaration at the start of a statement, so `border-color:` and `outline-color:` cannot pass as an ink. */
const TOKEN_DECLARATION = /(?:^|[\s;{])(--[a-z0-9-]+)\s*:\s*([^;}]+)/gmu;
const INK = /(?:^|[\s;{])color:\s*var\(\s*--([a-z0-9-]+)\s*\)/gmu;
const SURFACE = /(?:^|[\s;{])background(?:-color)?:\s*var\(\s*--([a-z0-9-]+)\s*\)/gmu;
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
  return { themes, tokens, unread, inks: painted(INK), surfaces: painted(SURFACE) };
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
  violations: [],
  status: "blocked",
  reason,
});

/**
 * The gate: every declared pair against its own minimum, in every appearance the stylesheet declares, held to the
 * stylesheet that declares its tokens.
 */
export function checkContrastTokens({ root = REPOSITORY_ROOT, stylesheet = STYLESHEET, pairs = CONTRAST_PAIRS } = {}) {
  let css;
  try {
    css = readFileSync(resolve(root, stylesheet), "utf8");
  } catch {
    return blockedReading(`${stylesheet} could not be read`);
  }
  if (pairs.length === 0) return blockedReading("no pair to measure");
  const { themes, tokens, unread, inks, surfaces } = readStylesheet(css);
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

  return {
    gate: "contrast-tokens",
    examined: rows.length,
    tokens: new Set(pairs.flatMap((pair) => [pair.fg, pair.bg])).size,
    themes: [...themes.keys()],
    rows,
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
 * Print the reading and return the exit code: `blocked` is always 1, a failing pair is 1 only under `--fail`.
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
  for (const violation of result.violations) err.write(`${violation.code}\n  ${violation.detail}\n`);
  if (result.violations.length > 0) err.write(`contrast_tokens: ${result.violations.length} violation(s)\n`);
  out.write(
    `${JSON.stringify({
      gate: result.gate,
      examined: result.examined,
      tokens: result.tokens,
      violations: result.violations,
      // The rule this run verified, named, for the same reason the other gates name theirs: the harness has to be able
      // to tell a gate that asserted something from one that only printed a table.
      checks: [{ id: "every_declared_pair_meets_its_minimum", status: result.status }],
      status: result.status,
    })}\n`,
  );
  if (result.status === "passed") return 0;
  if (result.status === "blocked") return 1;
  if (!fail) err.write("contrast_tokens: report-only, exit 0; pass --fail to make a failing pair exit 1\n");
  return fail ? 1 : 0;
}

function main(argv) {
  const rootIndex = argv.indexOf("--root");
  const root =
    rootIndex >= 0 && typeof argv[rootIndex + 1] === "string" ? resolve(argv[rootIndex + 1]) : REPOSITORY_ROOT;
  return reportContrastTokens(checkContrastTokens({ root }), { fail: argv.includes("--fail") });
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  process.exitCode = main(process.argv.slice(2));
