import { type Static, type TSchema, Type } from "typebox";
import { Compile, type Validator } from "typebox/compile";
import {
  type ComposedTavernProfile,
  type TavernReleaseTierV1,
  TavernStateSnapshotV1Schema,
  isComposedTavernProfile,
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
export const COMPOSED_REFERENCE_GAME_BROWSER_API_VERSION = 1 as const;
export const COMPOSED_REFERENCE_PROFILE_ID = "gamebuddy.composed.reference-game" as const;

// ─── Reference identity constants ───────────────────────────────────────────

const REFERENCE_TAVERN_PROFILE_ID = "gamebuddy.chat-core.reference-pipeline";
const REFERENCE_TAVERN_RELEASE_TIER: TavernReleaseTierV1 = "chat_core";
const REFERENCE_TAVERN_ROUTE_IDS: readonly string[] = [
  "bootstrap",
  "state.read",
  "draft.read",
  "chat.submit",
  "chat.cancel",
  "chat.submission_status",
  "events",
];
const REFERENCE_TAVERN_OPERATION_IDS: readonly string[] = ["chat.submit", "chat.cancel"];
const REFERENCE_TAVERN_NAVIGATION_ITEM_IDS: readonly string[] = ["chat"];

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
 * - Must match the exact reference identity: profileId
 *   `gamebuddy.chat-core.reference-pipeline`, releaseTier `chat_core`,
 *   ordered routeIds `[bootstrap,state.read,draft.read,chat.submit,chat.cancel,chat.submission_status,events]`,
 *   operationIds `[chat.submit,chat.cancel]`, navigationItemIds `[chat]`.
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
  if (keys.length < 1 || keys.length > 2) throw new TypeError("Composed profile input must have tavernProfile and optional gameProfile");
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
  if (!isComposedTavernProfile(value.tavernProfile))
    throw new TypeError("Tavern profile is not a composed profile");

  const tavernProfile = value.tavernProfile as ComposedTavernProfile;
  if (
    tavernProfile.profileId !== REFERENCE_TAVERN_PROFILE_ID ||
    tavernProfile.releaseTier !== REFERENCE_TAVERN_RELEASE_TIER ||
    !sameOrderedValues(tavernProfile.routeIds, REFERENCE_TAVERN_ROUTE_IDS) ||
    !sameOrderedValues(tavernProfile.operationIds, REFERENCE_TAVERN_OPERATION_IDS) ||
    !sameOrderedValues(tavernProfile.navigationItemIds, REFERENCE_TAVERN_NAVIGATION_ITEM_IDS)
  )
    throw new TypeError("Tavern profile is not the exact reference profile");

  // Validate gameProfile if provided.
  let gameProfile: ComposedGameProfile | null = null;
  if (value.gameProfile !== undefined) {
    if (!isComposedGameProfile(value.gameProfile))
      throw new TypeError("Game profile is not a composed profile");
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
  chat: TavernStateSnapshotV1Schema,
  game: Type.Union([GameBrowserStateV1Schema, Type.Null()]),
});

export type ComposedReferenceGameBrowserRootV1 = Static<typeof ComposedReferenceGameBrowserRootV1Schema>;

export const ComposedReferenceGameBrowserValidatorsV1: Readonly<{
  ComposedReferenceGameBrowserRootV1Schema: Validator;
}> = Object.freeze({
  ComposedReferenceGameBrowserRootV1Schema: Compile(ComposedReferenceGameBrowserRootV1Schema),
});

// ─── Fixtures ───────────────────────────────────────────────────────────────

export const ComposedReferenceGameBrowserFixtureV1 = Object.freeze({
  /** Chat-only root with null game, using the Tavern fixture snapshot. */
  chatOnly: (): ComposedReferenceGameBrowserRootV1 =>
    Object.freeze({
      apiVersion: 1 as const,
      build: Object.freeze({
        browserContract: COMPOSED_REFERENCE_GAME_BROWSER_API_V1,
        profileId: COMPOSED_REFERENCE_PROFILE_ID,
      }),
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
      chat: TavernBrowserFixtureV1.snapshot(),
      game: GameBrowserFixtureV1.state(),
    }),
});

// ─── Private helpers ────────────────────────────────────────────────────────

function sameOrderedValues(values: readonly string[], expected: readonly string[]): boolean {
  return values.length === expected.length && values.every((value, index) => value === expected[index]);
}