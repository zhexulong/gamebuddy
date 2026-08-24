import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { readPublishedStardewActionIds } from "./stardew-published-action-registry.mjs";

const registry = `
const publishedAction = () => undefined;
const experimentalAction = () => undefined;
const isMaterializablePublishedAction = () => true;
export const STARDEW_ACTION_REGISTRY = Object.freeze([
  publishedAction("move_to_tile"),
  experimentalAction("not_published"),
  publishedAction("till_soil"),
]);
export const PUBLISHED_STARDEW_ACTIONS = Object.freeze(
  STARDEW_ACTION_REGISTRY.filter(isMaterializablePublishedAction),
);
`;

async function withRegistry(source, run) {
  const root = await mkdtemp(join(tmpdir(), "gamebuddy-action-registry-"));
  const path = join(root, "action-registry.ts");
  try {
    await writeFile(path, source, "utf8");
    return await run(path);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("published action registry extraction is AST-based and excludes non-published calls", async () => {
  await withRegistry(registry, async (registryPath) => {
    assert.deepEqual(await readPublishedStardewActionIds({ registryPath }), ["move_to_tile", "till_soil"]);
  });
});

test("published action registry extraction fails closed for a source token without the typed projection", async () => {
  await withRegistry(
    registry.replace("STARDEW_ACTION_REGISTRY.filter(isMaterializablePublishedAction)", "STARDEW_ACTION_REGISTRY"),
    async (registryPath) => {
      await assert.rejects(readPublishedStardewActionIds({ registryPath }), /invalid_published_projection/);
    },
  );
});

test("published action registry extraction rejects duplicate published identifiers", async () => {
  await withRegistry(
    registry.replace('publishedAction("till_soil")', 'publishedAction("move_to_tile")'),
    async (registryPath) => {
      await assert.rejects(readPublishedStardewActionIds({ registryPath }), /invalid_published_set/);
    },
  );
});
