import assert from "node:assert/strict";
import { lstat, mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { canonicalHash, canonicalJson, TavernArtifactStore, TavernRevisionConflict } from "./artifact-store.js";
import { type TavernArtifact, validateTavernArtifact } from "./types.js";

test("artifact store canonicalizes, atomically read-backs, and rejects revision conflicts", async () => {
  const root = await mkdtemp(join(tmpdir(), "tavern-store-"));
  try {
    const store = new TavernArtifactStore(root);
    const path = join(root, "tavern", "v1", "players", "p", "personas", "a.json");
    const artifact: TavernArtifact = { schemaVersion: 1 as const, revision: 1, personaId: "persona", name: "Player" };
    const written = await store.write(path, artifact, validateTavernArtifact);
    assert.equal(written.canonicalHash, canonicalHash(artifact));
    assert.equal((await store.read(path, validateTavernArtifact)).artifact.revision, 1);
    await assert.rejects(
      store.compareAndWrite(path, 0, { ...artifact, revision: 2 } as TavernArtifact, validateTavernArtifact),
      TavernRevisionConflict,
    );
    await assert.rejects(store.write(path, artifact, validateTavernArtifact), TavernRevisionConflict);
    await assert.rejects(store.read(join(root, "outside.json"), validateTavernArtifact));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test("artifact writes reject a symlinked parent and do not create through it", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "tavern-store-symlink-"));
  const outside = await mkdtemp(join(tmpdir(), "tavern-store-outside-"));
  try {
    const real = join(root, "real");
    const linked = join(root, "tavern");
    await mkdir(real);
    try {
      await symlink(outside, linked, process.platform === "win32" ? "junction" : "dir");
    } catch (error) {
      if (
        process.platform === "win32" &&
        error instanceof Error &&
        "code" in error &&
        ["EPERM", "EACCES", "ENOTSUP"].includes(String(error.code))
      ) {
        t.skip("Windows junction fixture creation is unsupported");
        return;
      }
      throw error;
    }
    const store = new TavernArtifactStore(root);
    await assert.rejects(
      store.write(
        join(linked, "v1", "artifact.json"),
        { schemaVersion: 1, revision: 1, personaId: "p", name: "Player" },
        validateTavernArtifact,
      ),
      /unsafe_path_boundary|tavern_artifact_unreadable/,
    );
    await assert.rejects(lstat(join(outside, "v1")), { code: "ENOENT" });
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("artifact writes reject a parent replaced between setup and lock boundary", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "tavern-store-replaced-"));
  try {
    const parent = join(root, "tavern");
    const moved = join(root, "moved");
    await mkdir(parent);
    await rename(parent, moved);
    try {
      await symlink(moved, parent, process.platform === "win32" ? "junction" : "dir");
    } catch (error) {
      if (
        process.platform === "win32" &&
        error instanceof Error &&
        "code" in error &&
        ["EPERM", "EACCES", "ENOTSUP"].includes(String(error.code))
      ) {
        t.skip("Windows junction fixture creation is unsupported");
        return;
      }
      throw error;
    }
    const store = new TavernArtifactStore(root);
    await assert.rejects(
      store.write(
        join(parent, "artifact.json"),
        { schemaVersion: 1, revision: 1, personaId: "p", name: "Player" },
        validateTavernArtifact,
      ),
      /unsafe_path_boundary|tavern_artifact_unreadable/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("artifact reads reject an envelope with unknown keys", async () => {
  const root = await mkdtemp(join(tmpdir(), "tavern-store-envelope-schema-"));
  try {
    const store = new TavernArtifactStore(root);
    const path = join(root, "tavern", "v1", "players", "p", "personas", "a.json");
    const artifact: TavernArtifact = { schemaVersion: 1, revision: 1, personaId: "persona", name: "Player" };
    const written = await store.write(path, artifact, validateTavernArtifact);
    await writeFile(path, canonicalJson({ ...written, unexpected: true }), "utf8");
    await assert.rejects(store.read(path, validateTavernArtifact), /invalid_tavern_artifact/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("compareAndWrite does not treat malformed existing JSON as a new artifact", async () => {
  const root = await mkdtemp(join(tmpdir(), "tavern-store-corrupt-"));
  try {
    const store = new TavernArtifactStore(root);
    const path = join(root, "tavern", "v1", "players", "p", "personas", "a.json");
    await mkdir(join(root, "tavern", "v1", "players", "p", "personas"), { recursive: true });
    await writeFile(path, "{ broken", "utf8");
    await assert.rejects(
      store.compareAndWrite(
        path,
        undefined,
        { schemaVersion: 1, revision: 1, personaId: "persona", name: "Player" },
        validateTavernArtifact,
      ),
      /tavern_artifact_unreadable/,
    );
    assert.equal(await readFile(path, "utf8"), "{ broken");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("artifact reads reject duplicate decoded envelope keys before validation", async () => {
  const root = await mkdtemp(join(tmpdir(), "tavern-store-duplicate-key-"));
  try {
    const store = new TavernArtifactStore(root);
    const path = join(root, "artifact.json");
    await writeFile(
      path,
      '{"schemaVersion":1,"schemaVersion":1,"revision":1,"canonicalHash":"x","artifact":{}}',
      "utf8",
    );
    await assert.rejects(store.read(path, validateTavernArtifact), /tavern_artifact_unreadable/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("revision repository rejects junk entries and never falls back from a corrupt highest numeric revision", async () => {
  const root = await mkdtemp(join(tmpdir(), "tavern-revisions-"));
  try {
    const store = new TavernArtifactStore(root);
    const repository = store.openRevisionRepository({
      root: join(root, "personas", "persona"),
      artifactKind: "persona",
      id: "persona",
      validateArtifact: validateTavernArtifact,
      matchesId: (artifact, id) => "personaId" in artifact && artifact.personaId === id,
      project: (artifact) => artifact.revision,
      invalidArtifact: () => new Error("invalid_persona_artifact"),
      conflict: () => new Error("persona_revision_conflict"),
    });
    await repository.create(() => ({ schemaVersion: 1, revision: 1, personaId: "persona", name: "One" }));
    await repository.update(1, (revision) => ({ schemaVersion: 1, revision, personaId: "persona", name: "Two" }));
    const revisions = join(root, "personas", "persona", "revisions");
    await writeFile(join(revisions, "2.json"), "{ corrupt", "utf8");
    await assert.rejects(repository.readLatest(), /invalid_persona_artifact/);
    await writeFile(join(revisions, "notes.txt"), "junk", "utf8");
    await assert.rejects(repository.readLatest(), /invalid_persona_artifact/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("revision repository rejects a corrupt lower numeric revision even when the highest revision is valid", async () => {
  const root = await mkdtemp(join(tmpdir(), "tavern-revisions-lower-corrupt-"));
  try {
    const store = new TavernArtifactStore(root);
    const repository = store.openRevisionRepository({
      root: join(root, "personas", "persona"),
      artifactKind: "persona",
      id: "persona",
      validateArtifact: validateTavernArtifact,
      matchesId: (artifact, id) => "personaId" in artifact && artifact.personaId === id,
      project: (artifact) => artifact.revision,
      invalidArtifact: () => new Error("invalid_persona_artifact"),
      conflict: () => new Error("persona_revision_conflict"),
    });
    await repository.create(() => ({ schemaVersion: 1, revision: 1, personaId: "persona", name: "One" }));
    await repository.update(1, (revision) => ({ schemaVersion: 1, revision, personaId: "persona", name: "Two" }));
    const revisions = join(root, "personas", "persona", "revisions");
    await writeFile(join(revisions, "1.json"), "{ corrupt", "utf8");
    await assert.rejects(repository.readLatest(), /invalid_persona_artifact/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("revision repository rejects a highest revision whose embedded identity or revision mismatches its filename", async () => {
  const root = await mkdtemp(join(tmpdir(), "tavern-revisions-mismatch-"));
  try {
    const store = new TavernArtifactStore(root);
    const repository = store.openRevisionRepository({
      root: join(root, "personas", "persona"),
      artifactKind: "persona",
      id: "persona",
      validateArtifact: validateTavernArtifact,
      matchesId: (artifact, id) => "personaId" in artifact && artifact.personaId === id,
      project: (artifact) => artifact.revision,
      invalidArtifact: () => new Error("invalid_persona_artifact"),
      conflict: () => new Error("persona_revision_conflict"),
    });
    await repository.create(() => ({ schemaVersion: 1, revision: 1, personaId: "persona", name: "One" }));
    const revisions = join(root, "personas", "persona", "revisions");
    const mismatchedId = { schemaVersion: 1 as const, revision: 2, personaId: "other", name: "Two" };
    await writeFile(
      join(revisions, "2.json"),
      canonicalJson({
        schemaVersion: 1,
        revision: 2,
        canonicalHash: canonicalHash(mismatchedId),
        artifact: mismatchedId,
      }),
      "utf8",
    );
    await assert.rejects(repository.readLatest(), /invalid_persona_artifact/);
    const mismatchedRevision = { schemaVersion: 1 as const, revision: 1, personaId: "persona", name: "Two" };
    await writeFile(
      join(revisions, "2.json"),
      canonicalJson({
        schemaVersion: 1,
        revision: 2,
        canonicalHash: canonicalHash(mismatchedRevision),
        artifact: mismatchedRevision,
      }),
      "utf8",
    );
    await assert.rejects(repository.readLatest(), /invalid_persona_artifact/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("canonical JSON has stable key ordering", () => {
  assert.equal(canonicalJson({ z: [{ b: 2, a: 1 }], a: true }), '{"a":true,"z":[{"a":1,"b":2}]}');
});
test("artifact validation rejects unsafe text and invalid opening references", () => {
  assert.throws(() => validateTavernArtifact({ schemaVersion: 1, revision: 1, personaId: "p", name: "bad\nname" }));
  assert.throws(() =>
    validateTavernArtifact({
      schemaVersion: 1,
      revision: 1,
      chatThreadId: "t",
      companionId: "c",
      continuityId: "x",
      openingSelection: { kind: "greeting", sourceRevision: 0, variantId: "v", messageId: "m" },
    }),
  );
});
