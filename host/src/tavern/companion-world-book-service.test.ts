import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { validateWorldBook, readWorldBook, worldBookMetadata, writeWorldBook, type WorldBook } from "../worldbook.js";
import { COMPANION_WORLD_BOOK_CONTENT_MAX_LENGTH } from "./browser-contract/index.js";
import {
  projectCompanionWorldBook,
  projectRenderedCompanionWorldBook,
  updateCompanionWorldBook,
} from "./companion-world-book-service.js";
import { macroTable } from "./macro-engine.js";

/**
 * The companion's own book is readable, body included.
 *
 * It used to be the opposite - `projectCompanionWorldBook` dropped the body on
 * purpose, on the reasoning that "a body is context the companion reads rather
 * than text the browser renders" - while the same panel let the player read and
 * edit this companion's voice directive, persona, scenario and greetings. An entry
 * whose trigger words are visible and whose text is not is a row the player can
 * deliberately reach and still cannot read, so the body is projected now. The
 * browser contract carries it bounded, and the composition seam renders the
 * card's macros before it leaves the Host.
 */
test("the companion's world book projection carries each entry's body", () => {
  const book: WorldBook = {
    schemaVersion: 1,
    revision: 1,
    entries: [
      {
        entryId: "entry-1",
        title: "温室",
        content: "{{char}}把温室的玻璃换成了新的。",
        scope: "companion",
        provenance: "card",
        tokenBudget: "small",
        constant: false,
        keys: ["温室", "玻璃房"],
      },
    ],
  } as unknown as WorldBook;

  const projection = projectCompanionWorldBook(book);
  assert.equal(projection.present, true);
  assert.equal(projection.entries.length, 1);
  const entry = projection.entries[0]!;
  // The body is carried **verbatim**: this layer is the durable read, so the
  // author's own `{{char}}` is still here. Rendering it is the composition seam's
  // job, and asserting the raw text here is what keeps that split honest - a
  // projection that rendered would have to know the run's macro table, which it
  // has no access to.
  assert.equal(entry.content, "{{char}}把温室的玻璃换成了新的。");
  assert.deepEqual(entry.keys, ["温室", "玻璃房"]);
  assert.equal(entry.constant, false);
  // …and the bound the browser contract enforces is the one this projection can
  // satisfy: an entry longer than it is a case the seam refuses by name, not one
  // the schema truncates.
  assert.ok(COMPANION_WORLD_BOOK_CONTENT_MAX_LENGTH > 0);
});

test("a companion with no world book projects absence, not an empty body list", () => {
  const projection = projectCompanionWorldBook(null);
  assert.equal(projection.present, false);
  assert.deepEqual(projection.entries, []);
});

// --- The edit (`companion.worldbook.update`) ---

/** The run's own macro table: the companion's real name and the player's own reference. */
const MACROS = macroTable({ char: "琥珀", user: "阿岚" });

/**
 * The reviewed card's own book: two entries, both of them carrying an authored macro, and
 * a third metadata fact per entry (a non-default provenance, token budget and always-on
 * flag) so an edit's carry-through is observable rather than assumed. A third entry is
 * appended by the removal test below.
 */
function cardBook(): WorldBook {
  return validateWorldBook({
    schemaVersion: 1,
    worldBookId: "worldbook_edit",
    revision: 3,
    alwaysOnPremise: "{{user}}和她一起打理农场。",
    scanDepth: 6,
    entries: [
      {
        entryId: "st-json-1",
        title: "温室",
        content: "{{user}}把温室的玻璃换成了新的。",
        scope: "setting",
        provenance: "st-card-import",
        tokenBudget: "medium",
        keys: ["温室", "玻璃房"],
      },
      {
        entryId: "st-json-2",
        title: "洒水器",
        content: "{{char}}修好了洒水器，管子接在井边。",
        scope: "setting",
        provenance: "st-card-import",
        tokenBudget: "medium",
        constant: true,
        keys: ["洒水器", "灌溉"],
      },
    ],
  });
}

/** A temp root holding one durable book (or raw bytes, or nothing at all). */
async function bookRoot(book: WorldBook | null, raw?: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "gamebuddy-world-book-edit-"));
  if (raw !== undefined) await writeFile(join(root, "worldbook.json"), raw, "utf8");
  else if (book !== null) await writeWorldBook(join(root, "worldbook.json"), book);
  return root;
}

/** The calls a refresh spy saw, so the metadata handed to the store is asserted, not assumed. */
type RefreshCall = Readonly<{
  previous: { revision: number; canonicalHash: string };
  next: { revision: number; canonicalHash: string };
}>;

test("an edit stores the player's own words verbatim and leaves an untouched row's authored text alone", async () => {
  const root = await bookRoot(cardBook());
  try {
    const path = join(root, "worldbook.json");
    const read = await projectRenderedCompanionWorldBook(root, MACROS);
    assert.equal(read.present, true);
    // The read the browser works from: the durable revision, and both bodies RENDERED.
    assert.equal(read.revision, 3);
    assert.deepEqual(
      read.entries.map((entry) => entry.content),
      ["阿岚把温室的玻璃换成了新的。", "琥珀修好了洒水器，管子接在井边。"],
    );

    const calls: RefreshCall[] = [];
    const updated = await updateCompanionWorldBook({
      path,
      containmentRoot: root,
      macros: MACROS,
      expectedRevision: 3,
      entries: [
        // The player rewrites this row with a macro of her OWN, which is her text.
        { title: "温室", keys: ["温室", "玻璃房"], constant: false, content: "{{user}}说这扇玻璃是她挑的。" },
        // …and sends this row back exactly as she read it.
        { title: "洒水器", keys: ["洒水器", "灌溉"], constant: true, content: "琥珀修好了洒水器，管子接在井边。" },
      ],
      refreshBindings: async (previous, next) => {
        calls.push({ previous, next });
        return 2;
      },
    });

    // The reply is the Host's own re-projection, macros rendered.
    assert.equal(updated.revision, 4);
    assert.deepEqual(
      updated.entries.map((entry) => entry.content),
      ["阿岚说这扇玻璃是她挑的。", "琥珀修好了洒水器，管子接在井边。"],
    );

    const durable = await readWorldBook(path);
    assert.equal(durable.revision, 4);
    // The player's own words, stored verbatim - her `{{user}}` is the author's text now.
    assert.equal(durable.entries[0]!.content, "{{user}}说这扇玻璃是她挑的。");
    // …and the row she did not touch still carries the CARD's own `{{char}}`. A save that
    // stored the rendered text back would bake one run's rendering of the author's macro
    // into her book, which is the whole reason the match exists.
    assert.equal(durable.entries[1]!.content, "{{char}}修好了洒水器，管子接在井边。");
    // The metadata the projection never carried rides with the row it belonged to.
    assert.equal(durable.entries[1]!.provenance, "st-card-import");
    assert.equal(durable.entries[1]!.tokenBudget, "medium");
    assert.equal(durable.entries[1]!.constant, true);
    assert.equal(durable.entries[1]!.scope, "setting");
    // A row the player rewrote is hers: authored, the companion's own setting scope, smallest budget.
    assert.equal(durable.entries[0]!.provenance, "authored");
    assert.equal(durable.entries[0]!.tokenBudget, "small");
    assert.equal(durable.entries[0]!.scope, "setting");
    // The members the projection does not carry are not dropped by an edit about entries.
    assert.equal(durable.alwaysOnPremise, "{{user}}和她一起打理农场。");
    assert.equal(durable.scanDepth, 6);
    assert.equal(durable.worldBookId, "worldbook_edit");
    // Entry ids are positional and re-minted, like the greeting set's variant ids.
    assert.deepEqual(
      durable.entries.map((entry) => entry.entryId),
      ["wb-entry-1", "wb-entry-2"],
    );

    // The store is handed the metadata of the book that WAS, and of the book that now is.
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.previous.revision, 3);
    assert.equal(calls[0]!.previous.canonicalHash, worldBookMetadata(cardBook()).canonicalHash);
    assert.equal(calls[0]!.next.revision, 4);
    assert.equal(calls[0]!.next.canonicalHash, worldBookMetadata(durable).canonicalHash);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("removing a row keeps every remaining row's own authored text, whatever position it moves to", async () => {
  const root = await bookRoot(
    validateWorldBook({
      schemaVersion: 1,
      worldBookId: "worldbook_removal",
      revision: 1,
      alwaysOnPremise: "",
      entries: [
        {
          entryId: "a",
          title: "甲",
          content: "{{char}}一",
          scope: "setting",
          provenance: "authored",
          tokenBudget: "small",
        },
        {
          entryId: "b",
          title: "乙",
          content: "{{user}}二",
          scope: "setting",
          provenance: "authored",
          tokenBudget: "small",
        },
        { entryId: "c", title: "丙", content: "三", scope: "setting", provenance: "authored", tokenBudget: "small" },
      ],
    }),
  );
  try {
    const path = join(root, "worldbook.json");
    const read = await projectRenderedCompanionWorldBook(root, MACROS);
    // The player removes the FIRST row, so every remaining row moves one position up: a
    // positional match would hand 乙 the text of 甲 and 丙 the text of 乙.
    await updateCompanionWorldBook({
      path,
      containmentRoot: root,
      macros: MACROS,
      expectedRevision: 1,
      entries: [read.entries[1]!, read.entries[2]!],
      refreshBindings: async () => 0,
    });
    const durable = await readWorldBook(path);
    assert.deepEqual(
      durable.entries.map((entry) => [entry.title, entry.content]),
      [
        ["乙", "{{user}}二"],
        ["丙", "三"],
      ],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a stale revision is refused by name, and the durable book is untouched", async () => {
  const root = await bookRoot(cardBook());
  try {
    const path = join(root, "worldbook.json");
    const before = await readFile(path, "utf8");
    const calls: RefreshCall[] = [];
    await assert.rejects(
      updateCompanionWorldBook({
        path,
        containmentRoot: root,
        macros: MACROS,
        expectedRevision: 2,
        entries: [{ title: "温室", keys: [], constant: false, content: "改过了。" }],
        refreshBindings: async (previous, next) => {
          calls.push({ previous, next });
          return 0;
        },
      }),
      /companion_world_book_conflict/,
    );
    assert.equal(await readFile(path, "utf8"), before, "a refused edit writes nothing at all");
    assert.deepEqual(calls, [], "and it never reaches the threads that pin the book");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an entry the worldbook validator will not keep is refused by name", async () => {
  const root = await bookRoot(cardBook());
  try {
    const path = join(root, "worldbook.json");
    const before = await readFile(path, "utf8");
    // `worldbook.ts` requires a non-empty title and a non-empty body; the browser sent
    // neither, which is the one thing this route must not accept and silently store.
    await assert.rejects(
      updateCompanionWorldBook({
        path,
        containmentRoot: root,
        macros: MACROS,
        expectedRevision: 3,
        entries: [{ title: "", keys: ["温室"], constant: false, content: "" }],
        refreshBindings: async () => 0,
      }),
      /companion_world_book_invalid/,
    );
    assert.equal(await readFile(path, "utf8"), before);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("no book at all and an unreadable book are each their own refusal", async () => {
  const absent = await bookRoot(null);
  const broken = await bookRoot(null, "{ not json");
  try {
    for (const [root, code] of [
      [absent, /companion_world_book_absent/],
      [broken, /companion_world_book_unreadable/],
    ] as const) {
      await assert.rejects(
        updateCompanionWorldBook({
          path: join(root, "worldbook.json"),
          containmentRoot: root,
          macros: MACROS,
          expectedRevision: 1,
          entries: [{ title: "温室", keys: [], constant: false, content: "正文。" }],
          refreshBindings: async () => 0,
        }),
        code,
      );
    }
    // Nothing was invented for the companion with no book.
    await assert.rejects(readFile(join(absent, "worldbook.json"), "utf8"), /ENOENT/);
  } finally {
    await rm(absent, { recursive: true, force: true });
    await rm(broken, { recursive: true, force: true });
  }
});

test("a refresh the durable store refuses leaves the book exactly as it was", async () => {
  const root = await bookRoot(cardBook());
  try {
    const path = join(root, "worldbook.json");
    const before = await readFile(path, "utf8");
    await assert.rejects(
      updateCompanionWorldBook({
        path,
        containmentRoot: root,
        macros: MACROS,
        expectedRevision: 3,
        entries: [{ title: "温室", keys: [], constant: false, content: "改过了。" }],
        refreshBindings: async () => {
          throw new Error("chat_thread_store_closed");
        },
      }),
      // The refusal is the service's own named code, not the store's raw message: what the
      // route answers is a bounded problem, and the store's internal vocabulary never leaves it.
      /companion_world_book_binding_unavailable/,
    );
    assert.equal(
      await readFile(path, "utf8"),
      before,
      "a pin that could not be carried is not left beside a book that no longer exists",
    );
    assert.equal((await readWorldBook(path)).revision, 3);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a restoring write that fails too reports the one state a retry cannot fix", async () => {
  const root = await bookRoot(cardBook());
  try {
    const path = join(root, "worldbook.json");
    await assert.rejects(
      updateCompanionWorldBook({
        path,
        containmentRoot: root,
        macros: MACROS,
        expectedRevision: 3,
        entries: [{ title: "温室", keys: [], constant: false, content: "改过了。" }],
        refreshBindings: async () => {
          // The pin refresh failed AND the restoring write cannot land: the book is the
          // new one while the threads that pinned the old revision still pin it.
          await rm(root, { recursive: true, force: true });
          throw new Error("chat_thread_store_closed");
        },
      }),
      /companion_world_book_binding_partial/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an edited body over the browser's bound is refused by name rather than truncated", async () => {
  const root = await bookRoot(cardBook());
  try {
    // The durable file keeps the author's text; an entry whose RENDERED form is longer than
    // the browser's own bound cannot be read back, so it cannot be edited either.
    const root2 = await mkdtemp(join(tmpdir(), "gamebuddy-world-book-long-"));
    await writeWorldBook(join(root2, "worldbook.json"), {
      ...cardBook(),
      entries: [
        {
          entryId: "long",
          title: "长正文",
          content: "x".repeat(COMPANION_WORLD_BOOK_CONTENT_MAX_LENGTH + 1),
          scope: "setting",
          provenance: "authored",
          tokenBudget: "small",
        },
      ],
    });
    try {
      await assert.rejects(projectRenderedCompanionWorldBook(root2, MACROS), /companion_world_book_entry_too_long/);
    } finally {
      await rm(root2, { recursive: true, force: true });
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
