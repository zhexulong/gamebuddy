import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { readWorldBook, validateWorldBook, writeWorldBook, type WorldBook, type WorldBookEntry } from "../worldbook.js";
import type { UpdateCompanionWorldBookCommandV1 } from "./browser-contract/index.js";
import {
  selectAuthoredContextVolatileSourceRefs,
  type AuthoredContextVolatileSourceCandidate,
} from "./chat-thread-store.js";
import { projectRenderedCompanionWorldBook, updateCompanionWorldBook } from "./companion-world-book-service.js";
import { macroTable, renderMacros } from "./macro-engine.js";

/**
 * The card's SECOND condition, edited by the player.
 *
 * `secondaryKeys`/`selectiveLogic` are the half of an entry's firing rule the surface never carried
 * (`worldbook.ts` documents the mode: 0 AND ANY, 1 NOT ALL, 2 NOT ANY, 3 AND ALL, applied by the
 * per-turn selector only after one of `keys` matched). While the player had no control for them,
 * the write path re-attached them to the row that claimed the entry - the card's own rule rode back
 * onto every save, and that was correct because it was the only copy.
 *
 * The moment the panel can state them, that re-attach becomes a SECOND authority over one fact:
 * the player's words arrive on the wire and are overwritten by the durable entry's, silently, on
 * the next save. So the durable entry is the authority, the card is the seed a fresh import leaves
 * in it, and these tests are written to fail on the re-attach rather than to describe it.
 */
const MACROS = macroTable({ char: "琥珀", user: "阿岚" });
const REVISION = 5;
const PATH_OF = (root: string): string => join(root, "worldbook.json");

/** The card's own entry, gated in SillyTavern's NOT ANY mode on the word it was imported with. */
function cardBook(): WorldBook {
  return validateWorldBook({
    schemaVersion: 1,
    worldBookId: "worldbook_player_gate",
    revision: REVISION,
    alwaysOnPremise: "",
    entries: [
      {
        entryId: "st-json-1",
        title: "温室",
        content: "{{char}}把温室的玻璃换成了新的。",
        scope: "setting",
        provenance: "st-card-import",
        tokenBudget: "small",
        keys: ["温室"],
        secondaryKeys: ["雨天"],
        selectiveLogic: 2,
      },
      {
        entryId: "st-json-2",
        title: "洒水器",
        content: "洒水器接在井边。",
        scope: "setting",
        provenance: "st-card-import",
        tokenBudget: "small",
        keys: ["洒水器"],
      },
    ],
  });
}

const GREENHOUSE = 0;
const SPRINKLER = 1;

async function bookRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "gamebuddy-world-book-player-gate-"));
  await writeWorldBook(PATH_OF(root), cardBook());
  return root;
}

type EditorRow = UpdateCompanionWorldBookCommandV1["entries"][number];

/** The rows the editor would send back: the projection the player actually reads, unchanged. */
async function editorRows(root: string): Promise<readonly EditorRow[]> {
  return (await projectRenderedCompanionWorldBook(root, MACROS)).entries;
}

/**
 * One save of the whole list, with the pin refresh stubbed out.
 *
 * The CAS revision is read from the file on each call, so a test that saves twice is judged on the
 * same rule the surface is: a save CASes on the revision that is there, and a stale one is refused.
 */
async function save(root: string, rows: readonly EditorRow[]): Promise<readonly WorldBookEntry[]> {
  const expectedRevision = (await readWorldBook(PATH_OF(root))).revision;
  await updateCompanionWorldBook({
    path: PATH_OF(root),
    containmentRoot: root,
    macros: MACROS,
    expectedRevision,
    entries: rows,
    refreshBindings: async () => 0,
  });
  return (await readWorldBook(PATH_OF(root))).entries;
}

/**
 * One durable entry as the per-turn selector receives it: the three lines the runtime's own two
 * links write.
 * `resolveBoundWorldBookSource` (`continuity-semantic-chat-runtime-construction.internal.ts:492-493`)
 * hands each keyword entry's `secondaryKeys`/`selectiveLogic` through, and
 * `deriveVolatileWorldInfoSources` (`catalog-service.ts:558-559`) turns them into this candidate.
 * Both of those links are covered where they live (`catalog-service.test.ts` asserts a layer
 * source's gate reaches `volatileSources`, `chat-thread-store.private.test.ts` asserts all four
 * modes). This file asserts the fact neither of them can: that a player's EDIT is what they read.
 */
function candidateOf(entry: WorldBookEntry): AuthoredContextVolatileSourceCandidate {
  const content = renderMacros(entry.content, MACROS);
  return Object.freeze({
    sourceId: entry.entryId,
    kind: "lorebook_entry" as const,
    revision: String(REVISION),
    canonicalHash: createHash("sha256").update(content, "utf8").digest("hex"),
    content,
    budgetTokens: 1,
    totalOrderKey: "0001",
    provenance: "test",
    selectionKeys: Object.freeze([...(entry.keys ?? [entry.title])]),
    ...(entry.secondaryKeys === undefined ? {} : { secondaryKeys: Object.freeze([...entry.secondaryKeys]) }),
    ...(entry.selectiveLogic === undefined ? {} : { selectiveLogic: entry.selectiveLogic }),
  });
}

/** Whether the per-turn selector reaches this one entry for what the player said. */
function selected(entry: WorldBookEntry, playerText: string): boolean {
  return selectAuthoredContextVolatileSourceRefs(playerText, "", [candidateOf(entry)]).refs.length === 1;
}

/**
 * The row with its mode cleared: the control's "Not set" states absence by carrying no field, and
 * `exactOptionalPropertyTypes` is what makes that a compile-time fact rather than a convention.
 */
function withoutSelectiveLogic(row: EditorRow): EditorRow {
  const { selectiveLogic: _cleared, ...rest } = row;
  return rest;
}

test("a freshly imported card's second condition is what the read carries", async () => {
  const root = await bookRoot();
  try {
    const rows = await editorRows(root);
    // The import-time seed, read back through the projection the panel draws: without this the
    // editor would open on two empty controls for a card that states a rule, and the first save
    // would then be the act that erased it.
    assert.deepEqual(rows[GREENHOUSE]!.secondaryKeys, ["雨天"]);
    assert.equal(rows[GREENHOUSE]!.selectiveLogic, 2);
    // …and an entry the card gated on nothing says so by carrying nothing, not by an empty list.
    assert.equal(Object.hasOwn(rows[SPRINKLER]!, "secondaryKeys"), false);
    assert.equal(Object.hasOwn(rows[SPRINKLER]!, "selectiveLogic"), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the player's own second condition words are the ones the book keeps", async () => {
  const root = await bookRoot();
  try {
    const rows = await editorRows(root);
    const durable = await save(root, [{ ...rows[GREENHOUSE]!, secondaryKeys: ["雪天"] }, rows[SPRINKLER]!]);

    assert.deepEqual(
      durable[GREENHOUSE]!.secondaryKeys,
      ["雪天"],
      "the book kept the card's word instead of the player's, so the save overwrote her edit",
    );
    // The entry the player did not touch keeps the word it was imported with.
    assert.equal(Object.hasOwn(durable[SPRINKLER]!, "secondaryKeys"), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the player's own mode is the one the book keeps, and the selector applies it", async () => {
  const root = await bookRoot();
  try {
    const rows = await editorRows(root);
    // NOT ANY becomes AND ALL: the same word list, the opposite rule.
    const durable = await save(root, [{ ...rows[GREENHOUSE]!, selectiveLogic: 3 }, rows[SPRINKLER]!]);

    assert.equal(durable[GREENHOUSE]!.selectiveLogic, 3, "the book kept the card's mode instead of the player's");
    assert.deepEqual(durable[GREENHOUSE]!.secondaryKeys, ["雨天"]);
    // The rule the player chose is the rule the turn is selected by. The card's NOT ANY fired on a
    // turn that never said the word; the player's AND ALL requires it.
    assert.equal(
      selected(cardBook().entries[GREENHOUSE]!, "温室里很暖和"),
      true,
      "NOT ANY (the card's mode) fires when the word is absent",
    );
    assert.equal(selected(durable[GREENHOUSE]!, "温室里很暖和"), false, "AND ALL does not fire on a turn without it");
    assert.equal(selected(durable[GREENHOUSE]!, "温室 雨天"), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a word the player removes, and one she adds, decide selection on the next turn", async () => {
  const root = await bookRoot();
  try {
    const rows = await editorRows(root);
    // Her words replace the card's, and the mode stays the entry's own (NOT ANY): a save that only
    // states the words must not resolve the mode to the selector's default and change the rule.
    const edited = await save(root, [{ ...rows[GREENHOUSE]!, secondaryKeys: ["雪天"] }, rows[SPRINKLER]!]);
    assert.deepEqual(edited[GREENHOUSE]!.secondaryKeys, ["雪天"]);
    assert.equal(edited[GREENHOUSE]!.selectiveLogic, 2);
    // NOT ANY over 雪天: the entry fires unless the player mentions it.
    assert.equal(selected(edited[GREENHOUSE]!, "温室 雨天"), true);
    assert.equal(selected(edited[GREENHOUSE]!, "温室 雪天"), false);

    // And removing the condition altogether is ABSENCE, the shape the card import writes for a
    // keyless entry: the selector then has no gate to apply, so the primary word alone decides.
    const ungated = await save(root, [{ ...rows[GREENHOUSE]!, secondaryKeys: [] }, rows[SPRINKLER]!]);
    assert.equal(Object.hasOwn(ungated[GREENHOUSE]!, "secondaryKeys"), false);
    assert.equal(selected(ungated[GREENHOUSE]!, "温室 雪天"), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a mode the player clears is absence, and the selector falls back to its documented default", async () => {
  const root = await bookRoot();
  try {
    const rows = await editorRows(root);
    // "Not set" is a choice the control offers, and it means what the label beside it says
    // (`worldBookEntrySelectiveLogicHint`): words with no mode chosen are combined as AND ANY. The
    // book stores no field rather than minting the default, so a re-export stays the card's shape.
    const cleared = await save(root, [withoutSelectiveLogic(rows[GREENHOUSE]!), rows[SPRINKLER]!]);
    assert.equal(Object.hasOwn(cleared[GREENHOUSE]!, "selectiveLogic"), false);
    assert.deepEqual(cleared[GREENHOUSE]!.secondaryKeys, ["雨天"]);
    // The default the selector applies is AND ANY: one of the words is enough.
    assert.equal(selected(cleared[GREENHOUSE]!, "温室 雨天"), true);
    assert.equal(selected(cleared[GREENHOUSE]!, "温室里很暖和"), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
