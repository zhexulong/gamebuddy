import assert from "node:assert/strict";
import { readFile, rm } from "node:fs/promises";
import test from "node:test";
import {
  buildChatCompanionSystemPrompt,
  createIdentityProfileBinding,
  identityProfileHash,
  type IdentityProfile,
  readIdentityProfile,
  readIdentityProfileBinding,
  validateIdentityProfile,
  writeIdentityProfile,
  writeIdentityProfileBinding,
} from "../identity-profile.js";
import { bindWindowsStaleLockReclaimer } from "../path-lock.js";
import { identityKey, resolveRuntimePaths, type CompanionIdentity } from "../runtime-identity.js";
import { canonicalTestRoot } from "../test-support/canonical-test-root.test-support.js";
import { candidateToIdentityProfile, previewStCard } from "../st-card-import.js";
import { createBuildWindowsStaleLockReclaimer } from "../windows-stale-lock-reclaimer/index.js";
import {
  createChatThreadStore,
  acceptMountedPlayerMessage,
  createProfileAwareChatThreadCreationCapability,
} from "./chat-thread-store.js";
import {
  type CompanionProfileBindingRefresh,
  projectCompanionVoice,
  renderCompanionVoiceText,
  updateMountedCompanionVoice,
} from "./companion-voice-service.js";
import { macroTable } from "./macro-engine.js";
import { provisionNewCompanion, type NewCompanionReview } from "./new-companion-service.js";
import type { CharacterCandidate } from "./types.js";

/**
 * The table these tests treat as the surface's own: `{{char}}` is Nova and `{{user}}` is
 * the Chinese second person the run speaks in. A save is told which table rendered the text
 * it is handed, so that a value still equal to the authored rendering is stored authored.
 */
const IDENTITY_MACROS = macroTable({ char: "Nova", locale: "zh-CN" });

const identity: CompanionIdentity = Object.freeze({
  continuityId: "continuity_voice",
  companionId: "companion_voice",
  playerId: "player_voice",
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

/** The card's own imported directive, as the reviewed import provisions it. */
function cardProfile(): IdentityProfile {
  return candidateToIdentityProfile(
    previewStCard({
      spec: "chara_card_v3",
      data: { name: "Nova", system_prompt: "Open every reply with a *micro-action*." },
    }),
    4,
  );
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

/**
 * The refresh this service performs, as the composition hands it in: the real store method over a
 * real continuity root. A suite that is not about the re-pin still goes through it, and its own
 * count is asserted by the tests that are.
 */
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

test("clearing the directive removes the field and the mount prompt stays byte-identical to no directive", async () => {
  const root = await canonicalTestRoot("companion-voice-clear-");
  try {
    const paths = resolveRuntimePaths(identity, root, "surface_voice_clear");
    const profilePath = await writeProfile(root, cardProfile(), "surface_voice_clear");
    const withVoice = await readIdentityProfile(profilePath);
    assert.deepEqual(projectCompanionVoice(withVoice), {
      text: "Open every reply with a *micro-action*.",
      source: "card",
    });
    // The directive is real: it renders a labelled section after the Host floor.
    assert.ok(buildChatCompanionSystemPrompt(withVoice).includes("【角色演出指导（Character Voice & Directives）】"));

    const cleared = await updateMountedCompanionVoice({
      identityProfilePath: profilePath,
      runtimeCwd: paths.runtimeCwd,
      containmentRoot: paths.root,
      identityKey: identityKey(identity),
      expectedProfileRevision: withVoice.revision,
      macros: IDENTITY_MACROS,
      voice: null,
      refreshThreadBindings: threadBindingRefresh(root),
    });
    assert.equal(cleared.characterVoice, null);

    // The field is REMOVED, not stored as empty text - and that is durable.
    const readBack = await readIdentityProfile(profilePath);
    assert.equal("characterVoice" in readBack, false);
    assert.equal(JSON.stringify(readBack).includes("characterVoice"), false);

    // A mount of the cleared profile renders exactly what a profile that never
    // carried a directive renders: the section is absent, not empty.
    const never = await readIdentityProfile(profilePath);
    const noDirective = validateIdentityProfile({ ...readBack, characterVoice: undefined });
    assert.equal(buildChatCompanionSystemPrompt(readBack), buildChatCompanionSystemPrompt(noDirective));
    assert.equal(buildChatCompanionSystemPrompt(readBack).includes("CARD DIRECTIVES"), false);
    assert.deepEqual(projectCompanionVoice(never), null);
  } finally {
    await release(root);
  }
});

test("editing the directive re-authors it as the player's and refreshes the profile binding", async () => {
  const root = await canonicalTestRoot("companion-voice-edit-");
  try {
    const paths = resolveRuntimePaths(identity, root, "surface_voice_edit");
    const profilePath = await writeProfile(root, cardProfile(), "surface_voice_edit");
    const original = await readIdentityProfile(profilePath);

    const edited = await updateMountedCompanionVoice({
      identityProfilePath: profilePath,
      runtimeCwd: paths.runtimeCwd,
      containmentRoot: paths.root,
      identityKey: identityKey(identity),
      expectedProfileRevision: original.revision,
      macros: IDENTITY_MACROS,
      voice: { text: "Speak in short, warm sentences." },
      refreshThreadBindings: threadBindingRefresh(root),
    });
    assert.deepEqual(edited.characterVoice, { text: "Speak in short, warm sentences.", source: "player" });
    assert.equal(edited.profileRevision, original.revision + 1);

    // Every existing binding for this continuity now pins the rewritten profile,
    // so a later mount of the same surface still passes its binding check.
    const binding = await readIdentityProfileBinding(paths.identityProfileBindingPath);
    assert.ok(binding !== null);
    assert.equal(binding.revision, edited.profileRevision);
    assert.equal(binding.canonicalHash, identityProfileHash(await readIdentityProfile(profilePath)));

    // A stale expected revision is refused instead of silently overwriting.
    await assert.rejects(
      updateMountedCompanionVoice({
        identityProfilePath: profilePath,
        runtimeCwd: paths.runtimeCwd,
        containmentRoot: paths.root,
        identityKey: identityKey(identity),
        expectedProfileRevision: original.revision,
        macros: IDENTITY_MACROS,
        voice: { text: "stale write" },
        refreshThreadBindings: threadBindingRefresh(root),
      }),
      /character_voice_conflict/,
    );
  } finally {
    await release(root);
  }
});

test("a re-import of the same card provisions a new companion and never repopulates the cleared directive", async () => {
  const root = await canonicalTestRoot("companion-voice-reimport-");
  try {
    const paths = resolveRuntimePaths(identity, root, "surface_voice_reimport");
    const profilePath = await writeProfile(root, cardProfile(), "surface_voice_reimport");
    const original = await readIdentityProfile(profilePath);
    await updateMountedCompanionVoice({
      identityProfilePath: profilePath,
      runtimeCwd: paths.runtimeCwd,
      containmentRoot: paths.root,
      identityKey: identityKey(identity),
      expectedProfileRevision: original.revision,
      macros: IDENTITY_MACROS,
      voice: null,
      refreshThreadBindings: threadBindingRefresh(root),
    });
    const clearedBytes = await readFile(profilePath, "utf8");

    // The same card is imported again: the import path derives a NEW companion in
    // its own namespace from the reviewed fields, so the player's cleared choice
    // on the existing companion survives - an import never resurrects it.
    const sourceHash = "f".repeat(64);
    const candidate: CharacterCandidate = Object.freeze({
      schemaVersion: 1,
      revision: 1,
      candidateId: "st-card-reimport",
      sourceFormat: "st-v3",
      sourceVersion: "st-v3",
      sourceHash,
      name: "Nova",
      reviewState: "pending",
      fields: Object.freeze([
        Object.freeze({ field: "name", text: "Nova", eligibility: "profile_eligible_after_explicit_review" as const }),
        Object.freeze({
          field: "system_prompt",
          text: "Open every reply with a *micro-action*.",
          eligibility: "profile_eligible_after_explicit_review" as const,
        }),
      ]),
    });
    const review: NewCompanionReview = Object.freeze({
      candidateId: candidate.candidateId,
      candidateRevision: candidate.revision,
      sourceHash,
      reviewedFields: Object.freeze(["name", "system_prompt"]),
      approvedAtMs: 1,
    });
    const threads = createChatThreadStore(root, identityKey(identity));
    try {
      const provision = await provisionNewCompanion(root, identity.playerId, candidate, review, threads);
      assert.notEqual(provision.identity.companionId, identity.companionId);
      assert.deepEqual(projectCompanionVoice(provision.profile), {
        text: "Open every reply with a *micro-action*.",
        source: "card",
      });
    } finally {
      threads.close?.();
    }

    // The pre-existing companion's profile is untouched: still cleared.
    assert.equal(await readFile(profilePath, "utf8"), clearedBytes);
    assert.equal("characterVoice" in (await readIdentityProfile(profilePath)), false);
  } finally {
    await release(root);
  }
});

/**
 * The save is refused while she is answering, and the refusal leaves the profile byte-identical.
 *
 * Three separate facts, and all three are the contract:
 *  1. a Chat of THIS companion with a live turn blocks the save - and the refusal names the one
 *     thing the player can do about it;
 *  2. the profile on disk was put back exactly as it was, so nothing is stranded half-saved;
 *  3. a settled Chat saves normally, and another companion's live turn does not block this one -
 *     the blast radius is the threads of the companion being saved, nothing wider.
 */
test("a save is refused while one of her Chats is answering, and nothing is written", async () => {
  const root = await canonicalTestRoot("companion-voice-turn-active-");
  try {
    const paths = resolveRuntimePaths(identity, root, "surface_voice_turn_active");
    const profilePath = await writeProfile(root, cardProfile(), "surface_voice_turn_active");
    const original = await readIdentityProfile(profilePath);
    const bytesBefore = await readFile(profilePath, "utf8");
    await createOwnChat(root, {
      chatThreadId: "thread_turn_active",
      chatSurfaceSessionId: "surface_turn_active",
      profileRevision: original.revision,
      profileCanonicalHash: identityProfileHash(original),
    });
    await acceptTurn(root, {
      chatThreadId: "thread_turn_active",
      chatSurfaceSessionId: "surface_turn_active",
      idempotencyKey: "abcdefghijklmnopqrstuv",
    });

    await assert.rejects(
      updateMountedCompanionVoice({
        identityProfilePath: profilePath,
        runtimeCwd: paths.runtimeCwd,
        containmentRoot: paths.root,
        identityKey: identityKey(identity),
        expectedProfileRevision: original.revision,
        macros: IDENTITY_MACROS,
        voice: { text: "Speak in short, warm sentences." },
        refreshThreadBindings: threadBindingRefresh(root),
      }),
      /chat_profile_binding_turn_active/u,
      "the refusal says the save was stopped because she is answering, not that something failed",
    );
    // The stronger claim: the file was not merely left alone by an unsuccessful request, it was put
    // back after the profile had already been rewritten - so a failed save leaves no half state.
    assert.equal(await readFile(profilePath, "utf8"), bytesBefore, "the profile is byte-identical");
    assert.equal((await readIdentityProfile(profilePath)).revision, original.revision);
    assert.deepEqual(projectCompanionVoice(await readIdentityProfile(profilePath)), projectCompanionVoice(original));
  } finally {
    await release(root);
  }
});

test("a settled Chat saves normally, and another companion's live turn does not block this one", async () => {
  const root = await canonicalTestRoot("companion-voice-turn-settled-");
  try {
    const paths = resolveRuntimePaths(identity, root, "surface_voice_turn_settled");
    const profilePath = await writeProfile(root, cardProfile(), "surface_voice_turn_settled");
    const original = await readIdentityProfile(profilePath);
    // Her own Chat exists and has no live turn: nothing of hers is answering, so her pin is free.
    await createOwnChat(root, {
      chatThreadId: "thread_turn_settled",
      chatSurfaceSessionId: "surface_turn_settled",
      profileRevision: original.revision,
      profileCanonicalHash: identityProfileHash(original),
    });
    // Another companion, answering right now, in its own continuity.
    const otherIdentity = Object.freeze({
      continuityId: "continuity_voice_other",
      companionId: "companion_voice_other",
      playerId: identity.playerId,
    });
    const otherPaths = resolveRuntimePaths(otherIdentity, root, "surface_voice_other");
    const otherProfile = cardProfile();
    await writeIdentityProfile(otherPaths.identityProfilePath, otherProfile, { containmentRoot: otherPaths.root });
    const otherThreads = createChatThreadStore(root, identityKey(otherIdentity));
    try {
      await createProfileAwareChatThreadCreationCapability(otherThreads, {
        async readExact() {
          return {
            profileId: otherProfile.profileId,
            revision: otherProfile.revision,
            canonicalHash: identityProfileHash(otherProfile),
          };
        },
      }).createExplicit({
        chatThreadId: "thread_other_active",
        chatSurfaceSessionId: "surface_other_active",
        companionId: otherIdentity.companionId,
        continuityId: otherIdentity.continuityId,
        opening: "blank",
      });
      await acceptTurn(root, {
        chatThreadId: "thread_other_active",
        chatSurfaceSessionId: "surface_other_active",
        idempotencyKey: "bcdefghijklmnopqrstuvw",
        playerId: otherIdentity.playerId,
        companionId: otherIdentity.companionId,
        continuityId: otherIdentity.continuityId,
      });
      const otherState = await otherThreads.resumeThread("thread_other_active", "surface_other_active");
      assert.equal(otherState.turnLedger?.status, "accepted_queued", "the other companion really is answering");
    } finally {
      otherThreads.close?.();
    }

    // Her own threads have no live turn, so the save goes through - and the other companion's live
    // turn is outside the rows this save would move, so it cannot refuse it. The blast radius is the
    // threads of the companion being saved, nothing wider.
    const saved = await updateMountedCompanionVoice({
      identityProfilePath: profilePath,
      runtimeCwd: paths.runtimeCwd,
      containmentRoot: paths.root,
      identityKey: identityKey(identity),
      expectedProfileRevision: original.revision,
      macros: IDENTITY_MACROS,
      voice: { text: "Speak in short, warm sentences." },
      refreshThreadBindings: threadBindingRefresh(root),
    });
    assert.equal(saved.profileRevision, original.revision + 1);
    assert.deepEqual(saved.characterVoice, { text: "Speak in short, warm sentences.", source: "player" });

    // The other companion's profile is untouched - she was never in this save's scope.
    assert.equal((await readIdentityProfile(otherPaths.identityProfilePath)).revision, otherProfile.revision);
  } finally {
    await release(root);
  }
});

/** One Chat of the mounted companion, created against the profile it will pin. */
async function createOwnChat(
  root: string,
  input: Readonly<{
    chatThreadId: string;
    chatSurfaceSessionId: string;
    profileRevision: number;
    profileCanonicalHash: string;
  }>,
): Promise<void> {
  const profilePath = resolveRuntimePaths(identity, root, input.chatSurfaceSessionId).identityProfilePath;
  const profileId = (await readIdentityProfile(profilePath)).profileId;
  const threads = createChatThreadStore(root, identityKey(identity));
  try {
    await createProfileAwareChatThreadCreationCapability(threads, {
      async readExact() {
        return {
          profileId,
          revision: input.profileRevision,
          canonicalHash: input.profileCanonicalHash,
        };
      },
    }).createExplicit({
      chatThreadId: input.chatThreadId,
      chatSurfaceSessionId: input.chatSurfaceSessionId,
      companionId: identity.companionId,
      continuityId: identity.continuityId!,
      opening: "blank",
    });
  } finally {
    threads.close?.();
  }
}

/** Accepts one player turn, which is what makes a thread's pin live. */
async function acceptTurn(
  root: string,
  input: Readonly<{
    chatThreadId: string;
    chatSurfaceSessionId: string;
    idempotencyKey: string;
    playerId?: string;
    companionId?: string;
    continuityId?: string;
  }>,
): Promise<void> {
  const routeIdentity = Object.freeze({
    playerId: input.playerId ?? identity.playerId,
    companionId: input.companionId ?? identity.companionId,
    continuityId: input.continuityId ?? identity.continuityId!,
  });
  // The acceptance route is registered by a LIVE store for this continuity, so one has to be open
  // for the length of the call - exactly as the mounted runtime holds one.
  const mounted = createChatThreadStore(root, identityKey(routeIdentity));
  try {
    await acceptMountedPlayerMessage(
      {
        runtimeRoot: root,
        ...routeIdentity,
        chatThreadId: input.chatThreadId,
        chatSurfaceSessionId: input.chatSurfaceSessionId,
        selectionGeneration: 1,
      },
      {
        text: "Are you there?",
        locale: "en-US",
        idempotencyKey: input.idempotencyKey,
        expectedDraftRevision: 0,
        authoredContextPreparation: { sourceRefs: [], stableTokenCount: 0, volatileTokenCount: 0 },
      },
    );
  } finally {
    mounted.close?.();
  }
}
