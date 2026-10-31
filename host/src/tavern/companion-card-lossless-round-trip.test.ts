import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import test from "node:test";
import { readIdentityProfile } from "../identity-profile.js";
import { bindWindowsStaleLockReclaimer } from "../path-lock.js";
import { resolveRuntimePaths } from "../runtime.js";
import { canonicalTestRoot } from "../test-support/canonical-test-root.test-support.js";
import { createBuildWindowsStaleLockReclaimer } from "../windows-stale-lock-reclaimer/index.js";
import { TavernArtifactStore } from "./artifact-store.js";
import { createCompanionCardExportService } from "./companion-card-export-service.js";
import { createChatThreadStore } from "./chat-thread-store.js";
import { macroTable, renderMacros } from "./macro-engine.js";
import { provisionNewCompanion } from "./new-companion-service.js";
import { StCardImportService } from "./st-card-import-service.js";
import { resolveTavernPaths } from "./tavern-paths.js";

test.before(async () => {
  bindWindowsStaleLockReclaimer(await createBuildWindowsStaleLockReclaimer());
});

test.after(() => {
  bindWindowsStaleLockReclaimer(undefined);
});

const CHAR = "琥珀";
const PLAYER = "player_lossless";
/** Two opaque roster handles, so both companions of one root can be exported. */
const SEED_HANDLE = "S".repeat(43);
const ROUND_TRIP_HANDLE = "R".repeat(43);

/**
 * A card that writes `{{char}}` and `{{user}}` in every authored text field it can carry
 * one in.
 *
 * The defect family this gate exists for: a companion's card is stored with the writing
 * run's macro rendering baked in, so exporting her yields a card that says 琥珀 and 你
 * where the author wrote `{{char}}` and `{{user}}` - a different character in any other
 * Tavern, and no longer the card she came from. `AGENTS.md` names it as the
 * "lossless round-trip" family: exporting imported structures must preserve every
 * accepted field without silent mutation.
 *
 * Every field below carries a macro ON PURPOSE, and the assertion set is derived from the
 * card rather than listed here, so a seventh text field the format grows is covered
 * without editing this file.
 */
const MACRO_CARD = JSON.stringify({
  spec: "chara_card_v3",
  spec_version: "3.0",
  data: {
    name: CHAR,
    description: "{{char}} 是 {{user}} 的农场搭档。",
    personality: "{{char}} 对 {{user}} 说话很直接。",
    scenario: "{{char}} 和 {{user}} 一起搬到星露谷。",
    system_prompt: "{{char}} 每次开口前先对 {{user}} 做一个动作。",
    post_history_instructions: "{{char}} 收尾时只对 {{user}} 说一句。",
    mes_example: "{{user}}: {{char}} 今天做什么？\n{{char}}: 先去西边看看，{{user}} 跟上。",
    first_mes: "{{char}} 抬头看向 {{user}}。",
    alternate_greetings: ["{{char}} 把水壶递给 {{user}}。"],
  },
});

type CardData = Record<string, unknown>;

/**
 * The card's authored text fields, DERIVED from the card this test handed in.
 *
 * `name` is the one field excluded, and it is excluded by name rather than by a pattern:
 * her name is the identity the product resolves `{{char}}` TO, so a `{{char}}` inside it is
 * a self-reference nothing can render, and `data.name` round-trips from `identity.name`.
 */
const NOT_A_MACRO_CHANNEL = new Set(["name"]);

function authoredTextFields(data: CardData): string[] {
  return Object.keys(data)
    .filter((field) => !NOT_A_MACRO_CHANNEL.has(field))
    .filter(
      (field) =>
        typeof data[field] === "string" ||
        (Array.isArray(data[field]) && (data[field] as unknown[]).every((entry) => typeof entry === "string")),
    )
    .sort();
}

type CompanionRef = Readonly<{ companionId: string; continuityId: string }>;

type Fixture = Readonly<{
  root: string;
  authored: CardData;
  seed: CompanionRef;
  /** Exports one provisioned companion of this root, by the handle it was registered under. */
  exportCard: (companion: CompanionRef) => Promise<string>;
  /** Provisions a companion from `source`, through the real stage → review → confirm path. */
  provisionFromCard: (importId: string, source: string) => Promise<CompanionRef>;
  profileOf: (companion: CompanionRef) => Promise<Awaited<ReturnType<typeof readIdentityProfile>>>;
  close: () => void;
}>;

async function losslessFixture(): Promise<Fixture> {
  const root = await canonicalTestRoot("tavern-card-lossless-");
  const store = new TavernArtifactStore(root);
  const seedIdentity = { playerId: PLAYER, companionId: "seed", continuityId: "seed-continuity" };
  const tavernPaths = resolveTavernPaths(resolveRuntimePaths(seedIdentity, root), seedIdentity);
  const threads = createChatThreadStore(root, "a".repeat(64));
  const importService = new StCardImportService(store, tavernPaths);

  // The roster's reverse map, owned here because a handle is a per-mount HMAC: the export
  // service only reads the roots the record it resolves derives.
  const registered = new Map<string, Readonly<{ companionId: string; continuityId: string }>>();
  const register = (handle: string, companion: Readonly<{ companionId: string; continuityId: string }>): void => {
    registered.set(handle, Object.freeze({ companionId: companion.companionId, continuityId: companion.continuityId }));
  };
  const handleOf = (companion: CompanionRef): string => {
    for (const [handle, entry] of registered)
      if (entry.companionId === companion.companionId && entry.continuityId === companion.continuityId) return handle;
    throw new Error("lossless_fixture_companion_not_registered");
  };
  const exportService = createCompanionCardExportService({
    store,
    runtimeRoot: root,
    playerId: PLAYER,
    resolveCompanion: async (handle) => {
      const entry = registered.get(handle);
      return entry === undefined ? null : Object.freeze({ ...entry, name: CHAR });
    },
  });

  const provisionFromCard = async (importId: string, source: string): Promise<CompanionRef> => {
    const staged = await importService.import(importId, source);
    const eligible = staged.candidate.artifact.fields
      .filter((field) => field.eligibility === "profile_eligible_after_explicit_review")
      .map((field) => field.field);
    await importService.recordReview(importId, { reviewedFields: eligible, approvedAtMs: 1 });
    const created = await provisionNewCompanion(
      root,
      PLAYER,
      staged.candidate.artifact,
      await importService.confirmedReview(importId),
      threads,
    );
    return Object.freeze({ companionId: created.identity.companionId, continuityId: created.identity.continuityId! });
  };

  const seed = await provisionFromCard("seed_card", MACRO_CARD);
  register(SEED_HANDLE, seed);
  return Object.freeze({
    root,
    authored: (JSON.parse(MACRO_CARD) as { data: CardData }).data,
    seed,
    exportCard: async (companion: CompanionRef) => {
      const exported = await exportService.read(handleOf(companion), "json");
      if (exported === null || exported.format !== "json") throw new Error("expected the JSON form of the card");
      return exported.card;
    },
    provisionFromCard: async (importId: string, source: string) => {
      const created = await provisionFromCard(importId, source);
      register(importId === "round_trip_card" ? ROUND_TRIP_HANDLE : importId, created);
      return created;
    },
    profileOf: async (companion: CompanionRef) =>
      await readIdentityProfile(resolveRuntimePaths({ playerId: PLAYER, ...companion }, root).identityProfilePath),
    close: () => threads.close?.(),
  });
}

async function withFixture(body: (fixture: Fixture) => Promise<void>): Promise<void> {
  const fixture = await losslessFixture();
  try {
    await body(fixture);
  } finally {
    fixture.close();
    await rm(fixture.root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}

/**
 * The gate: every authored text field of an imported card is still the author's own text
 * after storage, and the export writes that text back.
 *
 * Two claims, deliberately separate. The first is the round trip itself. The second names
 * the mechanism that breaks it - a field stored as one run's RENDERING - so a failure says
 * which field and what it became, instead of only that two strings differ.
 */
test("an imported card's authored macros survive storage and the export writes them back", async () => {
  await withFixture(async (fixture) => {
    const exported = JSON.parse(await fixture.exportCard(fixture.seed)) as { data: CardData };
    const macros = macroTable({ char: CHAR, locale: "zh-CN" });
    const fields = authoredTextFields(fixture.authored);
    // Derived, and asserted to be non-trivial: a gate whose population quietly shrank to
    // nothing would pass forever.
    assert.deepEqual(fields, [
      "alternate_greetings",
      "description",
      "first_mes",
      "mes_example",
      "personality",
      "post_history_instructions",
      "scenario",
      "system_prompt",
    ]);
    const frozen: string[] = [];
    for (const field of fields) {
      const authored = fixture.authored[field];
      if (exported.data[field] !== undefined && JSON.stringify(exported.data[field]) !== JSON.stringify(authored))
        frozen.push(
          `${field}: exported ${JSON.stringify(exported.data[field])} instead of ${JSON.stringify(authored)}`,
        );
      // The named mechanism, for the case where the difference is exactly a rendering.
      for (const text of typeof authored === "string" ? [authored] : (authored as string[])) {
        const rendered = renderMacros(text, macros);
        if (rendered === text) continue;
        const wrote = JSON.stringify(exported.data[field]);
        if (wrote.includes(JSON.stringify(rendered).slice(1, -1)))
          frozen.push(`${field}: stored the rendering ${JSON.stringify(rendered)} rather than the author's macro`);
      }
    }
    assert.deepEqual(frozen, [], `fields that lost the author's macros: ${frozen.join("; ")}`);
  });
});

/**
 * The stronger half, and the one a one-generation fix passes: her card, fed back through
 * the real import path, must export to the SAME BYTES. That holds only while every write
 * side stores authored text - one more generation of a rendering write and the second
 * card says 琥珀 where the first said `{{char}}`.
 */
test("re-exporting is byte-identical, and so is the card the exported card provisions", async () => {
  await withFixture(async (fixture) => {
    const first = await fixture.exportCard(fixture.seed);
    // Byte identity alone cannot discriminate - a write side that renders on the way in is
    // deterministic, so two generations of it agree with each other. The identity this test
    // is about is identity with the AUTHOR'S card, so it is asserted on the same bytes: every
    // authored text field is present in them, macro and all.
    for (const field of authoredTextFields(fixture.authored)) {
      const authored = fixture.authored[field];
      for (const text of typeof authored === "string" ? [authored] : (authored as string[]))
        assert.ok(
          first.includes(JSON.stringify(text).slice(1, -1)),
          `the exported card lost ${field}: ${JSON.stringify(text)} is not in it`,
        );
    }
    assert.equal(await fixture.exportCard(fixture.seed), first, "two exports of one companion must be the same bytes");
    const roundTripped = await fixture.provisionFromCard("round_trip_card", first);
    assert.notEqual(roundTripped.companionId, fixture.seed.companionId, "the second import is its own companion");
    assert.equal(
      await fixture.exportCard(roundTripped),
      first,
      "the card the exported card provisions must export identically",
    );
  });
});

/**
 * What is on disk, stated separately from what the export writes: the durable profile is
 * the AUTHOR's record. Without this, an export that silently re-rendered on read could
 * keep the gate above green while storage had already lost the macros.
 */
test("the stored profile keeps the author's macros for every authored profile field", async () => {
  await withFixture(async (fixture) => {
    const profile = await fixture.profileOf(fixture.seed);
    const stored = JSON.stringify({
      core: profile.persona?.core,
      interactionStyle: profile.persona?.interactionStyle,
      examples: profile.examples,
      characterVoice: profile.characterVoice?.text,
    });
    assert.match(stored, /\{\{char\}\}/u, "the durable profile keeps the author's own text");
    assert.match(stored, /\{\{user\}\}/u, "the durable profile keeps the author's own text");
  });
});
