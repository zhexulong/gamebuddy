import assert from "node:assert/strict";
import test from "node:test";
import { bindWindowsStaleLockReclaimer } from "../../path-lock.js";
import { canonicalTestRoot } from "../../test-support/canonical-test-root.test-support.js";
import { createBuildWindowsStaleLockReclaimer } from "../../windows-stale-lock-reclaimer/index.js";
import { exportTavernLorebook } from "./tavern-lorebook-exporter.js";
import { importTavernLorebook, isRawTavernLorebook } from "./tavern-lorebook-importer.js";
import { createWorldInfoManagementRepository } from "./world-info-management.js";

// The library writes its catalog under a durable path lock, and on Windows releasing one needs the
// run's stale-lock reclaimer bound - the same before/after every other test of this store performs.
test.before(async () => {
  bindWindowsStaleLockReclaimer(await createBuildWindowsStaleLockReclaimer());
});

test.after(() => {
  bindWindowsStaleLockReclaimer(undefined);
});

/**
 * The export exists so a player can take a book away and get it back, so the only reading that
 * means anything is the round trip: import → export → import must yield the SAME entries.
 *
 * The input is a real SillyTavern/Chub file - keys, a secondary gate, the four-mode
 * `selectiveLogic`, an always-on entry, a switched-off one, and an entry that carries none of the
 * optional facts - because a fixture shaped to match the exporter would prove the exporter agrees
 * with itself. Both sides of the comparison are the importer's own output, and the entry sets are
 * compared whole, so a field dropped anywhere in the middle fails by name.
 */
test("a library item exported as a lorebook file imports back with the same entries", async () => {
  const source = {
    name: "雨天的约定",
    description: "关于雨天与晴天的一切。",
    entries: [
      {
        uid: 0,
        comment: "雨天安排",
        content: "雨天喜欢在门廊煮热茶看雨。",
        keys: ["雨天", "下雨"],
        secondary_keys: ["茶", "门廊"],
        selectiveLogic: 1,
        constant: true,
        enabled: true,
        order: 2,
      },
      {
        uid: 1,
        comment: "晴天安排",
        content: "晴天喜欢去河边散步。",
        keys: ["晴天"],
        enabled: false,
        order: 1,
      },
      {
        uid: 2,
        comment: "没有触发词的事",
        content: "这是一条没有任何触发词、也不始终生效的词条。",
        order: 3,
      },
      {
        uid: 3,
        comment: "从不说出口的设定",
        content: "作者把它关掉了。",
        keys: ["秘密"],
        enabled: false,
        order: 4,
      },
    ],
  };
  const imported = importTavernLorebook(source);
  const root = await canonicalTestRoot("lorebook-export-round-trip-");
  const repository = createWorldInfoManagementRepository(root);
  const stored = await repository.create(imported);

  const exported = exportTavernLorebook(stored);
  // The file is the shape the import path DETECTS as an external lorebook, which is the fact that
  // makes it re-importable: a document the importer read as a native item would bypass the
  // translation entirely.
  const document: unknown = JSON.parse(exported.document);
  assert.equal(isRawTavernLorebook(document), true, "the export is detected as an external lorebook");
  assert.equal("character_book" in (document as object), false, "the canonical flat shape is the one written");
  assert.equal(Array.isArray((document as { entries: unknown }).entries), true, "entries stay an ordered array");

  const reimported = importTavernLorebook(document);
  assert.equal(reimported.publicTitle, stored.publicTitle, "the book's own name survives");
  assert.equal(reimported.summary, stored.summary, "and its summary");
  assert.deepEqual(reimported.entries, stored.entries, "every entry, every field, in the stored order");
  assert.equal(exported.entryCount, stored.entries.length, "the count the surface reports is the list it wrote");
  // The switched-off entries are entries, not omissions: the round trip carries the switch.
  // (Order is the card's own: `order` 1, 2, 3, 4 decides the sequence the library stores.)
  assert.deepEqual(
    stored.entries.map((entry) => entry.enabled === false),
    [true, false, false, true],
  );
});

/**
 * A field the entry does not carry is not invented by the export.
 *
 * An entry with no `selectiveLogic` and one that names AND ANY are different facts to the per-turn
 * selector, so an exporter that wrote a default would rewrite the author's rule on the round trip -
 * silently, in the one file the player takes to another app.
 */
test("the export writes no default for a fact the entry does not carry", async () => {
  const root = await canonicalTestRoot("lorebook-export-absent-");
  const repository = createWorldInfoManagementRepository(root);
  const stored = await repository.create({
    publicTitle: "只有必需字段",
    summary: "这一项没有任何可选字段。",
    entries: [{ scope: "setting", publicTitle: "一条词条", summary: "它只说这一句。" }],
  });
  const document = JSON.parse(exportTavernLorebook(stored).document) as {
    entries: readonly Record<string, unknown>[];
  };
  const entry = document.entries[0]!;
  assert.equal(Object.hasOwn(entry, "keys"), false, "no trigger words were written that nobody wrote");
  assert.equal(Object.hasOwn(entry, "secondary_keys"), false, "and no second condition");
  assert.equal(Object.hasOwn(entry, "selectiveLogic"), false, "and no gate mode, which would read as AND ANY");
  assert.equal(entry.constant, false, "the required always-on fact is stated, because SillyTavern reads it");
  assert.equal(entry.enabled, true, "and so is the switch");
});
