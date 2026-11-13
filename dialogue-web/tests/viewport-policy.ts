/**
 * The viewport population: the sizes the suite evaluates, and the contract a spec owes them.
 *
 * WHY ONE FILE. The same seven cells were written out by hand in four spec files and a fifth spelling - 1280x720 -
 * was never written at all: it is the `Desktop Chrome` device cell, so every mounted spec that sets no viewport is
 * measured in a size no declared list contains. That is one fact with five spellings, and the fifth one is why
 * fifty-four specs sample a single cell nobody chose.
 *
 * THE SIZES, AND WHAT MAKES EACH ONE A DIFFERENT LAYOUT. The shell has five width folds in `style.css` -
 * `max-width: 860px`, `768px`, `640px`, `480px`, and the two wide bands `884..1315px` and `min-width: 1316px` - so a
 * cell is here because it sits on a different side of one of them, or because it is a height at which a wide layout
 * has to survive a short window. The reason is on the cell and not in this comment, so the next size has to state why
 * it exists before it can join.
 *
 * THE CONTRACT EVERY SPEC OWES. A spec that measures the rendered page at two or more viewport sizes is measuring
 * viewport-dependent rendering, and it must evaluate every cell in `VIEWPORT_SIZES` - by iterating that array, so a
 * new cell joins it without an edit - or state a named reason why not, in `VIEWPORT_EXEMPTIONS` of
 * `tools/check-viewport-population.mjs`. A spec that sets one size, or none, owes nothing: it is pinning the layout a
 * defect belongs to, and pinning is a decision. `tools/check-viewport-population.mjs` is the gate over this file.
 *
 * Runtime is the reason the contract is stated rather than assumed: the cross-product is not free, so a copy journey
 * that varies two layouts to prove the same sentence survives on both says so, instead of quietly deciding by
 * omission. `LAYOUT_PAIR` is what such a journey iterates - the two cells where the two layouts are, derived here and
 * never re-spelled in a spec.
 */

export type ViewportSize = Readonly<{
  /** The name a failure message uses, so a red run says "tablet" and not only "1024x768". */
  name: string;
  width: number;
  height: number;
  /** What this cell is that the others are not: the fold it sits on, or the window it stands for. */
  reason: string;
}>;

/** The phone baseline: the narrowest window the shell is expected to work in, below the 480px rules. */
export const PHONE: ViewportSize = {
  name: "phone",
  width: 400,
  height: 800,
  reason:
    "The phone baseline the owner's report named: below every width fold (860, 768, 640, 480), so all of them apply " +
    "at once, and it is the surface a player holds while the game runs on another screen.",
};

/** The widest declared window: above `min-width: 1316px`, where the shell draws its widest arrangement. */
export const DESKTOP: ViewportSize = {
  name: "desktop",
  width: 1440,
  height: 900,
  reason:
    "The widest window the product is used at, above the `min-width: 1316px` band: the arrangement with the most " +
    "columns, where a surface that is not anchored shows the most empty tail.",
};

export const LAPTOP: ViewportSize = {
  name: "laptop",
  width: 1280,
  height: 800,
  reason:
    "The middle wide band (`884..1315px`): between the two wide arrangements, so a `1316px`-only rule that leaked " +
    "below its band or a folded-nav rule that started early both show up here rather than at either end.",
};

export const SMALL_LAPTOP: ViewportSize = {
  name: "small-laptop",
  width: 1280,
  height: 720,
  reason:
    "The first-screen budget: the shortest laptop window the product is held to, and the cell `first-screen.spec.ts` " +
    "measures Settings against - the connection group must end above 720 px and the voice consent below it. It is " +
    "also the cell Playwright's `Desktop Chrome` device gives, which is why it is the inherited one: the whole suite " +
    "was already measured here, and the size was simply never declared.",
};

export const TABLET: ViewportSize = {
  name: "tablet",
  width: 1024,
  height: 768,
  reason:
    "The narrowest window that still draws the unfolded AppBar (the fold is at 860px) with a 768-tall viewport: a " +
    "wide layout in a short window, which is the case where the composer band is pushed past the bottom edge.",
};

export const COMPACT: ViewportSize = {
  name: "compact",
  width: 900,
  height: 700,
  reason:
    "The tightest wide layout: 40px above the 860px fold, with the least vertical room of any wide cell, so it is " +
    "where a wide arrangement runs out of height first.",
};

export const STRIP: ViewportSize = {
  name: "strip",
  width: 816,
  height: 767,
  reason:
    "The 816px strip the owner's report named: below the 860px fold, so the AppBar has folded, one pixel short of " +
    "the 768px height the fold leaves for content.",
};

export const PHONE_TALL: ViewportSize = {
  name: "phone-tall",
  width: 480,
  height: 900,
  reason:
    "Exactly the `max-width: 480px` boundary - the widest window the phone rules still apply to - at a phone's " +
    "tallest, separating 'narrow' from 'narrow and short'.",
};

/** Every cell a spec that measures the rendered page at more than one size owes. */
export const VIEWPORT_SIZES: readonly ViewportSize[] = [
  DESKTOP,
  LAPTOP,
  SMALL_LAPTOP,
  TABLET,
  COMPACT,
  STRIP,
  PHONE_TALL,
  PHONE,
];

/**
 * The two cells where the two layouts are: the widest window and the phone baseline.
 *
 * A journey that varies text, copy or one control across layouts - rather than measuring the layout itself - iterates
 * this pair, so its list is still the declaration's and not a second copy of it.
 */
export const LAYOUT_PAIR: readonly ViewportSize[] = [DESKTOP, PHONE];

/**
 * The cell a spec is measured in when it sets no viewport: `playwright.config.ts` installs it.
 *
 * It is the first-screen laptop cell - the one `Desktop Chrome` already gives, so declaring it changes no spec's
 * layout and only turns an undeclared inheritance into a member of the population. It has to be a member: a spec that
 * sets nothing is measured in it, and a cell fifty-four specs sample cannot be one the declaration has never heard of.
 */
export const DEFAULT_VIEWPORT: ViewportSize = SMALL_LAPTOP;
