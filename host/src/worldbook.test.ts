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
  const execute = (tool: typeof catalog, params: unknown) =>
    tool.execute("call", params as never, new AbortController().signal, () => {}, {} as never);
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
