import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import test from "node:test";
import { canonicalTestRoot } from "../../test-support/canonical-test-root.test-support.js";
import { TavernArtifactStore } from "../artifact-store.js";
import { validateTavernArtifact } from "../types.js";
import { createPersonaManagementService } from "./persona-management.js";

test("persona management creates a strict safe player projection and reads back its revision", async () => {
  const root = await canonicalTestRoot("persona-management-");
  try {
    const service = createPersonaManagementService(new TavernArtifactStore(root), root);

    const created = await service.create({ name: "Alex", description: "A calm farmer" });
    assert.deepEqual(created, { revision: 1, name: "Alex", description: "A calm farmer" });
    assert.deepEqual(await service.read(), created);
    assert.equal("personaId" in created, false);
    assert.equal("artifactId" in created, false);
    assert.equal("canonicalHash" in created, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("persona management creates canonical revision trees and updates exact revisions", async () => {
  const root = await canonicalTestRoot("persona-management-");
  try {
    const store = new TavernArtifactStore(root);
    const service = createPersonaManagementService(store, root);
    await service.create({ name: "Alex", description: "First" });
    const updated = await service.update({ expectedRevision: 1, name: "Alex", description: "Second" });
    assert.deepEqual(updated, { revision: 2, name: "Alex", description: "Second" });
    const personaId = `player-persona-${createHash("sha256").update(resolve(root), "utf8").digest("hex").slice(0, 32)}`;
    assert.equal(
      (await store.read(join(resolve(root), "personas", personaId, "revisions", "2.json"), validateTavernArtifact))
        .artifact.revision,
      2,
    );
    await assert.rejects(
      service.update({ expectedRevision: 1, name: "Alex", description: "Stale" }),
      /persona_revision_conflict/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("persona management fails closed when its highest numeric revision is corrupt", async () => {
  const root = await canonicalTestRoot("persona-management-");
  try {
    const store = new TavernArtifactStore(root);
    const service = createPersonaManagementService(store, root);
    await service.create({ name: "Alex", description: "First" });
    await service.update({ expectedRevision: 1, name: "Alex", description: "Second" });
    assert.deepEqual(await service.read(), { revision: 2, name: "Alex", description: "Second" });
    const personaId = `player-persona-${createHash("sha256").update(resolve(root), "utf8").digest("hex").slice(0, 32)}`;
    await writeFile(join(resolve(root), "personas", personaId, "revisions", "2.json"), "{ corrupt", "utf8");
    await assert.rejects(service.read(), /invalid_persona_artifact/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("persona management rejects nonnumeric revision-directory entries", async () => {
  const root = await canonicalTestRoot("persona-management-");
  try {
    const service = createPersonaManagementService(new TavernArtifactStore(root), root);
    await service.create({ name: "Alex" });
    const personaId = `player-persona-${createHash("sha256").update(resolve(root), "utf8").digest("hex").slice(0, 32)}`;
    await writeFile(join(resolve(root), "personas", personaId, "revisions", "notes.txt"), "junk", "utf8");
    await assert.rejects(service.read(), /invalid_persona_artifact/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("persona management rejects arbitrary fields, unsafe text, and duplicate creation", async () => {
  const root = await canonicalTestRoot("persona-management-");
  try {
    const service = createPersonaManagementService(new TavernArtifactStore(root), root);
    await assert.rejects(
      service.create({ name: "Alex", description: "safe", ignored: "field" } as never),
      /invalid_persona_request/,
    );
    await assert.rejects(service.create({ name: "Alex\n" }), /invalid_persona_request/);
    await service.create({ name: "Alex" });
    await assert.rejects(service.create({ name: "Taylor" }), /persona_already_exists/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
