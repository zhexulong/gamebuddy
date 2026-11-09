import type { PublicWorldInfoProjection } from "./world-info-management.js";

/**
 * One managed library item as an external lorebook file - the exact shape `importTavernLorebook`
 * reads back (`tavern-lorebook-importer.ts`).
 *
 * THE SHAPE, and why this one
 *
 * The importer accepts a flat standalone lorebook (`name` + `description` + `entries`), the same
 * file wrapped in a card's `character_book`, and `entries` either as an ordered array or as an
 * object keyed by uid. The canonical form written here is the FLAT one with `entries` as an array
 * in the item's own order, because it is the one shape that means the same thing in every reader:
 * a card-wrapped file claims to be a character, and an object-keyed map would put the order the
 * library stores (which decides where an entry lands in the assembled prompt) behind a map that
 * every exporter renumbers differently.
 *
 * Each entry is written with SillyTavern's own field names - `comment` for the entry's name,
 * `content` for its text, `keys`/`secondary_keys`, `selectiveLogic`, `constant`, `enabled` and
 * `order` - so a file exported here opens in SillyTavern unchanged, and so the importer's own
 * reader picks every fact back up. `order` is the entry's index: the library's sequence IS its
 * declared order (`inDeclaredOrder`), and writing it back keeps a re-import in the same sequence.
 *
 * A field the entry does not carry is NOT written. An entry with no `selectiveLogic` and one that
 * names AND ANY are different facts to the per-turn selector (`deriveVolatileWorldInfoSources`),
 * so writing a default would silently rewrite the author's rule on a round trip.
 *
 * Text fidelity: the importer owns the normalization (`cleanLorebookText`), so a re-import
 * normalizes rather than silently mutating - stored text already went through it on the way in,
 * and an entry authored in the editor arrives already trimmed and control-character free.
 */
export function exportTavernLorebook(
  projection: PublicWorldInfoProjection,
): Readonly<{ entryCount: number; fileName: string; document: string }> {
  const entries = projection.entries.map((entry, index) =>
    Object.freeze({
      uid: index,
      comment: entry.publicTitle,
      content: entry.summary,
      order: index,
      scope: entry.scope,
      constant: entry.constant === true,
      enabled: entry.enabled !== false,
      ...(entry.keys === undefined ? {} : { keys: Object.freeze([...entry.keys]) }),
      ...(entry.secondaryKeys === undefined ? {} : { secondary_keys: Object.freeze([...entry.secondaryKeys]) }),
      ...(entry.selectiveLogic === undefined ? {} : { selectiveLogic: entry.selectiveLogic }),
    }),
  );
  return Object.freeze({
    entryCount: entries.length,
    fileName: exportedFileName(projection.publicTitle),
    document: JSON.stringify(
      Object.freeze({ name: projection.publicTitle, description: projection.summary, entries }),
      null,
      2,
    ),
  });
}

/**
 * The name the saved file carries: the item's own title, with the characters no filesystem accepts
 * (path separators, the Windows-reserved set, control characters) folded to a space.
 *
 * The Host names the file for the same reason it names the card export's and the backup's: a name
 * the browser invented would be a second rule for the same file, and the player would get a
 * different one per surface. A title with nothing usable left saves as `world-info.json`.
 */
function exportedFileName(publicTitle: string): string {
  const cleaned = publicTitle
    .replace(/[\\/:*?"<>|\u0000-\u001f\u007f-\u009f]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, 80);
  return `${cleaned.length > 0 ? cleaned : "world-info"}.json`;
}
