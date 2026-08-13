import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import {
  createIdentityProfileBinding,
  DEFAULT_IDENTITY_PROFILE,
  identityProfileHash,
  writeIdentityProfile,
  writeIdentityProfileBinding,
  type IdentityProfile,
} from "../identity-profile.js";
import { identityKey, resolveRuntimePaths, type CompanionIdentity } from "../runtime.js";
import { TavernArtifactStore } from "./artifact-store.js";
import { createTavernLibraryService } from "./library-service.js";
import { resolveTavernPaths } from "./tavern-paths.js";
import { createChatThreadStore, type ChatThreadStore } from "./chat-thread-store.js";
import { withPathLock } from "../path-lock.js";
import type { CharacterCandidate, TavernCompanion } from "./types.js";

/** Explicit review boundary: candidates cannot alter an existing companion. */
export type NewCompanionReview = Readonly<{
  candidateId: string;
  candidateRevision: number;
  sourceHash: string;
  reviewedFields: readonly string[];
  approvedAtMs: number;
}>;
export type NewCompanionMetadata = Readonly<{
  companionId: string;
  continuityId: string;
  name: string;
  profileId: string;
  profileRevision: number;
  profileHash: string;
}>;
export type NewCompanionWriter = Readonly<{ create(input: NewCompanionMetadata): Promise<TavernCompanion> }>;
export type NewCompanionService = Readonly<{
  review(
    candidate: CharacterCandidate,
    input: Readonly<{ reviewedFields: readonly string[]; approvedAtMs: number }>,
  ): NewCompanionReview;
  create(
    review: NewCompanionReview,
    candidate: CharacterCandidate,
    metadata: NewCompanionMetadata,
  ): Promise<TavernCompanion>;
}>;
export type NewCompanionProvision = Readonly<{
  companion: TavernCompanion;
  identity: CompanionIdentity;
  profile: IdentityProfile;
}>;

/**
 * Direct New Companion starts from a player-supplied display name only. It
 * never accepts an identity, continuity, profile, namespace, or source text
 * from the browser and cannot alter the active companion.
 */
export async function provisionDirectNewCompanion(
  root: string,
  playerId: string,
  name: string,
): Promise<NewCompanionProvision> {
  if (!text(name, 128)) throw new Error("invalid_new_companion_name");
  const companionId = `companion-${randomUUID()}`;
  const continuityId = `continuity-${randomUUID()}`;
  const identity: CompanionIdentity = Object.freeze({ playerId, companionId, continuityId });
  const profile = directProfile(name, companionId, continuityId);
  return provisionNewCompanionNamespace(root, identity, profile);
}

export function createNewCompanionService(writer: NewCompanionWriter): NewCompanionService {
  return Object.freeze({
    review(candidate, input) {
      const available = new Set(
        candidate.fields
          .filter((field) => field.eligibility === "profile_eligible_after_explicit_review")
          .map((field) => field.field),
      );
      const fields = [...input.reviewedFields];
      if (
        !Number.isSafeInteger(input.approvedAtMs) ||
        input.approvedAtMs < 0 ||
        fields.length === 0 ||
        new Set(fields).size !== fields.length ||
        !fields.every((field) => available.has(field))
      )
        throw new Error("invalid_new_companion_review");
      return Object.freeze({
        candidateId: candidate.candidateId,
        candidateRevision: candidate.revision,
        sourceHash: candidate.sourceHash,
        reviewedFields: Object.freeze(fields),
        approvedAtMs: input.approvedAtMs,
      });
    },
    async create(review, candidate, metadata) {
      if (
        review.candidateId !== candidate.candidateId ||
        review.candidateRevision !== candidate.revision ||
        review.sourceHash !== candidate.sourceHash
      )
        throw new Error("new_companion_review_required");
      validateMetadata(metadata);
      return writer.create(Object.freeze({ ...metadata }));
    },
  });
}

/**
 * Creates an entirely new Host-owned identity namespace. The imported candidate
 * is only used for fields that the persisted review explicitly approved; no
 * browser value supplies an ID, profile path, or continuity.
 */
export async function provisionNewCompanion(
  root: string,
  playerId: string,
  candidate: CharacterCandidate,
  review: NewCompanionReview,
  threads: ChatThreadStore,
): Promise<NewCompanionProvision> {
  // Validation is deliberately performed before any namespace or profile exists.
  if (
    review.candidateId !== candidate.candidateId ||
    review.candidateRevision !== candidate.revision ||
    review.sourceHash !== candidate.sourceHash
  )
    throw new Error("new_companion_review_required");
  const approved = new Map(
    candidate.fields
      .filter((field) => review.reviewedFields.includes(field.field))
      .map((field) => [field.field, field.text]),
  );
  const companionId = `companion-${randomUUID()}`;
  const continuityId = `continuity-${randomUUID()}`;
  const identity: CompanionIdentity = Object.freeze({ playerId, companionId, continuityId });
  return provisionNewCompanionNamespace(root, identity, reviewedProfile(approved, companionId, continuityId), threads);
}

async function provisionNewCompanionNamespace(
  root: string,
  identity: CompanionIdentity,
  profile: IdentityProfile,
  suppliedThreads?: ChatThreadStore,
): Promise<NewCompanionProvision> {
  const paths = resolveRuntimePaths(identity, root);
  try {
    // The containment-aware lock creates and verifies each parent component
    // before entering the transaction. A pre-existing namespace is never
    // adopted or overwritten.
    return await withPathLock(
      paths.runtimeCwd,
      async () => {
        await mkdir(paths.runtimeCwd, { recursive: false });
        await writeIdentityProfile(paths.identityProfilePath, profile, { containmentRoot: paths.root });
        await writeIdentityProfileBinding(
          paths.identityProfileBindingPath,
          createIdentityProfileBinding(identityKey(identity), profile),
          { containmentRoot: paths.root },
        );
        const threads = suppliedThreads ?? createChatThreadStore(paths.runtimeCwd, identityKey(identity));
        const library = createTavernLibraryService(
          resolveTavernPaths(paths, identity),
          new TavernArtifactStore(paths.root),
          threads,
        );
        const companion = await library.createNewCompanion({
          companionId: identity.companionId,
          continuityId: identity.continuityId!,
          name: profile.identity.name,
          profileId: profile.profileId,
          profileRevision: profile.revision,
          profileHash: identityProfileHash(profile),
        });
        return Object.freeze({ companion, identity, profile });
      },
      { containmentRoot: paths.root },
    );
  } catch (error) {
    // Deliberately do not recursively remove the namespace. This transaction
    // may have created nested Tavern artifacts, and path-based recursive
    // deletion cannot prove ownership after a replacement or sentinel entry.
    // Leaving it quarantined is fail-closed and preserves unmanaged content.
    throw error;
  }
}

function directProfile(name: string, companionId: string, continuityId: string): IdentityProfile {
  const base = DEFAULT_IDENTITY_PROFILE;
  return Object.freeze({
    ...base,
    profileId: `gamebuddy.${companionId}`,
    identity: Object.freeze({
      ...base.identity,
      name,
      continuity: `Host-owned continuity ${continuityId}; ${base.identity.continuity}`,
    }),
  });
}

function reviewedProfile(
  fields: ReadonlyMap<string, string>,
  companionId: string,
  continuityId: string,
): IdentityProfile {
  const base = DEFAULT_IDENTITY_PROFILE;
  const core = fields.get("persona_core");
  const interactionStyle = fields.get("persona_interaction_style");
  const expressionStyle = fields.get("persona_expression_style");
  const persona =
    core === undefined && interactionStyle === undefined && expressionStyle === undefined
      ? undefined
      : Object.freeze({
          core: core ?? base.persona?.core ?? "Maintain a stable, player-reviewed companion disposition.",
          interactionStyle: interactionStyle ?? base.persona?.interactionStyle ?? "Be helpful, calm, and direct.",
          expressionStyle: expressionStyle ?? base.persona?.expressionStyle ?? "Use clear, natural language.",
        });
  return Object.freeze({
    ...base,
    profileId: `gamebuddy.${companionId}`,
    identity: Object.freeze({
      ...base.identity,
      continuity: `Host-owned continuity ${continuityId}; ${base.identity.continuity}`,
    }),
    ...(persona === undefined ? {} : { persona }),
  });
}
function validateMetadata(value: NewCompanionMetadata): void {
  if (
    ![value.companionId, value.continuityId, value.profileId].every(isId) ||
    !text(value.name, 128) ||
    !positive(value.profileRevision) ||
    !/^[a-f0-9]{64}$/u.test(value.profileHash)
  )
    throw new Error("invalid_new_companion_metadata");
}
function isId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9._-]{1,128}$/u.test(value);
}
function text(value: unknown, max: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max && !/[\u0000-\u001f\u007f]/u.test(value);
}
function positive(value: unknown): boolean {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}
