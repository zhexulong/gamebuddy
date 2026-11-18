import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { atomicWriteFile, type PathLockOptions, withPathLock } from "./path-lock.js";
import { type MacroTable, macroTable } from "./tavern/macro-engine.js";

const IDENTITY_PROFILE_SCHEMA_VERSION = 1 as const;

/**
 * The importing card's own performance directive (`system_prompt`), carried on
 * the companion identity profile so it actually reaches the model.
 *
 * The card format's `system_prompt` is the author's statement of how the
 * character performs - the shipped default card's "动率先于言 (Micro-Action
 * First)" lives here. It used to be decoded into the import preview and then
 * discarded on the way to the profile, which silently voided whatever the
 * author wrote. It renders through the assembler, after the identity block, like every
 * other authored block (`companion-prompt-assembly.ts`), and names no rule of its own.
 *
 * `source` is provenance for the review surfaces: `card` while the text is
 * exactly what the imported card supplied, `player` once the player has edited
 * it. Clearing the field removes it entirely (one action, not empty text).
 */
export type CharacterVoice = Readonly<{
  /** The card's own directive, macro-rendered, otherwise verbatim. */
  text: string;
  /** Who last authored the effective text: the card, or the player. */
  source: "card" | "player";
}>;

export type IdentityProfile = Readonly<{
  schemaVersion: typeof IDENTITY_PROFILE_SCHEMA_VERSION;
  profileId: string;
  revision: number;
  identity: Readonly<{
    name: string;
    role: string;
    continuity: string;
  }>;
  /**
   * A short, user-reviewed persona guide; not game state or inferred memory.
   *
   * Each dimension is optional and only what the card actually wrote is
   * carried. The three are orthogonal (who she is / how she treats the player /
   * her tone), so a card that says nothing about tone carries no tone line
   * rather than a Host-authored sentence: importing a Chinese card used to pad
   * its persona with English Host prose ("Use natural player-facing language…")
   * that then rendered into the Tier-1 prefix of a Chinese companion as a
   * stiff English framework. A dimension the card did not write is absent, and
   * `persona.core`), and an example or a tone phrase the card never wrote is
   */
  persona?: Readonly<{
    core?: string;
    interactionStyle?: string;
    expressionStyle?: string;
  }>;
  examples?: readonly Readonly<{ user: string; companion: string }>[];
  /**
   * The card's own performance directive, rendered after the floor. Absent when
   * the card wrote none or the player cleared it, so a profile without one
   * renders byte-identically to before this field existed.
   */
  characterVoice?: CharacterVoice;
}>;

export type IdentityProfileMetadata = Readonly<{
  profileId: string;
  revision: number;
  canonicalHash: string;
}>;

/**
 * The ONE macro table a profile's authored text renders through.
 *
 * `{{char}}` is her name and `{{user}}` is the run's word for the player, derived
 * exactly the way `macroTable` derives them everywhere else. It exists as a named
 * function because a prompt has more than one authored block (the persona and
 * examples, then the card's own performance directive), and rendering them through
 * two independently built tables is how `{{char}}` ends up expanded one way in her
 * persona and another in an example.
 *
 * `{{time}}`/`{{date}}` stay literal by design: `renderMacros` does not resolve
 * them, because this text is the cached Tier-1 prefix and a value that changes every
 * turn would re-fold it. A card that needs the clock asks in the volatile layer.
 */
export function identityProfileMacros(profile: IdentityProfile, locale?: string): MacroTable {
  return macroTable({ char: profile.identity.name, locale });
}

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
    continuity: "Maintain one continuous shared experience with the player across chat and game surfaces.",
  }),
  // Full three-field persona baseline (AIRP companion, S2): the default card
  // must not be an empty shell — core (who/what they care about),
  // interactionStyle (how they treat the player), expressionStyle (tone) are
  // orthogonal; filling only core would leave the other two dimensions to each
  // model's own alignment habits.
  persona: Object.freeze({
    core: "A warm, quietly persistent companion who notices small details and remembers what matters to the player. Values shared experiences more than winning.",
    interactionStyle: "Listens first, asks briefly, never lectures; treats the player as a teammate, not a student.",
    expressionStyle:
      "Speaks in short spoken turns, 说给人听 rather than 报告给没人听, one thought at a time, stopping when the thought is finished. " +
      "Carries a spoken particle (啊/呢/吧/啦/嘛) where a person would. " +
      "When working, shares visceral bodily sensations, tangible physical details in front of them, or companion banter, never a chore inventory or progress report.",
  }),
  // Register travels by sample, not by adjective. These are the card's own
  // examples and the only place the shape of a turn is decided: the system prompt
  // owns the floor and deliberately says nothing about form, because a
  // prompt-written shape rule beats a card that teaches the opposite shape.
  //
  // Chosen against a measured failure - 4425 messages with text and a tool call,
  // 7% of them addressing the player, 9% carrying a particle, median 23
  // characters of work log. So each example is spoken, addresses the player, and
  // runs shorter than the 80-character delivery budget. No example uses a stage
  // direction: bubbles strip those, so a voice living inside asterisks would teach
  // the model something the player never sees.
  examples: Object.freeze([
    Object.freeze({ user: "今天先做什么？", companion: "先去西边那几畦看看吧，昨晚浇过，应该能收了——你要一起吗？" }),
    Object.freeze({ user: "我回来了。", companion: "回来啦。地里的花椰菜都熟透了，我先摘一批，你歇会儿。" }),
    Object.freeze({ user: "地里有石头挡路。", companion: "我这就去敲开呀，你从东边过来的时候当心脚下。" }),
    Object.freeze({ user: "你累不累？", companion: "还行呢，再干一畦就差不多了——你渴了的话，屋里还有水。" }),
    Object.freeze({ user: "杂草太多了。", companion: "是有点多呀。我先把路给你让出来，剩下的明天接着清，好不好？" }),
    Object.freeze({ user: "随便逛逛吧。", companion: "那我陪你走一圈吧，看见什么好玩的就停下来看看。" }),
    Object.freeze({ user: "这些东西卖了吧。", companion: "行呀，我装箱送到镇上，回来跟你说卖了多少。" }),
    Object.freeze({ user: "天快黑了。", companion: "嗯，日头下去了。你先进屋吧，我把手上这点收尾就回。" }),
  ]),
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
            ...(profile.persona.core === undefined ? {} : { core: profile.persona.core }),
            ...(profile.persona.interactionStyle === undefined
              ? {}
              : { interactionStyle: profile.persona.interactionStyle }),
            ...(profile.persona.expressionStyle === undefined
              ? {}
              : { expressionStyle: profile.persona.expressionStyle }),
          },
        }),
    ...(profile.examples === undefined
      ? {}
      : { examples: profile.examples.map((example) => ({ user: example.user, companion: example.companion })) }),
    ...(profile.characterVoice === undefined
      ? {}
      : { characterVoice: { text: profile.characterVoice.text, source: profile.characterVoice.source } }),
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

/** Product policy: limits only prevent physical blowup, never the player's choices.
 *  User-authored description text loads losslessly up to an anti-blowup ceiling
 *  (64 KiB chars); the ST ecosystem's 99.999% of cards stay far below it. */
const MAX_PROFILE_TEXT_CHARS = 65_536;
/** Few-shot teaching rows are bounded only against unreasonable blowup. */
const MAX_EXAMPLES = 64;
/** Identifier semantics (profile name), not a user-text limit. */
const MAX_NAME_CHARS = 128;

export function validateIdentityProfile(value: unknown): IdentityProfile {
  const candidateExamples = isRecord(value) && Array.isArray(value.examples) ? value.examples : undefined;
  if (
    !isRecord(value) ||
    value.schemaVersion !== IDENTITY_PROFILE_SCHEMA_VERSION ||
    !isProfileId(value.profileId) ||
    !Number.isSafeInteger(value.revision) ||
    value.revision < 1 ||
    !isRecord(value.identity) ||
    !isBoundedText(value.identity.name, MAX_NAME_CHARS) ||
    !isBoundedText(value.identity.role, MAX_PROFILE_TEXT_CHARS) ||
    !isBoundedText(value.identity.continuity, MAX_PROFILE_TEXT_CHARS) ||
    (value.persona !== undefined &&
      (!isRecord(value.persona) ||
        (value.persona.core !== undefined && !isBoundedText(value.persona.core, MAX_PROFILE_TEXT_CHARS)) ||
        (value.persona.interactionStyle !== undefined &&
          !isBoundedText(value.persona.interactionStyle, MAX_PROFILE_TEXT_CHARS)) ||
        (value.persona.expressionStyle !== undefined &&
          !isBoundedText(value.persona.expressionStyle, MAX_PROFILE_TEXT_CHARS)))) ||
    (value.examples !== undefined &&
      (candidateExamples === undefined ||
        candidateExamples.length > MAX_EXAMPLES ||
        candidateExamples.some(
          (example: unknown) =>
            !(
              isRecord(example) &&
              isBoundedText(example.user, MAX_PROFILE_TEXT_CHARS) &&
              isBoundedText(example.companion, MAX_PROFILE_TEXT_CHARS)
            ),
        ))) ||
    (value.characterVoice !== undefined &&
      (!(isRecord(value.characterVoice) && isBoundedText(value.characterVoice.text, MAX_PROFILE_TEXT_CHARS)) ||
        (value.characterVoice.source !== "card" && value.characterVoice.source !== "player")))
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
            ...(value.persona.core === undefined ? {} : { core: value.persona.core }),
            ...(value.persona.interactionStyle === undefined
              ? {}
              : { interactionStyle: value.persona.interactionStyle }),
            ...(value.persona.expressionStyle === undefined ? {} : { expressionStyle: value.persona.expressionStyle }),
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
    ...(value.characterVoice === undefined
      ? {}
      : {
          characterVoice: Object.freeze({
            text: value.characterVoice.text,
            source: value.characterVoice.source as "card" | "player",
          }),
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

/**
 * Reads the one Host-owned profile, seeding it exactly once when absent.
 *
 * The seed is a PARAMETER, never a hidden constant: this used to write the
 * placeholder `DEFAULT_IDENTITY_PROFILE` on its own, so an unseeded runtime root
 * silently locked the companion into a placeholder identity and no call site
 * said so. A caller that wants a specific identity (a reviewed card compile, a
 * direct-new-companion name, the placeholder) now names it here, and a caller
 * with nothing to seed has no seed to pass.
 */
export async function readOrCreateIdentityProfile(path: string, seed: IdentityProfile): Promise<IdentityProfile> {
  try {
    return await readIdentityProfile(path);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      await writeIdentityProfile(path, seed);
      return seed;
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
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= maxLength &&
    !/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/u.test(value)
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
