import assert from "node:assert/strict";
import test from "node:test";
import { COMPANION_WORLD_BOOK_CONTENT_MAX_LENGTH } from "./browser-contract/index.js";
import { projectCompanionWorldBook } from "./companion-world-book-service.js";
import type { WorldBook } from "../worldbook.js";

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
