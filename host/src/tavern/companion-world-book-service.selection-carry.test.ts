import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { readWorldBook, validateWorldBook, writeWorldBook, type WorldBook, type WorldBookEntry } from "../worldbook.js";
import type { UpdateCompanionWorldBookCommandV1 } from "./browser-contract/index.js";
import { projectRenderedCompanionWorldBook, updateCompanionWorldBook } from "./companion-world-book-service.js";
import { macroTable } from "./macro-engine.js";

/**
 * The facts a save must never reset, and the rows that must never swap them.
 *
 * The editor sends back every field the command can state - title, trigger words, second condition
 * words and mode, always-on flag, switch, body. Everything else a card authored about an entry - the
 * scope it is visible in, where it came from, how much of it the companion may carry, its
 * integration/save/world binding - has no control on that surface at all, so the write path has to
 * reattach those facts to the row that carried them. The identity it matches on has to be the
 * entry's OWN identity rather than "the whole row came back byte-identical": an edit to what the
 * entry says, or to one trigger word, or to its title, is not an instruction to drop its binding.
 *
 * The card's second condition used to ride with them, and it deliberately no longer does: once the
 * panel can state it, re-attaching it made the durable entry a second authority over the player's
 * own edit (`companion-world-book-service.player-gate.test.ts` proves the overwrite that caused).
 * So this file asserts the two groups separately - `carried` for the facts no row can state,
 * `condition` for the one the row now carries through untouched - and a row that swaps either with
 * its neighbour is visible rather than silent.
 *
 * The rows here carry pairwise DIFFERENT hidden facts, so a match that lands on the wrong row is
 * visible rather than silent: an entry that takes its neighbour's binding is the failure this file
 * is built to catch, whatever the reason.
 */
const MACROS = macroTable({ char: "琥珀", user: "阿岚" });

/** One row as the editor sends it back: the contract's own entry shape, derived rather than copied. */
type EditorRow = UpdateCompanionWorldBookCommandV1["entries"][number];

/** The entry's facts no row can state - everything the projection does not carry - in one shape. */
function carried(entry: WorldBookEntry): Readonly<Record<string, unknown>> {
  return Object.freeze({
    scope: entry.scope,
    provenance: entry.provenance,
    tokenBudget: entry.tokenBudget,
    integrationId: entry.integrationId,
    saveId: entry.saveId,
    worldId: entry.worldId,
  });
}

/** The entry's second condition: two fields the row states, so they ride with the row, not the carry. */
function condition(entry: WorldBookEntry): Readonly<Record<string, unknown>> {
  return Object.freeze({ secondaryKeys: entry.secondaryKeys, selectiveLogic: entry.selectiveLogic });
}

/**
 * One durable entry still is the entry the card wrote: the same binding facts, and the same second
 * condition - which the row carried back itself rather than having it re-attached.
 *
 * Two assertions rather than one object, because the two facts have two different authorities now,
 * and a failure has to say which one moved: `carried` is the write path's carry, `condition` is the
 * row's own.
 */
function assertKept(durable: WorldBookEntry, card: WorldBookEntry): void {
  assert.deepEqual(carried(durable), carried(card));
  assert.deepEqual(condition(durable), condition(card));
}

/**
 * Three entries whose hidden facts are pairwise different: a `setting` entry the card imported with
 * a NOT-ANY gate, an always-on `integration` entry with an AND-ANY gate, and a `world` entry
 * carrying its own save and world ids. A row that takes a neighbour's facts therefore has to take
 * them from a visibly different set.
 */
function cardBook(): WorldBook {
  return validateWorldBook({
    schemaVersion: 1,
    worldBookId: "worldbook_selection_carry",
    revision: 5,
    alwaysOnPremise: "{{user}}和她一起打理农场。",
    entries: [
      {
        entryId: "st-json-1",
        title: "温室",
        content: "{{char}}把温室的玻璃换成了新的。",
        scope: "setting",
        provenance: "st-card-import",
        tokenBudget: "medium",
        keys: ["温室", "玻璃房"],
        secondaryKeys: ["雨天"],
        selectiveLogic: 2,
      },
      {
        entryId: "st-json-2",
        title: "洒水器",
        content: "{{char}}修好了洒水器，管子接在井边。",
        scope: "integration",
        integrationId: "farm",
        provenance: "reviewed-import",
        tokenBudget: "medium",
        constant: true,
        keys: ["洒水器"],
        secondaryKeys: ["夏天"],
        selectiveLogic: 1,
      },
      {
        entryId: "st-json-3",
        title: "雨天",
        content: "{{char}}喜欢雨天。",
        scope: "world",
        integrationId: "farm",
        saveId: "save_01",
        worldId: "world_01",
        provenance: "authored",
        tokenBudget: "small",
        keys: ["下雨"],
      },
    ],
  });
}

/** The card's own entries, by position, so an assertion can name the facts it expected. */
const CARD = cardBook().entries;
const [GREENHOUSE, SPRINKLER, RAIN] = [0, 1, 2] as const;

/** A temp root holding the card's own book. */
async function bookRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "gamebuddy-world-book-carry-"));
  await writeWorldBook(join(root, "worldbook.json"), cardBook());
  return root;
}

/**
 * The rows the editor would send back, read through the projection the player actually sees.
 *
 * Spread rather than spelled out: the editor sends back what it read, so a field the contract grows
 * is in this row the moment it is in the projection - a hand-written field list here would make the
 * gate look absent from a save that carried it.
 */
async function editorRows(root: string): Promise<readonly EditorRow[]> {
  return (await projectRenderedCompanionWorldBook(root, MACROS)).entries;
}

/** One save of the whole list, CASed on the card's revision, with the pin refresh stubbed out. */
async function save(root: string, rows: readonly EditorRow[]): Promise<readonly WorldBookEntry[]> {
  await updateCompanionWorldBook({
    path: join(root, "worldbook.json"),
    containmentRoot: root,
    macros: MACROS,
    expectedRevision: 5,
    entries: rows,
    refreshBindings: async () => 0,
  });
  return (await readWorldBook(join(root, "worldbook.json"))).entries;
}

test("retitling an entry keeps the scope, budget and binding she cannot state, and leaves its neighbours alone", async () => {
  const root = await bookRoot();
  try {
    const rows = await editorRows(root);
    const durable = await save(root, [{ ...rows[GREENHOUSE]!, title: "旧温室" }, rows[SPRINKLER]!, rows[RAIN]!]);

    // The entry the row was renamed from is the entry it still is: the title is the player's, and
    // everything the editor could not show is the card's. Before this rule the renamed row matched
    // nothing, so the `setting` scope, the `medium` budget and the card's NOT-ANY condition all reset
    // to a fresh entry's defaults - silently, on a save that only changed a name.
    assert.equal(durable[GREENHOUSE]!.title, "旧温室");
    assertKept(durable[GREENHOUSE]!, CARD[GREENHOUSE]!);
    // …and its body still renders to exactly what the player read, so the AUTHORED text rides back.
    assert.equal(durable[GREENHOUSE]!.content, "{{char}}把温室的玻璃换成了新的。");
    // A rename is not a licence to reach the next entry's facts: both neighbours are untouched.
    assertKept(durable[SPRINKLER]!, CARD[SPRINKLER]!);
    assertKept(durable[RAIN]!, CARD[RAIN]!);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("editing one trigger word keeps the entry's scope, budget and binding", async () => {
  const root = await bookRoot();
  try {
    const rows = await editorRows(root);
    const durable = await save(root, [
      // The player adds one of her own words to the row. This is the edit the editor's own hint
      // invites, and it used to be enough on its own to make the row read as a NEW entry.
      { ...rows[GREENHOUSE]!, keys: ["温室", "玻璃房", "花房"] },
      rows[SPRINKLER]!,
      rows[RAIN]!,
    ]);

    assert.deepEqual(durable[GREENHOUSE]!.keys, ["温室", "玻璃房", "花房"]);
    assertKept(durable[GREENHOUSE]!, CARD[GREENHOUSE]!);
    // The body is unchanged, so the authored text is still the one stored.
    assert.equal(durable[GREENHOUSE]!.content, "{{char}}把温室的玻璃换成了新的。");
    assertKept(durable[SPRINKLER]!, CARD[SPRINKLER]!);
    assertKept(durable[RAIN]!, CARD[RAIN]!);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a field the command can state is the row's own, and the carry never overrides it", async () => {
  const root = await bookRoot();
  try {
    const rows = await editorRows(root);
    const durable = await save(root, [
      // Every field this command can state, stated: a body of her own, no trigger words, the
      // always-on flag turned on (the card's greenhouse entry carried none), and a second condition
      // of her own choosing.
      {
        title: rows[GREENHOUSE]!.title,
        keys: [],
        constant: true,
        enabled: true,
        content: "{{user}}说这扇玻璃是她挑的。",
        secondaryKeys: ["雪天"],
        selectiveLogic: 3,
      },
      rows[SPRINKLER]!,
      rows[RAIN]!,
    ]);

    // Each one is hers, exactly as sent - the carry adds facts, it never argues with one.
    assert.equal(durable[GREENHOUSE]!.title, "温室");
    assert.equal(durable[GREENHOUSE]!.keys, undefined, "no trigger words is an absent field, as the import writes it");
    assert.equal(durable[GREENHOUSE]!.constant, true);
    assert.equal(durable[GREENHOUSE]!.content, "{{user}}说这扇玻璃是她挑的。");
    // The condition is stated by this row now, so the card's is not re-attached over it: the words
    // and the mode are the ones the save carried (`player-gate.test.ts` is the file that proves the
    // overwrite this replaced).
    assert.deepEqual(durable[GREENHOUSE]!.secondaryKeys, ["雪天"]);
    assert.equal(durable[GREENHOUSE]!.selectiveLogic, 3);
    // …while the facts she has no field for still describe the entry she edited. `scope` belongs to
    // this group: `CompanionWorldBookEntryV1Schema` declares no scope, so the command cannot state
    // one, and the invariant this asserts is the one that is true - the carry never overrides a
    // field the command CAN state, and never invents one it cannot.
    assert.deepEqual(carried(durable[GREENHOUSE]!), carried(CARD[GREENHOUSE]!));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("removing a row leaves its neighbours' hidden facts on the neighbours", async () => {
  const root = await bookRoot();
  try {
    const rows = await editorRows(root);
    const durable = await save(root, [
      // The always-on integration entry is deleted, so both survivors move one position up - and
      // the last of them also has its trigger word edited, which is what a positional match or a
      // whole-row match would turn into "this row is new, give it the defaults".
      rows[GREENHOUSE]!,
      { ...rows[RAIN]!, keys: ["阴天"] },
    ]);

    assert.deepEqual(
      durable.map((entry) => entry.title),
      ["温室", "雨天"],
    );
    assert.deepEqual(durable[0]!.keys, ["温室", "玻璃房"]);
    assertKept(durable[0]!, CARD[GREENHOUSE]!);
    // The surviving row keeps its OWN world binding and budget, never the deleted row's.
    assertKept(durable[1]!, CARD[RAIN]!);
    assert.deepEqual(durable[1]!.keys, ["阴天"]);
    // …and the deleted entry's condition is left on nobody: the sprinkler's AND-ANY words are gone
    // with it, from the book as well as from the rows.
    assert.deepEqual(
      durable.flatMap((entry) => (entry.secondaryKeys === undefined ? [] : [entry.secondaryKeys])),
      [["雨天"]],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a row renamed to another entry's title keeps its own binding instead of taking that one's", async () => {
  const root = await bookRoot();
  try {
    const rows = await editorRows(root);
    const durable = await save(root, [
      // The player renames the greenhouse row to the sprinkler's name and leaves its text alone,
      // while the real sprinkler row sits right after it, unchanged. A match that resolved each row
      // on its own title would hand the renamed row the sprinkler's scope, budget and integration
      // binding, and leave the actual sprinkler with the greenhouse's - one save, two entries' facts
      // swapped.
      { ...rows[GREENHOUSE]!, title: "洒水器" },
      rows[SPRINKLER]!,
      rows[RAIN]!,
    ]);

    assert.deepEqual(
      durable.map((entry) => entry.title),
      ["洒水器", "洒水器", "雨天"],
    );
    // The renamed row is still the greenhouse: same scope, same budget, same NOT-ANY condition…
    assertKept(durable[0]!, CARD[GREENHOUSE]!);
    // …and the row that always carried that name kept its AND-ANY condition and its integration binding.
    assertKept(durable[1]!, CARD[SPRINKLER]!);
    assertKept(durable[2]!, CARD[RAIN]!);
    // Two rows sharing a title did not end up sharing an entry: their bodies are their own.
    assert.equal(durable[0]!.content, "{{char}}把温室的玻璃换成了新的。");
    assert.equal(durable[1]!.content, "{{char}}修好了洒水器，管子接在井边。");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
