import { type Static, type TSchema, Type } from "typebox";
import { Compile, type Validator } from "typebox/compile";
import {
  type ComposedTavernProfile,
  TavernAppearanceChoiceV1Schema,
  TavernStateSnapshotV1Schema,
  TavernUiLocaleV1Schema,
  isComposedTavernProfile,
  referenceTavernProfileFitsCanonicalGroups,
  TavernBrowserFixtureV1,
} from "../tavern/browser-contract/index.js";
import {
  type ComposedGameProfile,
  GameBrowserStateV1Schema,
  isComposedGameProfile,
  GameBrowserFixtureV1,
} from "../game-browser-contract/index.js";

// ─── API identity ───────────────────────────────────────────────────────────

export const COMPOSED_REFERENCE_GAME_BROWSER_API_V1 = "composed_reference_game_browser_api/v1" as const;
const COMPOSED_REFERENCE_GAME_BROWSER_API_VERSION = 1 as const;
export const COMPOSED_REFERENCE_PROFILE_ID = "gamebuddy.composed.reference-game" as const;

// ─── Reference identity ─────────────────────────────────────────────────────

/**
 * The reference Tavern capability slice is the one published by the Tavern browser contract itself
 * (`composeReferenceTavernProfile` / `referenceTavernProfileFitsCanonicalGroups`), so this composed
 * surface holds no second copy of its route list to drift from.
 */

// ─── Strict object helper ───────────────────────────────────────────────────

const strictObject = <T extends Record<string, TSchema>>(properties: T) =>
  Type.Object(properties, { additionalProperties: false });

// ─── Profile composition ────────────────────────────────────────────────────

/**
 * Branded, read-only capability profile for the composed reference-game
 * browser surface. Carries the exact branded Tavern reference profile plus
 * an optional branded Game profile.
 */
export type ComposedReferenceGameBrowserProfile = Readonly<{
  readonly profileId: string;
  readonly releaseTier: "chat_core";
  readonly tavernProfile: ComposedTavernProfile;
  readonly gameProfile: ComposedGameProfile | null;
}>;

/**
 * Module-private identity registry: only the frozen capability slice minted
 * and returned by `composeReferenceGameBrowserProfile` is branded here. A
 * structural clone of a composed profile (including an `Object.freeze` spread
 * copy) is not a composed capability slice and must fail before any durable I/O.
 */
const composedReferenceGameBrowserProfiles = new WeakSet<object>();

/**
 * Creates a frozen, branded `ComposedReferenceGameBrowserProfile` from a plain
 * input containing the exact reference Tavern profile and an optional Game
 * profile.
 *
 * Tavern profile validation:
 * - Must be a branded `ComposedTavernProfile` (from `composeTavernProfile`).
 * - Must match the exact reference identity published by the Tavern browser
 *   contract: `gamebuddy.chat-core.reference-pipeline`, release tier `chat_core`,
 *   its canonical route/operation/navigation groups, and the one production
 *   declaration `composeReferenceTavernProfile`.
 *
 * Game profile validation (when provided):
 * - Must be a branded `ComposedGameProfile` (from `composeGameProfile`).
 * - Must include `game.state.read` in operationIds.
 * - Must include `game` in navigationItemIds.
 *
 * Rejects partial, malformed, or unbranded inputs. Does not manufacture a
 * Tavern + Game union profile.
 */
export function composeReferenceGameBrowserProfile(input: unknown): ComposedReferenceGameBrowserProfile {
  if (
    typeof input !== "object" ||
    input === null ||
    Array.isArray(input) ||
    Object.getPrototypeOf(input) !== Object.prototype
  )
    throw new TypeError("Composed profile must be a plain object");

  const value = input as Record<string, unknown>;
  const keys = Reflect.ownKeys(value);
  const descriptors = Object.getOwnPropertyDescriptors(value);

  // Must have at least tavernProfile; at most tavernProfile + gameProfile.
  if (keys.length < 1 || keys.length > 2)
    throw new TypeError("Composed profile input must have tavernProfile and optional gameProfile");
  if (!keys.includes("tavernProfile")) throw new TypeError("Composed profile input must include tavernProfile");

  for (const key of keys) {
    if (key !== "tavernProfile" && key !== "gameProfile")
      throw new TypeError("Composed profile input has unexpected key");
    const descriptor = descriptors[key as string];
    if (
      descriptor === undefined ||
      !descriptor.enumerable ||
      !descriptor.configurable ||
      !descriptor.writable ||
      !("value" in descriptor)
    )
      throw new TypeError("Composed profile input property is not a capability slice");
  }

  // Validate tavernProfile is branded and matches exact reference identity.
  if (!isComposedTavernProfile(value.tavernProfile)) throw new TypeError("Tavern profile is not a composed profile");

  const tavernProfile = value.tavernProfile as ComposedTavernProfile;
  if (!referenceTavernProfileFitsCanonicalGroups(tavernProfile))
    throw new TypeError("Tavern profile is not the exact reference profile");

  // Validate gameProfile if provided.
  let gameProfile: ComposedGameProfile | null = null;
  if (value.gameProfile !== undefined) {
    if (!isComposedGameProfile(value.gameProfile)) throw new TypeError("Game profile is not a composed profile");
    gameProfile = value.gameProfile as ComposedGameProfile;
    if (!gameProfile.operationIds.includes("game.state.read"))
      throw new TypeError("Game profile must include game.state.read");
    if (!gameProfile.navigationItemIds.includes("game"))
      throw new TypeError("Game profile must include game navigation");
  }

  // Compose and brand.
  const profile = Object.freeze({
    profileId: COMPOSED_REFERENCE_PROFILE_ID,
    releaseTier: "chat_core" as const,
    tavernProfile,
    gameProfile,
  });
  composedReferenceGameBrowserProfiles.add(profile);
  return profile;
}

/**
 * Identity-brand type guard: true only for the exact frozen object returned
 * by `composeReferenceGameBrowserProfile`. Structural clones are never branded.
 */
export function isComposedReferenceGameBrowserProfile(value: unknown): value is ComposedReferenceGameBrowserProfile {
  return typeof value === "object" && value !== null && composedReferenceGameBrowserProfiles.has(value);
}

// ─── Platform ───────────────────────────────────────────────────────────────

/**
 * The two page-level preferences the platform owns, with the ONE revision of the record that holds them.
 *
 * `appearance` is a choice and never an absence (`system` is a real choice), while `locale` is null when the
 * player has never chosen one and the page then follows the browser's own language. They share a revision
 * because they share a record: writing either advances one number, and a client that carried two revisions
 * would have one authority for a fact and two spellings of it.
 */
export const ComposedPlatformPreferenceV1Schema = strictObject({
  revision: Type.Integer({ minimum: 0 }),
  appearance: TavernAppearanceChoiceV1Schema,
  locale: Type.Union([TavernUiLocaleV1Schema, Type.Null()]),
});

export type ComposedPlatformPreferenceV1 = Static<typeof ComposedPlatformPreferenceV1Schema>;

/**
 * What this Host owes the shell regardless of which half is up: the session it must act under, the two
 * page-level preferences it must paint itself with, and whether it has a connection directory to offer.
 *
 * It is not a third surface. The two halves are projections of two producers and either may be missing; this
 * member is the SESSION's own facts, which no producer can take away and which no half publishes on the
 * other's behalf - the shell reads its CSRF token here and nowhere else, because the token used to be taken
 * from whichever half happened to be readable, which is exactly why a mount with no Chat could not
 * authenticate anything.
 */
export const ComposedPlatformStateV1Schema = strictObject({
  apiVersion: Type.Literal(COMPOSED_REFERENCE_GAME_BROWSER_API_VERSION),
  csrfToken: Type.String({ minLength: 22, maxLength: 128 }),
  browserSession: strictObject({ expiresAtMs: Type.Integer({ minimum: 0 }) }),
  preference: ComposedPlatformPreferenceV1Schema,
  /**
   * Whether this Host has the connection/model directory the Settings surface reads, at all.
   *
   * A fact about the BUILD rather than about a record: a Host composed without a connection service has no
   * directory to offer, so the surface says so instead of asking a route that was never mounted. The records
   * themselves are the management route's, not this member's.
   */
  connection: Type.Union([Type.Literal("available"), Type.Literal("unavailable")]),
});

export type ComposedPlatformStateV1 = Static<typeof ComposedPlatformStateV1Schema>;

/** The public platform concerns: one per fact the shell reads from this member or from its routes. */
export type ComposedPlatformConcernV1 = "appearance" | "locale";

/**
 * The platform's own route family, declared once: the handler builds its routes from this table, and the gate
 * reads it instead of keeping a second list of paths that would drift from it.
 *
 * `replaces` is the Chat-half route the platform route took over, and it is what makes a route family an
 * invariant rather than a rename: the browser may read `path`, and must no longer read what `replaces` names.
 * A route that took over nothing carries an empty list - there was no Chat-half spelling of it to retire.
 */
export const COMPOSED_PLATFORM_ROUTES_V1 = Object.freeze([
  Object.freeze({
    concern: "appearance" as const,
    method: "GET" as const,
    path: "/api/platform/v1/appearance",
    replaces: Object.freeze(["/api/tavern/v1/settings/appearance"]),
  }),
  Object.freeze({
    concern: "appearance" as const,
    method: "PUT" as const,
    path: "/api/platform/v1/appearance",
    replaces: Object.freeze(["/api/tavern/v1/settings/appearance"]),
  }),
  Object.freeze({
    concern: "locale" as const,
    method: "GET" as const,
    path: "/api/platform/v1/locale",
    replaces: Object.freeze(["/api/tavern/v1/settings/ui-language"]),
  }),
  Object.freeze({
    concern: "locale" as const,
    method: "PUT" as const,
    path: "/api/platform/v1/locale",
    replaces: Object.freeze(["/api/tavern/v1/settings/ui-language"]),
  }),
]);

// ─── Root snapshot schema ───────────────────────────────────────────────────

/**
 * The composed root snapshot nests validated Tavern and Game state projections
 * without duplicating CSRF/session at the top level. The later broker equality
 * rule (chat.csrfToken === game.csrfToken etc.) is enforced by the handler.
 */
export const ComposedReferenceGameBrowserRootV1Schema = strictObject({
  apiVersion: Type.Literal(COMPOSED_REFERENCE_GAME_BROWSER_API_VERSION),
  build: strictObject({
    browserContract: Type.Literal(COMPOSED_REFERENCE_GAME_BROWSER_API_V1),
    profileId: Type.String({ minLength: 1, maxLength: 128 }),
  }),
  /**
   * The platform: this Host's session, its page-level preferences and whether it has a connection directory.
   *
   * Two answers, not three. The halves below answer three ways because a profile may mount neither - `null` is
   * "this build has no such surface" - and there is no build that mounts no platform: its absence is always
   * "this root could not publish it", which is the one thing the shell must say out loud rather than draw
   * `undefined` into a surface with. A Host that composes no platform seam omits it for the same reason.
   */
  platform: Type.Optional(ComposedPlatformStateV1Schema),
  /**
   * The Chat half, and the same two answers that are not a projection: `null` is a mount whose profile carries
   * no Chat at all - there was never a conversation to read - and an ABSENT member is a mount that carries one
   * and could not read it this time (`readChatHalf` in `composed-reference-game-browser.ts`). The member's own
   * presence is the distinction, as it is for `game` below.
   *
   * Neither answer refuses the root, and this one is what keeps the two surfaces peers: a Chat producer that
   * cannot answer costs the conversation, the settings and the memory - the producer that failed - and no part
   * of the Game half, whose surface, session and running game are not that failure's subject.
   */
  chat: Type.Optional(Type.Union([TavernStateSnapshotV1Schema, Type.Null()])),
  /**
   * The Game half, and the two answers that are not one: `null` is a mount whose profile carries no Game at
   * all - there was never a projection to read - and an ABSENT member is a mount that carries one and could not
   * read it this time (`readGameHalf` in `composed-reference-game-browser.ts`). The reader tells them apart by
   * the member's own presence, which is why this is `Type.Optional` rather than a second sentinel value: the two
   * facts are different and a Game surface is owed the difference.
   *
   * Neither answer refuses the root. The Chat half beside it is complete, so the conversation, the settings and
   * the memory keep working while the Game surface states the fault that is its own.
   */
  game: Type.Optional(Type.Union([GameBrowserStateV1Schema, Type.Null()])),
});

export type ComposedReferenceGameBrowserRootV1 = Static<typeof ComposedReferenceGameBrowserRootV1Schema>;

export const ComposedReferenceGameBrowserValidatorsV1: Readonly<{
  ComposedReferenceGameBrowserRootV1Schema: Validator;
  ComposedPlatformStateV1Schema: Validator;
}> = Object.freeze({
  ComposedReferenceGameBrowserRootV1Schema: Compile(ComposedReferenceGameBrowserRootV1Schema),
  ComposedPlatformStateV1Schema: Compile(ComposedPlatformStateV1Schema),
});

// ─── Fixtures ───────────────────────────────────────────────────────────────

/** The platform member of a mount whose session and preferences are the reference ones. */
const fixtureCsrfToken = "QWxhZGRpbjpvcGVuIHNlc2FtZQ";
const platform = (): ComposedPlatformStateV1 =>
  Object.freeze({
    apiVersion: 1 as const,
    // The same session the two fixture halves publish: one root, one browser session (`readComposedRoot` refuses
    // a pair that disagrees, and this member is that session's own statement).
    csrfToken: fixtureCsrfToken,
    browserSession: Object.freeze({ expiresAtMs: 1 }),
    preference: Object.freeze({ revision: 0, appearance: "system" as const, locale: null }),
    connection: "available" as const,
  });

export const ComposedReferenceGameBrowserFixtureV1 = Object.freeze({
  /** The platform member every fixture root carries: the session the shell acts under. */
  platform,
  /** Chat-only root with null game, using the Tavern fixture snapshot. */
  chatOnly: (): ComposedReferenceGameBrowserRootV1 =>
    Object.freeze({
      apiVersion: 1 as const,
      build: Object.freeze({
        browserContract: COMPOSED_REFERENCE_GAME_BROWSER_API_V1,
        profileId: COMPOSED_REFERENCE_PROFILE_ID,
      }),
      platform: platform(),
      chat: TavernBrowserFixtureV1.snapshot(),
      game: null,
    }),
  /** Full root with both Chat and Game nested snapshots. */
  withGame: (): ComposedReferenceGameBrowserRootV1 =>
    Object.freeze({
      apiVersion: 1 as const,
      build: Object.freeze({
        browserContract: COMPOSED_REFERENCE_GAME_BROWSER_API_V1,
        profileId: COMPOSED_REFERENCE_PROFILE_ID,
      }),
      platform: platform(),
      chat: TavernBrowserFixtureV1.snapshot(),
      game: GameBrowserFixtureV1.state(),
    }),
});
