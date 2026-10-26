import assert from "node:assert/strict";
import { join, resolve } from "node:path";
import { existsSync } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import test from "node:test";
import { readIdentityProfile } from "../identity-profile.js";
import { bindWindowsStaleLockReclaimer } from "../path-lock.js";
import { resolveRuntimePaths, type CompanionIdentity } from "../runtime.js";
import { canonicalTestRoot } from "../test-support/canonical-test-root.test-support.js";
import { createBuildWindowsStaleLockReclaimer } from "../windows-stale-lock-reclaimer/index.js";
import { readWorldBook, type WorldBook } from "../worldbook.js";
import { TavernArtifactStore } from "./artifact-store.js";
import {
  assertCompanionCardImportable,
  buildCompanionCard,
  companionCardFileName,
  exportCompanionCard,
} from "./companion-card-export.js";
import { createCompanionCardExportService } from "./companion-card-export-service.js";
import { createChatThreadStore } from "./chat-thread-store.js";
import { createGreetingManagementService } from "./greeting-management/greeting-management.js";
import { provisionNewCompanion } from "./new-companion-service.js";
import { createScenarioManagementService } from "./scenario-management/scenario-management.js";
import { StCardImportService } from "./st-card-import-service.js";
import { decodeStCard } from "../st-card-import.js";
import { pngCardFile } from "../test-support/png-card.test-support.js";
import { companionAvatarPath, readAvatarFile } from "./companion-avatar/index.js";
import { readCompanionCardExtensions } from "./card-extensions.js";
import { readCompanionCardMetadata } from "./card-metadata.js";
import { readCompanionPostHistoryInstructions } from "./post-history-instructions.js";
import { resolveTavernPaths } from "./tavern-paths.js";
import { ST_CARD_DECODER_LIMITS_V1 } from "./compatibility-manifest.v1.js";

test.before(async () => {
  bindWindowsStaleLockReclaimer(await createBuildWindowsStaleLockReclaimer());
});

test.after(() => {
  bindWindowsStaleLockReclaimer(undefined);
});

async function cleanupTestRoot(root: string): Promise<void> {
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

/**
 * The card a companion is first built from: her own world book (keyed entries and
 * one always-on entry, with a declared scan depth), a scenario, two openings
 * beside the default and a performance directive. This is the shape that makes a
 * round trip meaningful - every field the export writes came from a card first,
 * so the second import has something to get wrong.
 */
const SEED_CARD = JSON.stringify({
  spec: "chara_card_v3",
  spec_version: "3.0",
  data: {
    name: "琥珀",
    description: "她是鹈鹕镇的农夫,细心而且固执。",
    personality: "先听再说,从不教训人。",
    scenario: "你们一起在祖辈留下的农场里开始新的生活。",
    first_mes: "早上好。今天的风很适合播种。",
    alternate_greetings: ["雨停了,我们去矿洞看看？", "我把早餐留在桌上了。"],
    system_prompt: "先做一个动作,再说一句话。",
    mes_example:
      "{{user}}: 今天种什么？\n{{char}}: 先种防风草吧。\n<START>{{user}}: 你要去镇上吗？\n{{char}}: 我去买点种子。",
    character_book: {
      scan_depth: 5,
      entries: [
        { comment: "温室", content: "温室是她去年冬天修好的。", keys: ["温室", "玻璃房"] },
        { comment: "洒水器", content: "洒水器接在井边。", constant: true },
      ],
    },
  },
});

/** One companion's own effective records, as every reader the surface uses sees them. */
type ReadRecords = Readonly<{
  name: string;
  personaCore: string | null;
  interactionStyle: string | null;
  characterVoice: string | null;
  examples: readonly Readonly<{ user: string; companion: string }>[];
  scenario: string | null;
  openings: readonly string[];
  worldBook: WorldBook | null;
  /** The card's open-by-design `extensions` object, as her own record holds it. */
  extensions: Readonly<Record<string, unknown>> | null;
  /** The author fields this product does not interpret, as her own record holds them. */
  preservedFields: Readonly<Record<string, unknown>> | null;
  /** The card's closing direction, as her own record holds it. */
  postHistoryInstructions: string | null;
}>;

async function readRecords(root: string, identity: CompanionIdentity): Promise<ReadRecords> {
  const runtimePaths = resolveRuntimePaths(identity, root);
  const tavernPaths = resolveTavernPaths(runtimePaths, identity);
  const store = new TavernArtifactStore(root);
  const profile = await readIdentityProfile(runtimePaths.identityProfilePath);
  const scenario = await createScenarioManagementService(store, tavernPaths.companionRoot).read();
  const greetings = await createGreetingManagementService(store, tavernPaths.companionRoot).read();
  let worldBook: WorldBook | null = null;
  try {
    worldBook = await readWorldBook(join(runtimePaths.runtimeCwd, "worldbook.json"));
  } catch {
    worldBook = null;
  }
  return Object.freeze({
    name: profile.identity.name,
    personaCore: profile.persona?.core ?? null,
    interactionStyle: profile.persona?.interactionStyle ?? null,
    characterVoice: profile.characterVoice?.text ?? null,
    examples: Object.freeze(profile.examples?.map((example) => Object.freeze({ ...example })) ?? []),
    scenario: scenario?.description ?? null,
    openings: Object.freeze(greetings?.variants.map((variant) => variant.text) ?? []),
    worldBook,
    extensions: await readCompanionCardExtensions(store, tavernPaths.companionRoot),
    preservedFields: await readCompanionCardMetadata(store, tavernPaths.companionRoot),
    postHistoryInstructions: await readCompanionPostHistoryInstructions(store, tavernPaths.companionRoot),
  });
}

/**
 * The acceptance: a companion is built, exported to a card, and that card is fed
 * through the REAL import path (`StCardImportService` stage → review → confirm →
 * `provisionNewCompanion`). The second companion's effective records must equal
 * the first's - name, scenario text, the openings in order, the world-book entries
 * with their trigger words and depth, the directive and the persona.
 *
 * Both sides are quoted by the assertion: each value is the durable record read
 * back from a real root by the same readers the Characters surface uses, not a
 * re-parse of the card under test.
 */
test("a companion's card round-trips through the real import path to the same effective companion", async (t) => {
  const root = await canonicalTestRoot("tavern-card-export-round-trip-");
  let threads: ReturnType<typeof createChatThreadStore> | undefined;
  try {
    const store = new TavernArtifactStore(root);
    const seedIdentity = {
      playerId: "player-round-trip",
      companionId: "seed-companion",
      continuityId: "seed-continuity",
    };
    const seedPaths = resolveTavernPaths(resolveRuntimePaths(seedIdentity, root), seedIdentity);
    const importService = new StCardImportService(store, seedPaths);
    const seededStage = await importService.import("seed_card", SEED_CARD);
    const seededEligible = seededStage.candidate.artifact.fields
      .filter((field) => field.eligibility === "profile_eligible_after_explicit_review")
      .map((field) => field.field);
    await importService.recordReview("seed_card", { reviewedFields: seededEligible, approvedAtMs: 1 });
    threads = createChatThreadStore(root, "a".repeat(64));
    const first = await provisionNewCompanion(
      root,
      "player-round-trip",
      seededStage.candidate.artifact,
      await importService.confirmedReview("seed_card"),
      threads,
    );

    const firstRecords = await readRecords(root, first.identity);

    // Export her through the real service, addressed by the roster handle.
    const handle = "H".repeat(43);
    const exportService = createCompanionCardExportService({
      store,
      runtimeRoot: root,
      playerId: "player-round-trip",
      resolveCompanion: async (requested) =>
        requested === handle
          ? Object.freeze({
              companionId: first.identity.companionId,
              continuityId: first.identity.continuityId!,
              name: firstRecords.name,
            })
          : null,
    });
    const exported = await exportService.read(handle, "json");
    if (exported === null || exported.format !== "json") throw new Error("expected the JSON form of the card");
    assert.equal(exported.spec, "chara_card_v3");
    assert.equal(exported.fileName, "琥珀.json");
    // The exported card is one our own decoder accepts, and it declares the V3 spec.
    const decoded = decodeStCard(exported.card);
    assert.equal(decoded.format, "st-v3");
    assert.notEqual(decoded.candidate, undefined);

    // Feed it back through the REAL import path.
    const secondStage = await importService.import("round_trip_card", exported.card);
    const secondEligible = secondStage.candidate.artifact.fields
      .filter((field) => field.eligibility === "profile_eligible_after_explicit_review")
      .map((field) => field.field);
    await importService.recordReview("round_trip_card", { reviewedFields: secondEligible, approvedAtMs: 2 });
    const second = await provisionNewCompanion(
      root,
      "player-round-trip",
      secondStage.candidate.artifact,
      await importService.confirmedReview("round_trip_card"),
      threads,
    );
    const secondRecords = await readRecords(root, second.identity);

    t.diagnostic(
      `round-trip first=${JSON.stringify(firstRecords)}\nround-trip second=${JSON.stringify(secondRecords)}`,
    );

    assert.equal(secondRecords.name, firstRecords.name);
    assert.equal(secondRecords.scenario, firstRecords.scenario);
    assert.deepEqual(secondRecords.openings, firstRecords.openings);
    assert.equal(secondRecords.characterVoice, firstRecords.characterVoice);
    assert.equal(secondRecords.personaCore, firstRecords.personaCore);
    assert.equal(secondRecords.interactionStyle, firstRecords.interactionStyle);
    assert.deepEqual(secondRecords.examples, firstRecords.examples);
    assert.equal(secondRecords.worldBook?.scanDepth, firstRecords.worldBook?.scanDepth);
    const entries = (book: WorldBook | null) =>
      (book?.entries ?? []).map((entry) => ({
        title: entry.title,
        content: entry.content,
        keys: entry.keys ?? [],
        constant: entry.constant === true,
      }));
    assert.deepEqual(entries(secondRecords.worldBook), entries(firstRecords.worldBook));
    // A card that wrote no `extensions` stays that way on both sides: the export
    // writes no field for it and the second companion owns no record, rather than
    // an empty object standing in for "she has none".
    assert.equal(firstRecords.extensions, null);
    assert.equal(secondRecords.extensions, null);
    assert.equal("extensions" in (JSON.parse(exported.card) as { data: Record<string, unknown> }).data, false);
    // The values are not vacuous: the seed card really carried them.
    assert.equal(firstRecords.name, "琥珀");
    assert.equal(firstRecords.openings.length, 3);
    assert.equal(firstRecords.worldBook?.scanDepth, 5);
    assert.deepEqual(
      entries(firstRecords.worldBook).map((entry) => entry.keys),
      [["温室", "玻璃房"], []],
    );
    assert.equal(entries(firstRecords.worldBook)[1]?.constant, true);
  } finally {
    threads?.close?.();
    await cleanupTestRoot(root);
  }
});

/**
 * The repo's shipped default companion card, as committed.
 *
 * It is the fixture this test is about: the one card in the repository that
 * already carries game-integration facts in `extensions`
 * (`extensions.gamebuddy.stardew` - her farmer appearance, the gifts she likes,
 * the stamina threshold she turns cautious at).
 */
function shippedDefaultCardPath(): string {
  for (const candidate of [process.cwd(), resolve(process.cwd(), ".."), resolve(process.cwd(), "..", "..")]) {
    const path = join(candidate, "assets", "tavern", "presets", "default-companion", "card.json");
    if (existsSync(path)) return path;
  }
  throw new Error("shipped_default_card_not_findable");
}

/**
 * The acceptance for the card's open-by-design `extensions` object: what the
 * shipped default card wrote for the game integration comes back out of her card
 * unchanged.
 *
 * Those facts are not prompt material - nothing renders them - so they live where
 * her other authored card material lives (a durable record in her own root, beside
 * her scenario and her openings), never in the identity profile. This test holds
 * the whole path up on the product's own functions: the real import stages and
 * provisions her, the real export reads her records, and the exported bytes are
 * fed back through the real import path a second time.
 */
test("the shipped card's game extensions survive a round trip through the companion's own record", async (t) => {
  const cardText = await readFile(shippedDefaultCardPath(), "utf8");
  const shippedExtensions = (JSON.parse(cardText) as { data: { extensions?: Record<string, unknown> } }).data
    .extensions;
  assert.ok(
    shippedExtensions !== undefined && Object.keys(shippedExtensions).length > 0,
    "the shipped card must carry the extensions this test is about",
  );
  // The fixture really is the game-integration block, not an empty object.
  assert.ok(JSON.stringify(shippedExtensions).includes("farmer_appearance"));

  const root = await canonicalTestRoot("tavern-card-export-extensions-");
  let threads: ReturnType<typeof createChatThreadStore> | undefined;
  try {
    const store = new TavernArtifactStore(root);
    const identity = {
      playerId: "player-extensions",
      companionId: "seed-extensions",
      continuityId: "seed-extensions-continuity",
    };
    const seedPaths = resolveTavernPaths(resolveRuntimePaths(identity, root), identity);
    const importService = new StCardImportService(store, seedPaths);
    const staged = await importService.import("shipped_card", cardText);
    const eligible = staged.candidate.artifact.fields
      .filter((field) => field.eligibility === "profile_eligible_after_explicit_review")
      .map((field) => field.field);
    await importService.recordReview("shipped_card", { reviewedFields: eligible, approvedAtMs: 1 });
    threads = createChatThreadStore(root, "c".repeat(64));
    const first = await provisionNewCompanion(
      root,
      identity.playerId,
      staged.candidate.artifact,
      await importService.confirmedReview("shipped_card"),
      threads,
    );
    const firstRecords = await readRecords(root, first.identity);
    // She owns the card's own object, and it is inert data: frozen, not a live
    // reference back into the staged import.
    assert.deepEqual(firstRecords.extensions, shippedExtensions);
    assert.equal(Object.isFrozen(firstRecords.extensions), true);

    const cardHandle = "X".repeat(43);
    const cardOf = (records: ReadRecords, companion: typeof first) =>
      createCompanionCardExportService({
        store,
        runtimeRoot: root,
        playerId: identity.playerId,
        resolveCompanion: async (requested) =>
          requested === cardHandle
            ? Object.freeze({
                companionId: companion.identity.companionId,
                continuityId: companion.identity.continuityId!,
                name: records.name,
              })
            : null,
      });
    const exported = await cardOf(firstRecords, first).read(cardHandle, "json");
    if (exported === null || exported.format !== "json") throw new Error("expected the JSON form of the card");
    const extensionsOf = (card: string): unknown =>
      (JSON.parse(card) as { data: { extensions?: unknown } }).data.extensions;
    assert.deepEqual(extensionsOf(exported.card), shippedExtensions);

    // Feed the card's own bytes back through the real import path.
    const secondStage = await importService.import("shipped_round_trip", exported.card);
    const secondEligible = secondStage.candidate.artifact.fields
      .filter((field) => field.eligibility === "profile_eligible_after_explicit_review")
      .map((field) => field.field);
    await importService.recordReview("shipped_round_trip", { reviewedFields: secondEligible, approvedAtMs: 2 });
    const second = await provisionNewCompanion(
      root,
      identity.playerId,
      secondStage.candidate.artifact,
      await importService.confirmedReview("shipped_round_trip"),
      threads,
    );
    const secondRecords = await readRecords(root, second.identity);
    assert.deepEqual(secondRecords.extensions, shippedExtensions);

    // The re-export carries the same extension bytes as the first export, so the
    // round trip is a fixed point: exporting what she exported loses nothing more.
    const exportedAgain = await cardOf(secondRecords, second).read(cardHandle, "json");
    if (exportedAgain === null || exportedAgain.format !== "json")
      throw new Error("expected the JSON form of the card");
    assert.equal(JSON.stringify(extensionsOf(exportedAgain.card)), JSON.stringify(extensionsOf(exported.card)));

    t.diagnostic(
      `extensions round-trip card=${JSON.stringify(extensionsOf(exported.card)).length} chars ` +
        `record=${JSON.stringify(firstRecords.extensions).length} chars`,
    );
  } finally {
    threads?.close?.();
    await cleanupTestRoot(root);
  }
});

test("the author's own notes, tags, name and version survive the round trip, and the closing direction with them", async (t) => {
  // A card the way an author actually writes one: standard metadata outside the interpreted fields, plus the
  // post_history_instructions this product already accepted at import - and until now never wrote back.
  const authored = {
    spec: "chara_card_v3",
    spec_version: "3.0",
    data: {
      name: "Wrenna",
      description: "A beekeeper with opinions about weather.",
      personality: "Dry, patient.",
      scenario: "A wet afternoon in the shed.",
      first_mes: "Mind the frames, they are heavier than they look.",
      mes_example: "",
      creator_notes: "Written for a slow campaign. Please keep her quiet.",
      tags: ["slice-of-life", "beekeeping"],
      creator: "somebody@example.invalid",
      character_version: "2.4.1",
      post_history_instructions: "End on something small and physical.",
      character_book: { entries: [] },
    },
  };

  const root = await canonicalTestRoot("tavern-card-export-metadata-");
  let threads: ReturnType<typeof createChatThreadStore> | undefined;
  try {
    const store = new TavernArtifactStore(root);
    const identity = {
      playerId: "player-metadata",
      companionId: "seed-metadata",
      continuityId: "seed-metadata-continuity",
    };
    const seedPaths = resolveTavernPaths(resolveRuntimePaths(identity, root), identity);
    const importService = new StCardImportService(store, seedPaths);
    const staged = await importService.import("authored_card", JSON.stringify(authored));
    const eligible = staged.candidate.artifact.fields
      .filter((field) => field.eligibility === "profile_eligible_after_explicit_review")
      .map((field) => field.field);
    await importService.recordReview("authored_card", { reviewedFields: eligible, approvedAtMs: 1 });
    threads = createChatThreadStore(root, "d".repeat(64));
    const first = await provisionNewCompanion(
      root,
      identity.playerId,
      staged.candidate.artifact,
      await importService.confirmedReview("authored_card"),
      threads,
    );
    const firstRecords = await readRecords(root, first.identity);
    // The import performed the classification it reports rather than only naming it.
    assert.deepEqual(firstRecords.preservedFields, {
      creator: "somebody@example.invalid",
      creator_notes: "Written for a slow campaign. Please keep her quiet.",
      tags: ["slice-of-life", "beekeeping"],
      character_version: "2.4.1",
    });
    assert.equal(firstRecords.postHistoryInstructions, "End on something small and physical.");

    const cardHandle = "Y".repeat(43);
    const cardOf = (records: ReadRecords, companion: typeof first) =>
      createCompanionCardExportService({
        store,
        runtimeRoot: root,
        playerId: identity.playerId,
        resolveCompanion: async (requested) =>
          requested === cardHandle
            ? Object.freeze({
                companionId: companion.identity.companionId,
                continuityId: companion.identity.continuityId!,
                name: records.name,
              })
            : null,
      });
    const exported = await cardOf(firstRecords, first).read(cardHandle, "json");
    if (exported === null || exported.format !== "json") throw new Error("expected the JSON form of the card");
    const dataOf = (card: string): Record<string, unknown> =>
      (JSON.parse(card) as { data: Record<string, unknown> }).data;

    // Every author field comes back out, by its own name, unchanged.
    const out = dataOf(exported.card);
    assert.equal(out.creator_notes, authored.data.creator_notes);
    assert.deepEqual(out.tags, authored.data.tags);
    assert.equal(out.creator, authored.data.creator);
    assert.equal(out.character_version, authored.data.character_version);
    assert.equal(out.post_history_instructions, authored.data.post_history_instructions);
    // And the interpreted fields did not get shadowed by the preserved copy.
    assert.equal(out.name, authored.data.name);
    assert.equal(out.description, authored.data.description);

    // Feed the card's own bytes back through the real import path: the round trip is a fixed point.
    const secondStage = await importService.import("authored_round_trip", exported.card);
    const secondEligible = secondStage.candidate.artifact.fields
      .filter((field) => field.eligibility === "profile_eligible_after_explicit_review")
      .map((field) => field.field);
    await importService.recordReview("authored_round_trip", { reviewedFields: secondEligible, approvedAtMs: 2 });
    const second = await provisionNewCompanion(
      root,
      identity.playerId,
      secondStage.candidate.artifact,
      await importService.confirmedReview("authored_round_trip"),
      threads,
    );
    const secondRecords = await readRecords(root, second.identity);
    assert.deepEqual(secondRecords.preservedFields, firstRecords.preservedFields);
    assert.equal(secondRecords.postHistoryInstructions, firstRecords.postHistoryInstructions);

    const exportedAgain = await cardOf(secondRecords, second).read(cardHandle, "json");
    if (exportedAgain === null || exportedAgain.format !== "json")
      throw new Error("expected the JSON form of the card");
    assert.equal(JSON.stringify(dataOf(exportedAgain.card)), JSON.stringify(out));

    t.diagnostic(`author metadata round-trip fields=${Object.keys(out).sort().join(",")}`);
  } finally {
    threads?.close?.();
    await cleanupTestRoot(root);
  }
});

test("the export writes only the fields the companion has, and never an expression style the card format lacks", () => {
  const card = buildCompanionCard({
    name: "Only Name",
    persona: { core: "who", interactionStyle: "how", expressionStyle: "tone" },
  });
  assert.deepEqual(Object.keys(card.data).sort(), ["description", "name", "personality"]);
  // The two persona dimensions the spec has fields for are carried; the third
  // (`expressionStyle`) has no V2/V3 field and is left out rather than folded in.
  assert.equal(card.data.description, "who");
  assert.equal(card.data.personality, "how");

  const bare = buildCompanionCard({ name: "Bare" });
  assert.deepEqual(Object.keys(bare.data), ["name"]);
  assert.equal(bare.spec, "chara_card_v3");
  assert.equal(bare.spec_version, "3.0");
});

test("a world book's always-on premise is dropped because the card format has no field for it", () => {
  const book: WorldBook = Object.freeze({
    schemaVersion: 1,
    worldBookId: "worldbook-1",
    revision: 1,
    alwaysOnPremise: "{{user}}和她一起打理农场。",
    scanDepth: 3,
    entries: Object.freeze([
      Object.freeze({
        entryId: "e1",
        title: "温室",
        content: "温室是她修好的。",
        scope: "setting" as const,
        provenance: "st-card-import" as const,
        tokenBudget: "small" as const,
        keys: Object.freeze(["温室"]),
      }),
    ]),
  });
  const card = buildCompanionCard({ name: "Amber", worldBook: book });
  assert.deepEqual(Object.keys(card.data.character_book!).sort(), ["entries", "scan_depth"]);
  assert.equal(card.data.character_book!.scan_depth, 3);
  const entry = decodeStCard(JSON.stringify(card));
  // The book's own premise is not representable; the entries and the depth are.
  assert.deepEqual(entry.candidate!.worldBookScanDepth, 3);
  assert.deepEqual(
    entry.candidate!.worldBookCandidates.map((value) => value.title),
    ["温室"],
  );
  assert.deepEqual(entry.candidate!.worldBookCandidates[0]?.keys, ["温室"]);
});

test("an export refuses by name when a record will not fit the importer's own card bounds", () => {
  const tooLongEntry = "x".repeat(ST_CARD_DECODER_LIMITS_V1.characterBookEntryBytes + 1);
  assert.throws(
    () =>
      exportCompanionCard({
        name: "Amber",
        worldBook: {
          schemaVersion: 1,
          worldBookId: "worldbook-2",
          revision: 1,
          alwaysOnPremise: "",
          entries: [
            {
              entryId: "e1",
              title: "Big",
              content: tooLongEntry,
              scope: "setting",
              provenance: "authored",
              tokenBudget: "small",
            },
          ],
        },
      }),
    /companion_card_too_large/,
  );
  const tooLongVoice = "y".repeat(ST_CARD_DECODER_LIMITS_V1.cardVoiceBytes + 1);
  assert.throws(
    () => exportCompanionCard({ name: "Amber", characterVoice: { text: tooLongVoice, source: "player" } }),
    /companion_card_too_large/,
  );
  // The card's open-by-design `extensions` object is bounded by the decoder's own
  // rule for it - the length of its JSON text - so an export can never be a card
  // whose extensions the next import would silently drop. The boundary itself is
  // measured, not approximated: exactly at the bound is a card, one character more
  // is not.
  const extensionsAtBound = {
    gamebuddy: "x".repeat(ST_CARD_DECODER_LIMITS_V1.cardExtensionsJsonChars - 16),
  };
  assert.equal(JSON.stringify(extensionsAtBound).length, ST_CARD_DECODER_LIMITS_V1.cardExtensionsJsonChars);
  assert.doesNotThrow(() => exportCompanionCard({ name: "Amber", extensions: extensionsAtBound }));
  assert.throws(
    () =>
      exportCompanionCard({
        name: "Amber",
        extensions: { gamebuddy: "x".repeat(ST_CARD_DECODER_LIMITS_V1.cardExtensionsJsonChars - 15) },
      }),
    /companion_card_too_large/,
  );
  // The bound is the importer's own, not a second opinion: a card exactly at the
  // decoder's entry ceiling is accepted.
  assert.doesNotThrow(() =>
    assertCompanionCardImportable(
      buildCompanionCard({
        name: "Amber",
        worldBook: {
          schemaVersion: 1,
          worldBookId: "worldbook-3",
          revision: 1,
          alwaysOnPremise: "",
          entries: [
            {
              entryId: "e1",
              title: "AtBound",
              content: "x".repeat(ST_CARD_DECODER_LIMITS_V1.characterBookEntryBytes),
              scope: "setting",
              provenance: "authored",
              tokenBudget: "small",
            },
          ],
        },
      }),
    ),
  );
});

test("a card filename is the companion's own name, made safe for a filesystem, in the form's own extension", () => {
  assert.equal(companionCardFileName("琥珀", "json"), "琥珀.json");
  assert.equal(companionCardFileName("琥珀", "png"), "琥珀.png");
  assert.equal(companionCardFileName('a/b\\c:d*e?f"g<h>i|j', "json"), "a_b_c_d_e_f_g_h_i_j.json");
  assert.equal(companionCardFileName("..", "png"), "companion.png");
  assert.equal(companionCardFileName("   ", "json"), "companion.json");
});

test("a companion with no records at all still exports a card our import reads back by name", () => {
  const exported = exportCompanionCard({ name: "Solo" });
  const decoded = decodeStCard(exported.card);
  assert.equal(decoded.candidate?.profileCandidate.identity.name, "Solo");
  assert.equal(decoded.losses.length, 0);
});

/** Every chunk of a PNG in order, read by the test and not by the code under test. */
function pngChunksOf(input: Uint8Array): readonly Readonly<{ type: string; data: Buffer }>[] {
  const bytes = Buffer.from(input);
  const chunks: Readonly<{ type: string; data: Buffer }>[] = [];
  let offset = 8;
  while (offset + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(offset);
    const type = bytes.subarray(offset + 4, offset + 8).toString("latin1");
    chunks.push(Object.freeze({ type, data: Buffer.from(bytes.subarray(offset + 8, offset + 8 + length)) }));
    offset += 12 + length;
    if (type === "IEND") break;
  }
  return chunks;
}

/** The chunks that ARE the picture: everything that is not a card-carrying text chunk. */
function pictureChunks(bytes: Uint8Array): readonly string[] {
  const cardKeywords = new Set(["chara", "ccv3", "character"]);
  return pngChunksOf(bytes)
    .filter((chunk) => {
      if (!["tEXt", "zTXt", "iTXt"].includes(chunk.type)) return true;
      const split = chunk.data.indexOf(0);
      return split < 1 || !cardKeywords.has(chunk.data.subarray(0, split).toString("latin1").toLowerCase());
    })
    .map((chunk) => `${chunk.type}:${chunk.data.toString("base64")}`);
}

/** The card JSON a PNG carries in its one card chunk, or `null` when it carries none. */
function carriedCardJson(bytes: Uint8Array): string | null {
  const cardChunks = pngChunksOf(bytes).filter((chunk) => chunk.type === "tEXt");
  for (const chunk of cardChunks) {
    const split = chunk.data.indexOf(0);
    if (split < 1) continue;
    const keyword = chunk.data.subarray(0, split).toString("latin1").toLowerCase();
    if (!["chara", "ccv3", "character"].includes(keyword)) continue;
    const value = chunk.data
      .subarray(split + 1)
      .toString("latin1")
      .trim();
    return value.startsWith("{") ? value : Buffer.from(value, "base64").toString("utf8");
  }
  return null;
}

/**
 * The PNG form's own acceptance: a companion with her own picture is exported as a
 * PNG card - her picture, with the card inside it - and those bytes are fed back
 * through the REAL import path (`StCardImportService` stage → review → confirm →
 * `provisionNewCompanion`).
 *
 * The imported companion's avatar must be the card file the export produced, byte
 * for byte, and the picture inside it must still be the picture she had. The seed
 * is a PNG card, because that is the only way a companion ends up with a picture
 * (her avatar IS the card file she was imported from) - and it also makes the hard
 * case real: her bytes already carry the card she came from, so this proves the
 * writer replaces that stale chunk rather than letting it shadow the new one.
 */
test("her picture round-trips: the PNG card carries her own image and the re-import keeps the whole card as her avatar", async (t) => {
  const root = await canonicalTestRoot("tavern-card-export-png-round-trip-");
  let threads: ReturnType<typeof createChatThreadStore> | undefined;
  try {
    const store = new TavernArtifactStore(root);
    const seedIdentity = { playerId: "player-png", companionId: "seed-png", continuityId: "seed-png-continuity" };
    const seedPaths = resolveTavernPaths(resolveRuntimePaths(seedIdentity, root), seedIdentity);
    const importService = new StCardImportService(store, seedPaths);
    // The seed is a PNG card: its `chara` value is the SEED_CARD's own JSON, base64-
    // encoded (the ecosystem's own spelling, and the only one a `tEXt` chunk can carry
    // for a card whose text is not ASCII).
    const seedPicture = Buffer.from(pngCardFile(Buffer.from(SEED_CARD, "utf8").toString("base64")));
    await importService.import("png_seed", seedPicture);
    const seededStage = await importService.read("png_seed");
    const seededEligible = seededStage.candidate.artifact.fields
      .filter((field) => field.eligibility === "profile_eligible_after_explicit_review")
      .map((field) => field.field);
    await importService.recordReview("png_seed", { reviewedFields: seededEligible, approvedAtMs: 1 });
    threads = createChatThreadStore(root, "b".repeat(64));
    const first = await provisionNewCompanion(
      root,
      "player-png",
      seededStage.candidate.artifact,
      await importService.confirmedReview("png_seed"),
      threads,
      await importService.stagedAvatar("png_seed"),
    );
    const firstRecords = await readRecords(root, first.identity);

    const herPicturePath = companionAvatarPath(root, "player-png", {
      companionId: first.identity.companionId,
      continuityId: first.identity.continuityId!,
    });
    const herPicture = await readAvatarFile(herPicturePath, root);
    assert.equal(herPicture.state, "present");
    if (herPicture.state !== "present") return;
    // Her own bytes are the PNG card she was imported from - the card chunk and all.
    assert.deepEqual(herPicture.bytes, seedPicture);

    const handle = "P".repeat(43);
    const exportService = createCompanionCardExportService({
      store,
      runtimeRoot: root,
      playerId: "player-png",
      resolveCompanion: async (requested) =>
        requested === handle
          ? Object.freeze({
              companionId: first.identity.companionId,
              continuityId: first.identity.continuityId!,
              name: firstRecords.name,
            })
          : null,
    });
    const json = await exportService.read(handle, "json");
    const png = await exportService.read(handle, "png");
    if (json === null || json.format !== "json") throw new Error("expected the JSON form of the card");
    if (png === null || png.format !== "png") throw new Error("expected the PNG form of the card");
    assert.equal(png.fileName, "琥珀.png");
    const cardFile = Buffer.from(png.cardFile);

    // Her picture survived byte for byte; the stale card chunk it carried did not.
    assert.deepEqual(pictureChunks(cardFile), pictureChunks(herPicture.bytes));
    assert.equal(carriedCardJson(cardFile), json.card);
    assert.deepEqual(pngChunksOf(cardFile).filter((chunk) => chunk.type === "IEND").length, 1);
    // Both forms carry the SAME card: the PNG arm is the JSON arm inside a picture.
    assert.deepEqual(decodeStCard(cardFile).candidate, decodeStCard(json.card).candidate);
    assert.equal(decodeStCard(cardFile).source, "png");
    assert.equal(decodeStCard(cardFile).format, "st-v3");

    // Feed the PNG card back through the REAL import path, picture and all.
    const secondStage = await importService.import("png_round_trip", cardFile);
    const secondEligible = secondStage.candidate.artifact.fields
      .filter((field) => field.eligibility === "profile_eligible_after_explicit_review")
      .map((field) => field.field);
    await importService.recordReview("png_round_trip", { reviewedFields: secondEligible, approvedAtMs: 2 });
    const second = await provisionNewCompanion(
      root,
      "player-png",
      secondStage.candidate.artifact,
      await importService.confirmedReview("png_round_trip"),
      threads,
      await importService.stagedAvatar("png_round_trip"),
    );
    const secondRecords = await readRecords(root, second.identity);
    const importedAvatar = await readAvatarFile(
      companionAvatarPath(root, "player-png", {
        companionId: second.identity.companionId,
        continuityId: second.identity.continuityId!,
      }),
      root,
    );

    t.diagnostic(
      `png round-trip her-picture=${pictureChunks(herPicture.bytes).join("|")}\n` +
        `png round-trip exported-card=${pictureChunks(cardFile).join("|")}\n` +
        `png round-trip imported-avatar-bytes=${importedAvatar.state === "present" ? importedAvatar.bytes.length : -1}\n` +
        `png round-trip exported-card-bytes=${cardFile.length}`,
    );

    // The imported companion's avatar IS the card the export produced, byte for byte.
    assert.equal(importedAvatar.state, "present");
    if (importedAvatar.state !== "present") return;
    assert.deepEqual(importedAvatar.bytes, cardFile);
    assert.deepEqual(pictureChunks(importedAvatar.bytes), pictureChunks(herPicture.bytes));

    // And the effective records are the ones she had.
    assert.equal(secondRecords.name, firstRecords.name);
    assert.equal(secondRecords.scenario, firstRecords.scenario);
    assert.deepEqual(secondRecords.openings, firstRecords.openings);
    assert.equal(secondRecords.characterVoice, firstRecords.characterVoice);
    assert.equal(secondRecords.personaCore, firstRecords.personaCore);
    assert.equal(secondRecords.interactionStyle, firstRecords.interactionStyle);
    assert.deepEqual(secondRecords.examples, firstRecords.examples);
    assert.equal(secondRecords.worldBook?.scanDepth, firstRecords.worldBook?.scanDepth);
    const entries = (book: WorldBook | null) =>
      (book?.entries ?? []).map((entry) => ({
        title: entry.title,
        content: entry.content,
        keys: entry.keys ?? [],
        constant: entry.constant === true,
      }));
    assert.deepEqual(entries(secondRecords.worldBook), entries(firstRecords.worldBook));
    assert.equal(firstRecords.name, "琥珀");
    assert.equal(firstRecords.openings.length, 3);
  } finally {
    threads?.close?.();
    await cleanupTestRoot(root);
  }
});

/**
 * A companion with no picture cannot produce a PNG card, and the refusal says so
 * by name instead of shipping a blank or invented image. The JSON form is the one
 * that carries her records, and it still works.
 */
test("a companion with no picture refuses the PNG form by name, and the JSON form still carries her", async () => {
  const root = await canonicalTestRoot("tavern-card-export-no-picture-");
  try {
    const store = new TavernArtifactStore(root);
    const handle = "N".repeat(43);
    const exportService = createCompanionCardExportService({
      store,
      runtimeRoot: root,
      playerId: "player-no-picture",
      resolveCompanion: async (requested) =>
        requested === handle
          ? Object.freeze({ companionId: "companion-n", continuityId: "continuity-n", name: "Solo" })
          : null,
    });
    // The JSON form is a projection of her records and needs no picture.
    const json = await exportService.read(handle, "json");
    if (json === null || json.format !== "json") throw new Error("expected the JSON form of the card");
    assert.equal(json.fileName, "Solo.json");
    assert.equal(decodeStCard(json.card).candidate?.profileCandidate.identity.name, "Solo");
    // The PNG form does not: there is no picture to carry, and none is invented.
    await assert.rejects(() => exportService.read(handle, "png"), /companion_card_image_absent/);
  } finally {
    await cleanupTestRoot(root);
  }
});
