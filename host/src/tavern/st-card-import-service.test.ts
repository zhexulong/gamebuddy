import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import test from "node:test";
import { identityProfileMetadata, renderIdentityProfile } from "../identity-profile.js";
import { bindWindowsStaleLockReclaimer } from "../path-lock.js";
import { identityKey, resolveRuntimePaths } from "../runtime.js";
import { canonicalTestRoot } from "../test-support/canonical-test-root.test-support.js";
import { createBuildWindowsStaleLockReclaimer } from "../windows-stale-lock-reclaimer/index.js";
import { TavernArtifactStore } from "./artifact-store.js";
import { createChatThreadStore } from "./chat-thread-store.js";
import { createGreetingManagementService } from "./greeting-management/greeting-management.js";
import { createTavernLibraryService } from "./library-service.js";
import { macroTable, renderMacros } from "./macro-engine.js";
import { provisionNewCompanion } from "./new-companion-service.js";
import { StCardImportService } from "./st-card-import-service.js";
import { resolveTavernPaths, tavernImportPath } from "./tavern-paths.js";

test.before(async () => {
  bindWindowsStaleLockReclaimer(await createBuildWindowsStaleLockReclaimer());
});

test.after(() => {
  bindWindowsStaleLockReclaimer(undefined);
});

/** The persona block the model reads, as the one reader prints it. */
function renderedPersona(profile: Parameters<typeof renderIdentityProfile>[0]): string {
  return renderIdentityProfile(profile, "zh-CN");
}

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
      artifact: {
        worldBookCandidates: readonly { keys?: readonly string[] }[];
        extensions?: Readonly<Record<string, unknown>>;
      };
    };
    assert.deepEqual(candidateJson.artifact.worldBookCandidates[0]?.keys, ["harvest", "spring"]);
    // The card's open-by-design `extensions` object is preserved to disk with the
    // staged candidate, so the confirm step can give it a home (her own
    // `card-extensions.json`); it is inert data and no reader executes it.
    assert.deepEqual(candidateJson.artifact.extensions, { script: "bad" });
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

/**
 * The reviewed card's own picture of the player.
 *
 * `{{user}}` is the card format's macro for the player *being addressed*, so it
 * belongs to the run, not to an identity partition. This path used to render it —
 * and everything else it renders — with the player's opaque partition id
 * (`player_01` in every fixture), so a card that wrote the macro in her
 * `description` froze `与player_01一同…` into her Tier-1 persona and then repeated
 * it to the model on every turn. Her opening was not rendered at all, so the
 * literal `{{user}}` shipped as the conversation's first line.
 *
 * Both now store the decoder's own text and render at the READER: the prompt's table is
 * `renderIdentityProfile`'s, and every surface the player reads goes through
 * `companion-profile-service`. The asserted text is the whole persona and the whole
 * opening, not a substring: a nested literal is exactly what a second rendering rule
 * would leave behind.
 */
test("a reviewed card's {{user}} reaches her persona and her opening as the run's player reference, never the partition id", async () => {
  const root = await canonicalTestRoot("tavern-st-import-player-reference-");
  let threads: ReturnType<typeof createChatThreadStore> | undefined;
  // The partition id the defect froze: an opaque `player_<n>`, never a name.
  const partition = { ...identity, playerId: "player_01" };
  try {
    const paths = resolveTavernPaths({ root } as never, partition);
    const service = new StCardImportService(new TavernArtifactStore(root), paths);
    const imported = await service.import(
      "import_player_reference",
      JSON.stringify({
        spec: "chara_card_v3",
        data: {
          name: "Macro Companion",
          description: "清晨{{user}}还没醒，她就把热水烧上了。",
          first_mes: "*把粗瓷杯搁在桌沿*\n“{{user}}，水烧好了，趁热喝。”",
        },
      }),
    );
    await service.recordReview("import_player_reference", {
      reviewedFields: ["name", "persona_core", "first_greeting"],
      approvedAtMs: 3,
    });
    threads = createChatThreadStore(root, "import-player-reference");
    const provisioned = await provisionNewCompanion(
      root,
      partition.playerId,
      imported.candidate.artifact,
      await service.confirmedReview("import_player_reference"),
      threads,
    );
    // Her persona AS STORED is the author's line; what the model reads is the rendering.
    assert.equal(provisioned.profile.persona?.core, "清晨{{user}}还没醒，她就把热水烧上了。");
    assert.match(renderedPersona(provisioned.profile), /^Core disposition: 清晨你还没醒，她就把热水烧上了。$/mu);
    // The reference is chosen in ONE place, and provisioning now goes through it.
    // The rule it holds is `macroTable`'s: a run that NAMES the player keeps that
    // name (the more specific fact), and only a nameless run falls to the
    // locale's pronoun. Nothing in the reviewed path can bypass that, because the
    // path no longer builds a table of its own.
    assert.equal(macroTable({ char: "Macro Companion", user: "阿岚", locale: "zh-CN" }).user, "阿岚");
    // Her opening: the greeting record's only variant, which is the card's own line -
    // the rendering is the Chat surface's, and Message 0 below is where it shows.
    const runtimePaths = resolveRuntimePaths(provisioned.identity, root);
    const tavernPaths = resolveTavernPaths(runtimePaths, provisioned.identity);
    const store = new TavernArtifactStore(root);
    const greeting = await createGreetingManagementService(store, tavernPaths.companionRoot).read();
    assert.deepEqual(
      greeting?.variants.map((variant) => variant.text),
      ["*把粗瓷杯搁在桌沿*\n“{{user}}，水烧好了，趁热喝。”"],
    );
    // The durable profile is what every later turn reads, so the partition id may
    // not appear in it in any field.
    assert.doesNotMatch(
      await readFile(join(root, "contexts", identityKey(provisioned.identity), "identity-profile.json"), "utf8"),
      /player_/u,
    );
    const library = createTavernLibraryService(tavernPaths, store, threads, {
      async readExact() {
        return identityProfileMetadata(provisioned.profile);
      },
    });
    const chat = await library.createNewChat({
      chatThreadId: "thread-player-reference",
      chatSurfaceSessionId: "surface-player-reference",
    });
    assert.equal(chat.messages[0]?.kind, "opening");
    // The Chat's Message 0 is what the player reads: no `{{user}}` placeholder, and never
    // the partition id - the surface renders through the run's own table.
    assert.doesNotMatch(chat.messages[0]?.text ?? "", /\{\{|player_/u);
  } finally {
    threads?.close?.();
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

/**
 * The SHIPPED default card, imported through the reviewed path.
 *
 * A fresh root seeds this card through the compiled preset, so the reviewed
 * import path is the second half of the same card's truth. It carries
 * `{{user}}`/`{{char}}` in its `mes_example`, and every reviewed field of her
 * profile is asserted here to be free of the partition id — the defect this
 * suite holds out — while her own words stay exactly her card's.
 */
test("the shipped default card imports with no partition id in her persona and the run's word above her example lines", async () => {
  const root = await canonicalTestRoot("tavern-st-import-shipped-card-");
  let threads: ReturnType<typeof createChatThreadStore> | undefined;
  const partition = { ...identity, playerId: "player_01" };
  try {
    const cardText = await readFile(join(reviewedPresetDirectory(), "card.json"), "utf8");
    const service = new StCardImportService(
      new TavernArtifactStore(root),
      resolveTavernPaths({ root } as never, partition),
    );
    const imported = await service.import("import_shipped", cardText);
    const eligible = imported.candidate.artifact.fields
      .filter((field) => field.eligibility === "profile_eligible_after_explicit_review")
      .map((field) => field.field);
    await service.recordReview("import_shipped", { reviewedFields: eligible, approvedAtMs: 4 });
    threads = createChatThreadStore(root, "import-shipped");
    const provisioned = await provisionNewCompanion(
      root,
      partition.playerId,
      imported.candidate.artifact,
      await service.confirmedReview("import_shipped"),
      threads,
    );
    // Her card's own prose, verbatim once the prompt renders it, and no macro left standing
    // in what the model reads. The card's text is what is STORED; the prompt is where it
    // renders. The phrase is read from the card itself, so a card whose author rewrites her
    // description does not fail this test for the wrong reason.
    const cardDescription = (JSON.parse(cardText) as { data: { description: string } }).data.description;
    const firstClause = cardDescription.split("\n").find((line) => line.startsWith("- 身份："));
    assert.ok(firstClause !== undefined, "the shipped card must still state her identity line");
    const statedIdentity = firstClause.replace(/^- 身份：/u, "").split("、")[0]!;
    assert.ok(
      renderedPersona(provisioned.profile).includes(statedIdentity),
      `the prompt must carry the card's own identity line ${JSON.stringify(statedIdentity)}`,
    );
    assert.equal(renderedPersona(provisioned.profile), renderIdentityProfile(provisioned.profile, "zh-CN"));
    assert.equal(provisioned.profile.identity.name, "琥珀");
    assert.doesNotMatch(
      await readFile(join(root, "contexts", identityKey(provisioned.identity), "identity-profile.json"), "utf8"),
      /player_/u,
    );
    // The prompt block the model reads: her card's examples as the run renders them - the
    // player's line labelled with the run's own word (the word `{{user}}` resolves to), her
    // own line under her name, and no macro left standing anywhere.
    const rendered = renderIdentityProfile(provisioned.profile, "zh-CN");
    const macros = macroTable({ char: "琥珀", locale: "zh-CN" });
    const firstExample = provisioned.profile.examples?.[0];
    assert.ok(firstExample !== undefined, "the shipped card carries example dialogues");
    assert.ok(
      rendered.includes(`${macros.user}: ${renderMacros(firstExample.user, macros)}`),
      "the model reads the player's example line under the run's own word for them",
    );
    assert.ok(
      rendered.includes(`${provisioned.profile.identity.name}: ${renderMacros(firstExample.companion, macros)}`),
      "the model reads her example line under her own name",
    );
    assert.doesNotMatch(rendered, /\{\{/u);
  } finally {
    threads?.close?.();
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

/** The reviewed preset's own directory, found the way the drift gate finds it. */
function reviewedPresetDirectory(): string {
  for (const candidate of [process.cwd(), resolve(process.cwd(), ".."), resolve(process.cwd(), "..", "..")]) {
    if (existsSync(join(candidate, "assets", "tavern", "presets", "default-companion", "card.json")))
      return join(candidate, "assets", "tavern", "presets", "default-companion");
  }
  throw new Error("reviewed_preset_card_not_findable");
}
