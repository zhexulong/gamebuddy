import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createWorldInfoManagementRepository } from "../world-info-management/world-info-management.js";
import { createManagedWorldInfoBindingResolver } from "./managed-world-info-binding.js";

const first = {
  publicTitle: "Pelican Town",
  summary: "A small valley town.",
  entries: [{ scope: "setting" as const, publicTitle: "Square", summary: "Town center." }],
};

test("managed resolver binds and resolves the exact immutable revision rather than latest", async () => {
  const root = await mkdtemp(join(tmpdir(), "managed-world-info-binding-"));
  try {
    const repository = createWorldInfoManagementRepository(root);
    await repository.create(first);
    const resolver = createManagedWorldInfoBindingResolver(repository);
    const binding = await resolver.bind("Pelican Town");
    const initial = await resolver.resolve(binding);
    await repository.update("Pelican Town", {
      expectedRevision: 1,
      publicTitle: "Pelican Town",
      summary: "An updated town.",
      entries: [],
    });
    assert.equal((await resolver.resolve(binding)).content, initial.content);
    await assert.rejects(() => resolver.resolve({ ...binding, canonicalHash: "a".repeat(64) }), /binding_mismatch/);
    await assert.rejects(() => resolver.resolve({ ...binding, revision: 3 }), /revision_missing/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
