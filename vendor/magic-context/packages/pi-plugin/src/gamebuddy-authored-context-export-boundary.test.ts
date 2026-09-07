import { expect, it } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

it("keeps authored bridge out of the ordinary extension entry", async () => {
  const source = await readFile(join(import.meta.dirname, "index.ts"), "utf8");
  expect(source).not.toContain("publishGameBuddyAuthoredStableCatalog");
  expect(source).not.toContain("gamebuddy-authored-context-bridge.internal");
});
