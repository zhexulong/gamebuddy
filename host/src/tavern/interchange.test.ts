import assert from "node:assert/strict";
import test from "node:test";
import {
  decodeSafeInterchange,
  exportSafeChat,
  exportSafeWorldBook,
  TAVERN_INTERCHANGE_VERSION,
} from "./interchange.js";

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
  const input =
    [
      JSON.stringify({ user_name: "User", character_name: "Companion", chat_metadata: {} }),
      JSON.stringify({ name: "Companion", is_user: false, is_system: false, send_date: 10, mes: "Hi" }),
      JSON.stringify({ name: "User", is_user: true, is_system: false, send_date: 11, mes: "Hello" }),
    ].join("\n") + "\n";
  const imported = decodeSafeInterchange(input);
  assert.equal(imported.kind, "chat");
  assert.equal(imported.jsonl, input);
  assert.deepEqual(
    imported.messages.map((message) => message.mes),
    ["Hi", "Hello"],
  );
  assert.match(imported.dispositions[0]!.reason, /inert/);
});

test("safe Tavern WorldBook interchange excludes scoped facts and rejects tampering", () => {
  const exported = exportSafeWorldBook({
    schemaVersion: 1,
    worldBookId: "book_01",
    revision: 1,
    alwaysOnPremise: "private prompt premise",
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
  assert.deepEqual(exported.entries, [
    { entryId: "setting", title: "Town", content: "public lore", scope: "setting", tokenBudget: "small" },
  ]);
  assert.doesNotMatch(JSON.stringify(exported), /private prompt premise|private fact/);
  assert.throws(() => decodeSafeInterchange(JSON.stringify({ ...exported, entries: [] })), /hash/);
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
