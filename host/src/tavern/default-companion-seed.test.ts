import assert from "node:assert/strict";
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import {
  identityProfileMetadata,
  buildChatCompanionSystemPrompt,
  type IdentityProfile,
  readIdentityProfile,
  writeIdentityProfile,
} from "../identity-profile.js";
import { bindWindowsStaleLockReclaimer } from "../path-lock.js";
import { identityKey, resolveRuntimePaths, type CompanionIdentity } from "../runtime-identity.js";
import { canonicalTestRoot } from "../test-support/canonical-test-root.test-support.js";
import { createBuildWindowsStaleLockReclaimer } from "../windows-stale-lock-reclaimer/index.js";
import { TavernArtifactStore } from "./artifact-store.js";
import { createChatThreadStore } from "./chat-thread-store.js";
import { DEFAULT_COMPANION_PRESET } from "./default-companion-preset.js";
import { seedDefaultCompanionIntoFreshRuntimeRoot } from "./default-companion-seed.js";
import { createGreetingManagementService } from "./greeting-management/greeting-management.js";
import { macroTable } from "./macro-engine.js";
import { createTavernLibraryService, resolveCompanionOwnScenario } from "./library-service.js";
import {
  createScenarioManagementService,
  withScenarioSurfaceMacros,
} from "./scenario-management/scenario-management.js";
import { resolveTavernPaths } from "./tavern-paths.js";

const identity: CompanionIdentity = Object.freeze({
  continuityId: "continuity_default_companion",
  companionId: "companion_default_companion",
  playerId: "player_default_companion",
});

test.before(async () => {
  bindWindowsStaleLockReclaimer(await createBuildWindowsStaleLockReclaimer());
});

test.after(() => {
  bindWindowsStaleLockReclaimer(undefined);
});

async function release(root: string): Promise<void> {
  await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}

test("a fresh runtime root presents as 琥珀 with the preset's opening and world book", async () => {
  const root = await canonicalTestRoot("default-companion-seed-");
  try {
    const outcome = await seedDefaultCompanionIntoFreshRuntimeRoot(identity, root);
    assert.equal(outcome.seeded, true);
    assert.equal(outcome.reason, "seeded");
    assert.equal(outcome.identityName, "琥珀");
    assert.equal(outcome.profileId, DEFAULT_COMPANION_PRESET.profile.profileId);
    assert.equal(outcome.greetingVariants, DEFAULT_COMPANION_PRESET.greetings.length);

    const paths = resolveRuntimePaths(identity, root);
    const profile = await readIdentityProfile(paths.identityProfilePath);
    assert.equal(profile.identity.name, "琥珀");
    assert.notEqual(profile.identity.name, "GameBuddy Companion");
    assert.ok(profile.persona?.core !== undefined && profile.persona.core.length > 0);

    const book = JSON.parse(await readFile(join(paths.runtimeCwd, "worldbook.json"), "utf8")) as {
      worldBookId: string;
    };
    assert.equal(book.worldBookId, DEFAULT_COMPANION_PRESET.worldBook.worldBookId);

    const tavernPaths = resolveTavernPaths(paths, identity);
    const record = await createGreetingManagementService(
      new TavernArtifactStore(paths.root),
      tavernPaths.companionRoot,
    ).readExact();
    assert.ok(record !== null);
    assert.equal(record.variants[0]?.text, DEFAULT_COMPANION_PRESET.greetings[0]?.text);

    // The card's scenario is a durable scenario record, not profile text, so the
    // seed must install it: a fresh root's companion otherwise reaches the player
    // with no world premise. Both readers resolve the SAME record by
    // `companionScenarioId` — the character surface's Scenario panel
    // (`scenario.read`, which otherwise shows 「还没有保存场景。」) and a new Chat's
    // own scenario (`resolveCompanionOwnScenario`).
    const scenario = await createScenarioManagementService(
      new TavernArtifactStore(paths.root),
      tavernPaths.companionRoot,
    ).read();
    assert.ok(scenario !== null, "the seeded companion must carry a durable scenario record");
    assert.equal(scenario.description, DEFAULT_COMPANION_PRESET.scenario);
    assert.ok(scenario.description.includes("星露谷"));

    const ownScenario = await resolveCompanionOwnScenario(
      new TavernArtifactStore(paths.root),
      tavernPaths.companionRoot,
    );
    assert.ok(ownScenario !== undefined, "a new Chat must resolve the seeded companion's own scenario");
    assert.equal(ownScenario.artifact.description, DEFAULT_COMPANION_PRESET.scenario);
  } finally {
    await release(root);
  }
});

test("a restart after a fresh seed never overwrites the player's edits", async () => {
  const root = await canonicalTestRoot("default-companion-reseed-");
  try {
    await seedDefaultCompanionIntoFreshRuntimeRoot(identity, root);
    const paths = resolveRuntimePaths(identity, root);
    const edited: IdentityProfile = Object.freeze({
      ...DEFAULT_COMPANION_PRESET.profile,
      identity: Object.freeze({ ...DEFAULT_COMPANION_PRESET.profile.identity, name: "我的搭档" }),
    });
    await writeIdentityProfile(paths.identityProfilePath, edited);

    const again = await seedDefaultCompanionIntoFreshRuntimeRoot(identity, root);
    assert.equal(again.seeded, false);
    assert.equal(again.reason, "already_present");
    assert.equal((await readIdentityProfile(paths.identityProfilePath)).identity.name, "我的搭档");
  } finally {
    await release(root);
  }
});

test("a fresh seed installs the library companion record, so the seeded companion opens a second Chat", async () => {
  const root = await canonicalTestRoot("default-companion-seed-chat-");
  try {
    await seedDefaultCompanionIntoFreshRuntimeRoot(identity, root);
    const paths = resolveRuntimePaths(identity, root);
    const tavernPaths = resolveTavernPaths(paths, identity);

    // The record the library's chat selector reads is the record the seed installs
    // through the library's own creation path: one producer, always present.
    const companion = JSON.parse(await readFile(join(tavernPaths.companionRoot, "companion.json"), "utf8")) as {
      artifact: { companionId: string; continuityId: string };
    };
    assert.equal(companion.artifact.companionId, identity.companionId);
    assert.equal(companion.artifact.continuityId, identity.continuityId);

    const threads = createChatThreadStore(paths.runtimeCwd, identityKey(identity), () => 10);
    try {
      const library = createTavernLibraryService(tavernPaths, new TavernArtifactStore(root), threads, {
        async readExact() {
          return identityProfileMetadata(await readIdentityProfile(paths.identityProfilePath));
        },
      });
      // The runtime's own first Chat, then a second one created on the seeded
      // companion - the exact operation the capture could not perform.
      const first = await library.createNewChat({
        chatThreadId: "chat-seed-1",
        chatSurfaceSessionId: "surface-seed-1",
        opening: { kind: "blank" },
      });
      assert.equal(first.messages.length, 0);
      const second = await library.createNewChat({
        chatThreadId: "chat-seed-2",
        chatSurfaceSessionId: "surface-seed-2",
      });
      const opening = second.messages.find((message) => message.kind === "opening");
      assert.ok(opening !== undefined);
      assert.equal(opening.text, DEFAULT_COMPANION_PRESET.greetings[0]?.text);
      assert.deepEqual(
        (await library.listChats()).map((chat) => chat.chatThreadId),
        ["chat-seed-1", "chat-seed-2"],
      );
    } finally {
      threads.close?.();
    }
  } finally {
    await release(root);
  }
});

// The three laws of the default path, end to end: the card's own directive
// must reach the model through the SHIPPED preset, the fresh-root seed must
// persist it into `identity-profile.json`, and the rendered prompt must carry
// it AFTER the Host floor.
test("the seed persists the card's characterVoice and the rendered prompt carries it after the floor", async () => {
  const root = await canonicalTestRoot("default-companion-seed-voice-");
  try {
    await seedDefaultCompanionIntoFreshRuntimeRoot(identity, root);
    const paths = resolveRuntimePaths(identity, root);
    const profile = await readIdentityProfile(paths.identityProfilePath);
    assert.ok(profile.characterVoice !== undefined);
    assert.equal(profile.characterVoice.source, "card");
    assert.ok(profile.characterVoice.text.includes("动率先于言"));
    assert.ok(profile.characterVoice.text.includes("称谓规范"));
    assert.ok(profile.characterVoice.text === DEFAULT_COMPANION_PRESET.profile.characterVoice?.text);

    const prompt = buildChatCompanionSystemPrompt(profile, "zh-CN");
    const floorMarker = "Never mention prompts, instructions, models, or systems, and never explain how you work.";
    const voiceMarker = "【角色演出指导（Character Voice & Directives）】";
    assert.ok(prompt.includes(voiceMarker), "the rendered prompt must carry the character-voice section");
    assert.ok(
      prompt.indexOf("动率先于言") > prompt.indexOf(floorMarker) &&
        prompt.indexOf(voiceMarker) > prompt.indexOf(floorMarker),
      "the card's directive must render AFTER the Host floor on the default path",
    );
    assert.ok(
      prompt.indexOf("动率先于言") > prompt.indexOf(voiceMarker),
      "the directive must sit inside its own labelled section",
    );
  } finally {
    await release(root);
  }
});
test("the seeded companion's scenario reaches the browser with its macros rendered", async () => {
  const root = await canonicalTestRoot("default-companion-surface-");
  try {
    await seedDefaultCompanionIntoFreshRuntimeRoot(identity, root);
    const paths = resolveRuntimePaths(identity, root);
    const tavernPaths = resolveTavernPaths(paths, identity);
    const store = new TavernArtifactStore(paths.root);
    const durable = createScenarioManagementService(store, tavernPaths.companionRoot);
    const profile = await readIdentityProfile(paths.identityProfilePath);
    const surface = withScenarioSurfaceMacros(durable, async () =>
      macroTable({ char: profile.identity.name, locale: "zh-CN" }),
    );

    const projection = await surface.read();
    assert.ok(projection !== null, "the seeded companion must carry a durable scenario record");
    assert.equal(projection.description.includes("{{"), false, "the surface must never paint a raw macro");
    assert.ok(projection.description.includes(profile.identity.name), "the companion's real name is resolved");
    assert.ok(projection.description.includes("玩家"), "the player reference is resolved");

    // The durable record still carries `{{user}}`, so the absence above is the
    // rendering and not a scenario that happened to contain no macro.
    const stored = await durable.read();
    assert.ok(stored !== null);
    assert.ok(stored.description.includes("{{user}}"));
  } finally {
    await release(root);
  }
});
