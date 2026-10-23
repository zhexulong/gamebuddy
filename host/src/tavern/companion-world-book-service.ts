import { existsSync } from "node:fs";
import { join } from "node:path";
import { withPathLock } from "../path-lock.js";
import {
  readWorldBook,
  validateWorldBook,
  worldBookMetadata,
  writeWorldBook,
  type WorldBook,
  type WorldBookEntry,
  type WorldBookMetadata,
} from "../worldbook.js";
import {
  COMPANION_WORLD_BOOK_CONTENT_MAX_LENGTH,
  type CompanionWorldBookEntryV1,
  type CompanionWorldBookV1,
  TAVERN_BROWSER_API_VERSION,
  type UpdateCompanionWorldBookCommandV1,
} from "./browser-contract/index.js";
import { type MacroTable, renderMacros } from "./macro-engine.js";

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
 * run's macro table at the read seam, exactly as the scenario projection does, and
 * never by hiding it.
 *
 * `revision` is the durable book's own revision, and it belongs on the wire because
 * editing the book is a CAS against it: the book is one file replaced whole, so an
 * edit that did not name the revision the browser read would silently overwrite an
 * edit it never saw. That capability is served - `updateCompanionWorldBook` below -
 * so this projection is no longer read-only.
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
  /** The durable revision, null in exactly the one case `present` is false. */
  revision: number | null;
  entries: readonly CompanionWorldBookEntryProjection[];
}>;

/** The same per-entry trigger-word bound the persisted entry itself carries. */
const MAX_PROJECTED_KEYS = 16;

export function projectCompanionWorldBook(book: WorldBook | null): CompanionWorldBookProjection {
  if (book === null) return Object.freeze({ present: false, revision: null, entries: Object.freeze([]) });
  return Object.freeze({
    present: true,
    revision: book.revision,
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
 * The companion's own world book, as the browser reads it on the wire: the
 * durable book read from the companion's own runtime root, every authored body
 * rendered through the run's macro table and bounded.
 *
 * The bodies carry the author's `{{user}}`/`{{char}}` macros verbatim - they are
 * the durable, authored content - so the rendering belongs at this read seam,
 * exactly as the scenario projection renders its own text. Rendering happens
 * before the bound is applied, so a macro that straddles it is resolved whole
 * instead of being cut into a stray `{{`, and a body that renders past the bound
 * is refused by name rather than truncated (a shortened body would read as the
 * author's own text).
 *
 * One function, because the mounted read (`companion.worldbook.read`), the edit's
 * own reply (`companion.worldbook.update`) and the character inspector
 * (`companion.profile.read`) serve the same fact: two projections of one fact would
 * bound it differently.
 */
export async function projectRenderedCompanionWorldBook(
  runtimeCwd: string,
  macros: MacroTable,
): Promise<CompanionWorldBookV1> {
  const book = await readDurableCompanionWorldBook(runtimeCwd);
  if (book === null) return absentWorldBook();
  return renderWorldBook(book, macros);
}

/**
 * Reads the companion's own book from its runtime root. A companion need not have
 * one - a directly-named companion has no card - and that is ordinary, so a
 * missing file projects `present: false` rather than an error. A file that is
 * present but unreadable fails closed with one bounded code instead of silently
 * reporting an empty book, so a corrupt book never reads as a book with no entries.
 */
export async function readCompanionWorldBook(runtimeCwd: string): Promise<CompanionWorldBookProjection> {
  return projectCompanionWorldBook(await readDurableCompanionWorldBook(runtimeCwd));
}

/** The companion's own book, or null when she has none. A present-but-unreadable book fails closed. */
async function readDurableCompanionWorldBook(runtimeCwd: string): Promise<WorldBook | null> {
  const path = join(runtimeCwd, "worldbook.json");
  if (!existsSync(path)) return null;
  try {
    return await readWorldBook(path);
  } catch {
    throw new Error("companion_world_book_unreadable");
  }
}

/** The wire shape for a companion who has no book at all: the surface then renders no block. */
function absentWorldBook(): CompanionWorldBookV1 {
  return Object.freeze({ apiVersion: TAVERN_BROWSER_API_VERSION, present: false, revision: null, entries: [] });
}

/**
 * The wire projection of one durable book: every body rendered through the run's macro
 * table and bounded, the durable revision carried so an edit can CAS on it.
 *
 * `keys` and `constant` are normalized from the durable entry's own optional fields:
 * the persisted entry may carry neither (a keyless, not-always-on entry is the ordinary
 * import shape), while the published schema requires both present.
 */
function renderWorldBook(book: WorldBook, macros: MacroTable): CompanionWorldBookV1 {
  const entries: readonly CompanionWorldBookEntryV1[] = book.entries.map((entry) => {
    const content = renderMacros(entry.content, macros);
    if (content.length > COMPANION_WORLD_BOOK_CONTENT_MAX_LENGTH)
      throw new Error("companion_world_book_entry_too_long");
    return Object.freeze({
      title: entry.title,
      keys: Object.freeze([...(entry.keys ?? [])]),
      constant: entry.constant === true,
      content,
    });
  });
  return Object.freeze({
    apiVersion: TAVERN_BROWSER_API_VERSION,
    present: true,
    revision: book.revision,
    entries: Object.freeze(entries),
  });
}

/** Carries one edited book to the threads pinned to the revision it replaced. */
export type CompanionWorldBookBindingRefresh = (
  previous: WorldBookMetadata,
  next: WorldBookMetadata,
) => Promise<number>;

/**
 * One player edit of her own world book: the whole entry list she wants, CASed on the
 * revision she read.
 *
 * The write, in this order:
 *  1. read the durable book inside the book's own path lock;
 *  2. refuse unless its `revision` is the one the browser sent;
 *  3. assemble and validate the next book through `worldbook.ts`'s own rules;
 *  4. write it through `writeWorldBook` - the one writer, which stamps the canonical
 *     hash of the bytes it actually persisted;
 *  5. carry the new metadata to every Chat thread pinned to the old one, in one store
 *     transaction (`refreshCompanionWorldBookBinding`).
 *
 * Steps 4 and 5 are two authorities - a file and SQLite rows - so the pair cannot be one
 * atomic act, and the order is the one that fails safe: a pin is only ever moved onto a
 * book that is already on disk. A pin refresh that fails would leave every existing Chat
 * pinned to a revision that no longer exists, and the next mount of any of them refuses
 * construction with the drift code - so the file is put back exactly as it was and the
 * edit is refused (`companion_world_book_binding_unavailable`). The player sees a save
 * that did not happen, which is the truth, and nothing is stranded. If the restoring
 * write itself fails the drift state stands, and the refusal says so by name
 * (`companion_world_book_binding_partial`) rather than reporting a clean failure, so the
 * one state a retry cannot fix is never the state nobody was told about.
 *
 * The entry bodies that arrive are the RENDERED ones, because that is what the read
 * projected and what the player edited. A row keeps the entry it came from by that entry's
 * own identity (`authoredEntries`), and that entry brings back the metadata the projection
 * never showed - scope, provenance, token budget, the card's selection gate, any
 * integration/save/world binding. A row whose body still renders to exactly what that entry
 * renders keeps the AUTHORED body too, macros and all: a save must not rewrite the author's
 * text with one run's rendering of it. A row the player rewrote says her words verbatim,
 * rendered on the next read, while it remains the same entry to select on. A row nobody
 * claimed is one the player wrote: hers, with the companion's own setting scope, `authored`
 * provenance and the smallest budget.
 *
 * Editing is invisible to a Chat that is already mounted: the runtime publishes its
 * authored catalog once, at mount, so a running conversation keeps the background it
 * loaded and picks this change up when it mounts again. Two facts follow, and both are
 * said in the panel's own words: a turn in flight is never interrupted, and a keyword
 * that turn already selected still reaches the model with the text the entry had at that
 * mount.
 */
export async function updateCompanionWorldBook(
  input: Readonly<{
    path: string;
    containmentRoot: string;
    macros: MacroTable;
    expectedRevision: number;
    entries: UpdateCompanionWorldBookCommandV1["entries"];
    refreshBindings: CompanionWorldBookBindingRefresh;
  }>,
): Promise<CompanionWorldBookV1> {
  return await withPathLock(
    input.path,
    async () => {
      // A companion need not have a book: a directly-named companion has no card. There
      // is nothing to edit then, and that is a different fact from an unreadable book.
      if (!existsSync(input.path)) throw new Error("companion_world_book_absent");
      let current: WorldBook;
      try {
        current = await readWorldBook(input.path);
      } catch {
        throw new Error("companion_world_book_unreadable");
      }
      if (current.revision !== input.expectedRevision) throw new Error("companion_world_book_conflict");
      let next: WorldBook;
      try {
        next = validateWorldBook({
          schemaVersion: 1,
          worldBookId: current.worldBookId,
          revision: current.revision + 1,
          // The premise and the declared scan depth are not projected, so they are not
          // editable here and a mutation about entries must not silently drop them.
          alwaysOnPremise: current.alwaysOnPremise,
          ...(current.scanDepth === undefined ? {} : { scanDepth: current.scanDepth }),
          entries: authoredEntries(current, input.entries, input.macros),
        });
      } catch {
        throw new Error("companion_world_book_invalid");
      }
      await writeWorldBook(input.path, next);
      try {
        await input.refreshBindings(worldBookMetadata(current), worldBookMetadata(next));
      } catch {
        try {
          await writeWorldBook(input.path, current);
        } catch {
          throw new Error("companion_world_book_binding_partial");
        }
        throw new Error("companion_world_book_binding_unavailable");
      }
      return renderWorldBook(next, input.macros);
    },
    { containmentRoot: input.containmentRoot },
  );
}

/** One row the browser sent back: the projection's own fields, its body already rendered. */
type EditorRow = UpdateCompanionWorldBookCommandV1["entries"][number];

/**
 * The durable entry list one edit produces.
 *
 * A row keeps the entry it came from by that entry's own identity, never by its position:
 * removing a row shifts every row after it, so a positional match would hand one entry's
 * authored text and its card's selection gate to its neighbour.
 *
 * Identity is claimed in three passes over ONE claimed set, strongest evidence first: a row
 * whose title AND rendered body both still name one entry; then, for the rows no smaller
 * pass claimed, by title alone - the entry's public name and the identity the managed
 * library's own editor matches by (`entriesCarryingSelection` in `world-info-management.ts`);
 * then by rendered body alone, which is how a row the player RENAMED stays attached to the
 * entry it renamed instead of reading as a new one. The passes are ordered rather than tried
 * per row, so a title never resolves an entry that a row still carrying BOTH its title and
 * its text would otherwise have owned: a player who renames one row to another's name does
 * not move that entry's gate onto her row. The set is shared by all three passes, so an
 * entry one row claimed is never available to another under a weaker match.
 *
 * Every pass is first-unclaimed, so two rows that look alike resolve to their own entries in
 * order, and a row no pass claimed is one the player added. Fields the command can state
 * (`title`, `keys`, `constant`, its own body) are always the row's - the carry never
 * overrides them - and everything the projection never showed rides with the entry: scope,
 * provenance, token budget and the card's selection gate. That gate describes WHEN an entry
 * fires, not what it says, so a body rewrite keeps it: the player has no field for it, and
 * dropping it would rewrite the author's "only in this mood" rule into "any of these words".
 *
 * The entry id is positional and re-minted on every rewrite, exactly as the greeting set
 * mints its variant ids on every rewrite: the browser is never handed an id, no durable
 * pointer names one, and a position-derived id keeps the file readable without inventing
 * an identity the wire cannot carry.
 */
function authoredEntries(
  current: WorldBook,
  incoming: readonly EditorRow[],
  macros: MacroTable,
): readonly WorldBookEntry[] {
  const rendered: readonly string[] = current.entries.map((entry) => renderMacros(entry.content, macros));
  const claimed = new Set<number>();
  // The entry each row claims, -1 while no pass has claimed one for it.
  const matched: number[] = incoming.map(() => -1);
  const named = (row: EditorRow, entry: number): boolean => current.entries[entry]!.title === row.title;
  const saysSame = (row: EditorRow, entry: number): boolean => rendered[entry] === row.content;
  // One pass: every row still unclaimed takes the first unclaimed entry the evidence names. An
  // entry once claimed is gone for the passes after it, so the three passes share one identity
  // space rather than each resolving the row order on its own.
  const claimPass = (evidence: (row: EditorRow, entry: number) => boolean): void => {
    for (const [row, entry] of incoming.entries()) {
      if (matched[row] !== -1) continue;
      const found = current.entries.findIndex((_, candidate) => !claimed.has(candidate) && evidence(entry, candidate));
      if (found === -1) continue;
      claimed.add(found);
      matched[row] = found;
    }
  };
  claimPass((row, entry) => named(row, entry) && saysSame(row, entry));
  claimPass(named);
  claimPass(saysSame);
  return incoming.map((entry, index) => {
    const keys = Object.freeze([...entry.keys]);
    const source = matched[index]!;
    const carried = source === -1 ? undefined : current.entries[source];
    return Object.freeze({
      entryId: `wb-entry-${index + 1}`,
      title: entry.title,
      // The row's own text, unless it still says exactly what that entry renders to: then it
      // is the AUTHORED body the projection could not carry, and storing the rendered text
      // instead would bake one run's rendering of the author's macros into her book.
      content: carried !== undefined && rendered[source] === entry.content ? carried.content : entry.content,
      scope: carried?.scope ?? ("setting" as const),
      provenance: carried?.provenance ?? ("authored" as const),
      tokenBudget: carried?.tokenBudget ?? ("small" as const),
      ...(entry.constant ? { constant: true } : {}),
      // The worldbook validator refuses an empty key list, so "no trigger words" is an
      // absent field - the same shape the card import writes for a keyless entry.
      ...(keys.length === 0 ? {} : { keys }),
      // The card's selection gate is metadata the projection never showed, so the entry it
      // belongs to keeps it: an edit that dropped it would rewrite the author's rule into
      // "any of these words".
      ...(carried?.secondaryKeys === undefined ? {} : { secondaryKeys: carried.secondaryKeys }),
      ...(carried?.selectiveLogic === undefined ? {} : { selectiveLogic: carried.selectiveLogic }),
      ...(carried?.integrationId === undefined ? {} : { integrationId: carried.integrationId }),
      ...(carried?.saveId === undefined ? {} : { saveId: carried.saveId }),
      ...(carried?.worldId === undefined ? {} : { worldId: carried.worldId }),
    });
  });
}
