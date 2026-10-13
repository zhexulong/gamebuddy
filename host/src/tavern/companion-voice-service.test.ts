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
import { createChatThreadStore } from "./chat-thread-store.js";
import { projectCompanionVoice, updateMountedCompanionVoice } from "./companion-voice-service.js";
import { provisionNewCompanion, type NewCompanionReview } from "./new-companion-service.js";
import type { CharacterCandidate } from "./types.js";

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
      voice: null,
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
    assert.equal(
      buildChatCompanionSystemPrompt(readBack),
      buildChatCompanionSystemPrompt(noDirective),
    );
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
      voice: { text: "Speak in short, warm sentences." },
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
        voice: { text: "stale write" },
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
      voice: null,
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
