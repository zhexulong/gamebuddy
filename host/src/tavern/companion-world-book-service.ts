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
 * `keys` and `content` are both projected, and the body's inclusion is a decision
 * that was reversed deliberately. It used to say: "the body is NOT projected:
 * `companion_worldbook_catalog` already omits bodies, and a body is context the
 * companion reads rather than text the browser paints." That reasoning does not
 * survive what the surface already does - the same panel lets the player read and
 * edit this companion's voice directive, persona, scenario and greetings - and an
 * entry whose trigger words are visible but whose text is not is a row the player
 * can deliberately reach and still cannot read. The `{{user}}`/`{{char}}` concern
 * the old comment was really about is answered by rendering the body through the
 * run's macro table at the read seam (`desktop-presentation-admission-owner.ts`),
 * exactly as the scenario projection does, and never by hiding it.
 *
 * Editing a body or a trigger word is a planned capability (a `PUT` with the same
 * `expectedRevision` CAS the other companion mutations use) and is not served yet:
 * this projection is read-only, and that asymmetry is deliberate, not forgotten.
 */
export type CompanionWorldBookEntryProjection = Readonly<{
  title: string;
  keys: readonly string[];
  /** Always-on background, carried regardless of what is said, so it has no trigger words. */
  constant: boolean;
  /**
   * The entry's authored body, verbatim from the durable book. It is rendered
   * through the run's macro table on the way to the browser, so what the player
   * reads carries no `{{placeholder}}`; the durable file keeps the author's own
   * text.
   */
  content: string;
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
          content: entry.content,
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
