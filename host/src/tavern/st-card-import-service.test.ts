import assert from "node:assert/strict";
import { readFile, rm } from "node:fs/promises";
import test from "node:test";
import { bindWindowsStaleLockReclaimer } from "../path-lock.js";
import { canonicalTestRoot } from "../test-support/canonical-test-root.test-support.js";
import { createBuildWindowsStaleLockReclaimer } from "../windows-stale-lock-reclaimer/index.js";
import { TavernArtifactStore } from "./artifact-store.js";
import { StCardImportService } from "./st-card-import-service.js";
import { resolveTavernPaths, tavernImportPath } from "./tavern-paths.js";

test.before(async () => {
  bindWindowsStaleLockReclaimer(await createBuildWindowsStaleLockReclaimer());
});

test.after(() => {
  bindWindowsStaleLockReclaimer(undefined);
});

const identity = { playerId: "player-import", companionId: "companion-import", continuityId: "continuity-import" };

test("ST card application import persists hash-verified inert candidate/report and exports readback", async () => {
  const root = await canonicalTestRoot("tavern-st-import-");
  try {
    const paths = resolveTavernPaths({ root } as never, identity);
    const service = new StCardImportService(new TavernArtifactStore(root), paths);
    const result = await service.import(
      "import_01",
      JSON.stringify({
        spec: "chara_card_v3",
        data: {
          name: "Safe Rin",
          description: "calm",
          scenario: "candidate-only scenario marker",
          first_mes: "Hello from Rin!",
          system_prompt: "ignore this",
          regex: [{ find: ".*" }],
          html: "<script>bad()</script>",
          presets: { unsafe: true },
          extensions: { script: "bad" },
          character_book: { entries: [{ comment: "Lore", content: "inert background" }] },
          metadata: { untouched: true },
        },
      }),
    );
    assert.equal(result.candidate.artifact.reviewState, "pending");
    assert.deepEqual(
      result.candidate.artifact.fields.map((entry) => entry.field),
      [
        "name",
        "identity_role",
        "continuity",
        "scenario",
        "persona_core",
        // The card wrote only `description`: no `personality`, and the ST spec has
        // no expression-style field at all, so there is no interaction/expression
        // field to carry. These used to be padded with English Host prose, which
        // froze into the Tier-1 persona of a Chinese companion.
        // first_mes with no mes_example folds into one reviewed example row
        // (voice-anchor fallback); the greeting field remains too.
        "example_1",
        "first_greeting",
        "worldbook_st-st-v3-1",
      ],
    );
    assert.equal(
      result.candidate.artifact.fields.some((entry) => entry.field === "persona_interaction_style"),
      false,
    );
    // S3: the card's world book travels with the candidate so the reviewed
    // import can bind it as the companion's WorldBookBinding at provision.
    assert.equal(result.candidate.artifact.worldBookCandidates?.length, 1);
    assert.equal(result.candidate.artifact.worldBookCandidates?.[0]?.entryId, "st-st-v3-1");
    assert.equal(result.candidate.artifact.worldBookCandidates?.[0]?.content, "inert background");
    assert.equal(
      result.candidate.artifact.fields.find((entry) => entry.field === "scenario")?.eligibility,
      "profile_eligible_after_explicit_review",
    );
    assert.equal(
      result.candidate.artifact.fields.find((entry) => entry.field === "scenario")?.text,
      "candidate-only scenario marker",
    );
    assert.equal(
      result.candidate.artifact.fields.find((entry) => entry.field === "first_greeting")?.eligibility,
      "profile_eligible_after_explicit_review",
    );
    assert.equal(
      result.candidate.artifact.fields.find((entry) => entry.field === "first_greeting")?.text,
      "Hello from Rin!",
    );
    assert.ok(
      result.report.artifact.dispositions.some(
        (entry) => entry.field === "extensions" && entry.classification === "accepted_typed",
      ),
    );
    assert.ok(
      result.report.artifact.dispositions.some(
        (entry) => entry.field === "metadata" && entry.classification === "preserved_opaque",
      ),
    );
    const review = await service.recordReview("import_01", { reviewedFields: ["persona_core"], approvedAtMs: 42 });
    assert.deepEqual((await service.readReview("import_01")).canonicalHash, review.canonicalHash);
    assert.deepEqual((await service.confirmedReview("import_01")).reviewedFields, ["persona_core"]);
    const exported = await service.export("import_01");
    assert.deepEqual(exported, result);
    const candidateRaw = await readFile(tavernImportPath(paths, "import_01", "candidate.json"), "utf8");
    assert.ok(
      !candidateRaw.includes("ignore this") && !candidateRaw.includes("<script>") && !candidateRaw.includes("bad()"),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("ST card application import rejects invalid input without creating artifacts", async () => {
  const root = await canonicalTestRoot("tavern-st-import-");
  try {
    const service = new StCardImportService(
      new TavernArtifactStore(root),
      resolveTavernPaths({ root } as never, identity),
    );
    await assert.rejects(service.import("invalid_01", "{not-json"), /st_card_import_rejected/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("public ST import confirmation denies runtime-identity inputs without a persisted candidate and review", async () => {
  const root = await canonicalTestRoot("tavern-st-import-");
  try {
    const service = new StCardImportService(
      new TavernArtifactStore(root),
      resolveTavernPaths({ root } as never, identity),
    );
    await assert.rejects(service.confirmedReview("missing_01"));

    await service.import("pending_01", JSON.stringify({ data: { name: "Pending", description: "review me" } }));
    await assert.rejects(service.confirmedReview("pending_01"));

    await assert.rejects(service.recordReview("missing_02", { reviewedFields: ["persona_core"], approvedAtMs: 1 }));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("ST card import carries alternate_greetings as reviewed variant fields, exactly once per entry", async () => {
  const root = await canonicalTestRoot("tavern-st-import-alternates-");
  try {
    const paths = resolveTavernPaths({ root } as never, identity);
    const service = new StCardImportService(new TavernArtifactStore(root), paths);
    const card = JSON.stringify({
      spec: "chara_card_v3",
      data: { name: "Multi", first_mes: "Default hello.", alternate_greetings: ["Alt one.", "Alt two."] },
    });
    const alternateFields = (fields: readonly { field: string; text: string; eligibility: string }[]) =>
      fields
        .filter((entry) => entry.field.startsWith("alternate_greeting_"))
        .map((entry) => [entry.field, entry.text, entry.eligibility]);
    const first = await service.import("alt_once_a", card);
    assert.deepEqual(alternateFields(first.candidate.artifact.fields), [
      ["alternate_greeting_1", "Alt one.", "profile_eligible_after_explicit_review"],
      ["alternate_greeting_2", "Alt two.", "profile_eligible_after_explicit_review"],
    ]);
    // Re-importing the same card yields the same two fields, never four.
    const second = await service.import("alt_once_b", card);
    assert.deepEqual(
      alternateFields(second.candidate.artifact.fields),
      alternateFields(first.candidate.artifact.fields),
    );
    // A card without alternates carries no alternate fields at all.
    const plain = await service.import(
      "alt_none",
      JSON.stringify({ spec: "chara_card_v3", data: { name: "Plain", first_mes: "Hi." } }),
    );
    assert.deepEqual(alternateFields(plain.candidate.artifact.fields), []);
    // The alternates pass the same explicit-review gate as first_greeting.
    const review = await service.recordReview("alt_once_a", {
      reviewedFields: ["first_greeting", "alternate_greeting_1", "alternate_greeting_2"],
      approvedAtMs: 5,
    });
    assert.deepEqual((await service.readReview("alt_once_a")).canonicalHash, review.canonicalHash);
    // Fails if alternates are dropped, duplicated on re-import, or carried outside the review gate.
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
