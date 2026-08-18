import assert from "node:assert/strict";
import test from "node:test";
import { validateTavernArtifact } from "./types.js";

test("Scenario requires canonical name and description metadata", () => {
  const canonical = {
    schemaVersion: 1,
    revision: 1,
    scenarioId: "scenario",
    name: "Quiet room",
    description: "A quiet room.",
    text: "A quiet room.",
    provenance: "authored" as const,
    owner: "companion_default" as const,
  };
  assert.deepEqual(validateTavernArtifact(canonical), canonical);
  assert.throws(() => validateTavernArtifact({ ...canonical, name: undefined }), /invalid_tavern_artifact/);
  assert.throws(() => validateTavernArtifact({ ...canonical, description: undefined }), /invalid_tavern_artifact/);
  assert.throws(() => validateTavernArtifact({ ...canonical, name: 42 }), /invalid_tavern_artifact/);
  assert.throws(() => validateTavernArtifact({ ...canonical, description: 42 }), /invalid_tavern_artifact/);
  assert.throws(() => validateTavernArtifact({ ...canonical, description: "unsafe\ntext" }), /invalid_tavern_artifact/);
  assert.throws(() => validateTavernArtifact({ ...canonical, script: "run()" }), /invalid_tavern_artifact/);
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

test("Every canonical Tavern artifact root and nested record rejects unknown keys", () => {
  const artifacts = [
    {
      schemaVersion: 1,
      revision: 1,
      candidateId: "candidate",
      sourceFormat: "st-v3",
      sourceVersion: "3",
      sourceHash: "a".repeat(64),
      name: "Name",
      reviewState: "pending",
      fields: [{ field: "name", text: "Name", eligibility: "candidate_only" }],
    },
    {
      schemaVersion: 1,
      revision: 1,
      importId: "import",
      candidateId: "candidate",
      candidateRevision: 1,
      sourceHash: "a".repeat(64),
      reviewedFields: ["name"],
      approvedAtMs: 1,
    },
    {
      schemaVersion: 1,
      revision: 1,
      importId: "import",
      source: "json",
      sourceHash: "a".repeat(64),
      dispositions: [{ field: "name", classification: "accepted_typed", reason: "safe" }],
    },
    {
      schemaVersion: 1,
      revision: 1,
      companionId: "companion",
      continuityId: "continuity",
      name: "Name",
      profileId: "profile",
      profileRevision: 1,
      profileHash: "a".repeat(64),
    },
    { schemaVersion: 1, revision: 1, personaId: "persona", name: "Name" },
    {
      schemaVersion: 1,
      revision: 1,
      scenarioId: "scenario",
      name: "Name",
      description: "Description",
      text: "Text",
      provenance: "authored",
      owner: "companion_default",
    },
    { schemaVersion: 1, revision: 1, examplesId: "examples", blocks: ["Example"] },
    { schemaVersion: 1, revision: 1, greetingSetId: "greetings", variants: [{ variantId: "variant", text: "Hello" }] },
    {
      schemaVersion: 1,
      revision: 1,
      chatThreadId: "thread",
      companionId: "companion",
      continuityId: "continuity",
      openingSelection: { kind: "greeting", sourceRevision: 1, variantId: "variant", messageId: "message" },
    },
  ];
  for (const artifact of artifacts)
    assert.throws(() => validateTavernArtifact({ ...artifact, unexpected: true }), /invalid_tavern_artifact/);

  const nested = [
    {
      schemaVersion: 1,
      revision: 1,
      candidateId: "candidate",
      sourceFormat: "st-v3",
      sourceVersion: "3",
      sourceHash: "a".repeat(64),
      name: "Name",
      reviewState: "pending",
      fields: [{ field: "name", text: "Name", eligibility: "candidate_only", unexpected: true }],
    },
    {
      schemaVersion: 1,
      revision: 1,
      importId: "import",
      source: "json",
      sourceHash: "a".repeat(64),
      dispositions: [{ field: "name", classification: "accepted_typed", reason: "safe", unexpected: true }],
    },
    {
      schemaVersion: 1,
      revision: 1,
      greetingSetId: "greetings",
      variants: [{ variantId: "variant", text: "Hello", unexpected: true }],
    },
    {
      schemaVersion: 1,
      revision: 1,
      chatThreadId: "thread",
      companionId: "companion",
      continuityId: "continuity",
      openingSelection: { kind: "blank", unexpected: true },
    },
  ];
  for (const artifact of nested) assert.throws(() => validateTavernArtifact(artifact), /invalid_tavern_artifact/);
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
