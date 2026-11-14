/**
 * The stylesheet's scroll containers, read out of `src/style.css` itself.
 *
 * THE POPULATION IS THE SHEET. Every ruleset that declares a block-axis (`overflow-y`, or the `overflow`
 * shorthand) value of `auto` or `scroll` is a box whose own scrollbar can appear and disappear, which is
 * the set that owes a reserved gutter. Nothing lists the containers by hand, so a new scroller joins by
 * being written into the sheet. Inline-axis scrollers (`overflow-x` alone, a code block's `<pre>`) are
 * outside it: `scrollbar-gutter` reserves the strip a *block-axis* scrollbar occupies, and a
 * horizontally scrolling box is served by neither.
 *
 * TWO CONSUMERS, ONE READER. `scroll-containers-keep-their-width.spec.ts` (the mounted zone) measures what
 * these containers DO in a browser - that a reservation is taken before the content overflows, and that the
 * content column does not narrow when it does. `layout-stability-gate.test.mjs` (the static zone) holds the
 * class: every container either declares the reservation or is exempt with a reason, and no exemption
 * outlives the selector that earned it. Both read the sheet through this module, so a rule added to the
 * sheet joins both without an edit, and a change to how a container is recognised lands in one place.
 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** The sheet both consumers read: `src/style.css`, resolved from this module's own location. */
export const STYLESHEET: string = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "style.css");

/** The values that make a box a scroll container on an axis. */
export const SCROLLING_VALUES: ReadonlySet<string> = new Set(["auto", "scroll"]);

/** The values that reserve the gutter. `both-edges` is the same promise with the strip mirrored. */
export const RESERVING_GUTTER = /^stable(\s+both-edges)?$/u;

/** Containers deliberately left without a reserved gutter, each with the reason it is left alone. */
export const SCROLL_GUTTER_EXEMPTIONS: ReadonlyMap<string, string> = new Map([
  [
    ".tavern-memory-section",
    "declares `overflow-y: auto` but no block-axis bound of its own - it is a column child of the " +
      "surface and grows with its content, so it never becomes a scroller; a reserved gutter would " +
      "only take 15 px off the notebook",
  ],
  [
    ".draft-content",
    "a `max-height: 120px` preview inside the drawer, replaced wholesale when a draft arrives: " +
      "reserving the strip would narrow every two-line draft to avoid a shift that happens while the " +
      "text under it is being replaced anyway",
  ],
  [".reference-draft-section p", "the same capped preview in the reference drawer, one selector over"],
  [
    ".composer-textarea",
    "the field the player types into: two lines at rest, the band's 176 px ceiling when the draft is long, " +
      "and it scrolls only past that ceiling. A reserved strip would narrow every line of every short draft " +
      "to avoid one reflow of the field's own text at the ceiling",
  ],
  [
    ".message-edit-field",
    "the same field on the other side of the exchange - two rows at rest, 300 px at the ceiling - and " +
      "exempt for the same reason",
  ],
  [
    ".opening-variants",
    "a nested list capped to `min(32dvh, 300px)` and generated in one answer; the region a machine " +
      "fills is the region that scrolls, and a permanent strip in a 420 px card costs the rows more " +
      "than the one-off reflow",
  ],
  [".installation-candidates", "the same capped, machine-filled list on the installation panel"],
  [
    "[data-card-import-review] .card-import-report",
    "the same capped report, filled once by an import, with the decision row kept outside it",
  ],
  [
    ".game-diagnostics-json",
    "a `<pre>` that scrolls on both axes; the gutter a horizontal scrollbar occupies is on the block " +
      "axis, which `scrollbar-gutter` does not reserve",
  ],
]);

/** One declaration: the property as the sheet spells it, and its value with whitespace collapsed. */
export type Declaration = readonly [property: string, value: string];

/** One innermost ruleset: its selector and its declarations, in source order. */
export type StyleRule = Readonly<{ selector: string; declarations: readonly Declaration[] }>;

/** One box whose own block axis can scroll, and whether it reserves the strip that scrollbar occupies. */
export type ScrollContainer = Readonly<{ selector: string; reserving: boolean }>;

/** Comments blanked so a `;` or `{}` inside them cannot be read as syntax. */
export function blankComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//gu, (match) => " ".repeat(match.length));
}

/** The declarations of one rule body, as `[property, value]` pairs with whitespace collapsed. */
export function declarationsOf(body: string): readonly Declaration[] {
  const out: Declaration[] = [];
  for (const part of body.split(";")) {
    const trimmed = part.trim();
    if (trimmed.length === 0 || trimmed.includes("{")) continue;
    const separator = trimmed.indexOf(":");
    if (separator <= 0) continue;
    out.push([trimmed.slice(0, separator).trim(), trimmed.slice(separator + 1).trim().replace(/\s+/gu, " ")]);
  }
  return out;
}

/** One innermost ruleset: its selector and its declarations, in source order. */
export function rulesOf(css: string): readonly StyleRule[] {
  const text = blankComments(css);
  const out: StyleRule[] = [];
  const stack: { prelude: string; start: number }[] = [];
  let preludeStart = 0;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (character === "{") {
      stack.push({ prelude: text.slice(preludeStart, index).trim().replace(/\s+/gu, " "), start: index });
      preludeStart = index + 1;
      continue;
    }
    if (character === "}") {
      const entry = stack.pop();
      if (entry !== undefined && !entry.prelude.startsWith("@")) {
        out.push({ selector: entry.prelude, declarations: declarationsOf(text.slice(entry.start + 1, index)) });
      }
      preludeStart = index + 1;
      continue;
    }
    if (character === ";") preludeStart = index + 1;
  }
  return out;
}

/** The block-axis overflow a rule's declarations resolve to, or null when it declares none. */
export function blockAxisOverflow(declarations: readonly Declaration[]): string | null {
  const declared = new Map(declarations);
  const shorthand = declared.get("overflow");
  if (shorthand !== undefined) {
    // `overflow: <inline> <block>`; a single value applies to both axes.
    const values = shorthand.split(" ");
    return values.length === 1 ? values[0] : values[1];
  }
  return declared.get("overflow-y") ?? null;
}

/** Every ruleset whose own block axis can scroll: the population both consumers read. */
export function scrollContainers(css: string): readonly ScrollContainer[] {
  return rulesOf(css)
    .filter((rule) => SCROLLING_VALUES.has(blockAxisOverflow(rule.declarations) ?? ""))
    .map((rule) => ({
      selector: rule.selector,
      reserving: rule.declarations.some(
        ([property, value]) => property === "scrollbar-gutter" && RESERVING_GUTTER.test(value),
      ),
    }));
}
