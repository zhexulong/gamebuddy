import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

/**
 * One fact, two spellings - so assert they are still the same fact.
 *
 * The default companion's reviewed prose exists twice: `card.json`'s `character_book.entries` (the shape the ST-card
 * import path reads) and `worldbook.json`'s `entries` (the shape the compiled preset is built from). Nothing compared
 * them, so a lane could fix a lie in one file and leave it in the other. Measured 2026-11-08: a reviewer reported the
 * card telling the companion it could cook, while the worldbook - the copy that actually reaches the prompt - had
 * already been corrected; the two had drifted and only a human reading both caught it.
 *
 * The authority is the CONTENT, not the field names: the two files are different schemas on purpose (one is an ST-card
 * export, one is a product world book), so this compares what a player would read, entry by entry.
 */

const ROOT = join(import.meta.dirname, "..", "..", "..");
const PRESET = join(ROOT, "assets", "tavern", "presets", "default-companion");

type MirrorEntry = { content?: unknown };

function entriesOf(file: string, pick: (json: unknown) => unknown): MirrorEntry[] {
  const json: unknown = JSON.parse(readFileSync(join(PRESET, file), "utf8"));
  const entries = pick(json);
  assert.ok(Array.isArray(entries), `${file} carries no entry array`);
  return entries as MirrorEntry[];
}

test("the card's character book and the world book say the same thing", () => {
  const card = entriesOf(
    "card.json",
    (json) => (json as { data?: { character_book?: { entries?: unknown } } }).data?.character_book?.entries,
  );
  const book = entriesOf("worldbook.json", (json) => (json as { entries?: unknown }).entries);

  assert.ok(card.length > 0 && book.length > 0, "both files must carry entries; an empty pair agrees with itself");
  assert.equal(
    card.length,
    book.length,
    `the two spellings carry ${String(card.length)} card entries and ${String(book.length)} world-book entries`,
  );

  const drifted: string[] = [];
  for (const [index, cardEntry] of card.entries()) {
    const bookEntry = book[index];
    const cardText = typeof cardEntry.content === "string" ? cardEntry.content.trim() : "";
    const bookText = typeof bookEntry?.content === "string" ? bookEntry.content.trim() : "";
    if (cardText !== bookText) {
      drifted.push(
        `entry ${String(index)}: card says "${cardText.slice(0, 40)}…" / world book says "${bookText.slice(0, 40)}…"`,
      );
    }
  }
  assert.deepEqual(
    drifted,
    [],
    `the reviewed prose drifted between card.json and worldbook.json, so one of them is telling the companion ` +
      `something the other is not:\n  ${drifted.join("\n  ")}`,
  );

  console.log(`default_companion_mirror: examined ${String(card.length)} entries against ${String(book.length)}`);
});
