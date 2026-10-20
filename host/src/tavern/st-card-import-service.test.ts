import assert from "node:assert/strict";
import { readFile, rm } from "node:fs/promises";
import test from "node:test";
import { identityProfileMetadata } from "../identity-profile.js";
import { bindWindowsStaleLockReclaimer } from "../path-lock.js";
import { resolveRuntimePaths } from "../runtime.js";
import { canonicalTestRoot } from "../test-support/canonical-test-root.test-support.js";
import { createBuildWindowsStaleLockReclaimer } from "../windows-stale-lock-reclaimer/index.js";
import { TavernArtifactStore } from "./artifact-store.js";
import { createChatThreadStore } from "./chat-thread-store.js";
import { createGreetingManagementService } from "./greeting-management/greeting-management.js";
import { createTavernLibraryService } from "./library-service.js";
import { provisionNewCompanion } from "./new-companion-service.js";
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
          character_book: {
            entries: [{ comment: "Lore", content: "inert background", keys: ["harvest", "spring"] }],
          },
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
        // The card's own performance directive, shown in review beside the
        // persona and carried into the profile as `characterVoice`.
        "system_prompt",
        "persona_core",
        // The card wrote only `description`: no `personality`, and the ST spec has
        // no expression-style field at all, so there is no interaction/expression
        // field to carry. These used to be padded with English Host prose, which
        // froze into the Tier-1 persona of a Chinese companion.
        // `first_mes` with no `mes_example` is the greeting and nothing else: the
        // voice-anchor fallback that used to add an `example_1` row here is gone.
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
    // The card's own trigger words are a real ST v3 world-book field, not a
    // decoration: they are what a keyword-gated entry fires on, so they must
    // survive the persistence boundary. Before this assertion the candidate's
    // `only()` allowlist refused `keys` and the whole import died with a bare
    // `invalid_tavern_artifact` — the shipped default card carries `keys`.
    const candidateJson = JSON.parse(
      await readFile(tavernImportPath(paths, "import_01", "candidate.json"), "utf8"),
    ) as {
      artifact: { worldBookCandidates: readonly { keys?: readonly string[] }[] };
    };
    assert.deepEqual(candidateJson.artifact.worldBookCandidates[0]?.keys, ["harvest", "spring"]);
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
    // Dropped executable/prompt-control fields never reach the persisted
    // candidate...
    assert.ok(!candidateRaw.includes("<script>") && !candidateRaw.includes("bad()"));
    // ...while the card's own `system_prompt` is now a reviewed field, so it does.
    assert.ok(candidateRaw.includes("ignore this"));
    assert.equal(
      result.candidate.artifact.fields.find((entry) => entry.field === "system_prompt")?.eligibility,
      "profile_eligible_after_explicit_review",
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

/**
 * A staged card always offers **something** for the player to approve.
 *
 * This is not a detail of the importer: the browser's import review calls
 * `character.import.review` only when the staged response lists at least one
 * profile-eligible field, and then calls `confirm`, which the Host refuses
 * without a recorded review. So a card whose eligible list came back empty would
 * turn a legitimate import into a bare failure with no review written - the
 * shape of defect this suite exists to keep out. Two facts hold it up, and both
 * are asserted here rather than assumed:
 *
 *  - `candidateFromReport` pushes the card's own `name` as
 *    `profile_eligible_after_explicit_review` unconditionally, however little
 *    else the card carries;
 *  - `field()` keeps a field whose text is empty, so an unnamed-in-effect card
 *    still has a row.
 */
test("a staged card always offers at least its own name for review", async () => {
  const root = await canonicalTestRoot("tavern-st-import-review-");
  try {
    const paths = resolveTavernPaths({ root } as never, identity);
    const service = new StCardImportService(new TavernArtifactStore(root), paths);
    // The smallest card the ST shape admits: a name and nothing else.
    const staged = await service.import(
      "import_min",
      JSON.stringify({ spec: "chara_card_v3", data: { name: "Only" } }),
    );
    const eligible = staged.candidate.artifact.fields
      .filter((entry) => entry.eligibility === "profile_eligible_after_explicit_review")
      .map((entry) => entry.field);
    assert.ok(eligible.length > 0, `a staged card must offer a reviewable field; got ${JSON.stringify(eligible)}`);
    assert.ok(eligible.includes("name"), `the card's own name is always reviewable; got ${JSON.stringify(eligible)}`);
    // …and the review the browser would record is accepted by the Host, which is
    // the half that fails today if the list above were ever empty.
    await service.recordReview("import_min", { reviewedFields: eligible, approvedAtMs: 1 });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

/**
 * The opening a card wrote is the greeting, and nothing more.
 *
 * A card that ships `first_mes` and no `mes_example` used to have the whole
 * opening folded into one reviewed `example_1` row as a "voice anchor". An
 * opening is scene-setting prose, so that few-shot taught the model that a reply
 * IS that long, and short conversations came back as long, self-narrating turns.
 * These three facts hold the fix up: there is no example row, no loss is hidden
 * behind its absence, and the opening still reaches the greeting set and the
 * Chat's own Message 0.
 */
test("a companion provisioned from a card with first_mes and no mes_example opens on that greeting with no example row", async () => {
  const root = await canonicalTestRoot("tavern-st-import-greeting-");
  let threads: ReturnType<typeof createChatThreadStore> | undefined;
  try {
    const paths = resolveTavernPaths({ root } as never, identity);
    const service = new StCardImportService(new TavernArtifactStore(root), paths);
    // The common real shape: a written opening, and no `mes_example` at all.
    const opening = "*The screen door creaks open.* Morning - the parsnips are up.";
    const imported = await service.import(
      "import_greeting",
      JSON.stringify({
        spec: "chara_card_v3",
        data: { name: "Greeting Rae", description: "Quiet, attentive.", first_mes: opening },
      }),
    );
    // (a) No example row exists for this card - not the opening, and nothing
    // derived from it - so the reviewed field list is the greeting and no more.
    assert.deepEqual(
      imported.candidate.artifact.fields.map((field) => field.field),
      ["name", "identity_role", "continuity", "persona_core", "first_greeting"],
    );
    // (b) Nothing is hidden behind that absence: no loss is recorded, and no
    // disposition claims the card's absent `mes_example` was read from anywhere.
    assert.equal("losses" in imported.report.artifact, false);
    assert.deepEqual(
      imported.report.artifact.dispositions.filter((entry) => entry.field === "mes_example"),
      [],
    );
    // (c) The opening still seeds the greeting path: the provisioned companion
    // owns it as the greeting set's only variant AND as its Message 0.
    await service.recordReview("import_greeting", {
      reviewedFields: ["name", "persona_core", "first_greeting"],
      approvedAtMs: 7,
    });
    threads = createChatThreadStore(root, "import-greeting");
    const provisioned = await provisionNewCompanion(
      root,
      identity.playerId,
      imported.candidate.artifact,
      await service.confirmedReview("import_greeting"),
      threads,
    );
    const tavernPaths = resolveTavernPaths(resolveRuntimePaths(provisioned.identity, root), provisioned.identity);
    const greeting = await createGreetingManagementService(
      new TavernArtifactStore(root),
      tavernPaths.companionRoot,
    ).read();
    assert.deepEqual(
      greeting?.variants.map((variant) => variant.text),
      [opening],
    );
    const library = createTavernLibraryService(tavernPaths, new TavernArtifactStore(root), threads, {
      async readExact() {
        return identityProfileMetadata(provisioned.profile);
      },
    });
    const chat = await library.createNewChat({
      chatThreadId: "thread-greeting",
      chatSurfaceSessionId: "surface-greeting",
    });
    assert.equal(chat.messages[0]?.kind, "opening");
    assert.equal(chat.messages[0]?.text, opening);
  } finally {
    threads?.close?.();
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
