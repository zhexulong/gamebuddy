import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import {
  buildChatCompanionSystemPrompt,
  type IdentityProfile,
  identityProfileMetadata,
  readIdentityProfile,
  writeIdentityProfile,
} from "../identity-profile.js";
import { bindWindowsStaleLockReclaimer } from "../path-lock.js";
import { type CompanionIdentity, identityKey, resolveRuntimePaths } from "../runtime-identity.js";
import { canonicalTestRoot } from "../test-support/canonical-test-root.test-support.js";
import { createBuildWindowsStaleLockReclaimer } from "../windows-stale-lock-reclaimer/index.js";
import { TavernArtifactStore } from "./artifact-store.js";
import { createChatThreadStore } from "./chat-thread-store.js";
import {
  COMPANION_AVATAR_FILE_NAME,
  companionAvatarPath,
  createCompanionAvatarService,
  isCompletePngFile,
  MAX_COMPANION_AVATAR_BYTES,
} from "./companion-avatar/index.js";
import { DEFAULT_COMPANION_PRESET } from "./default-companion-preset.js";
import { seedDefaultCompanionIntoFreshRuntimeRoot } from "./default-companion-seed.js";
import { createGreetingManagementService } from "./greeting-management/greeting-management.js";
import { createTavernLibraryService, resolveCompanionOwnScenario } from "./library-service.js";
import { macroTable } from "./macro-engine.js";
import { readCompanionPostHistoryInstructions } from "./post-history-instructions.js";
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

// The card's closing direction is the last authored fact the shipped preset
// dropped: the decoder kept it, but nothing between the preset and her own root
// carried it, so a seeded companion ended every reply without it while an imported
// card's companion ended with it. The reader below is the exact call
// `catalog-service.ts` makes when it builds her catalogue, so a record this test
// can read is a record the fork's tail can append.
test("a fresh seed writes the card's post_history_instructions as her own record, verbatim", async () => {
  const root = await canonicalTestRoot("default-companion-post-history-");
  try {
    assert.ok(DEFAULT_COMPANION_PRESET.postHistoryInstructions !== undefined);
    await seedDefaultCompanionIntoFreshRuntimeRoot(identity, root);
    const paths = resolveRuntimePaths(identity, root);
    const tavernPaths = resolveTavernPaths(paths, identity);
    const recorded = await readCompanionPostHistoryInstructions(
      new TavernArtifactStore(paths.root),
      tavernPaths.companionRoot,
    );
    // Verbatim, down to the byte and including the author's own line breaks: the
    // reader renders macros, so nothing between here and there may rewrite it.
    // The byte count is taken from the compiled preset rather than hardcoded: the
    // number that matters is "the bytes written equal the bytes shipped", and a
    // literal here would have to be edited every time the card's wording changed -
    // at which point the case stops being a check and becomes a registration step.
    assert.equal(recorded, DEFAULT_COMPANION_PRESET.postHistoryInstructions);
    assert.ok(recorded !== null);
    assert.equal(
      Buffer.byteLength(recorded, "utf8"),
      Buffer.byteLength(DEFAULT_COMPANION_PRESET.postHistoryInstructions!, "utf8"),
    );
    assert.equal(recorded.split("\n")[0], DEFAULT_COMPANION_PRESET.postHistoryInstructions!.split("\n")[0]);
  } finally {
    await release(root);
  }
});

// Absence is a state of its own: no file at all, not an empty one - the same
// distinction the reader makes between `null` and a zero-length record.
test("a preset whose card declares no post_history_instructions writes no record at all", async () => {
  const root = await canonicalTestRoot("default-companion-post-history-absent-");
  try {
    const { postHistoryInstructions: _closing, ...withoutField } = DEFAULT_COMPANION_PRESET;
    await seedDefaultCompanionIntoFreshRuntimeRoot(identity, root, withoutField);
    const paths = resolveRuntimePaths(identity, root);
    const tavernPaths = resolveTavernPaths(paths, identity);
    assert.equal(existsSync(join(tavernPaths.companionRoot, "post-history-instructions.json")), false);
    assert.equal(
      await readCompanionPostHistoryInstructions(new TavernArtifactStore(paths.root), tavernPaths.companionRoot),
      null,
    );
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
    assert.ok(projection.description.includes("星露谷"));

    const stored = await durable.read();
    assert.ok(stored !== null);
    assert.equal(stored.description, DEFAULT_COMPANION_PRESET.scenario);
  } finally {
    await release(root);
  }
});

// The preset's picture travels the same road as her profile: the compiled preset
// carries it (base64, because a generated module cannot hold binary) and the seed
// writes it where the avatar face reads. These two tests are the two facts that
// must never be confused - "she has a picture and it is the owner's file" and
// "her picture was present and refused by name".
test("a preset carrying a picture puts it on her companion root, where the avatar face reads it", async () => {
  const root = await canonicalTestRoot("default-companion-seed-avatar-");
  try {
    await seedDefaultCompanionIntoFreshRuntimeRoot(identity, root);
    const paths = resolveRuntimePaths(identity, root);
    const tavernPaths = resolveTavernPaths(paths, identity);
    // The bytes are the owner's own `assets/tavern/presets/default-companion/avatar.png`
    // (the drift test proves that half); here they must decide where the picture landed.
    assert.ok(DEFAULT_COMPANION_PRESET.avatarBase64 !== undefined);
    const expected = Buffer.from(DEFAULT_COMPANION_PRESET.avatarBase64, "base64");
    assert.ok(isCompletePngFile(expected), "the preset's picture must itself be a picture");
    assert.deepEqual(await readFile(join(tavernPaths.companionRoot, COMPANION_AVATAR_FILE_NAME)), expected);
    // The file being there is not the claim; the face the shell mounts serving it is.
    const handle = `${"D".repeat(42)}A`;
    const service = createCompanionAvatarService({
      runtimeRoot: root,
      playerId: identity.playerId,
      async resolveCompanion(candidate) {
        return candidate === handle
          ? Object.freeze({ companionId: identity.companionId, continuityId: identity.continuityId! })
          : null;
      },
    });
    const read = await service.read(handle);
    assert.equal(read?.state, "present");
    assert.deepEqual(read?.state === "present" ? read.bytes : undefined, expected);
    // A handle the roster projects nothing for is a different answer again.
    assert.equal(await service.read(`${"E".repeat(42)}A`), null);
  } finally {
    await release(root);
  }
});

test("a preset picture that is present and unusable is refused by name, and seeds nothing", async () => {
  const root = await canonicalTestRoot("default-companion-seed-avatar-refused-");
  try {
    const paths = resolveRuntimePaths(identity, root);
    const avatarPath = companionAvatarPath(root, identity.playerId, {
      companionId: identity.companionId,
      continuityId: identity.continuityId!,
    });
    const withAvatar = (avatarBase64: string) => Object.freeze({ ...DEFAULT_COMPANION_PRESET, avatarBase64 });

    // A JSON card renamed `.png`: the bytes are a card, not a picture.
    await assert.rejects(
      seedDefaultCompanionIntoFreshRuntimeRoot(
        identity,
        root,
        withAvatar(Buffer.from('{"spec":"chara_card_v3","data":{"name":"Rin"}}', "utf8").toString("base64")),
      ),
      /default_companion_avatar_malformed/u,
    );
    // Over the avatar module's OWN ceiling is the other named refusal - not the
    // same word for both, and not a companion seeded without a picture.
    await assert.rejects(
      seedDefaultCompanionIntoFreshRuntimeRoot(
        identity,
        root,
        withAvatar(Buffer.alloc(MAX_COMPANION_AVATAR_BYTES + 1).toString("base64")),
      ),
      /default_companion_avatar_too_large/u,
    );
    // Both refusals happen before the first durable write, so nothing half-seeded
    // is left behind for the next open to read as a companion.
    assert.equal(existsSync(paths.identityProfilePath), false);
    assert.equal(existsSync(avatarPath), false);

    // A preset that carries NO picture is an ordinary state, and seeds normally
    // with no avatar file: absence is not the same fact as a refusal. This is the
    // shape a preset directory with no `avatar.png` compiles to.
    const { avatarBase64: _picture, ...withoutPicture } = DEFAULT_COMPANION_PRESET;
    const outcome = await seedDefaultCompanionIntoFreshRuntimeRoot(identity, root, withoutPicture);
    assert.equal(outcome.seeded, true);
    assert.equal(existsSync(paths.identityProfilePath), true);
    assert.equal(existsSync(avatarPath), false);
  } finally {
    await release(root);
  }
});
