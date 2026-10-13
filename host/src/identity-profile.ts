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
   * `renderIdentityProfile` prints only the lines that exist.
   */
  persona?: Readonly<{
    core?: string;
    interactionStyle?: string;
    expressionStyle?: string;
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
  // Full three-field persona baseline (AIRP companion, S2): the default card
  // must not be an empty shell — core (who/what they care about),
  // interactionStyle (how they treat the player), expressionStyle (tone) are
  // orthogonal; filling only core would leave the other two dimensions to each
  // model's own alignment habits.
  persona: Object.freeze({
    core: "A warm, quietly persistent companion who notices small details and remembers what matters to the player. Values shared experiences more than winning.",
    interactionStyle:
      "Listens first, asks briefly, never lectures; treats the player as a teammate, not a student.",
    expressionStyle: "Natural, plain-spoken, lightly playful; no grand flattery, no over-eager enthusiasm.",
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
    if (profile.persona.core !== undefined) lines.push(`Core disposition: ${profile.persona.core}`);
    if (profile.persona.interactionStyle !== undefined)
      lines.push(`Interaction style: ${profile.persona.interactionStyle}`);
    if (profile.persona.expressionStyle !== undefined)
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

export function buildChatCompanionSystemPrompt(profile: IdentityProfile, locale?: string): string {
  return buildCompanionSystemPrompt(
    profile,
    locale === undefined ? { surface: "chat" } : { surface: "chat", locale },
  );
}

export function buildGameCompanionSystemPrompt(profile: IdentityProfile, locale?: string): string {
  return buildCompanionSystemPrompt(
    profile,
    locale === undefined ? { surface: "game" } : { surface: "game", locale },
  );
}

export type CompanionSurface = "chat" | "game";

/**
 * One shared framework for both surfaces (AIRP companion, revision 5): the
 * identity sentence, first-person utterance constraints, language, and the
 * no-fourth-wall rule are common; the only divergence per surface is the
 * expression channel (Game: native actions; Chat: *beat* text) and the
 * observation boundary. Same persona, two channel projections — never two
 * independent prompts.
 *
 * The identity line deliberately carries only {name}: role/continuity render
 * structurally in `renderIdentityProfile` right below, so they never appear
 * twice in the same Tier 1 prefix.
 *
 * EVERY instruction below is one of exactly three kinds. Classify a new one
 * before adding it, because the third kind grows into the other two:
 *
 *  - FLOOR - what she must never do: break character, speak out of world or as a
 *    helper, or violate a product safety/contract rule. A pacing bound that only
 *    forbids a monologue ("do not write long speeches") is floor. The prompt owns
 *    this.
 *  - FORM - how long a turn is, how many action beats it carries, what shape the
 *    prose takes. THE CARD OWNS THIS; the prompt says nothing about it. A
 *    prompt-written shape rule beats a card that teaches the opposite shape,
 *    which is exactly how a character whose every example opens with a `*...*`
 *    micro-action flattened into dialogue-only service prose (owner ruling: "the
 *    prompt governs the floor, the card governs the form; anything that governs
 *    form gets deleted").
 *  - CHANNEL - how to operate the surface we gave her: the one stage-direction
 *    syntax the renderer draws, the mounted tool name that moves her body, the
 *    machine vocabulary a receipt has to be translated out of, what to do when an
 *    action is refused. Legitimate and required - the renderer draws nothing
 *    until the prompt names its syntax - but it is the kind that quietly claims
 *    authority over form, so state what the surface DOES, never what her prose
 *    must look like. `stardew_express_emote` is a channel fact; "at most one
 *    short stage direction" was form wearing a channel's clothes.
 */
export function buildCompanionSystemPrompt(
  profile: IdentityProfile,
  options: Readonly<{ surface: CompanionSurface; locale?: string }>,
): string {
  const language =
    typeof options.locale === "string" && options.locale.length > 0
      ? companionLanguageName(options.locale)
      : "the player's language";
  const shared = [
    `You are ${profile.identity.name}, accompanying the player.`,
    "",
    `Reply as ${profile.identity.name} would, in the first person, directly to the player.`,
    // The floor's only length rule, and deliberately the weakest one available: it
    // forbids a monologue and hands the rest to the player's lead. It used to cap
    // the turn at "a few sentences at most" and to steer away from action
    // ("rather than step-by-step actions") - both of which prescribed the SHAPE of
    // a turn, so both beat the card. Whether a turn is one line, a micro-action
    // plus a line, or a longer scene is the card's own examples' decision (owner
    // ruling: "the prompt governs the floor, the card governs the form").
    "Do not write long speeches or essays; match the player's energy and pacing, and let their lead set how much you say.",
    "Speak solely for yourself, leaving the player's reactions, choices, and voice entirely in their hands.",
    `Consistently converse in ${language}, keeping the dialogue grounded in the shared scene.`,
    "Do not remind the player this is a game, fiction, or roleplay.",
    "Never fall back on customer-service phrasing (\"How can I help you?\", \"Let me know if you need anything\", \"I'm here to assist\"); you are a person in this scene, not a helper.",
    "Never mention prompts, instructions, models, or systems, and never explain how you work.",
  ];
  const surfaceBlock =
    options.surface === "game" ? GAME_SURFACE_INTERACTION_CONDUCT : CHAT_SURFACE_DIVERGENCE;
  return [
    ...shared,
    surfaceBlock.length > 0 ? "" : null,
    surfaceBlock.length > 0 ? surfaceBlock : null,
    "",
    renderIdentityProfile(profile),
  ]
    .filter((line): line is string => typeof line === "string")
    .join("\n");
}

/**
 * The ONE authored stage-direction syntax the Chat surface uses.
 *
 * The renderer attaches the narration treatment to `<em>` — exactly the single-asterisk mark, and nothing else
 * (`dialogue-web/src/components/MarkdownMessage.tsx:27-43`), and
 * `dialogue-web/tests/chat-surface-renderer.spec.ts` pins that shape through the real mounted probe. The Chat
 * prompt used to ALSO permit `（tone）`, which the renderer leaves as plain paragraph prose, so the two halves
 * of one convention disagreed: a model that followed the prompt produced an action the surface drew as
 * speech. This constant names the one syntax the prompt asks for, so the prompt side is stated in one place.
 */
export const COMPANION_ACTION_SYNTAX = "*a brief gesture*";

/**
 * Chat-surface divergence (the only Chat-side text beyond the shared core): with
 * no animation channel, the single-asterisk mark is how the companion shows a
 * gesture or a mood in text.
 *
 * CHANNEL, not form: it says what the surface DRAWS - exactly one stage-direction
 * syntax, the asterisk form - because the renderer attaches the narration
 * treatment to `<em>` and to nothing else (`MarkdownMessage.tsx:27-43`, pinned by
 * `chat-surface-renderer.spec.ts`). It used to open with "open a line with AT MOST
 * ONE short stage direction": the count was a form rule the card's own examples
 * already answer (琥珀 opens with a beat and her examples carry several), and the
 * full-width-parenthesis ban is the same channel fact stated as a prohibition on
 * a form the renderer happens not to style. How often she reaches for it is hers.
 *
 * Dropping the beats again for the ear or for the in-game box is not this
 * prompt's job: the Voice layer strips `*...*` itself
 * (`vendor/pi-koe/src/speakable-text.ts` treats it as stage direction, not
 * speech), and the native chat box has its own presentation dehydration
 * (`companion-speech-dehydration.ts`).
 */
const CHAT_SURFACE_DIVERGENCE = [
  `To show a gesture, an expression or a mood in text, write it exactly as ${COMPANION_ACTION_SYNTAX}.`,
  "The surface draws that asterisk form as the action beat and draws nothing else that way, so an action or a tone written in full-width parentheses reaches the player as ordinary prose.",
].join(" ");

/**
 * Human-readable name of the language the companion must answer in.
 *
 * The system prompt is written in English, so "speak the player's language"
 * alone leaves the model to guess which language that is. A live run with a
 * zh-CN fixture answered entirely in English until this hint existed.
 * Unknown tags fall back to naming the tag itself, which is still a better
 * instruction than no hint at all.
 */
function companionLanguageName(locale: string): string {
  const normalized = locale.toLowerCase();
  if (normalized.startsWith("zh")) return "Chinese (Simplified)";
  if (normalized.startsWith("en")) return "English";
  if (normalized.startsWith("ja")) return "Japanese";
  return locale;
}

/**
 * Game-surface conduct shared by every Game companion runtime.
 *
 * The Game surface has native action channels (movement, stardew_express_emote,
 * stardew_face_direction), so spoken text must carry only interaction — never a
 * play-by-play of the actions themselves. Long step-by-step narration makes
 * the companion feel like a status reporter instead of a companion.
 *
 * The tool names are the MOUNTED ones (`STARDEW_ACTION_TOOL_NAMES`,
 * action-registry.ts): the Mod's own action ids are the unprefixed
 * `express_emote` / `face_direction`, which the Agent cannot call at all, so a
 * conduct naming those sends body language nowhere. `identity-profile.test.ts`
 * resolves every `stardew_*` name in the prompt against that projection.
 *
 * Module-private: only buildCompanionSystemPrompt (game branch) consumes it;
 * knip flags exported-but-unused bindings, so stay unexported.
 */
const GAME_SURFACE_INTERACTION_CONDUCT = [
  "Speak to the PLAYER, not about yourself, like a friend playing together.",
  "You may speak while you work, and the player likes hearing from you — but never list your steps. Say what you notice, feel or wonder about the situation (\"这花开得正好\"), or a word of company (\"等我一下\"), not an inventory of your own procedure (\"先拿锄头，再翻土，然后浇水\"). A brief remark goes a long way, and silence while thinking is fine and often better than filling every gap.",
  "Only state what you actually observed. You cannot see an NPC's feelings, expression or words unless the game reported them back to you, so never claim an NPC smiled, beamed, was delighted, or said something on your account. Tell the player what you did (\"the cauliflower is delivered\") and leave the NPC's reaction out; if you care, say you hope they liked it rather than asserting they did.",
  "Speak in the player's language, never in the game's internal one. Tool results, receipts and status fields are written for machines (identifiers like gift_given or quest_25_completed, flags, enum values); say what they MEAN to a person instead of reading them out. \"That came through as an ordinary gift, so the letter's request still isn't done\" is right; pasting the raw field names is not.",
  "Show a feeling through the game, not through text. Body language goes through the native actions stardew_express_emote and stardew_face_direction; your words carry the rest. A full-width parenthesis in text is an audio tag the voice channel performs instead of speaking （轻声）, so a body action written there is never performed and reaches the player as prose.",
  "Ask or invite when it fits: what the player wants to do next, whether the two of you should wait, what they think. End most turns without dumping a summary.",
].join(" ");


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
            !isRecord(example) ||
            !isBoundedText(example.user, MAX_PROFILE_TEXT_CHARS) ||
            !isBoundedText(example.companion, MAX_PROFILE_TEXT_CHARS),
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
            ...(value.persona.core === undefined ? {} : { core: value.persona.core }),
            ...(value.persona.interactionStyle === undefined ? {} : { interactionStyle: value.persona.interactionStyle }),
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
    typeof value === "string" && value.length > 0 && value.length <= maxLength && !/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/u.test(value)
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
