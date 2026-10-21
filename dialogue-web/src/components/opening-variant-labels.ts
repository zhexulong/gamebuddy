/**
 * The Host's greeting-variant vocabulary in the player's words.
 *
 * A greeting set's entry names are the Host's structural spelling - `Default`,
 * `Alternate 1` (the card's own 1-based order, `buildGreetingVariants` in
 * `host/src/tavern/new-companion-service.ts`) - or an authored label the card or
 * the player wrote. They are translated through the catalogue where they are
 * structural and shown as published where they are not, so the opening bubble's
 * pager and the New Chat picker read an opening the same way.
 */

export type OpeningVariantLabels = Readonly<{ openingVariantDefault: string; openingVariantAlternate: string }>;

/** The Host's `Default` / `Alternate N` in player words; any other label as published. */
function translatedLabel(label: string, labels: OpeningVariantLabels): string {
  if (label === "Default") return labels.openingVariantDefault;
  const alternate = /^Alternate (\d+)$/u.exec(label);
  return alternate === null ? label : labels.openingVariantAlternate.replace("{{index}}", alternate[1]!);
}

/** The opening's position in the set it came from: `2/3`. */
function position(variant: Readonly<{ index: number; count: number }>): string {
  return `${variant.index + 1}/${variant.count}`;
}

/**
 * An opening's own name: the label the Host published, in the player's words, or
 * the bare position when it published nothing rather than a name invented here.
 *
 * The name is what a chooser row reads, so it never carries the position: the
 * position belongs to the strip under the opening bubble, and composing both put
 * the same row at `Default 1/3` and `备用 1 2/3` - one opening named twice, its
 * place read as part of its name.
 */
export function openingVariantName(
  variant: Readonly<{ label: string | null; index: number; count: number }>,
  labels: OpeningVariantLabels,
): string {
  return variant.label === null ? position(variant) : translatedLabel(variant.label, labels);
}

/**
 * The opening bubble's pager: the opening's name and its position beside it, as
 * Tavern's own `‹ Alternate 1 2/3 ›` reads. Here the two are distinct facts - the
 * name is the card's own order among its alternates, the position is the place in
 * the whole set - and the pair is what the player swiping is choosing between.
 */
export function openingVariantWords(
  variant: Readonly<{ label: string | null; index: number; count: number }>,
  labels: OpeningVariantLabels,
): string {
  return `${openingVariantName(variant, labels)} ${position(variant)}`;
}
