import { type Static, type TSchema, Type } from "typebox";
import { Compile, type Validator } from "typebox/compile";
import { Format } from "typebox/format";

export const GAME_BROWSER_API_V1 = "game_browser_api/v1" as const;
const GAME_BROWSER_API_VERSION = 1 as const;

// ─── Shared primitives (reuse Tavern's base64url format, registered by tavern/browser-contract) ───

const BASE64URL_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
const OPAQUE_HANDLE_PATTERN = "^[A-Za-z0-9_-]{22,128}$";
const IDEMPOTENCY_KEY_PATTERN = "^[A-Za-z0-9_-]{22}$";

const isCanonicalUnpaddedBase64Url = (value: string): boolean => {
  if (!/^[A-Za-z0-9_-]+$/.test(value) || value.length % 4 === 1) return false;
  const finalValue = BASE64URL_ALPHABET.indexOf(value.at(-1)!);
  return value.length % 4 === 0 || (value.length % 4 === 2 ? finalValue % 16 === 0 : finalValue % 4 === 0);
};

Format.Set("game-browser-canonical-base64url-v1", isCanonicalUnpaddedBase64Url);

const strictObject = <T extends Record<string, TSchema>>(properties: T) =>
  Type.Object(properties, { additionalProperties: false });
const ApiVersion = Type.Literal(GAME_BROWSER_API_VERSION);
const OpaqueHandle = Type.String({
  minLength: 22,
  maxLength: 128,
  pattern: OPAQUE_HANDLE_PATTERN,
  format: "game-browser-canonical-base64url-v1",
});
const IdempotencyKey = Type.String({
  minLength: 22,
  maxLength: 22,
  pattern: IDEMPOTENCY_KEY_PATTERN,
  format: "game-browser-canonical-base64url-v1",
});
const PositiveGeneration = Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER });
const NonNegativeGeneration = Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER });
/** Loose safe identifier for published integration ids and opaque durable session handles (not a proof or canonical handle). */
const SAFE_ID = Type.String({ minLength: 1, maxLength: 128, pattern: "^[A-Za-z0-9_-]{1,128}$" });

// ─── Problem code ───────────────────────────────────────────────────────────

/**
 * The one declaration of the `game_browser_api/v1` problem vocabulary: the union `GameProblemV1Schema.code`
 * validates, and the arms `GAME_BROWSER_PROBLEM_CODES_V1` publishes below.
 *
 * A code is added HERE and nowhere else. The browser's copy cannot import this package and is held to EQUALITY
 * with these arms by `dialogue-web/tests/problem-code-gate.test.mjs` (`problem-code.9` for the names,
 * `problem-code.10` for the player's words), which reads them from this declaration.
 */
const GameProblemCode = Type.Union([
  Type.Literal("unauthorized"),
  Type.Literal("csrf_failed"),
  Type.Literal("invalid_request"),
  Type.Literal("unsupported_api_version"),
  Type.Literal("profile_operation_unavailable"),
  Type.Literal("idempotency_conflict"),
  Type.Literal("idempotency_in_progress"),
  Type.Literal("idempotency_expired"),
  Type.Literal("game_unavailable"),
  Type.Literal("game_prerequisites_missing"),
  Type.Literal("game_instance_not_found"),
  Type.Literal("game_attachment_conflict"),
  Type.Literal("game_operation_in_progress"),
  Type.Literal("stardew_cabin_choice_stale"),
  Type.Literal("stardew_manifest_handoff_uncertain"),
  Type.Literal("game_runtime_unavailable"),
  // The launch that never reached the game: the Host's connection to the part that starts the game
  // can be absent or end mid-command, and a launch frame this side refuses to write never left it
  // either - in every one of those the game was never asked to start anything, so the refusal is a
  // refusal and not an outcome the Host cannot state. It is its own code because the nearest two
  // readings are both false claims here: `state_unavailable` tells the player the result is unknown,
  // and `game_runtime_unavailable` carries the panel's "the result is uncertain" line, which is what
  // the panel shows for a refusal whose effect the Host cannot rule out. It names the CONDITION only -
  // which step failed travels in no field.
  Type.Literal("game_launch_unreachable"),
  Type.Literal("game_storage_unavailable"),
  // The composed reference-game shell's own route and transport refusals. They are
  // produced by `composed-reference-game-browser.ts` for its bootstrap, state,
  // lifecycle and game routes, so they belong to this surface's vocabulary rather
  // than to a client-side allowlist. The client already reads `not_found` as an
  // absent route and `state_unavailable` (and any 5xx) as retryable.
  Type.Literal("closed"),
  Type.Literal("malformed_request"),
  Type.Literal("not_found"),
  Type.Literal("state_unavailable"),
  Type.Literal("game_endgame_settlement_unavailable"),
  // The player's own Stardew settings: the record they edited moved under them. It is a
  // refusal, not a fault - nothing was written, and the fresh record is the thing to act on.
  Type.Literal("stardew_settings_revision_conflict"),
  // The player-host role exited: the Guardian that owns the game process reported the
  // native exit code it ended with, so the cabin handoff cannot be read for a game that is
  // no longer there. It is its own code because `state_unavailable` is the opposite claim -
  // the Host does not know - and because the code states the CONDITION only: the exit fact
  // itself (the code the OS gave) travels in exactly one field, `game.instance.playerHostExitCode`,
  // and appears nowhere else.
  Type.Literal("stardew_player_host_exited"),
  // The other named answer the cabin read gives, which it has produced since 2026-10-28 without
  // this union declaring it: a live, generation-correlated host world that offers no cabin the
  // companion may use. Its cure is the game's own - have Robin build one - so it must reach the
  // player as that fact rather than as an internal error.
  Type.Literal("stardew_player_host_cabin_missing"),
  // An earlier attempt still holds the installation registration. The activation route answers
  // this instead of the generic `state_unavailable` because the two facts have opposite fixes: a
  // missing registration is the installation step, a held one is "close the game and this
  // GameBuddy session". It names the CONDITION only - which attempt holds it travels in no field.
  Type.Literal("stardew_bootstrap_registration_held"),
  // The create whose world is the player's own. The save slot the new world would be registered on
  // already binds the world an earlier session created and the recovery deliberately preserved, so
  // this create refuses instead of taking it over (`STARDEW_GAME_CREATE_WORLD_HELD_BY_PLAYER_RESUME_REQUIRED`,
  // stardew-production-lifecycle-coordinator.internal.ts:969-970). Its fix is the opposite of the
  // generic `state_unavailable`'s: retrying create on the same slot fails identically, and the world
  // the player already has is resumed, never recreated. It names the CONDITION only - which session
  // holds the world travels in no field.
  Type.Literal("stardew_game_create_world_held_by_player"),
  // The create whose slot an earlier GameBuddy attempt still holds. That attempt's lease was not
  // proven gone, so nothing was finalized and nothing released
  // (`STARDEW_GAME_CREATE_SLOT_HOLDER_NOT_PROVEN_GONE`, stardew-production-lifecycle-coordinator.internal.ts:950).
  // Its own code rather than the one above because the two facts have opposite fixes: there the
  // world is the player's and is resumed, here a leftover attempt of this product is what has to be
  // closed out. It names the CONDITION only - which attempt holds it travels in no field.
  Type.Literal("stardew_game_create_slot_held_by_earlier_attempt"),
]);

/**
 * The union's own members, as the runtime list a caller iterates.
 *
 * Derived from `GameProblemCode.anyOf`, never restated: the annotation is the union's own static type, so a member
 * the union does not declare - or an arm that stopped being a literal - is a compile error here, and a code added
 * above appears without a second edit. It was a hand-written `Object.freeze([...])` of the same codes beside the
 * union, which nothing compared to it; the contract's own test then restated sixteen of them a third time.
 */
export const GAME_BROWSER_PROBLEM_CODES_V1: readonly Static<typeof GameProblemCode>[] = Object.freeze(
  GameProblemCode.anyOf.map((arm) => arm.const),
);

// ─── Redacted read projections ──────────────────────────────────────────────

const PrerequisiteStatus = Type.Union([Type.Literal("unknown"), Type.Literal("met"), Type.Literal("failed")]);

/**
 * The Player Host instance slot `game.state.read` publishes.
 *
 * `unread` is the Host's own word for "the read of the player's game produced no fact":
 * the coordinator's Player Host slot answered `unavailable` (the evidence read failed) or
 * `unknown` (a player-external game it could not verify). It is deliberately not `none`,
 * which means "nothing is running yet"; a game the Host has not read has established no
 * instance fact at all. `game-browser/game-browser-state-provider.ts` is its only writer.
 *
 * `crashed` and `stopped` are the two ways a game that ended reads there, and the exit code
 * decides between them: a non-zero code (or a launch that failed with no exit reported at all)
 * is `crashed`, and the OS's normal-termination code `0` is `stopped` - the player ended the
 * game, which is terminal for this attempt but is not a fault to report as one.
 */
const InstanceStatus = Type.Union([
  Type.Literal("none"),
  Type.Literal("launching"),
  Type.Literal("running"),
  Type.Literal("stopped"),
  Type.Literal("crashed"),
  Type.Literal("unread"),
]);

const CompatibilityStatus = Type.Union([
  Type.Literal("unchecked"),
  Type.Literal("compatible"),
  Type.Literal("incompatible"),
  Type.Literal("warning"),
]);

const AttachmentStatus = Type.Union([
  Type.Literal("none"),
  Type.Literal("pending"),
  Type.Literal("attached"),
  Type.Literal("failed"),
]);

const ConnectionStatus = Type.Union([
  Type.Literal("none"),
  Type.Literal("discovering"),
  Type.Literal("launch_pending"),
  Type.Literal("attach_pending"),
  Type.Literal("compatibility_warning"),
  Type.Literal("awaiting_confirmation"),
  Type.Literal("connecting"),
  Type.Literal("connected_idle"),
  Type.Literal("active"),
  Type.Literal("stopping"),
  Type.Literal("reconnecting"),
  Type.Literal("syncing"),
  Type.Literal("stopped"),
  Type.Literal("failed"),
  Type.Literal("disconnected"),
]);

const ActionAuthority = Type.Union([Type.Literal("unavailable"), Type.Literal("active"), Type.Literal("paused")]);

const Role = Type.Union([Type.Literal("player"), Type.Literal("companion"), Type.Null()]);

const Outcome = Type.Union([
  Type.Literal("none"),
  Type.Literal("succeeded"),
  Type.Literal("failed"),
  Type.Literal("cancelled"),
]);

const DetectedGameLabel = Type.Union([Type.String({ minLength: 1, maxLength: 256 }), Type.Null()]);
const CompanionName = Type.Union([Type.String({ minLength: 1, maxLength: 256 }), Type.Null()]);
const SafeWorldLabel = Type.Union([Type.String({ minLength: 1, maxLength: 256 }), Type.Null()]);
const SafeSaveLabel = Type.Union([Type.String({ minLength: 1, maxLength: 256 }), Type.Null()]);
const CompatibilityMessage = Type.Union([Type.String({ minLength: 1, maxLength: 512 }), Type.Null()]);
const GameTitleLabel = Type.Union([Type.String({ minLength: 1, maxLength: 256 }), Type.Null()]);

/**
 * The prerequisite projection `game.state.read` publishes.
 *
 * Two facts and no third: whether the bound installation is registered, and which game that is. The
 * Host's readiness view is binary - an `registered`/`absent` installation plus a launch-readiness
 * status - so it has no per-item list to publish. "What am I missing" is answered by the
 * installation-discovery route (`GET .../installation/discovery`), which names the candidate folders
 * it found, whether the chosen one holds a mod loader, and which channel it could not read.
 */
export const GamePrerequisiteStateV1Schema = strictObject({
  status: PrerequisiteStatus,
  detectedGame: DetectedGameLabel,
});

export const GameInstanceV1Schema = strictObject({
  status: InstanceStatus,
  gameTitle: GameTitleLabel,
  /** Redacted launch-ready generation: 0 until the coordinator owns/stages the instance. */
  generation: NonNegativeGeneration,
  /**
   * The native exit code the game process ended with, when the Guardian that owns
   * it reported an exit for this activation.
   *
   * It is optional because it is a fact only one producer has: an older Host that
   * never receives a role exit omits the key, and this field is never defaulted to a
   * number a Host invented. Its absence means "this Host did not observe an exit",
   * not "the game is running" - `status` is the field that answers that question.
   * The whole native uint32 range and nothing else: a value outside it is not
   * something the OS reported.
   */
  playerHostExitCode: Type.Optional(Type.Integer({ minimum: 0, maximum: 4_294_967_295 })),
});

export const GameCompatibilityV1Schema = strictObject({
  status: CompatibilityStatus,
  message: CompatibilityMessage,
});

export const GameAttachmentStateV1Schema = strictObject({
  status: AttachmentStatus,
  generation: NonNegativeGeneration,
  /**
   * The cabin this attachment bound, as the attached world's own document names it - rendered for the surface, never
   * a native identity (the browser contract publishes no raw ids: the cabin list carries `choiceHandle`, not
   * `cabinId`).
   *
   * `null` is the Host saying it knows of no cabin for this attachment; the key absent is a Host that does not publish
   * cabin labels at all. The surface answers both with "her cabin", and it never derives a name of its own, because a
   * name taken from the list of offers on screen would point at a different cabin after the next bind.
   */
  cabinLabel: Type.Optional(Type.Union([Type.String({ minLength: 1, maxLength: 128 }), Type.Null()])),
});

/**
 * What the live capability surface published, or why this layer could not read it at all.
 *
 * THREE ZEROS STAY APART. `published` with `count: 0` is a runtime that answered and published no capability - a
 * measurement. `not_measured` is a projection that could not see the surface, and it carries NO count at all: the shape
 * this replaces (`{available: false, count: 0}`) said "nothing is published" whether the runtime had published nothing
 * or the Host had never looked, and the browser rendered both as the same sentence.
 */
export const GameCapabilitySummaryV1Schema = Type.Union([
  strictObject({ status: Type.Literal("published"), count: Type.Integer({ minimum: 0, maximum: 512 }) }),
  strictObject({ status: Type.Literal("not_measured"), reason: Type.String({ minLength: 1, maxLength: 64 }) }),
]);

/**
 * The Game surface's own push checkpoint: which process epoch its stream is in, and where that stream has
 * reached. `cursor` is the opaque encoding of `{epoch, sequence}` (`game-browser/game-event-stream.ts`).
 *
 * It is the Game channel's own epoch and never the Chat channel's: the Game panel's facts must not depend on
 * which Chat is mounted, so nothing here is stamped with a Chat selection generation.
 */
export const GameEventStreamV1Schema = strictObject({ epoch: OpaqueHandle, cursor: OpaqueHandle });

/**
 * The facts that can change without a player acting, one frame's worth at a time.
 *
 * A closed union, one member per fact, and each member names exactly the projection fields that fact owns. The
 * closure is the point: a producer cannot publish `prerequisites` (command-driven), `actionAuthority`
 * (command-driven), or `role`/`companionName`/`selectedSave` (never anything but `null`), because there is no
 * frame shape that carries them. `fact` names the transition seam that published, so a journey can say which
 * one it drove.
 *
 * The members are the `/game` projection's own field schemas, not copies of them: a field that changes shape
 * upstream changes here too, or this file stops compiling.
 */
const GameInstanceFactPatchV1Schema = strictObject({
  fact: Type.Literal("instance"),
  game: strictObject({
    instance: GameInstanceV1Schema,
    compatibility: GameCompatibilityV1Schema,
    latestOutcome: Outcome,
  }),
});

const GameAttachmentFactPatchV1Schema = strictObject({
  fact: Type.Literal("attachment"),
  /** The attached runtime's own catalog count rides the attachment frame: it can only move with it. */
  game: strictObject({
    attachment: GameAttachmentStateV1Schema,
    connectionStatus: ConnectionStatus,
    capabilitySummary: GameCapabilitySummaryV1Schema,
  }),
});

const GameSelectedWorldFactPatchV1Schema = strictObject({
  fact: Type.Literal("selectedWorld"),
  game: strictObject({ selectedWorld: SafeWorldLabel }),
});

export const GameFactPatchV1Schema = Type.Union([
  GameInstanceFactPatchV1Schema,
  GameAttachmentFactPatchV1Schema,
  GameSelectedWorldFactPatchV1Schema,
]);

/**
 * One frame of the Game surface's stream.
 *
 * `game.stream_resync_required` is the one frame that carries no facts: the caller's cursor cannot be served
 * (window, epoch, or shape), so the caller replaces its whole projection from the `/game` snapshot, which stays
 * the authority.
 */
export const GameEventV1Schema = Type.Union([
  strictObject({
    apiVersion: ApiVersion,
    epoch: OpaqueHandle,
    sequence: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
    eventType: Type.Literal("game.fact_changed"),
    payload: GameFactPatchV1Schema,
  }),
  strictObject({
    apiVersion: ApiVersion,
    epoch: OpaqueHandle,
    sequence: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
    eventType: Type.Literal("game.stream_resync_required"),
    payload: strictObject({
      reason: Type.Union([Type.Literal("gap"), Type.Literal("epoch_changed"), Type.Literal("ambiguous_cursor")]),
    }),
  }),
]);

export const GameBrowserStateV1Schema = strictObject({
  apiVersion: ApiVersion,
  build: strictObject({
    browserContract: Type.Literal(GAME_BROWSER_API_V1),
    profileId: Type.String({ minLength: 1, maxLength: 128 }),
  }),
  csrfToken: OpaqueHandle,
  browserSession: strictObject({ expiresAtMs: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }) }),
  /**
   * Additive optional v1 field, the same shape the Chat snapshot has carried: absent means this Host holds no
   * Game event stream, which is a Host (or a test mount) that only ever answers the snapshot. The client
   * subscribes exactly when the field is present, and retires its cursor whenever the epoch differs.
   */
  eventStream: Type.Optional(GameEventStreamV1Schema),
  game: strictObject({
    prerequisites: GamePrerequisiteStateV1Schema,
    instance: GameInstanceV1Schema,
    compatibility: GameCompatibilityV1Schema,
    attachment: GameAttachmentStateV1Schema,
    connectionStatus: ConnectionStatus,
    /**
     * Coordinator-owned action authority: `unavailable` when no attached runtime
     * stands behind the projection, `paused` during and after a resume until a
     * fresh explicit Game instruction reopens admission, `active` when the
     * attached runtime admits new Game instructions.
     */
    actionAuthority: ActionAuthority,
    role: Role,
    companionName: CompanionName,
    selectedWorld: SafeWorldLabel,
    selectedSave: SafeSaveLabel,
    capabilitySummary: GameCapabilitySummaryV1Schema,
    latestOutcome: Outcome,
  }),
});

// ─── Read commands ──────────────────────────────────────────────────────────

export const GamePrerequisitesReadCommandV1Schema = strictObject({
  apiVersion: ApiVersion,
});

export const GameStateReadCommandV1Schema = strictObject({
  apiVersion: ApiVersion,
});

// Installation discovery is deliberately redacted: paths and executable identity
// never cross the browser boundary.
//
// `location` is the one exception, and it is not a path: the drive and the library
// folder's own name (`D: · SteamLibrary`), which is what tells two installations of
// the same game apart when `label` cannot (every Steam library installs to
// `...\steamapps\common\Stardew Valley`). Optional because reads that predate it are
// still legal v1 replies.
const GameCandidateV1Schema = strictObject({
  candidateId: OpaqueHandle,
  source: Type.String({ minLength: 1, maxLength: 64 }),
  label: Type.String({ minLength: 1, maxLength: 256 }),
  hint: Type.Union([Type.String({ minLength: 1, maxLength: 256 }), Type.Null()]),
  location: Type.Optional(Type.Union([Type.String({ minLength: 1, maxLength: 64 }), Type.Null()])),
  status: Type.Union([Type.Literal("candidate"), Type.Literal("invalid"), Type.Literal("admission_required")]),
  /**
   * Whether this folder already holds a mod loader.
   *
   * `present` means the folder can load the companion Mod, so choosing it registers immediately. `missing` means
   * the game is there and the loader is not - the player installs it, then finds again. Optional so a read from a
   * Host that predates the field stays legal.
   */
  modLoader: Type.Optional(Type.Union([Type.Literal("present"), Type.Literal("missing")])),
});
export const GameDiscoveryReadResultV1Schema = strictObject({
  apiVersion: ApiVersion,
  candidates: Type.Array(GameCandidateV1Schema, { maxItems: 64 }),
  diagnostics: Type.Array(Type.String({ minLength: 1, maxLength: 128 }), { maxItems: 32 }),
});
export const GameDiscoveryConfirmCommandV1Schema = strictObject({ apiVersion: ApiVersion, candidateId: OpaqueHandle });
export const GameDiscoveryActionCommandV1Schema = strictObject({ apiVersion: ApiVersion });

/**
 * What became of the companion Mod, in the launcher's own vocabulary.
 *
 * The same tokens `CompanionGameModDeploymentOutcome` produces
 * (`stardew-game-install/desktop-entry-mod-deployment.ts`) - one bounded lowercase token per outcome, and the browser
 * mirror (`dialogue-web/src/composed-reference-game-browser-api.ts`, `COMPANION_MOD_OUTCOMES`) validates membership
 * before it renders a sentence. Spelled here because this is the copy that crosses the browser boundary, and the three
 * copies are held to one list by `tools/lib/contract-mirror-keys.test.mjs`: a token added on one side alone makes
 * every registration reply unreadable on the surface, which is indistinguishable from no reply at all.
 */
const CompanionModOutcome = Type.Union([
  Type.Literal("companion-mod-current"),
  Type.Literal("companion-mod-installed"),
  Type.Literal("companion-mod-updated"),
  Type.Literal("companion-mod-game-not-found"),
  Type.Literal("companion-mod-choice-required"),
  Type.Literal("companion-mod-unavailable"),
  Type.Literal("companion-mod-game-installation-not-found"),
  Type.Literal("companion-mod-smapi-not-installed"),
  Type.Literal("companion-mod-mods-directory-missing"),
  Type.Literal("companion-mod-mods-directory-not-writable"),
  Type.Literal("companion-mod-existing-mod-version-requires-consent"),
  Type.Literal("companion-mod-foreign-mod-present"),
  Type.Literal("companion-mod-installed-mod-manifest-unreadable"),
  Type.Literal("companion-mod-package-invalid"),
  Type.Literal("companion-mod-deployment-incomplete"),
]);

/**
 * Redacted outcomes for installation-discovery mutations.
 *
 * `mod_loader_missing` is the one refusal the player can act on: the chosen folder
 * holds Stardew Valley and no mod loader, so the Companion Mod can never load in
 * it. It is a distinct outcome because the search itself succeeded - reporting it
 * as `unavailable` read to the player as a failed search.
 *
 * `not_stardew_installation` is the other: the chosen folder holds no Stardew Valley
 * executable at all, so registering it can only fail later. It is distinct for the same
 * reason - `unavailable` says nothing about the folder the player just picked.
 *
 * `reparse_point` is the third: the chosen folder's path reaches the game through a
 * shortcut, a junction or a virtual folder, so the installation it names is not the one
 * the player will launch. It is distinct because the fix is one the player performs -
 * pick the game's real installation folder.
 *
 * `expired` is the fourth, and it is the one that says nothing about the folder: the
 * candidate the press named is no longer an offer this Host will take, because a
 * registration already spent it, because a later scan replaced the list it came from, or
 * because the five minutes its scan issued it for ran out. It is distinct because the
 * player's step is a fresh search rather than a different folder - and because reporting
 * it as `unavailable` told a player whose folder was found and registered-fresh that the
 * folder itself could not be used.
 */
export const GameDiscoveryMutationResultV1Schema = Type.Union([
  strictObject({ apiVersion: ApiVersion, status: Type.Literal("accepted") }),
  strictObject({
    apiVersion: ApiVersion,
    status: Type.Literal("registered"),
    /**
     * What happened to the companion Mod in the folder that was just registered.
     *
     * Registering is the first moment the folder provably holds a mod loader, so it is also the first moment our Mod
     * can go where the game will load it - and the last step of registering is that deployment. Reported rather than
     * assumed, so a deployment that refused names its refusal instead of the panel implying the companion is ready
     * while `Mods/GameBuddy` is absent. Optional so a reply from a Host that predates the field stays legal; an absent
     * field is the only reading that means "the Host did not say", and it is never a claim that the Mod is there.
     */
    companionMod: Type.Optional(CompanionModOutcome),
  }),
  strictObject({ apiVersion: ApiVersion, status: Type.Literal("cancelled") }),
  strictObject({ apiVersion: ApiVersion, status: Type.Literal("unavailable") }),
  strictObject({ apiVersion: ApiVersion, status: Type.Literal("expired") }),
  strictObject({ apiVersion: ApiVersion, status: Type.Literal("mod_loader_missing") }),
  strictObject({ apiVersion: ApiVersion, status: Type.Literal("not_stardew_installation") }),
  strictObject({ apiVersion: ApiVersion, status: Type.Literal("reparse_point") }),
]);
export type GameDiscoveryMutationResultV1 = Static<typeof GameDiscoveryMutationResultV1Schema>;

/**
 * How many choices one cabin prompt may offer.
 *
 * Stated here, beside the schema that publishes it, because the client that validates the broker's
 * answer (`composed-reference-game-browser-client.ts`) has to stop at the same number: two copies of
 * `64` agree only until one of them moves.
 */
export const STARDEW_CABIN_CHOICES_MAX = 64;

export const StardewCabinChoicesV1Schema = strictObject({
  apiVersion: ApiVersion,
  choices: Type.Array(
    strictObject({
      displayLabel: Type.String({ minLength: 1, maxLength: 128 }),
      availability: Type.Literal("available"),
      choiceHandle: Type.String({ minLength: 43, maxLength: 43, format: "game-browser-canonical-base64url-v1" }),
      expiresAtMs: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
    }),
    { maxItems: STARDEW_CABIN_CHOICES_MAX },
  ),
});

/**
 * Every way the Mod's own document can fail to decide whether this save holds her.
 *
 * The vocabulary is the wire's, and the Host's probe derives its union from this one
 * (`StardewCabinOccupancyUnknownReason` in `stardew-attachment.ts`): a reason the browser can receive
 * without the probe being able to produce it, or the reverse, would be two vocabularies for one fact.
 * Each member names the LAYER that failed, because "the game did not say" is not a fact a player can act
 * on and "the advertisement stopped three beats ago" is.
 */
export const StardewCabinOccupancyUnknownReasonV1 = Type.Union([
  Type.Literal("session_document_missing"),
  Type.Literal("session_document_unreadable"),
  Type.Literal("session_document_unauthenticated"),
  Type.Literal("session_document_stale"),
  Type.Literal("session_document_clock_ahead"),
  Type.Literal("session_document_other_world"),
  Type.Literal("session_host_not_ready"),
  Type.Literal("session_protocol_mismatch"),
  Type.Literal("manifest_farmhand_unavailable"),
]);
export type StardewCabinOccupancyUnknownReasonV1 = Static<typeof StardewCabinOccupancyUnknownReasonV1>;

/**
 * What the press that asks "does this save hold her" did with the answer it read.
 *
 * `not_licensed` is every answer that licenses nothing: she is in the save (the handoff is over), or the
 * document could not decide (the quarantine stays). The four refusal members are the release's own
 * assertions, one name each, so a press that kept the quarantine says WHICH fact it could not establish
 * instead of reporting a generic failure.
 */
export const StardewCabinQuarantineReleaseV1 = Type.Union([
  Type.Literal("released"),
  Type.Literal("not_licensed"),
  Type.Literal("record_is_not_the_quarantined_attempt"),
  Type.Literal("registration_names_another_attempt"),
  Type.Literal("guardian_objects_not_proven_dead"),
  Type.Literal("evidence_not_fresh_for_this_world"),
]);
export type StardewCabinQuarantineReleaseV1 = Static<typeof StardewCabinQuarantineReleaseV1>;

/**
 * The cabin-quarantine press's answer: the Mod's three answers, with their reason, their cabin, and the
 * two clocks that make the answer evidence instead of a memory.
 *
 * `publishedAtUnixMs` is null exactly when no AUTHENTICATED document answered - an absent, unreadable or
 * forged one carries a stamp nobody can attribute, and publishing it would make the freshness claim
 * unfalsifiable. The world and farmhand the answer is about are deliberately absent: they are the
 * attempt's own identity, they travel nowhere, and the release re-derives them on the Host.
 */
export const StardewCabinOccupancyAnswerV1Schema = strictObject({
  apiVersion: ApiVersion,
  occupancy: strictObject({
    answer: Type.Union([Type.Literal("not_bound"), Type.Literal("already_bound"), Type.Literal("unknown")]),
    reason: Type.Union([StardewCabinOccupancyUnknownReasonV1, Type.Null()]),
    cabinId: Type.Union([Type.String({ minLength: 1, maxLength: 128 }), Type.Null()]),
    boundBy: Type.Union([Type.Literal("companion"), Type.Literal("manifest_farmhand"), Type.Null()]),
    publishedAtUnixMs: Type.Union([Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }), Type.Null()]),
    observedAtUnixMs: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
  }),
  release: StardewCabinQuarantineReleaseV1,
});

// ─── Mutation commands ──────────────────────────────────────────────────────

export const GamePrerequisitesSetupCommandV1Schema = strictObject({
  apiVersion: ApiVersion,
  idempotencyKey: IdempotencyKey,
});

export const GameLaunchCommandV1Schema = strictObject({
  apiVersion: ApiVersion,
  idempotencyKey: IdempotencyKey,
  expectedInstanceGeneration: PositiveGeneration,
});

export const GameAttachCommandV1Schema = strictObject({
  apiVersion: ApiVersion,
  idempotencyKey: IdempotencyKey,
  expectedAttachmentGeneration: PositiveGeneration,
});

export const GameStopCommandV1Schema = strictObject({
  apiVersion: ApiVersion,
  idempotencyKey: IdempotencyKey,
  expectedAttachmentGeneration: PositiveGeneration,
});

/**
 * `game.resume` names the durable Game session it reconnects. Resume is the one
 * command whose subject is a previously ended activation rather than the live
 * one, so it is the one command that must carry the session's opaque handle: the
 * coordinator resolves it through the store's registered world binding and fails
 * closed on any handle it cannot read. It is an interpretive identity, never a
 * proof and never a launch fact (no path, process, pipe, token or native frame).
 *
 * The key is optional because a resume that names nothing has a real typed
 * answer - `unavailable`, with no activation created - and that is what a
 * session-less command keeps getting. A named handle that resolves to no
 * resumable world is a refusal the coordinator reports by name, so a player is
 * told which session could not be resumed instead of "try again later".
 */
export const GameResumeCommandV1Schema = strictObject({
  apiVersion: ApiVersion,
  idempotencyKey: IdempotencyKey,
  expectedAttachmentGeneration: PositiveGeneration,
  gameSessionId: Type.Optional(SAFE_ID),
});

/**
 * Minimal strict `game.create` command (boundary card D1). It carries only
 * the selected published integration and the player's explicit continuity
 * binding choice (null = default, no binding). It never carries an expected
 * attachment generation, a gameSessionId (the store mints it), or any
 * bootstrap/native/launch fact. The coordinator mints the store-level
 * creation request identity in its own idempotency slot.
 */
export const GameCreateCommandV1Schema = strictObject({
  apiVersion: ApiVersion,
  idempotencyKey: IdempotencyKey,
  integrationId: SAFE_ID,
  continuityIdentityId: Type.Union([SAFE_ID, Type.Null()]),
});

/**
 * Redacted outcome of an admitted `game.create` (boundary card D1).
 * `accepted` means the binding/observation is still in progress, `attached`
 * means the world binding and the first activation completed, `unavailable`
 * means the create failed without any resumable half-record. The opaque
 * `gameSessionId` is only an interpretive projection: every later use must be
 * re-verified through the store. The status binds the handle exactly:
 * `accepted`/`attached` always carry the store-minted `gameSessionId` (never
 * null) and `unavailable` always carries null (never an id). It never carries
 * session internals, launch, path, process, token, generation-proof, lease,
 * digest, receipt, or attestation facts.
 */
export const GameCreateResultV1Schema = Type.Union([
  strictObject({
    apiVersion: ApiVersion,
    status: Type.Union([Type.Literal("accepted"), Type.Literal("attached")]),
    gameSessionId: SAFE_ID,
  }),
  strictObject({
    apiVersion: ApiVersion,
    status: Type.Literal("unavailable"),
    gameSessionId: Type.Null(),
  }),
]);

/**
 * Independent `game.resume.cancel` command (boundary card D3). It is never
 * folded into create and never reuses game.disconnect/game.stop (both require
 * a live attachment); it pins the exact in-flight reconnect attempt via the
 * armed attachment generation, mirroring the resume tuple discipline.
 */
export const GameResumeCancelCommandV1Schema = strictObject({
  apiVersion: ApiVersion,
  idempotencyKey: IdempotencyKey,
  expectedAttachmentGeneration: PositiveGeneration,
});

/**
 * Single-value cancelled outcome (single-literal precedent: game.reopen
 * `reopened`). The Player world and the durable session state are untouched;
 * the session stays resumable.
 */
export const GameResumeCancelResultV1Schema = strictObject({
  apiVersion: ApiVersion,
  status: Type.Literal("cancelled"),
});

/**
 * Redacted outcome of an admitted `game.resume`. The strict status vocabulary
 * distinguishes an attempt that is admitted and still in progress from one
 * that established a completed attachment and from an outcome that is
 * unavailable. It never carries session, launch, path, process, token,
 * generation-proof, lease, digest, receipt, or attestation facts.
 */
export const GameResumeResultV1Schema = strictObject({
  apiVersion: ApiVersion,
  status: Type.Union([Type.Literal("accepted"), Type.Literal("attached"), Type.Literal("unavailable")]),
});

export const GameReopenActionAuthorityCommandV1Schema = strictObject({
  apiVersion: ApiVersion,
  idempotencyKey: IdempotencyKey,
  expectedAttachmentGeneration: PositiveGeneration,
});

/**
 * Redacted outcome of an admitted `game.reopen`. The strict single-value
 * vocabulary reports that the paused action authority was reopened to active
 * by this fresh explicit Game instruction. It never carries session, launch,
 * path, process, token, generation-proof, lease, digest, receipt, or
 * attestation facts.
 */
export const GameReopenActionAuthorityResultV1Schema = strictObject({
  apiVersion: ApiVersion,
  status: Type.Literal("reopened"),
});

export const GameDisconnectCommandV1Schema = strictObject({
  apiVersion: ApiVersion,
  idempotencyKey: IdempotencyKey,
  expectedAttachmentGeneration: PositiveGeneration,
});

/**
 * Explicit endgame command. This is the only operation that may terminate the
 * Player; ordinary close, AI crash, controller EOF and reconnect failure must
 * never produce it (see the Game session survival task). It is deliberately a
 * separate authenticated operation instead of a flag on `game.stop`, because
 * `game.stop` only stops AI authority and leaves the Player world running.
 */
export const GameEndgameCommandV1Schema = strictObject({
  apiVersion: ApiVersion,
  idempotencyKey: IdempotencyKey,
  expectedAttachmentGeneration: PositiveGeneration,
  confirm: Type.Literal(true),
});

/**
 * Redacted endgame outcome. `gameended` is projected only from authoritative
 * game state, i.e. after the exact attempt was actually terminated. It never
 * carries session, launch, path, process, token, generation-proof, lease,
 * digest, receipt, or attestation facts.
 */
export const GameEndgameResultV1Schema = strictObject({
  apiVersion: ApiVersion,
  status: Type.Union([Type.Literal("gameended"), Type.Literal("unavailable")]),
});

export const StardewCabinConfirmCommandV1Schema = strictObject({
  apiVersion: ApiVersion,
  idempotencyKey: IdempotencyKey,
  choiceHandle: Type.String({ minLength: 43, maxLength: 43, format: "game-browser-canonical-base64url-v1" }),
  confirmed: Type.Literal(true),
});

export const StardewCabinConfirmResultV1Schema = strictObject({
  apiVersion: ApiVersion,
  status: Type.Literal("manifest_admitted"),
});

// ─── The player's own Stardew settings ─────────────────────────────────────

/**
 * One action family the player may switch off.
 *
 * The catalogue is the Mod's own: `DeniedActionFamilies` is validated against
 * `FarmhandActionCatalog` and the Mod refuses the WHOLE policy when one entry names
 * a family it does not declare, so this route can only ever offer ids from that
 * catalogue (`host/src/games/stardew/stardew-action-families.ts` derives it from
 * the Mod source, and `stardew-action-families.private.test.ts` holds the two equal).
 *
 * No count of the actions inside a family is published: the only source for one is
 * the Mod's live catalog, which is absent exactly when the player is most likely to
 * be editing settings (no world running), and a number that silently read 0 then
 * would be a lie about the family rather than a fact about the session.
 */
const StardewActionFamilyV1Schema = strictObject({
  familyId: SAFE_ID,
  denied: Type.Boolean(),
});

/**
 * The player-owned Stardew settings projection.
 *
 * `revision` is the durable record's compare-and-swap token: every write sends the
 * revision it read, and a write that arrives after someone else's is refused with
 * `stardew_settings_revision_conflict` rather than overwriting it.
 *
 * `appliesToRunningGame` is the honest per-field answer to "did that just change
 * anything?", and it is the reason the surface can promise anything at all:
 *  - the action policy is pushed to a RUNNING Mod as a `farmhand_action_policy_request`
 *    frame on the authenticated bridge, and the Mod replays its capability as a
 *    `catalog_update`, so a change reaches a running game within a turn of the pipe
 *    rather than on a timer;
 *  - the co-op night floor is read once at embodiment initialisation
 *    (`ConfigureLifecycleMinimumFarmers`), so a change takes effect the next time the
 *    world loads and its own sentence says so.
 */
/**
 * The four behaviours `WindowModeManagement` implements; anything else is not a mode this product can ask for.
 *
 * Module-private, like `GameCandidateV1Schema` and `StardewActionFamilyV1Schema`: it is one field's vocabulary inside
 * `StardewPlayerSettingsV1Schema`, not a frame of its own, and the versioned boundary below is exactly the exported
 * schemas - so exporting this one would publish a frame no route answers.
 */
const StardewWindowModeV1Schema = Type.Union([
  Type.Literal("visible"),
  Type.Literal("minimized"),
  Type.Literal("hidden"),
  Type.Literal("background"),
]);

export const StardewPlayerSettingsV1Schema = strictObject({
  apiVersion: ApiVersion,
  revision: NonNegativeGeneration,
  families: Type.Array(StardewActionFamilyV1Schema, { maxItems: 64 }),
  advanceDayMinimumOnlineFarmers: Type.Integer({ minimum: 1, maximum: 4 }),
  /**
   * Where the answer really takes effect. `next_world_load` is the co-op floor's own
   * fact, never a hedge: the Mod reads that field once, and a control that said
   * "saved" without saying that would be promising a live change it cannot make.
   */
  /**
   * How the game window behaves while the companion plays. Absent when the player never chose: the Mod's own `visible` then
   * applies, exactly as an absent language leaves the live-game locale in charge.
   */
  windowMode: Type.Optional(StardewWindowModeV1Schema),
  /** Individual action ids withheld on top of the families. Absent means none. */
  deniedActions: Type.Optional(Type.Array(SAFE_ID, { maxItems: 512 })),
  appliesToRunningGame: strictObject({
    actionPolicy: Type.Literal("within_seconds"),
    advanceDayMinimumOnlineFarmers: Type.Literal("next_world_load"),
    /** The window mode is read by the Mod on each tick, so this one really is immediate. */
    windowMode: Type.Literal("within_seconds"),
    /** Per-action denials ride the same policy document the families do. */
    deniedActions: Type.Literal("within_seconds"),
  }),
});

/**
 * One settings save. It replaces both player-owned values together, because the
 * surface edits them together; every field is required, so no write depends on what
 * a previous write happened to leave behind.
 */
export const StardewPlayerSettingsCommandV1Schema = strictObject({
  apiVersion: ApiVersion,
  expectedRevision: NonNegativeGeneration,
  deniedActionFamilies: Type.Array(SAFE_ID, { maxItems: 64 }),
  advanceDayMinimumOnlineFarmers: Type.Integer({ minimum: 1, maximum: 4 }),
  /**
   * Absent leaves whatever the record holds - a client that does not know the field cannot clear it - and naming it sets it.
   * There is no "clear" verb here on purpose: `visible` is the Mod's own default and the honest way to say "no preference".
   */
  windowMode: Type.Optional(StardewWindowModeV1Schema),
  deniedActions: Type.Optional(Type.Array(SAFE_ID, { maxItems: 512 })),
});

export const StardewPlayerSettingsReadCommandV1Schema = strictObject({
  apiVersion: ApiVersion,
});

// ─── Problem schema ─────────────────────────────────────────────────────────

export const GameProblemV1Schema = strictObject({
  type: Type.String({ minLength: 1, maxLength: 256 }),
  title: Type.String({ minLength: 1, maxLength: 256 }),
  status: Type.Integer({ minimum: 400, maximum: 599 }),
  code: GameProblemCode,
  requestId: OpaqueHandle,
  retryable: Type.Boolean(),
});

// ─── Profile composition ────────────────────────────────────────────────────

/**
 * The `game_browser_api/v1` operation vocabulary. A member is *produced* when a
 * shipped (non-test) Host source names it - the composed route's mount checks and
 * the Stardew profile's own capability list are those producers - and an entry no
 * shipped source names carries a reservation marker, so a declared operation is
 * never silent about having no route. `contract-producer-gate` enumerates this
 * array, so an operation added here is checked without touching the gate.
 */
export const GAME_BROWSER_OPERATION_IDS_V1 = Object.freeze([
  /** Reserved: no route serves it; the composed state read publishes the prerequisites projection. */
  "game.prerequisites.read",
  "game.prerequisites.setup",
  "game.state.read",
  "game.launch",
  /** Reserved: no route serves it; the Stardew profile does not list it in its operationIds. */
  "game.attach",
  "game.stop",
  "game.resume",
  "game.resume.cancel",
  "game.reopen",
  "game.disconnect",
  "game.create",
  "game.endgame",
  "game.installation.discovery.read",
  "game.installation.discovery.confirm",
  "game.installation.discovery.retry",
  "game.installation.discovery.cancel",
  "game.installation.discovery.manual_picker",
  "game.stardew.cabins.read",
  "game.stardew.cabins.confirm",
  "game.stardew.cabins.occupancy",
  /**
   * The player's own mod settings. Declared as the pair it is: one read the settings
   * surface mounts on, and one revision-checked save. Nothing else about the Mod's
   * config is reachable - the fixture fields, the bridge credentials and the
   * operator's provisioning block are not this surface's to show.
   */
  "game.stardew.settings.read",
  "game.stardew.settings.update",
] as const);

/**
 * The `game_browser_api/v1` reservation ledger: every declared operation no shipped
 * source can produce, with the shipped source that serves the shell in its place
 * (`servedBy`), the declared-and-produced member that answers the request instead
 * (`instead`), and why the reservation is deliberate (`reason`).
 *
 * It is exported from the contract rather than kept in the gate because
 * `contract-producer-gate` consumes this ledger: a gate that can be satisfied by
 * editing the gate is the same self-certification the ledger exists to stop. The
 * guarantee it buys is the one the tavern ledger states - a shipped source NAMES the
 * member, which is not proof that a live request is answered end to end.
 */
export type GameBrowserContractReservationV1 = Readonly<{
  readonly kind: "game-operation";
  readonly member: string;
  readonly servedBy: string;
  readonly instead: string;
  readonly reason: string;
}>;

export const GAME_BROWSER_CONTRACT_RESERVATIONS_V1: readonly GameBrowserContractReservationV1[] = Object.freeze([
  Object.freeze({
    kind: "game-operation",
    member: "game.prerequisites.read",
    servedBy: "host/src/composed-reference-game-browser.ts",
    instead: "game.state.read",
    reason:
      "by design: the composed state read already publishes the prerequisites projection, so no separate prerequisites operation is planned",
  }),
  Object.freeze({
    kind: "game-operation",
    member: "game.attach",
    servedBy: "host/src/composed-reference-game-browser.ts",
    instead: "game.state.read",
    reason:
      "no route serves it; the Stardew profile does not list it in its operationIds, and the composed state read publishes the attachment slot",
  }),
]);

const contractDeclaredOperationIds = new Set<string>(GAME_BROWSER_OPERATION_IDS_V1);
const contractDeclaredNavigationItemIds = new Set<string>(["game"]);

type GameBrowserNavigationItemIdV1 = "game";
type GameReleaseTierV1 = "game_preview";

export type ComposedGameProfile = Readonly<{
  readonly profileId: string;
  readonly releaseTier: GameReleaseTierV1;
  readonly operationIds: readonly GameOperationId[];
  readonly navigationItemIds: readonly GameBrowserNavigationItemIdV1[];
}>;

/**
 * Module-private identity registry: only the frozen capability slice minted and
 * returned by `composeGameProfile` is branded here. A structural clone of a
 * composed profile (including an `Object.freeze` spread copy) is not a composed
 * capability slice and must fail before any durable I/O.
 */
const composedGameProfiles = new WeakSet<object>();

export function composeGameProfile(input: unknown): ComposedGameProfile {
  if (
    typeof input !== "object" ||
    input === null ||
    Array.isArray(input) ||
    Object.getPrototypeOf(input) !== Object.prototype
  )
    throw new TypeError("Game profile must be a plain object");
  const value = input as Record<string, unknown>;
  const expectedKeys = ["profileId", "releaseTier", "operationIds", "navigationItemIds"] as const;
  const keys = Reflect.ownKeys(value);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (
    keys.length !== expectedKeys.length ||
    !expectedKeys.every((key) => {
      const descriptor = descriptors[key];
      return (
        keys.includes(key) &&
        descriptor !== undefined &&
        descriptor.enumerable === true &&
        descriptor.configurable === true &&
        descriptor.writable === true &&
        "value" in descriptor
      );
    })
  )
    throw new TypeError("Game profile input is not a capability slice");
  if (typeof value.profileId !== "string" || !/^[a-z][a-z0-9._-]{0,127}$/.test(value.profileId))
    throw new TypeError("Game profile id is invalid");
  if (value.releaseTier !== "game_preview") throw new TypeError("Game release tier is invalid");
  if (!Array.isArray(value.operationIds) || value.operationIds.length > 100)
    throw new TypeError("Game operations are invalid");
  if (!Array.isArray(value.navigationItemIds) || value.navigationItemIds.length > 100)
    throw new TypeError("Game navigation items are invalid");
  const seenOperationIds = new Set<string>();
  for (const operationId of value.operationIds) {
    if (typeof operationId !== "string" || !contractDeclaredOperationIds.has(operationId))
      throw new TypeError("Game operation is not declared by the contract");
    if (seenOperationIds.has(operationId)) throw new TypeError("Game operation is duplicated");
    seenOperationIds.add(operationId);
  }
  const seenNavigationItemIds = new Set<string>();
  for (const navigationItemId of value.navigationItemIds) {
    if (typeof navigationItemId !== "string" || !contractDeclaredNavigationItemIds.has(navigationItemId))
      throw new TypeError("Game navigation item is not declared by the contract");
    if (seenNavigationItemIds.has(navigationItemId)) throw new TypeError("Game navigation item is duplicated");
    seenNavigationItemIds.add(navigationItemId);
  }
  const profile = Object.freeze({
    profileId: value.profileId,
    releaseTier: value.releaseTier,
    operationIds: Object.freeze([...value.operationIds] as GameOperationId[]),
    navigationItemIds: Object.freeze([...value.navigationItemIds] as GameBrowserNavigationItemIdV1[]),
  });
  composedGameProfiles.add(profile);
  return profile;
}

/**
 * Identity-brand type guard: true only for the exact frozen object returned by
 * `composeGameProfile` (plus actual operation membership checks that the
 * binding service performs separately). Structural clones are never branded.
 */
export function isComposedGameProfile(value: unknown): value is ComposedGameProfile {
  return typeof value === "object" && value !== null && composedGameProfiles.has(value);
}

// ─── Contract ───────────────────────────────────────────────────────────────

/**
 * The `game_browser_api/v1` aggregate: every frame this version puts on the wire, one entry per schema.
 *
 * THIS OBJECT IS MEMBERSHIP'S ONLY DECLARATION, and the module's export surface is the population it must cover:
 * every schema this module exports is a frame here, and every frame here is a schema this module exports. Both
 * halves are the same rule, and `index.private.test.ts` reads them off the two surfaces - `Object.keys` of this
 * object and the exported values TypeBox brands with `~kind` - so a frame added to one and not the other fails there
 * naming it. Keeping a schema private is therefore a statement, not an omission: it says this shape is a field of
 * some frame rather than a frame (`GameCandidateV1Schema`, `StardewActionFamilyV1Schema`,
 * `StardewWindowModeV1Schema`). It used to be an omission: the test carried a hand-kept list of these names beside
 * the object, and `GameEventStreamV1Schema`, `GameFactPatchV1Schema` and `GameEventV1Schema` were served here before
 * `50f1a593` named them in that list by hand.
 */
export const GameBrowserContractV1 = Object.freeze({
  id: GAME_BROWSER_API_V1,
  schemas: Object.freeze({
    GameBrowserStateV1Schema,
    GamePrerequisiteStateV1Schema,
    GameInstanceV1Schema,
    GameCompatibilityV1Schema,
    GameAttachmentStateV1Schema,
    GameCapabilitySummaryV1Schema,
    GameEventStreamV1Schema,
    GameFactPatchV1Schema,
    GameEventV1Schema,
    GamePrerequisitesReadCommandV1Schema,
    GamePrerequisitesSetupCommandV1Schema,
    GameStateReadCommandV1Schema,
    GameLaunchCommandV1Schema,
    GameAttachCommandV1Schema,
    GameStopCommandV1Schema,
    GameResumeCommandV1Schema,
    GameResumeResultV1Schema,
    GameCreateCommandV1Schema,
    GameCreateResultV1Schema,
    GameResumeCancelCommandV1Schema,
    GameResumeCancelResultV1Schema,
    GameDisconnectCommandV1Schema,
    GameEndgameCommandV1Schema,
    GameEndgameResultV1Schema,
    GameReopenActionAuthorityCommandV1Schema,
    GameReopenActionAuthorityResultV1Schema,
    GameDiscoveryReadResultV1Schema,
    GameDiscoveryConfirmCommandV1Schema,
    GameDiscoveryActionCommandV1Schema,
    GameDiscoveryMutationResultV1Schema,
    StardewCabinChoicesV1Schema,
    StardewCabinConfirmCommandV1Schema,
    StardewCabinConfirmResultV1Schema,
    StardewCabinOccupancyAnswerV1Schema,
    StardewPlayerSettingsV1Schema,
    StardewPlayerSettingsReadCommandV1Schema,
    StardewPlayerSettingsCommandV1Schema,
    GameProblemV1Schema,
  }),
});

export const GameBrowserValidatorsV1: Readonly<Record<keyof typeof GameBrowserContractV1.schemas, Validator>> =
  Object.freeze(
    Object.fromEntries(
      Object.entries(GameBrowserContractV1.schemas).map(([name, schema]) => [name, Compile(schema)]),
    ) as Record<keyof typeof GameBrowserContractV1.schemas, Validator>,
  );

// ─── Types ──────────────────────────────────────────────────────────────────

export type GameOperationId = (typeof GAME_BROWSER_OPERATION_IDS_V1)[number];
export type GameDiscoveryReadResultV1 = Static<typeof GameDiscoveryReadResultV1Schema>;
export type GameDiscoveryConfirmCommandV1 = Static<typeof GameDiscoveryConfirmCommandV1Schema>;
export type GameBrowserStateV1 = Static<typeof GameBrowserStateV1Schema>;
export type GameEventStreamV1 = Static<typeof GameEventStreamV1Schema>;
export type GameFactPatchV1 = Static<typeof GameFactPatchV1Schema>;
export type GameEventV1 = Static<typeof GameEventV1Schema>;
export type GamePrerequisitesSetupCommandV1 = Static<typeof GamePrerequisitesSetupCommandV1Schema>;
export type GameLaunchCommandV1 = Static<typeof GameLaunchCommandV1Schema>;
export type GameStopCommandV1 = Static<typeof GameStopCommandV1Schema>;
export type GameResumeCommandV1 = Static<typeof GameResumeCommandV1Schema>;
export type GameCreateCommandV1 = Static<typeof GameCreateCommandV1Schema>;
export type GameCreateResultV1 = Static<typeof GameCreateResultV1Schema>;
export type GameResumeCancelCommandV1 = Static<typeof GameResumeCancelCommandV1Schema>;
export type GameResumeCancelResultV1 = Static<typeof GameResumeCancelResultV1Schema>;

export type GameResumeResultV1 = Static<typeof GameResumeResultV1Schema>;
export type GameReopenActionAuthorityCommandV1 = Static<typeof GameReopenActionAuthorityCommandV1Schema>;
export type GameReopenActionAuthorityResultV1 = Static<typeof GameReopenActionAuthorityResultV1Schema>;
export type GameDisconnectCommandV1 = Static<typeof GameDisconnectCommandV1Schema>;
export type GameEndgameCommandV1 = Static<typeof GameEndgameCommandV1Schema>;
export type GameEndgameResultV1 = Static<typeof GameEndgameResultV1Schema>;
export type StardewCabinChoicesV1 = Static<typeof StardewCabinChoicesV1Schema>;
export type StardewCabinOccupancyAnswerV1 = Static<typeof StardewCabinOccupancyAnswerV1Schema>;
export type StardewCabinConfirmCommandV1 = Static<typeof StardewCabinConfirmCommandV1Schema>;
export type StardewCabinConfirmResultV1 = Static<typeof StardewCabinConfirmResultV1Schema>;
export type StardewPlayerSettingsV1 = Static<typeof StardewPlayerSettingsV1Schema>;
export type StardewPlayerSettingsReadCommandV1 = Static<typeof StardewPlayerSettingsReadCommandV1Schema>;
export type StardewPlayerSettingsCommandV1 = Static<typeof StardewPlayerSettingsCommandV1Schema>;

// ─── Fixtures ───────────────────────────────────────────────────────────────

const fixtureHandle = "QWxhZGRpbjpvcGVuIHNlc2FtZQ";

export const GameBrowserFixtureV1 = Object.freeze({
  state: (): GameBrowserStateV1 =>
    Object.freeze({
      apiVersion: 1 as const,
      build: { browserContract: GAME_BROWSER_API_V1, profileId: "gamebuddy.game.preview" },
      csrfToken: fixtureHandle,
      browserSession: { expiresAtMs: 100_000 },
      game: {
        prerequisites: { status: "met" as const, detectedGame: "Stardew Valley" },
        instance: { status: "none" as const, gameTitle: null, generation: 0 },
        compatibility: { status: "compatible" as const, message: null },
        attachment: { status: "none" as const, generation: 0 },
        connectionStatus: "none" as const,
        actionAuthority: "unavailable" as const,
        role: null,
        companionName: null,
        selectedWorld: null,
        selectedSave: null,
        capabilitySummary: { status: "not_measured" as const, reason: "no_attached_runtime" },
        latestOutcome: "none" as const,
      },
    }),
  connectedState: (): GameBrowserStateV1 =>
    Object.freeze({
      apiVersion: 1 as const,
      build: { browserContract: GAME_BROWSER_API_V1, profileId: "gamebuddy.game.preview" },
      csrfToken: fixtureHandle,
      browserSession: { expiresAtMs: 100_000 },
      game: {
        prerequisites: { status: "met" as const, detectedGame: "Stardew Valley" },
        instance: { status: "running" as const, gameTitle: "Stardew Valley", generation: 3 },
        compatibility: { status: "compatible" as const, message: null },
        attachment: { status: "attached" as const, generation: 3 },
        connectionStatus: "connected_idle" as const,
        actionAuthority: "active" as const,
        role: "player" as const,
        companionName: "Farmhand",
        selectedWorld: "Pelican Town",
        selectedSave: "Spring Year 2",
        capabilitySummary: { status: "published" as const, count: 3 },
        latestOutcome: "succeeded" as const,
      },
    }),
});
