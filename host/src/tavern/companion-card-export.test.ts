import assert from "node:assert/strict";
import { join } from "node:path";
import { rm } from "node:fs/promises";
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
    const exported = await exportService.read(handle);
    assert.notEqual(exported, null);
    assert.equal(exported!.spec, "chara_card_v3");
    assert.equal(exported!.fileName, "琥珀.json");
    // The exported card is one our own decoder accepts, and it declares the V3 spec.
    const decoded = decodeStCard(exported!.card);
    assert.equal(decoded.format, "st-v3");
    assert.notEqual(decoded.candidate, undefined);

    // Feed it back through the REAL import path.
    const secondStage = await importService.import("round_trip_card", exported!.card);
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

test("a card filename is the companion's own name, made safe for a filesystem", () => {
  assert.equal(companionCardFileName("琥珀"), "琥珀.json");
  assert.equal(companionCardFileName('a/b\\c:d*e?f"g<h>i|j'), "a_b_c_d_e_f_g_h_i_j.json");
  assert.equal(companionCardFileName(".."), "companion.json");
  assert.equal(companionCardFileName("   "), "companion.json");
});

test("a companion with no records at all still exports a card our import reads back by name", () => {
  const exported = exportCompanionCard({ name: "Solo" });
  const decoded = decodeStCard(exported.card);
  assert.equal(decoded.candidate?.profileCandidate.identity.name, "Solo");
  assert.equal(decoded.losses.length, 0);
});
