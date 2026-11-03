import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { MAX_WORLDBOOK_SCAN_DEPTH } from "../worldbook.js";
import {
  decodeSafeInterchange,
  exportSafeChat,
  exportSafeWorldBook,
  TAVERN_INTERCHANGE_VERSION,
} from "./interchange.js";

/** The interchange's own canonical hash, so a test can reach the field validation behind it. */
function createHashForTest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
}

const messages = [
  {
    messageId: "opening",
    role: "companion" as const,
    kind: "opening" as const,
    text: "Welcome",
    occurredAtMs: 1,
    greetingSource: {
      greetingSetId: "greetings",
      sourceRevision: 1,
      canonicalHash: "a".repeat(64),
      variantId: "first",
      profileRevision: 1,
      scenarioRevision: null,
    },
  },
  {
    messageId: "player",
    role: "player" as const,
    kind: "player" as const,
    text: "hello",
    occurredAtMs: 2,
    greetingSource: null,
  },
  {
    messageId: "response",
    role: "companion" as const,
    kind: "response" as const,
    text: "welcome",
    occurredAtMs: 3,
    greetingSource: null,
  },
];

test("safe Tavern chat interchange exports ST-compatible header and selected player-visible bubbles as JSONL", () => {
  const exported = exportSafeChat("thread_01", messages, { userName: "A Player", characterName: "Keeper" });
  assert.equal(exported.format, TAVERN_INTERCHANGE_VERSION);
  assert.deepEqual(exported.header, { user_name: "A Player", character_name: "Keeper", chat_metadata: {} });
  assert.deepEqual(exported.messages, [
    { name: "Keeper", is_user: false, is_system: false, send_date: 1, mes: "Welcome" },
    { name: "A Player", is_user: true, is_system: false, send_date: 2, mes: "hello" },
    { name: "Keeper", is_user: false, is_system: false, send_date: 3, mes: "welcome" },
  ]);
  assert.match(exported.dispositions.find((item) => item.field === "swipes")?.reason ?? "", /selected/);
  const imported = decodeSafeInterchange(exported.jsonl);
  assert.equal(imported.kind, "chat");
  if (imported.kind !== "chat") throw new Error("expected chat");
  assert.deepEqual(imported.messages, exported.messages);
  assert.deepEqual(imported.header, exported.header);
  assert.match(imported.dispositions[0]!.reason, /inert/);
  assert.notEqual(imported.canonicalHash, exported.canonicalHash);
  assert.equal(JSON.parse(exported.jsonl.split("\n")[0]!).user_name, "A Player");
});

test("ST Chat JSONL import accepts only header and safe bubbles, and remains inert", () => {
  const input = `${[
    JSON.stringify({ user_name: "User", character_name: "Companion", chat_metadata: {} }),
    JSON.stringify({ name: "Companion", is_user: false, is_system: false, send_date: 10, mes: "Hi" }),
    JSON.stringify({ name: "User", is_user: true, is_system: false, send_date: 11, mes: "Hello" }),
  ].join("\n")}\n`;
  const imported = decodeSafeInterchange(input);
  assert.equal(imported.kind, "chat");
  assert.equal(imported.jsonl, input);
  assert.deepEqual(
    imported.messages.map((message) => message.mes),
    ["Hi", "Hello"],
  );
  assert.match(imported.dispositions[0]!.reason, /inert/);
});

test("safe Tavern WorldBook interchange keeps an entry's gate and drops only scoped facts", () => {
  const exported = exportSafeWorldBook({
    schemaVersion: 1,
    worldBookId: "book_01",
    revision: 1,
    alwaysOnPremise: "private prompt premise",
    scanDepth: 4,
    entries: [
      {
        entryId: "setting",
        title: "Town",
        content: "public lore",
        scope: "setting",
        provenance: "authored",
        tokenBudget: "small",
      },
      {
        entryId: "gated",
        title: "Tea",
        content: "public tea lore",
        scope: "companion",
        provenance: "st-card-import",
        tokenBudget: "medium",
        constant: true,
        keys: ["tea", "porch"],
        secondaryKeys: ["autumn"],
        selectiveLogic: 2,
      },
      {
        entryId: "world",
        title: "save",
        content: "private fact",
        scope: "world",
        provenance: "authored",
        tokenBudget: "small",
        integrationId: "stardew",
        saveId: "save",
        worldId: "world",
      },
    ],
  });
  assert.equal(exported.scanDepth, 4);
  assert.deepEqual(exported.entries, [
    { entryId: "setting", title: "Town", content: "public lore", scope: "setting", tokenBudget: "small" },
    {
      entryId: "gated",
      title: "Tea",
      content: "public tea lore",
      scope: "companion",
      tokenBudget: "medium",
      constant: true,
      keys: ["tea", "porch"],
      secondaryKeys: ["autumn"],
      selectiveLogic: 2,
    },
  ]);
  // Membership is stated, never invented: an entry that declared no gate members gains none.
  assert.equal(Object.hasOwn(exported.entries[0]!, "keys"), false);
  assert.equal(Object.hasOwn(exported.entries[0]!, "constant"), false);
  assert.doesNotMatch(JSON.stringify(exported), /private prompt premise|private fact|"stardew"/);

  // A reviewed "not always-on" stays stated instead of collapsing into absence, so a reader sees
  // the author's decision rather than inferring it.
  const notConstant = exportSafeWorldBook({
    schemaVersion: 1,
    worldBookId: "book_02",
    revision: 1,
    alwaysOnPremise: "",
    entries: [
      {
        entryId: "reviewed",
        title: "Town",
        content: "public lore",
        scope: "setting",
        provenance: "authored",
        tokenBudget: "small",
        constant: false,
      },
    ],
  });
  assert.equal(notConstant.entries[0]?.constant, false);

  // The gate is what makes a keyword-gated entry reachable, so the round trip must carry it whole.
  const imported = decodeSafeInterchange(JSON.stringify(exported));
  assert.equal(imported.kind, "worldbook");
  if (imported.kind !== "worldbook") throw new Error("expected worldbook");
  assert.equal(imported.scanDepth, 4);
  assert.deepEqual(imported.entries, exported.entries);
  assert.deepEqual(imported.dispositions, exported.dispositions);

  // This book's loss is scope filtering, and that is what the disposition names. The dropped
  // entries take their `integrationId`/`saveId`/`worldId` with them - `validateWorldBook` forbids
  // those on a kept `companion`/`setting` entry - so they have no entry-level disposition of their
  // own.
  assert.deepEqual(
    exported.dispositions.map((item) => [item.field, item.classification]),
    [["scope", "dropped_unsupported"]],
  );
  assert.match(exported.dispositions[0]!.reason, /world_and_integration_scoped_entries_excluded/);
  assert.throws(() => decodeSafeInterchange(JSON.stringify({ ...exported, entries: [] })), /hash/);
  // Scoping identifiers cannot come back in through the file, and the entry shape is what refuses
  // them: a member outside `SAFE_WORLDBOOK_ENTRY_KEYS` is not an entry, even when the hash is recomputed.
  const withIntegrationId = { ...exported, entries: [{ ...exported.entries[0]!, integrationId: "stardew" }] };
  const { canonicalHash: _sealed, ...withIntegrationIdUnsigned } = withIntegrationId;
  assert.throws(
    () =>
      decodeSafeInterchange(
        JSON.stringify({ ...withIntegrationIdUnsigned, canonicalHash: createHashForTest(withIntegrationIdUnsigned) }),
      ),
    /invalid_interchange_worldbook/,
  );
  // The book's own closed shape is separate: an unknown book-level member is named as such.
  const unknownBookMember = { ...exported, alwaysOnPremise: "leak" };
  const { canonicalHash: _bookSealed, ...unknownBookUnsigned } = unknownBookMember;
  assert.throws(
    () =>
      decodeSafeInterchange(
        JSON.stringify({ ...unknownBookUnsigned, canonicalHash: createHashForTest(unknownBookUnsigned) }),
      ),
    /interchange_private_or_unknown_field/,
  );
  // A gate member outside the book's own bounds is refused rather than silently normalized.
  for (const entry of [
    { ...exported.entries[1]!, selectiveLogic: 4 },
    { ...exported.entries[1]!, selectiveLogic: -1 },
    { ...exported.entries[1]!, keys: [] },
    { ...exported.entries[1]!, secondaryKeys: ["  "] },
    { ...exported.entries[1]!, constant: "yes" },
  ]) {
    const { canonicalHash: _dropped, ...rest } = { ...exported, entries: [entry] };
    assert.throws(
      () => decodeSafeInterchange(JSON.stringify({ ...rest, canonicalHash: createHashForTest(rest) })),
      /invalid_interchange_worldbook/,
    );
  }
  // `scanDepth` rides the book, so a depth outside the worldbook's own bound is refused too.
  for (const scanDepth of [0, MAX_WORLDBOOK_SCAN_DEPTH + 1, 2.5]) {
    const { canonicalHash: _depth, ...rest } = { ...exported, scanDepth };
    assert.throws(
      () => decodeSafeInterchange(JSON.stringify({ ...rest, canonicalHash: createHashForTest(rest) })),
      /invalid_interchange_worldbook/,
    );
  }

  // A book beyond the interchange's own entry limit is shortened, and the shortening is named rather
  // than silent: the file a player saves must not quietly be a smaller book than the one she has.
  const oversized = exportSafeWorldBook({
    schemaVersion: 1,
    worldBookId: "book_03",
    revision: 1,
    alwaysOnPremise: "",
    entries: Array.from({ length: 129 }, (_unused, index) => ({
      entryId: `entry_${index}`,
      title: `Entry ${index}`,
      content: "public lore",
      scope: "setting" as const,
      provenance: "authored" as const,
      tokenBudget: "small" as const,
    })),
  });
  assert.equal(oversized.entries.length, 128);
  assert.deepEqual(
    oversized.dispositions.map((item) => [item.field, item.reason]),
    [["entries", "entries_over_the_interchange_limit_excluded"]],
  );
});

test("safe Tavern interchange fails closed on private fields and unsupported versions", () => {
  const body = [
    JSON.stringify({ user_name: "User", character_name: "Companion", chat_metadata: {} }),
    JSON.stringify({
      name: "Companion",
      is_user: false,
      is_system: false,
      send_date: 1,
      mes: "ok",
      sessionId: "private",
    }),
  ].join("\n");
  assert.throws(() => decodeSafeInterchange(body), /invalid/);
  assert.throws(
    () => decodeSafeInterchange(JSON.stringify({ format: "tavern-interchange/v2", kind: "chat" })),
    /invalid/,
  );
});
