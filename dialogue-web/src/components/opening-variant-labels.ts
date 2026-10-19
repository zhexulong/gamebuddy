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
function openingVariantLabel(label: string, labels: OpeningVariantLabels): string {
  if (label === "Default") return labels.openingVariantDefault;
  const alternate = /^Alternate (\d+)$/u.exec(label);
  return alternate === null ? label : labels.openingVariantAlternate.replace("{{index}}", alternate[1]!);
}

/**
 * An opening's own name plus its position in the set it came from.
 *
 * The position says how many openings there are, so the name alone is enough to
 * tell the player which one they are looking at; a set the Host published no
 * label for leaves the position alone rather than inventing a name.
 */
export function openingVariantWords(
  variant: Readonly<{ label: string | null; index: number; count: number }>,
  labels: OpeningVariantLabels,
): string {
  const position = `${variant.index + 1}/${variant.count}`;
  return variant.label === null ? position : `${openingVariantLabel(variant.label, labels)} ${position}`;
}
