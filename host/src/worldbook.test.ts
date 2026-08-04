import assert from "node:assert/strict";
import test from "node:test";
import { createWorldBookTools, validateWorldBook, worldBookMetadata } from "./worldbook.js";

const book = validateWorldBook({
  schemaVersion: 1, worldBookId: "worldbook_01", revision: 1, alwaysOnPremise: "A small reviewed premise.",
  entries: [
    { entryId: "companion", title: "Companion background", content: "Always visible background.", scope: "companion", provenance: "authored", tokenBudget: "small" },
    { entryId: "world-a", title: "World A", content: "Scoped background.", scope: "world", provenance: "reviewed-import", tokenBudget: "small", integrationId: "stardew", saveId: "save_a", worldId: "world_a" },
  ],
});

test("WorldBook catalog/query are bounded and current-world scoped", async () => {
  const [catalog, query] = createWorldBookTools({ metadata: worldBookMetadata(book), book }, { integrationId: "stardew", saveId: "save_b", worldId: "world_b" });
  const execute = (tool: typeof catalog, params: unknown) => tool.execute("call", params as never, new AbortController().signal, () => {}, {} as never);
  const catalogResult = await execute(catalog, {});
  assert.deepEqual(JSON.parse((catalogResult.content[0]! as { text: string }).text).entries.map((entry: { entryId: string }) => entry.entryId), ["companion"]);
  const queryResult = await execute(query, { entryId: "companion" });
  assert.equal(JSON.parse((queryResult.content[0]! as { text: string }).text).entries[0].content, "Always visible background.");
  const hidden = await execute(query, { entryId: "world-a" });
  assert.deepEqual(JSON.parse((hidden.content[0]! as { text: string }).text).entries, []);
  await assert.rejects(() => execute(query, {}), /worldbook_query_selector_required/);
});

test("WorldBook rejects scope drift and duplicate entries", () => {
  assert.throws(() => validateWorldBook({ ...book, entries: [...book.entries, book.entries[0]] }), /invalid_worldbook/);
  assert.throws(() => validateWorldBook({ ...book, entries: [{ ...book.entries[1], saveId: undefined }] }), /invalid_worldbook/);
});
