// The row an edit to the companion's own world book sends back.
//
// `companion.worldbook.read` projects each entry as `{title, keys, constant, enabled, content}`
// (`CompanionWorldBookEntryV1Schema`, host/src/tavern/browser-contract/index.ts), and the update route
// validates the body against that same schema before the service ever compares revisions
// (host/src/tavern-management-dialogue-web.ts:1942) - an entry that omits one member is `400
// invalid_request`, which is not a refusal about anything the driver was measuring.
//
// That is how `q-companion-world-book.cjs` died: it built its SECOND write - the one that exists to move
// the book's revision while an editor pins the old one - from a hand-copied `{title, keys, constant,
// content}`. `f94d31c6` had made `enabled` required, so the write was refused 400, the book did not move,
// the editor's own save returned 200 and the panel closed, and the driver then sat on a
// `[data-companion-world-book-cancel]` that no longer existed.
//
// So a row is built by SPREADING the projection the Host sent: nothing can be dropped, because nothing is
// re-listed. `WORLD_BOOK_ENTRY_FIELDS` is the one place the members are named; `editRow` refuses a
// projection it does not declare, and `world-book-entry.test.mjs` checks the list against the contract's
// own schema, so the next required member fails in milliseconds instead of twenty minutes into a run.

/** The members of `CompanionWorldBookEntryV1Schema`, as an edit row carries them. */
const WORLD_BOOK_ENTRY_FIELDS = Object.freeze(["constant", "content", "enabled", "keys", "title"]);

/**
 * One edit row: the projected entry, with the field this edit changes replaced.
 *
 * `content` is optional - a row the player did not touch is sent back exactly as it was read. A
 * projection carrying a member this kit does not declare is refused by name rather than carried into a
 * write: the driver's own readings (`entryReading`) and its assertions are written against the declared
 * set, so an undeclared member is the driver being written against a contract that has moved.
 */
function editRow(entry, content) {
  const carried = Object.keys(entry).sort();
  const declared = [...WORLD_BOOK_ENTRY_FIELDS].sort();
  if (carried.join(",") !== declared.join(","))
    throw new Error(
      `a world-book projection carries [${carried.join(", ")}] while this kit's edit row declares ` +
        `[${declared.join(", ")}]: CompanionWorldBookEntryV1Schema ` +
        `(host/src/tavern/browser-contract/index.ts) and WORLD_BOOK_ENTRY_FIELDS ` +
        `(tools/live-run/frontend/capture/world-book-entry.cjs) must name the same members`,
    );
  return { ...entry, content: content === undefined ? entry.content : content };
}

/** What a driver reports about one projected entry: what it says, what fires it, and how much of it. */
function entryReading(entry) {
  return {
    title: entry.title,
    keys: entry.keys,
    constant: entry.constant,
    enabled: entry.enabled,
    chars: (entry.content ?? "").length,
    head: (entry.content ?? "").slice(0, 40),
  };
}

module.exports = { WORLD_BOOK_ENTRY_FIELDS, editRow, entryReading };
