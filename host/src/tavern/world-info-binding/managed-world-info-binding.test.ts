import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import test from "node:test";
import { canonicalTestRoot } from "../../test-support/canonical-test-root.test-support.js";
import { createWorldInfoManagementRepository } from "../world-info-management/world-info-management.js";
import { createManagedWorldInfoBindingResolver } from "./managed-world-info-binding.js";

const first = {
  publicTitle: "Pelican Town",
  summary: "A small valley town.",
  entries: [{ scope: "setting" as const, publicTitle: "Square", summary: "Town center." }],
};

test("managed resolver binds the exact immutable revision and never re-resolves as latest", async () => {
  const root = await canonicalTestRoot("managed-world-info-binding-");
  try {
    const repository = createWorldInfoManagementRepository(root);
    await repository.create(first);
    const resolver = createManagedWorldInfoBindingResolver(repository);
    const binding = await resolver.bindExact("Pelican Town", 1);
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

test("bindExact stays pinned to the named revision after a later revision exists", async () => {
  const root = await canonicalTestRoot("managed-world-info-binding-exact-");
  try {
    const repository = createWorldInfoManagementRepository(root);
    await repository.create(first);
    await repository.update("Pelican Town", {
      expectedRevision: 1,
      publicTitle: "Pelican Town",
      summary: "An updated town.",
      entries: [],
    });
    const resolver = createManagedWorldInfoBindingResolver(repository);
    const binding = await resolver.bindExact("Pelican Town", 1);
    assert.equal(binding.revision, 1);
    const resolved = await resolver.resolve(binding);
    assert.equal(resolved.binding.revision, 1);
    assert.match(resolved.content, /A small valley town\./);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("bindExact fails closed for an absent or invalid revision", async () => {
  const root = await canonicalTestRoot("managed-world-info-binding-absent-");
  try {
    const repository = createWorldInfoManagementRepository(root);
    await repository.create(first);
    const resolver = createManagedWorldInfoBindingResolver(repository);
    await assert.rejects(() => resolver.bindExact("Pelican Town", 2), /managed_world_info_revision_missing/);
    await assert.rejects(() => resolver.bindExact("Pelican Town", 0), /managed_world_info_revision_missing/);
    await assert.rejects(() => resolver.bindExact("Pelican Town", 1.5), /managed_world_info_revision_missing/);
    await assert.rejects(() => resolver.bindExact("No Such Town", 1), /managed_world_info_revision_missing/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
