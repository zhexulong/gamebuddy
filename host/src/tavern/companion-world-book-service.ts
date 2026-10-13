import { existsSync } from "node:fs";
import { join } from "node:path";
import { readWorldBook, type WorldBook } from "../worldbook.js";

/**
 * The companion's OWN world book, as the browser may see it.
 *
 * This is the reviewed card's `character_book`, persisted by the import at
 * `<runtimeCwd>/worldbook.json` (`new-companion-service.ts`), and it is a
 * different thing from the managed World Info library a conversation can attach
 * (`world-info.read`). The surface that reads only the library therefore said
 * "no world book is available" beside a companion that demonstrably has one.
 *
 * The body is NOT projected: `companion_worldbook_catalog` already omits bodies,
 * and a body is context the companion reads rather than text the browser paints.
 * What the player cannot otherwise find out is that the entry exists and which of
 * their own words reaches it - `keys` are the card's own trigger words, and
 * per-turn selection matches them against what the player said, so an entry whose
 * keys are invisible is an entry the player cannot deliberately reach.
 */
export type CompanionWorldBookEntryProjection = Readonly<{
  title: string;
  keys: readonly string[];
  /** Always-on background, carried regardless of what is said, so it has no trigger words. */
  constant: boolean;
}>;
export type CompanionWorldBookProjection = Readonly<{
  /** False when the companion has no book at all - the surface then renders no block. */
  present: boolean;
  entries: readonly CompanionWorldBookEntryProjection[];
}>;

/** The same per-entry trigger-word bound the persisted entry itself carries. */
const MAX_PROJECTED_KEYS = 16;

export function projectCompanionWorldBook(book: WorldBook | null): CompanionWorldBookProjection {
  if (book === null) return Object.freeze({ present: false, entries: Object.freeze([]) });
  return Object.freeze({
    present: true,
    entries: Object.freeze(
      book.entries.map((entry) =>
        Object.freeze({
          title: entry.title,
          keys: Object.freeze((entry.keys ?? []).slice(0, MAX_PROJECTED_KEYS)),
          constant: entry.constant === true,
        }),
      ),
    ),
  });
}

/**
 * Reads the companion's own book from its runtime root. A companion need not have
 * one - a directly-named companion has no card - and that is ordinary, so a
 * missing file projects `present: false` rather than an error. A file that is
 * present but unreadable fails closed with one bounded code instead of silently
 * reporting an empty book, so a corrupt book never reads as a book with no entries.
 */
export async function readCompanionWorldBook(runtimeCwd: string): Promise<CompanionWorldBookProjection> {
  const path = join(runtimeCwd, "worldbook.json");
  if (!existsSync(path)) return projectCompanionWorldBook(null);
  let book: WorldBook;
  try {
    book = await readWorldBook(path);
  } catch {
    throw new Error("companion_world_book_unreadable");
  }
  return projectCompanionWorldBook(book);
}
