import assert from "node:assert/strict";
import test from "node:test";
import { validateTavernArtifact } from "./types.js";

test("Scenario preserves legacy fields and accepts durable player metadata only as safe optional fields", () => {
  const legacy = {
    schemaVersion: 1,
    revision: 1,
    scenarioId: "scenario",
    text: "A quiet room.",
    provenance: "authored" as const,
    owner: "companion_default" as const,
  };
  assert.deepEqual(validateTavernArtifact(legacy), legacy);

  const managed = { ...legacy, name: "Quiet room", description: "A quiet room." };
  assert.deepEqual(validateTavernArtifact(managed), managed);
  assert.throws(() => validateTavernArtifact({ ...managed, name: 42 }), /invalid_tavern_artifact/);
  assert.throws(() => validateTavernArtifact({ ...managed, description: 42 }), /invalid_tavern_artifact/);
  assert.throws(() => validateTavernArtifact({ ...managed, description: "unsafe\ntext" }), /invalid_tavern_artifact/);
  assert.throws(() => validateTavernArtifact({ ...managed, script: "run()" }), /invalid_tavern_artifact/);
});

test("Persona, greeting, import, and thread optional fields are narrowed and forwarded", () => {
  const persona = { schemaVersion: 1, revision: 1, personaId: "persona", name: "Player", description: "Curious." };
  assert.deepEqual(validateTavernArtifact(persona), persona);

  const greeting = {
    schemaVersion: 1,
    revision: 1,
    greetingSetId: "greetings",
    label: "Openings",
    variants: [{ variantId: "hello", label: "Warm", text: "Hello." }],
  };
  assert.deepEqual(validateTavernArtifact(greeting), greeting);

  const importRecord = {
    schemaVersion: 1,
    revision: 1,
    importId: "import",
    source: "json" as const,
    sourceFormat: "st-v3" as const,
    sourceHash: "a".repeat(64),
    dispositions: [{ field: "name", classification: "accepted_typed" as const, reason: "safe" }],
  };
  assert.deepEqual(validateTavernArtifact(importRecord), importRecord);

  const thread = {
    schemaVersion: 1,
    revision: 1,
    chatThreadId: "thread",
    companionId: "companion",
    continuityId: "continuity",
    personaId: "persona",
    scenarioId: "scenario",
    openingSelection: { kind: "blank" as const },
    openingLockedAtEventId: "event",
  };
  assert.deepEqual(validateTavernArtifact(thread), thread);
});

test("Optional Tavern fields reject non-string values without weakening unknown-field rejection", () => {
  const persona = { schemaVersion: 1, revision: 1, personaId: "persona", name: "Player" };
  assert.throws(() => validateTavernArtifact({ ...persona, description: 1 }), /invalid_tavern_artifact/);

  const greeting = {
    schemaVersion: 1,
    revision: 1,
    greetingSetId: "greetings",
    variants: [{ variantId: "hello", text: "Hello." }],
  };
  assert.throws(() => validateTavernArtifact({ ...greeting, label: false }), /invalid_tavern_artifact/);
  assert.throws(
    () => validateTavernArtifact({ ...greeting, variants: [{ variantId: "hello", text: "Hello.", label: 1 }] }),
    /invalid_tavern_artifact/,
  );

  const importRecord = {
    schemaVersion: 1,
    revision: 1,
    importId: "import",
    source: "json" as const,
    sourceHash: "a".repeat(64),
    dispositions: [],
  };
  assert.throws(() => validateTavernArtifact({ ...importRecord, sourceFormat: 3 }), /invalid_tavern_artifact/);

  const thread = {
    schemaVersion: 1,
    revision: 1,
    chatThreadId: "thread",
    companionId: "companion",
    continuityId: "continuity",
    openingSelection: { kind: "blank" as const },
  };
  assert.throws(() => validateTavernArtifact({ ...thread, personaId: 1 }), /invalid_tavern_artifact/);
  assert.throws(() => validateTavernArtifact({ ...thread, scenarioId: false }), /invalid_tavern_artifact/);
  assert.throws(() => validateTavernArtifact({ ...thread, openingLockedAtEventId: {} }), /invalid_tavern_artifact/);
});
