import assert from "node:assert/strict";
import { mkdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import {
  COMPANION_PROFILE_NAME_MAX_LENGTH,
  COMPANION_PROFILE_TEXT_MAX_LENGTH,
  COMPANION_WORLD_BOOK_CONTENT_MAX_LENGTH,
} from "./browser-contract/index.js";
import { DEFAULT_IDENTITY_PROFILE, writeIdentityProfile } from "../identity-profile.js";
import { resolveRuntimePaths } from "../runtime-identity.js";
import { writeWorldBook } from "../worldbook.js";
import { TavernArtifactStore } from "./artifact-store.js";
import { createCompanionProfileService } from "./companion-profile-service.js";
import { createGreetingManagementService } from "./greeting-management/greeting-management.js";
import { createScenarioManagementService } from "./scenario-management/scenario-management.js";
import { resolveTavernPaths } from "./tavern-paths.js";
import { canonicalTestRoot } from "../test-support/canonical-test-root.test-support.js";

/**
 * The read-only inspector's projection, at its own seam.
 *
 * The client journeys (`dialogue-web/tests/companion-inspector.spec.ts`) assert what
 * reaches the screen; this asserts what the Host hands it, which is the half a
 * browser stub cannot see:
 *
 *  - every authored string is rendered through the run's macro table here, so a
 *    card's `{{user}}`/`{{char}}` never leaves the Host - and the DURABLE record
 *    still carries it, because an author's text is not the Host's to rewrite;
 *  - a group she was provisioned without reads as `present: false`, which is a
 *    different fact from a group that exists and holds nothing;
 *  - a field that renders past its bound is refused by name rather than shortened,
 *    because a shortened field would read as the author's own words.
 *
 * The greeting case is the one that used to leak: the greeting store projects
 * authored text verbatim (`greeting-management.ts` is the durable read the editor
 * writes back), so a card's `first_mes` carrying `{{user}}` reached the player as a
 * literal until this seam rendered it.
 */

const identity = Object.freeze({
  playerId: "player_01",
  companionId: "companion_01",
  continuityId: "continuity_01",
});

type Seeded = Readonly<{
  root: string;
  read: () => Promise<Awaited<ReturnType<ReturnType<typeof createCompanionProfileService>["read"]>>>;
  runtimeCwd: string;
  companionRoot: string;
}>;

async function seed(): Promise<Seeded> {
  const root = await canonicalTestRoot("gamebuddy-companion-profile-");
  const runtimePaths = resolveRuntimePaths(identity, root);
  const tavernPaths = resolveTavernPaths(runtimePaths, identity);
  const store = new TavernArtifactStore(root);
  await writeIdentityProfile(runtimePaths.identityProfilePath, {
    ...DEFAULT_IDENTITY_PROFILE,
    profileId: "profile_01",
    identity: { ...DEFAULT_IDENTITY_PROFILE.identity, name: "Mira" },
    persona: {
      core: "{{char}} keeps the ledgers and reads the weather.",
      interactionStyle: "{{user}} is late again, and she says so.",
    },
  });
  await createScenarioManagementService(store, tavernPaths.companionRoot).create({
    name: "Winter on the ridge",
    description: "The pass closes in November, and {{user}} knows it.",
  });
  await createGreetingManagementService(store, tavernPaths.companionRoot).create({
    label: "The porch",
    variants: [
      { label: "Default", text: "You are late, {{user}}, and the kettle is cold." },
      { label: "Warm", text: "There you are, {{user}}. I kept the kettle on." },
    ],
  });
  const service = createCompanionProfileService({
    store,
    runtimeRoot: root,
    playerId: identity.playerId,
    locale: async () => "en-US",
    resolveCompanion: async (handle) => (handle === "handle_01" ? { ...identity, name: "Mira" } : null),
  });
  return {
    root,
    runtimeCwd: runtimePaths.runtimeCwd,
    companionRoot: tavernPaths.companionRoot,
    read: () => service.read("handle_01"),
  };
}

async function worldBookFile(seeded: Seeded, content: string): Promise<string> {
  // Written through the world book authority's own writer, not hand-rolled JSON:
  // it validates the shape and stamps the canonical hash, so the fixture cannot be
  // rejected for a reason that has nothing to do with what the test is about.
  const path = join(seeded.runtimeCwd, "worldbook.json");
  await mkdir(seeded.runtimeCwd, { recursive: true });
  await writeWorldBook(path, {
    schemaVersion: 1,
    worldBookId: "gamebuddy-worldbook-companion_01",
    revision: 1,
    alwaysOnPremise: "",
    entries: [
      {
        entryId: "entry-1",
        title: "The pact",
        content,
        scope: "companion",
        provenance: "st-card-import",
        tokenBudget: "small",
        constant: true,
        keys: ["pact"],
      },
    ],
  });
  return path;
}

test("the projection renders every authored field, and the durable records keep the author's own text", async () => {
  const seeded = await seed();
  try {
    const bookPath = await worldBookFile(seeded, "{{char}} and {{user}} agreed to split the ridge.");
    const profile = await seeded.read();
    assert.ok(profile !== null);

    // Rendered: the player's own words, never a placeholder.
    assert.equal(profile.name, "Mira");
    assert.equal(profile.persona.present, true);
    assert.equal(profile.persona.core, "Mira keeps the ledgers and reads the weather.");
    assert.equal(profile.persona.interactionStyle, "the player is late again, and she says so.");
    // Absent stays absent: a dimension the card never wrote is null, not an empty
    // string, so the drawer can leave the line out rather than print nothing.
    assert.equal(profile.persona.expressionStyle, null);
    assert.equal(profile.scenario.present, true);
    assert.equal(profile.scenario.name, "Winter on the ridge");
    assert.equal(profile.scenario.description, "The pass closes in November, and the player knows it.");
    assert.equal(profile.greetings.present, true);
    assert.equal(profile.greetings.label, "The porch");
    assert.deepEqual(
      profile.greetings.variants.map((variant) => variant.text),
      ["You are late, the player, and the kettle is cold.", "There you are, the player. I kept the kettle on."],
    );
    assert.equal(profile.worldBook.present, true);
    assert.equal(profile.worldBook.entries[0]!.content, "Mira and the player agreed to split the ridge.");
    const serialised = JSON.stringify(profile);
    assert.equal(serialised.includes("{{"), false, "no placeholder survives the projection");

    // Durable: the author's text is exactly where the editor left it.
    const greetingRecord = await createGreetingManagementService(
      new TavernArtifactStore(seeded.root),
      seeded.companionRoot,
    ).read();
    assert.ok(greetingRecord !== null);
    assert.match(greetingRecord.variants[0]!.text, /\{\{user\}\}/u);
    const scenarioRecord = await createScenarioManagementService(
      new TavernArtifactStore(seeded.root),
      seeded.companionRoot,
    ).read();
    assert.match(String(scenarioRecord?.description), /\{\{user\}\}/u);
    assert.match(await readFile(bookPath, "utf8"), /\{\{char\}\}/u);
  } finally {
    await rm(seeded.root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test("a companion made without a group reads as absent, and an empty book is present", async () => {
  const root = await canonicalTestRoot("gamebuddy-companion-profile-empty-");
  try {
    const runtimePaths = resolveRuntimePaths(identity, root);
    const tavernPaths = resolveTavernPaths(runtimePaths, identity);
    // No identity profile, no scenario, no greeting set, and a book that exists and
    // holds nothing: the four facts the drawer must tell apart.
    await mkdir(runtimePaths.runtimeCwd, { recursive: true });
    await writeWorldBook(join(runtimePaths.runtimeCwd, "worldbook.json"), {
      schemaVersion: 1,
      worldBookId: "gamebuddy-worldbook-companion_01",
      revision: 1,
      alwaysOnPremise: "",
      entries: [],
    });
    const service = createCompanionProfileService({
      store: new TavernArtifactStore(root),
      runtimeRoot: root,
      playerId: identity.playerId,
      locale: async () => "en-US",
      resolveCompanion: async (handle) => (handle === "handle_01" ? { ...identity, name: "Bare" } : null),
    });
    const profile = await service.read("handle_01");
    assert.ok(profile !== null);
    // Her library name stands in when there is no identity profile to name her.
    assert.equal(profile.name, "Bare");
    assert.equal(profile.persona.present, false);
    assert.equal(profile.persona.core, null);
    assert.equal(profile.scenario.present, false);
    assert.equal(profile.greetings.present, false);
    assert.deepEqual(profile.greetings.variants, []);
    // Present and empty, which the drawer states in words rather than as a zero.
    assert.equal(profile.worldBook.present, true);
    assert.deepEqual(profile.worldBook.entries, []);
    // The paths the service read from are this companion's own, derived the way the
    // mount derives them - which is what makes an archived companion readable at all.
    assert.equal(tavernPaths.companionRoot.startsWith(runtimePaths.root), true);
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test("an entry body past the browser bound is refused by name, never shortened", async () => {
  const seeded = await seed();
  try {
    // The durable book's own bound is larger than the one the browser contract carries,
    // so this is the reachable case: the file is valid, and the projection refuses it
    // rather than handing the browser a shortened body that would read as the author's
    // own text.
    await worldBookFile(seeded, "x".repeat(COMPANION_WORLD_BOOK_CONTENT_MAX_LENGTH + 1));
    await assert.rejects(seeded.read, (error: Error) => error.message === "companion_world_book_entry_too_long");
  } finally {
    await rm(seeded.root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test("a handle the roster never projected reads as null rather than an empty companion", async () => {
  const seeded = await seed();
  try {
    const service = createCompanionProfileService({
      store: new TavernArtifactStore(seeded.root),
      runtimeRoot: seeded.root,
      playerId: identity.playerId,
      locale: async () => "en-US",
      resolveCompanion: async () => null,
    });
    assert.equal(await service.read("handle_unknown"), null);
    // …and the bounds this projection applies are real ones, so an oversized field is
    // a case the seam refuses rather than one the schema truncates. The profile writer
    // enforces a smaller bound of its own, so the projection's is the second line of
    // defence rather than the only one - asserted here so nobody mistakes the
    // reachable refusal for the unreachable one.
    assert.ok(COMPANION_PROFILE_NAME_MAX_LENGTH > 0);
    assert.ok(COMPANION_PROFILE_TEXT_MAX_LENGTH > 0);
  } finally {
    await rm(seeded.root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
