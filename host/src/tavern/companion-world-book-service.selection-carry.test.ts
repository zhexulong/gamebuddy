import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { readWorldBook, validateWorldBook, writeWorldBook, type WorldBook, type WorldBookEntry } from "../worldbook.js";
import { projectRenderedCompanionWorldBook, updateCompanionWorldBook } from "./companion-world-book-service.js";
import { macroTable } from "./macro-engine.js";

/**
 * The facts a save must never reset, and the rows that must never swap them.
 *
 * The editor shows a row's title, trigger words, always-on flag and body, and sends exactly those
 * four back. Everything else a card authored about an entry - the scope it is visible in, where it
 * came from, how much of it the companion may carry, and above all the AND-NOT gate in
 * `secondaryKeys`/`selectiveLogic` - has no control on that surface at all. So the write path has
 * to reattach those facts to the row that carried them, and the identity it matches on has to be
 * the entry's OWN identity rather than "the whole row came back byte-identical": the card author's
 * rule is metadata about WHEN an entry fires, and an edit to what it says, or to one trigger word,
 * or to its title, is not an instruction to drop it.
 *
 * The rows here carry pairwise DIFFERENT hidden facts, so a match that lands on the wrong row is
 * visible rather than silent: an entry that takes its neighbour's gate is the failure this file is
 * built to catch, whatever the reason.
 */
const MACROS = macroTable({ char: "琥珀", user: "阿岚" });

/** One row as the editor sends it back: the projection's own four fields, body already rendered. */
type EditorRow = Readonly<{ title: string; keys: readonly string[]; constant: boolean; content: string }>;

/** One entry's hidden facts - everything the projection does not carry - in one comparable shape. */
function hidden(entry: WorldBookEntry): Readonly<Record<string, unknown>> {
  return Object.freeze({
    scope: entry.scope,
    provenance: entry.provenance,
    tokenBudget: entry.tokenBudget,
    secondaryKeys: entry.secondaryKeys,
    selectiveLogic: entry.selectiveLogic,
    integrationId: entry.integrationId,
    saveId: entry.saveId,
    worldId: entry.worldId,
  });
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

/** The rows the editor would send back, read through the projection the player actually sees. */
async function editorRows(root: string): Promise<readonly EditorRow[]> {
  const read = await projectRenderedCompanionWorldBook(root, MACROS);
  return read.entries.map((entry) => ({
    title: entry.title,
    keys: [...entry.keys],
    constant: entry.constant,
    content: entry.content,
  }));
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

test("retitling an entry keeps its authored gate, scope and budget, and leaves its neighbours alone", async () => {
  const root = await bookRoot();
  try {
    const rows = await editorRows(root);
    const durable = await save(root, [{ ...rows[GREENHOUSE]!, title: "旧温室" }, rows[SPRINKLER]!, rows[RAIN]!]);

    // The entry the row was renamed from is the entry it still is: the title is the player's, and
    // everything the editor could not show is the card's. Before this rule the renamed row matched
    // nothing, so the author's NOT-ANY gate, the `setting` scope and the `medium` budget all reset
    // to a fresh entry's defaults - silently, on a save that only changed a name.
    assert.equal(durable[GREENHOUSE]!.title, "旧温室");
    assert.deepEqual(hidden(durable[GREENHOUSE]!), hidden(CARD[GREENHOUSE]!));
    // …and its body still renders to exactly what the player read, so the AUTHORED text rides back.
    assert.equal(durable[GREENHOUSE]!.content, "{{char}}把温室的玻璃换成了新的。");
    // A rename is not a licence to reach the next entry's facts: both neighbours are untouched.
    assert.deepEqual(hidden(durable[SPRINKLER]!), hidden(CARD[SPRINKLER]!));
    assert.deepEqual(hidden(durable[RAIN]!), hidden(CARD[RAIN]!));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("editing one trigger word keeps the entry's gate, scope and budget", async () => {
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
    assert.deepEqual(hidden(durable[GREENHOUSE]!), hidden(CARD[GREENHOUSE]!));
    // The body is unchanged, so the authored text is still the one stored.
    assert.equal(durable[GREENHOUSE]!.content, "{{char}}把温室的玻璃换成了新的。");
    assert.deepEqual(hidden(durable[SPRINKLER]!), hidden(CARD[SPRINKLER]!));
    assert.deepEqual(hidden(durable[RAIN]!), hidden(CARD[RAIN]!));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a field the command can state is the row's own, and the carry never overrides it", async () => {
  const root = await bookRoot();
  try {
    const rows = await editorRows(root);
    const durable = await save(root, [
      // Every field this command can state, stated: a body of her own, no trigger words, and the
      // always-on flag turned on (the card's greenhouse entry carried none).
      { title: rows[GREENHOUSE]!.title, keys: [], constant: true, content: "{{user}}说这扇玻璃是她挑的。" },
      rows[SPRINKLER]!,
      rows[RAIN]!,
    ]);

    // Each of the four is hers, exactly as sent - the carry adds facts, it never argues with one.
    assert.equal(durable[GREENHOUSE]!.title, "温室");
    assert.equal(durable[GREENHOUSE]!.keys, undefined, "no trigger words is an absent field, as the import writes it");
    assert.equal(durable[GREENHOUSE]!.constant, true);
    assert.equal(durable[GREENHOUSE]!.content, "{{user}}说这扇玻璃是她挑的。");
    // …while the facts she has no field for still describe the entry she edited. `scope` belongs to
    // this group: `CompanionWorldBookEntryV1Schema` is title/keys/constant/content, so the command
    // cannot state a scope at all, and the invariant this asserts is the one that is true - the
    // carry never overrides a field the command CAN state. A surface that could name a scope would
    // need its own change to the wire, and this rule honours it then by construction.
    assert.deepEqual(hidden(durable[GREENHOUSE]!), hidden(CARD[GREENHOUSE]!));
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
    assert.deepEqual(hidden(durable[0]!), hidden(CARD[GREENHOUSE]!));
    // The surviving row keeps its OWN world binding and budget, never the deleted row's.
    assert.deepEqual(hidden(durable[1]!), hidden(CARD[RAIN]!));
    assert.deepEqual(durable[1]!.keys, ["阴天"]);
    // …and the deleted entry's gate is left on nobody: the sprinkler's AND-ANY words are gone with
    // it, from the book as well as from the rows.
    assert.deepEqual(
      durable.flatMap((entry) => (entry.secondaryKeys === undefined ? [] : [entry.secondaryKeys])),
      [["雨天"]],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a row renamed to another entry's title keeps its own gate instead of taking that one's", async () => {
  const root = await bookRoot();
  try {
    const rows = await editorRows(root);
    const durable = await save(root, [
      // The player renames the greenhouse row to the sprinkler's name and leaves its text alone,
      // while the real sprinkler row sits right after it, unchanged. A match that resolved each row
      // on its own title would hand the renamed row the sprinkler's AND-ANY gate and leave the
      // actual sprinkler with the greenhouse's - one save, two entries' rules swapped.
      { ...rows[GREENHOUSE]!, title: "洒水器" },
      rows[SPRINKLER]!,
      rows[RAIN]!,
    ]);

    assert.deepEqual(
      durable.map((entry) => entry.title),
      ["洒水器", "洒水器", "雨天"],
    );
    // The renamed row is still the greenhouse: same scope, same budget, same NOT-ANY gate…
    assert.deepEqual(hidden(durable[0]!), hidden(CARD[GREENHOUSE]!));
    // …and the row that always carried that name kept its AND-ANY gate and its integration binding.
    assert.deepEqual(hidden(durable[1]!), hidden(CARD[SPRINKLER]!));
    assert.deepEqual(hidden(durable[2]!), hidden(CARD[RAIN]!));
    // Two rows sharing a title did not end up sharing an entry: their bodies are their own.
    assert.equal(durable[0]!.content, "{{char}}把温室的玻璃换成了新的。");
    assert.equal(durable[1]!.content, "{{char}}修好了洒水器，管子接在井边。");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
