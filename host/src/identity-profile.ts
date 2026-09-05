import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { atomicWriteFile, type PathLockOptions, withPathLock } from "./path-lock.js";

const IDENTITY_PROFILE_SCHEMA_VERSION = 1 as const;

export type IdentityProfile = Readonly<{
  schemaVersion: typeof IDENTITY_PROFILE_SCHEMA_VERSION;
  profileId: string;
  revision: number;
  identity: Readonly<{
    name: string;
    role: string;
    continuity: string;
  }>;
  /** A short, user-reviewed persona guide; not game state or inferred memory. */
  persona?: Readonly<{
    core: string;
    interactionStyle: string;
    expressionStyle: string;
  }>;
  examples?: readonly Readonly<{ user: string; companion: string }>[];
}>;

export type IdentityProfileMetadata = Readonly<{
  profileId: string;
  revision: number;
  canonicalHash: string;
}>;

export type IdentityProfileBinding = Readonly<{
  schemaVersion: typeof IDENTITY_PROFILE_SCHEMA_VERSION;
  identityKey: string;
  profileId: string;
  revision: number;
  canonicalHash: string;
  sessionFile: string | null;
}>;

export const DEFAULT_IDENTITY_PROFILE: IdentityProfile = Object.freeze({
  schemaVersion: IDENTITY_PROFILE_SCHEMA_VERSION,
  profileId: "gamebuddy.companion.default",
  revision: 1,
  identity: Object.freeze({
    name: "GameBuddy Companion",
    role: "the player's game companion",
    continuity:
      "Maintain one continuous shared experience with the player across chat and game surfaces.",
  }),
});

function canonicalIdentityProfile(profile: IdentityProfile): string {
  return JSON.stringify({
    schemaVersion: profile.schemaVersion,
    profileId: profile.profileId,
    revision: profile.revision,
    identity: {
      name: profile.identity.name,
      role: profile.identity.role,
      continuity: profile.identity.continuity,
    },
    ...(profile.persona === undefined
      ? {}
      : {
          persona: {
            core: profile.persona.core,
            interactionStyle: profile.persona.interactionStyle,
            expressionStyle: profile.persona.expressionStyle,
          },
        }),
    ...(profile.examples === undefined
      ? {}
      : { examples: profile.examples.map((example) => ({ user: example.user, companion: example.companion })) }),
  });
}

export function identityProfileHash(profile: IdentityProfile): string {
  return createHash("sha256").update(canonicalIdentityProfile(profile), "utf8").digest("hex");
}

export function identityProfileMetadata(profile: IdentityProfile): IdentityProfileMetadata {
  return Object.freeze({
    profileId: profile.profileId,
    revision: profile.revision,
    canonicalHash: identityProfileHash(profile),
  });
}

export function renderIdentityProfile(profile: IdentityProfile): string {
  const lines: string[] = [
    `[Character: ${profile.identity.name}]`,
    `Role: ${profile.identity.role}`,
    `Continuity: ${profile.identity.continuity}`,
  ];

  if (profile.persona !== undefined) {
    lines.push(`Core disposition: ${profile.persona.core}`);
    lines.push(`Interaction style: ${profile.persona.interactionStyle}`);
    lines.push(`Expression style: ${profile.persona.expressionStyle}`);
  }

  if (profile.examples !== undefined && profile.examples.length > 0) {
    lines.push("");
    lines.push("[Dialogue Examples]");
    for (const example of profile.examples) {
      lines.push("<START>");
      lines.push(`Player: ${example.user}`);
      lines.push(`${profile.identity.name}: ${example.companion}`);
    }
  }

  return lines.join("\n");
}

export function buildChatCompanionSystemPrompt(profile: IdentityProfile): string {
  return [
    `Write ${profile.identity.name}'s next reply in a fictional roleplay chat with the player. Stay in character and adhere to the character description, personality, and tone.`,
    "",
    renderIdentityProfile(profile),
  ].join("\n");
}

export function buildGameCompanionSystemPrompt(profile: IdentityProfile): string {
  return [
    `You are ${profile.identity.name}, accompanying the player as an active in-game companion across their gaming adventures. Stay in character, maintain your personality, tone, and mannerisms, and engage naturally with the player as you share their gameplay experiences.`,
    "",
    renderIdentityProfile(profile),
  ].join("\n");
}


export function createIdentityProfileBinding(
  identityKey: string,
  profile: IdentityProfile,
  sessionFile: string | null = null,
): IdentityProfileBinding {
  const metadata = identityProfileMetadata(profile);
  return Object.freeze({
    schemaVersion: IDENTITY_PROFILE_SCHEMA_VERSION,
    identityKey,
    profileId: metadata.profileId,
    revision: metadata.revision,
    canonicalHash: metadata.canonicalHash,
    sessionFile,
  });
}

export function validateIdentityProfile(value: unknown): IdentityProfile {
  const candidateExamples = isRecord(value) && Array.isArray(value.examples) ? value.examples : undefined;
  if (
    !isRecord(value) ||
    value.schemaVersion !== IDENTITY_PROFILE_SCHEMA_VERSION ||
    !isProfileId(value.profileId) ||
    !Number.isSafeInteger(value.revision) ||
    value.revision < 1 ||
    !isRecord(value.identity) ||
    !isBoundedText(value.identity.name, 128) ||
    !isBoundedText(value.identity.role, 512) ||
    !isBoundedText(value.identity.continuity, 1_024) ||
    (value.persona !== undefined &&
      (!isRecord(value.persona) ||
        !isBoundedText(value.persona.core, 1_024) ||
        !isBoundedText(value.persona.interactionStyle, 1_024) ||
        !isBoundedText(value.persona.expressionStyle, 1_024))) ||
    (value.examples !== undefined &&
      (candidateExamples === undefined ||
        candidateExamples.length > 4 ||
        candidateExamples.some(
          (example: unknown) =>
            !isRecord(example) || !isBoundedText(example.user, 512) || !isBoundedText(example.companion, 512),
        )))
  ) {
    throw new Error("invalid_identity_profile");
  }
  return Object.freeze({
    schemaVersion: IDENTITY_PROFILE_SCHEMA_VERSION,
    profileId: value.profileId,
    revision: value.revision,
    identity: Object.freeze({
      name: value.identity.name,
      role: value.identity.role,
      continuity: value.identity.continuity,
    }),
    ...(value.persona === undefined
      ? {}
      : {
          persona: Object.freeze({
            core: value.persona.core,
            interactionStyle: value.persona.interactionStyle,
            expressionStyle: value.persona.expressionStyle,
          }),
        }),
    ...(candidateExamples === undefined
      ? {}
      : {
          examples: Object.freeze(
            candidateExamples.map((example) => {
              const validExample = example as Record<string, unknown>;
              return Object.freeze({ user: validExample.user as string, companion: validExample.companion as string });
            }),
          ),
        }),
  });
}

function validateIdentityProfileBinding(value: unknown): IdentityProfileBinding {
  if (
    !isRecord(value) ||
    value.schemaVersion !== IDENTITY_PROFILE_SCHEMA_VERSION ||
    !isOpaque(value.identityKey) ||
    !isProfileId(value.profileId) ||
    !Number.isSafeInteger(value.revision) ||
    value.revision < 1 ||
    !/^[a-f0-9]{64}$/.test(value.canonicalHash) ||
    (value.sessionFile !== null && !isSessionFile(value.sessionFile))
  ) {
    throw new Error("invalid_identity_profile_binding");
  }
  return Object.freeze({
    schemaVersion: IDENTITY_PROFILE_SCHEMA_VERSION,
    identityKey: value.identityKey,
    profileId: value.profileId,
    revision: value.revision,
    canonicalHash: value.canonicalHash,
    sessionFile: value.sessionFile,
  });
}

export function assertProfileMatchesBinding(
  identityKey: string,
  profile: IdentityProfile,
  binding: IdentityProfileBinding,
): void {
  const metadata = identityProfileMetadata(profile);
  if (
    binding.identityKey !== identityKey ||
    binding.profileId !== metadata.profileId ||
    binding.revision !== metadata.revision ||
    binding.canonicalHash !== metadata.canonicalHash
  ) {
    throw new Error("identity_profile_mismatch");
  }
}

export async function readOrCreateIdentityProfile(path: string): Promise<IdentityProfile> {
  try {
    return await readIdentityProfile(path);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      await writeIdentityProfile(path, DEFAULT_IDENTITY_PROFILE);
      return DEFAULT_IDENTITY_PROFILE;
    }
    throw error;
  }
}

/** Read one Host-owned profile and verify its byte-stable canonical hash. */
export async function readIdentityProfile(path: string): Promise<IdentityProfile> {
  const parsed = JSON.parse(await readFile(path, "utf8")) as unknown;
  const profile = validateIdentityProfile(parsed);
  const expectedHash = identityProfileHash(profile);
  const storedHash = isRecord(parsed) && typeof parsed.canonicalHash === "string" ? parsed.canonicalHash : undefined;
  if (storedHash !== expectedHash) throw new Error("invalid_identity_profile");
  return profile;
}

/**
 * Provision a profile only through a Host-controlled path. Callers must not
 * write profile JSON beside a bound Context and expect it to be adopted.
 */
export async function writeIdentityProfile(
  path: string,
  value: IdentityProfile,
  options: PathLockOptions = {},
): Promise<void> {
  const profile = validateIdentityProfile(value);
  await writeJsonAtomically(path, { ...profile, canonicalHash: identityProfileHash(profile) }, options);
}

export async function readIdentityProfileBinding(path: string): Promise<IdentityProfileBinding | null> {
  try {
    return validateIdentityProfileBinding(JSON.parse(await readFile(path, "utf8")) as unknown);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return null;
    throw error;
  }
}

export async function writeIdentityProfileBinding(
  path: string,
  binding: IdentityProfileBinding,
  options: PathLockOptions = {},
): Promise<void> {
  await writeJsonAtomically(path, binding, options);
}

async function writeJsonAtomically(path: string, value: unknown, options: PathLockOptions): Promise<void> {
  await withPathLock(
    path,
    () => atomicWriteFile(path, JSON.stringify(value, null, 2), options.containmentRoot),
    options,
  );
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isBoundedText(value: unknown, maxLength: number): value is string {
  return (
    typeof value === "string" && value.length > 0 && value.length <= maxLength && !/[\u0000-\u001f\u007f]/u.test(value)
  );
}

function isOpaque(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

function isProfileId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9._-]{1,128}$/.test(value);
}

function isSessionFile(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9._-]{1,256}\.jsonl$/.test(value);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && typeof error.code === "string";
}
