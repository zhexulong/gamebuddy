import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  createWorldBookTools,
  readWorldBook,
  validateWorldBook,
  worldBookMetadata,
  writeWorldBook,
} from "./worldbook.js";

const book = validateWorldBook({
  schemaVersion: 1,
  worldBookId: "worldbook_01",
  revision: 1,
  alwaysOnPremise: "A small reviewed premise.",
  entries: [
    {
      entryId: "companion",
      title: "Companion background",
      content: "Always visible background.",
      scope: "companion",
      provenance: "authored",
      tokenBudget: "small",
    },
    {
      entryId: "world-a",
      title: "World A",
      content: "Scoped background.",
      scope: "world",
      provenance: "reviewed-import",
      tokenBudget: "small",
      integrationId: "stardew",
      saveId: "save_a",
      worldId: "world_a",
    },
  ],
});

test("WorldBook catalog/query are bounded and current-world scoped", async () => {
  const [catalog, query] = createWorldBookTools(
    { metadata: worldBookMetadata(book), book },
    { integrationId: "stardew", saveId: "save_b", worldId: "world_b" },
  );
  const execute = (tool: typeof catalog, params: unknown) => {
    assert.ok(tool);
    return tool.execute("call", params as never, new AbortController().signal, () => {}, {} as never);
  };
  const catalogResult = await execute(catalog, {});
  assert.deepEqual(
    JSON.parse((catalogResult.content[0]! as { text: string }).text).entries.map(
      (entry: { entryId: string }) => entry.entryId,
    ),
    ["companion"],
  );
  const queryResult = await execute(query, { entryId: "companion" });
  assert.equal(
    JSON.parse((queryResult.content[0]! as { text: string }).text).entries[0].content,
    "Always visible background.",
  );
  const hidden = await execute(query, { entryId: "world-a" });
  assert.deepEqual(JSON.parse((hidden.content[0]! as { text: string }).text).entries, []);
  await assert.rejects(() => execute(query, {}), /worldbook_query_selector_required/);
});

test("WorldBook query renders macros and omits an entry that cannot be rendered", async () => {
  // The failure this catches: the query tool used to return `entry.content`
  // verbatim, so a `{{user}}`-bearing entry reached the model as a literal brace
  // placeholder in a tool result.
  const macroBook = validateWorldBook({
    schemaVersion: 1,
    worldBookId: "worldbook_macro",
    revision: 1,
    alwaysOnPremise: "",
    entries: [
      {
        entryId: "macro",
        title: "Pact",
        content: "{{char}} and {{user}} farm together.",
        scope: "setting",
        provenance: "st-card-import",
        tokenBudget: "small",
      },
      {
        entryId: "broken",
        title: "Broken",
        content: "A {{unknown}} reference.",
        scope: "setting",
        provenance: "st-card-import",
        tokenBudget: "small",
      },
    ],
  });
  const [, query] = createWorldBookTools({ metadata: worldBookMetadata(macroBook), book: macroBook }, undefined, {
    char: "Kohaku",
  });
  const execute = (tool: typeof query, params: unknown) => {
    assert.ok(tool);
    return tool.execute("call", params as never, new AbortController().signal, () => {}, {} as never);
  };
  const rendered = await execute(query, { entryId: "macro" });
  const renderedEntry = JSON.parse((rendered.content[0]! as { text: string }).text).entries[0] as { content: string };
  assert.equal(renderedEntry.content, "Kohaku and you farm together.");
  assert.doesNotMatch(renderedEntry.content, /\{\{/u);
  const omitted = await execute(query, { entryId: "broken" });
  assert.deepEqual(JSON.parse((omitted.content[0]! as { text: string }).text).entries, []);
});

test("a world-book entry carries the card's secondary selection gate and refuses a malformed one", () => {
  // The durable record is where an imported card's selection rule has to live: the
  // per-turn selector reads the entry through this file, so a field this validator does
  // not carry is a rule the companion can never honour.
  const gated = validateWorldBook({
    ...book,
    entries: [{ ...book.entries[0], secondaryKeys: ["tea", "porch"], selectiveLogic: 0 }],
  });
  assert.deepEqual(gated.entries[0]?.secondaryKeys, ["tea", "porch"]);
  assert.equal(gated.entries[0]?.selectiveLogic, 0);
  // A gate with no word in it, a blank word, or a mode outside SillyTavern's four is
  // refused rather than degraded to "no gate": an entry silently widened that way
  // selects in exactly the situations its author excluded.
  for (const secondaryKeys of [[], [""], [123]]) {
    assert.throws(
      () => validateWorldBook({ ...book, entries: [{ ...book.entries[0], secondaryKeys }] }),
      /invalid_worldbook/,
    );
  }
  for (const selectiveLogic of [4, -1, 1.5]) {
    assert.throws(
      () => validateWorldBook({ ...book, entries: [{ ...book.entries[0], selectiveLogic }] }),
      /invalid_worldbook/,
    );
  }
});

test("WorldBook rejects scope drift and duplicate entries", () => {
  assert.throws(() => validateWorldBook({ ...book, entries: [...book.entries, book.entries[0]] }), /invalid_worldbook/);
  assert.throws(
    () => validateWorldBook({ ...book, entries: [{ ...book.entries[1], saveId: undefined }] }),
    /invalid_worldbook/,
  );
});

test("readWorldBook reads manual JSON without canonicalHash, writeWorldBook persists canonicalHash", async () => {
  const dir = await mkdtemp(join(tmpdir(), "worldbook-test-"));
  const filePath = join(dir, "worldbook.json");
  try {
    const manualJson = {
      schemaVersion: 1,
      worldBookId: "manual_worldbook",
      revision: 1,
      alwaysOnPremise: "Manual premise without hash.",
      entries: [
        {
          entryId: "manual_entry",
          title: "Manual Title",
          content: "Manual Content",
          scope: "companion",
          provenance: "authored",
          tokenBudget: "small",
        },
      ],
    };
    await writeFile(filePath, JSON.stringify(manualJson), "utf8");
    const loaded = await readWorldBook(filePath);
    assert.equal(loaded.worldBookId, "manual_worldbook");
    assert.equal(loaded.alwaysOnPremise, "Manual premise without hash.");
    assert.equal(loaded.entries.length, 1);
    assert.equal(loaded.entries[0]!.title, "Manual Title");

    await writeWorldBook(filePath, loaded);
    const rawWritten = JSON.parse(await readFile(filePath, "utf8")) as Record<string, unknown>;
    assert.ok(typeof rawWritten.canonicalHash === "string" && rawWritten.canonicalHash.length > 0);

    const reloaded = await readWorldBook(filePath);
    assert.deepEqual(reloaded, loaded);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test("WorldBook tools never echo always-on content back (S3: it already rides Tier 2 m[0])", async () => {
  const constantBook = validateWorldBook({
    schemaVersion: 1,
    worldBookId: "worldbook_constant",
    revision: 1,
    alwaysOnPremise: "The valley premise that lives in the m[0] lorebook_constant source.",
    entries: [
      {
        entryId: "kohaku-entry-10",
        title: "开拓同盟与农场誓约",
        content: "琥珀与玩家是共同开拓农场的青梅竹马合伙人。",
        scope: "setting",
        provenance: "reviewed-import",
        tokenBudget: "small",
        constant: true,
      },
      {
        entryId: "kohaku-entry-1",
        title: "雨天安排",
        content: "雨天喜欢在门廊煮热茶看雨。",
        scope: "setting",
        provenance: "reviewed-import",
        tokenBudget: "small",
      },
    ],
  });
  const [catalog, query] = createWorldBookTools({ metadata: worldBookMetadata(constantBook), book: constantBook });
  const execute = (tool: typeof catalog, params: unknown) => {
    assert.ok(tool);
    return tool.execute("call", params as never, new AbortController().signal, () => {}, {} as never);
  };
  // The catalog omits the constant entry (deduplicated against m[0]) and no
  // longer re-sends the premise.
  const catalogResult = await execute(catalog, {});
  const catalogBody = JSON.parse((catalogResult.content[0]! as { text: string }).text);
  assert.deepEqual(
    catalogBody.entries.map((entry: { entryId: string }) => entry.entryId),
    ["kohaku-entry-1"],
  );
  assert.equal(Object.hasOwn(catalogBody, "alwaysOnPremise"), false);
  // Query still serves full text on demand, including the constant entry.
  const viaTopic = await execute(query, { topic: "农场" });
  assert.equal(
    JSON.parse((viaTopic.content[0]! as { text: string }).text).entries[0].content,
    "琥珀与玩家是共同开拓农场的青梅竹马合伙人。",
  );
  const viaId = await execute(query, { entryId: "kohaku-entry-1" });
  assert.equal(JSON.parse((viaId.content[0]! as { text: string }).text).entries[0].entryId, "kohaku-entry-1");
});
