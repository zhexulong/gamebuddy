import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import test from "node:test";
import { buildChatCompanionSystemPrompt } from "../companion-prompt-assembly.js";
import {
  createIdentityProfileBinding,
  DEFAULT_IDENTITY_PROFILE,
  type IdentityProfile,
  readIdentityProfile,
  validateIdentityProfile,
  writeIdentityProfile,
  writeIdentityProfileBinding,
} from "../identity-profile.js";
import { bindWindowsStaleLockReclaimer } from "../path-lock.js";
import { identityKey, resolveRuntimePaths, type CompanionIdentity } from "../runtime-identity.js";
import { canonicalTestRoot } from "../test-support/canonical-test-root.test-support.js";
import { createBuildWindowsStaleLockReclaimer } from "../windows-stale-lock-reclaimer/index.js";
import {
  type CompanionExamplePair,
  renderCompanionExamples,
  updateMountedCompanionExamples,
} from "./companion-examples-service.js";
import { createChatThreadStore } from "./chat-thread-store.js";
import { macroTable } from "./macro-engine.js";
import type { CompanionProfileBindingRefresh } from "./mounted-identity-profile-write.js";

/**
 * Her example dialogues as a durable record that reaches the prompt.
 *
 * These are the few-shot rows that decide her register - `renderIdentityProfile` emits them as
 * `[Dialogue Examples]` and the Chat system prompt is built from exactly that rendering - and
 * until these routes existed no surface could write them: the card import set them, the card
 * export wrote them back, and a companion the player made directly kept the SHIPPED default's
 * rows for good.
 *
 * So the reading each test is built around is the prompt itself (`buildChatCompanionSystemPrompt`,
 *   the instrument `companion-voice-service.test.ts` uses for the directive): an editor over a
 *   field no prompt reads is the defect, and only the assembled prompt can show which side of it
 *   this is.
 */

/** The table the surface paints with: `{{char}}` is Nova, `{{user}}` the run's second person. */
const IDENTITY_MACROS = macroTable({ char: "Nova", locale: "zh-CN" });

const identity: CompanionIdentity = Object.freeze({
  continuityId: "continuity_examples",
  companionId: "companion_examples",
  playerId: "player_examples",
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

/** A directly-created companion: her own name, and whatever rows the caller wrote for her. */
function profileWithExamples(examples: readonly CompanionExamplePair[] | undefined): IdentityProfile {
  return validateIdentityProfile({
    ...DEFAULT_IDENTITY_PROFILE,
    profileId: "gamebuddy.companion_examples",
    identity: { ...DEFAULT_IDENTITY_PROFILE.identity, name: "Nova" },
    ...(examples === undefined ? { examples: undefined } : { examples }),
  });
}

async function writeProfile(root: string, profile: IdentityProfile, surfaceSessionId: string): Promise<string> {
  const paths = resolveRuntimePaths(identity, root, surfaceSessionId);
  await writeIdentityProfile(paths.identityProfilePath, profile, { containmentRoot: paths.root });
  await writeIdentityProfileBinding(
    paths.identityProfileBindingPath,
    createIdentityProfileBinding(identityKey(identity), profile),
    { containmentRoot: paths.root },
  );
  return paths.identityProfilePath;
}

/** The re-pin the composition hands in: the real store method over a real continuity root. */
function threadBindingRefresh(root: string): CompanionProfileBindingRefresh {
  return async (previous, next) => {
    const threads = createChatThreadStore(root, identityKey(identity));
    try {
      const refresh = threads.refreshCompanionProfileBinding;
      if (refresh === undefined) throw new Error("tavern_management_composition_unavailable");
      return await refresh({
        companionId: identity.companionId,
        continuityId: identity.continuityId!,
        previous: Object.freeze({
          profileId: previous.profileId,
          revision: previous.revision,
          canonicalHash: previous.canonicalHash,
        }),
        binding: Object.freeze({
          profileId: next.profileId,
          revision: next.revision,
          canonicalHash: next.canonicalHash,
        }),
      });
    } finally {
      threads.close?.();
    }
  };
}

test("a saved example reaches the assembled Chat prompt, and the rows it replaced are gone", async () => {
  const root = await canonicalTestRoot("companion-examples-prompt-");
  try {
    const session = "surface_examples_prompt";
    const paths = resolveRuntimePaths(identity, root, session);
    // A companion the player made directly: her profile is the shipped default's, which means
    // the default card's eight Chinese rows are teaching her register.
    const profilePath = await writeProfile(root, profileWithExamples(DEFAULT_IDENTITY_PROFILE.examples), session);
    const before = await readIdentityProfile(profilePath);
    const beforePrompt = buildChatCompanionSystemPrompt(before, "zh-CN");
    assert.ok(beforePrompt.includes("[Dialogue Examples]"));
    assert.match(beforePrompt, /先去西边那几畦看看吧/u);

    const saved = await updateMountedCompanionExamples({
      identityProfilePath: profilePath,
      runtimeCwd: paths.runtimeCwd,
      containmentRoot: paths.root,
      identityKey: identityKey(identity),
      expectedProfileRevision: before.revision,
      macros: IDENTITY_MACROS,
      examples: [{ user: "今天先做什么？", companion: "先把水壶灌满，我去西边那几垄。" }],
      refreshThreadBindings: threadBindingRefresh(root),
    });
    assert.deepEqual(saved.examples, [{ user: "今天先做什么？", companion: "先把水壶灌满，我去西边那几垄。" }]);

    // THE reading this whole lane rests on: the durable record a mount reads, rendered by the
    // Chat system prompt builder. The edited row is in the prompt and the replaced ones are not.
    const readBack = await readIdentityProfile(profilePath);
    const prompt = buildChatCompanionSystemPrompt(readBack, "zh-CN");
    assert.match(prompt, /\[Dialogue Examples\]/u);
    assert.match(prompt, /Nova: 先把水壶灌满，我去西边那几垄。/u);
    assert.match(prompt, /你: 今天先做什么？/u);
    assert.doesNotMatch(prompt, /先去西边那几畦看看吧/u);
  } finally {
    await release(root);
  }
});

test("a row the player did not rewrite keeps the author's macros", async () => {
  const root = await canonicalTestRoot("companion-examples-authored-");
  try {
    const session = "surface_examples_authored";
    const paths = resolveRuntimePaths(identity, root, session);
    const profilePath = await writeProfile(
      root,
      profileWithExamples([
        { user: "{{user}} 在家吗", companion: "{{char}} 在这儿。" },
        { user: "{{user}} 吃了吗", companion: "{{char}} 刚吃过。" },
      ]),
      session,
    );
    const original = await readIdentityProfile(profilePath);
    // What the surface paints: macros resolved.
    assert.deepEqual(renderCompanionExamples(original, IDENTITY_MACROS), [
      { user: "你 在家吗", companion: "Nova 在这儿。" },
      { user: "你 吃了吗", companion: "Nova 刚吃过。" },
    ]);

    // Two rows, handed back as they were painted except for ONE reply the player rewrote. The
    // halves she did not touch must stay the AUTHOR's, or the card export writes one run's
    // rendering where its author wrote `{{char}}`.
    await updateMountedCompanionExamples({
      identityProfilePath: profilePath,
      runtimeCwd: paths.runtimeCwd,
      containmentRoot: paths.root,
      identityKey: identityKey(identity),
      expectedProfileRevision: original.revision,
      macros: IDENTITY_MACROS,
      examples: [
        { user: "你 在家吗", companion: "Nova 在这儿。" },
        { user: "你 吃了吗", companion: "Nova 刚吃过，你呢？" },
      ],
      refreshThreadBindings: threadBindingRefresh(root),
    });

    const readBack = await readIdentityProfile(profilePath);
    assert.deepEqual(readBack.examples, [
      { user: "{{user}} 在家吗", companion: "{{char}} 在这儿。" },
      // Claimed by the half that still matched, so the player's reply is stored verbatim and
      // the untouched player turn stays the card's own text.
      { user: "{{user}} 吃了吗", companion: "Nova 刚吃过，你呢？" },
    ]);
  } finally {
    await release(root);
  }
});

test("clearing the set removes the member, so the prompt renders no examples at all", async () => {
  const root = await canonicalTestRoot("companion-examples-clear-");
  try {
    const session = "surface_examples_clear";
    const paths = resolveRuntimePaths(identity, root, session);
    const profilePath = await writeProfile(
      root,
      profileWithExamples([{ user: "今天先做什么？", companion: "先去西边那几垄。" }]),
      session,
    );
    const original = await readIdentityProfile(profilePath);
    assert.match(buildChatCompanionSystemPrompt(original, "zh-CN"), /\[Dialogue Examples\]/u);

    const cleared = await updateMountedCompanionExamples({
      identityProfilePath: profilePath,
      runtimeCwd: paths.runtimeCwd,
      containmentRoot: paths.root,
      identityKey: identityKey(identity),
      expectedProfileRevision: original.revision,
      macros: IDENTITY_MACROS,
      examples: [],
      refreshThreadBindings: threadBindingRefresh(root),
    });
    assert.deepEqual(cleared.examples, []);

    const readBack = await readIdentityProfile(profilePath);
    assert.equal("examples" in readBack, false);
    assert.doesNotMatch(buildChatCompanionSystemPrompt(readBack, "zh-CN"), /\[Dialogue Examples\]/u);
  } finally {
    await release(root);
  }
});

test("a stale save is refused by name and writes nothing", async () => {
  const root = await canonicalTestRoot("companion-examples-conflict-");
  try {
    const session = "surface_examples_conflict";
    const paths = resolveRuntimePaths(identity, root, session);
    const profilePath = await writeProfile(root, profileWithExamples([{ user: "a", companion: "b" }]), session);
    const original = await readIdentityProfile(profilePath);
    await assert.rejects(
      updateMountedCompanionExamples({
        identityProfilePath: profilePath,
        runtimeCwd: paths.runtimeCwd,
        containmentRoot: paths.root,
        identityKey: identityKey(identity),
        expectedProfileRevision: original.revision - 1,
        macros: IDENTITY_MACROS,
        examples: [{ user: "c", companion: "d" }],
        refreshThreadBindings: threadBindingRefresh(root),
      }),
      /character_examples_conflict/u,
    );
    // The refusal is the whole write: her record is exactly what it was.
    assert.deepEqual(await readIdentityProfile(profilePath), original);
  } finally {
    await release(root);
  }
});
