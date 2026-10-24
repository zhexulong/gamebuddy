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

export const GAME_BROWSER_PROBLEM_CODES_V1 = Object.freeze([
  "unauthorized",
  "csrf_failed",
  "invalid_request",
  "unsupported_api_version",
  "profile_operation_unavailable",
  "idempotency_conflict",
  "idempotency_in_progress",
  "idempotency_expired",
  "game_unavailable",
  "game_prerequisites_missing",
  "game_compatibility_error",
  "game_instance_not_found",
  "game_attachment_conflict",
  "game_operation_in_progress",
  "stardew_cabin_choice_stale",
  "stardew_manifest_handoff_uncertain",
  "game_runtime_unavailable",
  "game_storage_unavailable",
  // The composed reference-game shell's own route and transport refusals. They are
  // produced by `composed-reference-game-browser.ts` for its bootstrap, state,
  // lifecycle and game routes, so they belong to this surface's vocabulary rather
  // than to a client-side allowlist. The client already reads `not_found` as an
  // absent route and `state_unavailable` (and any 5xx) as retryable.
  "closed",
  "malformed_request",
  "not_found",
  "state_unavailable",
  "game_endgame_settlement_unavailable",
  // The player's own Stardew settings: the record they edited moved under them. It is a
  // refusal, not a fault - nothing was written, and the fresh record is the thing to act on.
  "stardew_settings_revision_conflict",
] as const);

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
  Type.Literal("game_compatibility_error"),
  Type.Literal("game_instance_not_found"),
  Type.Literal("game_attachment_conflict"),
  Type.Literal("game_operation_in_progress"),
  Type.Literal("stardew_cabin_choice_stale"),
  Type.Literal("stardew_manifest_handoff_uncertain"),
  Type.Literal("game_runtime_unavailable"),
  Type.Literal("game_storage_unavailable"),
  // The composed reference-game shell's own route and transport refusals (see
  // `GAME_BROWSER_PROBLEM_CODES_V1`).
  Type.Literal("closed"),
  Type.Literal("malformed_request"),
  Type.Literal("not_found"),
  Type.Literal("state_unavailable"),
  Type.Literal("game_endgame_settlement_unavailable"),
  Type.Literal("stardew_settings_revision_conflict"),
]);

// ─── Redacted read projections ──────────────────────────────────────────────

const PrerequisiteStatus = Type.Union([
  Type.Literal("unknown"),
  Type.Literal("met"),
  Type.Literal("unmet"),
  Type.Literal("checking"),
  Type.Literal("failed"),
]);

const InstanceStatus = Type.Union([
  Type.Literal("none"),
  Type.Literal("detected"),
  Type.Literal("launching"),
  Type.Literal("running"),
  Type.Literal("stopped"),
  Type.Literal("crashed"),
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
  Type.Literal("detaching"),
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
const MissingItemLabel = Type.String({ minLength: 1, maxLength: 256 });
const GameTitleLabel = Type.Union([Type.String({ minLength: 1, maxLength: 256 }), Type.Null()]);

/**
 * The prerequisite projection `game.state.read` publishes.
 *
 * Reserved members: `missingItems` is DECLARED BUT UNPRODUCED, and the
 * `unmet` / `checking` / `failed` statuses are declared with no producer. The one
 * shipped producer (`game-browser/game-browser-state-provider.ts:88-90`) writes
 * only `met` or `unknown` and always an empty `missingItems`, because the Host's
 * own readiness facts are binary - an `registered`/`absent` installation view plus
 * a launch-readiness status - and no shipped reader enumerates individual missing
 * prerequisites. The only per-item prerequisite strings in the tree ride the
 * installation-discovery route (`GET .../installation/discovery`), the sole place
 * they are honestly scoped. Rendering an always-empty list is not a fix;
 * producing entries would first take a reader that enumerates missing
 * prerequisites, which does not exist. The client keeps the full vocabulary
 * (`dialogue-web/src/composed-reference-game-browser-api.ts`), so a future
 * producer needs no contract change.
 */
const GamePrerequisiteStateV1Schema = strictObject({
  status: PrerequisiteStatus,
  detectedGame: DetectedGameLabel,
  missingItems: Type.Array(MissingItemLabel, { maxItems: 50 }),
});

const GameInstanceV1Schema = strictObject({
  status: InstanceStatus,
  gameTitle: GameTitleLabel,
  /** Redacted launch-ready generation: 0 until the coordinator owns/stages the instance. */
  generation: NonNegativeGeneration,
});

const GameCompatibilityV1Schema = strictObject({
  status: CompatibilityStatus,
  message: CompatibilityMessage,
});

const GameAttachmentStateV1Schema = strictObject({
  status: AttachmentStatus,
  generation: NonNegativeGeneration,
});

const GameCapabilitySummaryV1Schema = strictObject({
  available: Type.Boolean(),
  count: Type.Integer({ minimum: 0, maximum: 512 }),
});

export const GameBrowserStateV1Schema = strictObject({
  apiVersion: ApiVersion,
  build: strictObject({
    browserContract: Type.Literal(GAME_BROWSER_API_V1),
    profileId: Type.String({ minLength: 1, maxLength: 128 }),
  }),
  csrfToken: OpaqueHandle,
  browserSession: strictObject({ expiresAtMs: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }) }),
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

const GamePrerequisitesReadCommandV1Schema = strictObject({
  apiVersion: ApiVersion,
});

/**
 * Reserved: no route on the reference shell produces it (see the reservation on
 * its id in `GAME_BROWSER_OPERATION_IDS_V1`).
 *
 * There is no honest body behind it. The lifecycle owns exactly ONE Player Host instance
 * (`stardew-production-lifecycle-coordinator.internal.ts`: "This lifecycle owns one not-yet-launched
 * Player Host instance", with `expectedPlayerHostInstanceGeneration` fixed at 1), and
 * `game.state.read` already publishes that one slot whole: `game.instance`
 * (status/gameTitle/generation), `game.attachment`, `game.connectionStatus`, `game.compatibility`
 * and `game.latestOutcome` (`game-browser/game-browser-state-provider.ts`). A second route
 * re-projecting one slot as a list is shape, not fact.
 *
 * The one multi-row durable list the coordinator does hold - the semantic game authority's
 * `listResumableGameSessions()` - is a list of game SESSIONS (`ProductionGameSessionMetadata`:
 * gameSessionId/integrationId/continuityIdentityId/status/revision), not launched instances, and
 * those raw identity fields are exactly what this contract never exposes. It is also unreachable
 * from here: the presentation admission is handed the redacted `GamePresentationProjection` only
 * (`desktop-host-composition.ts`), never the semantic game authority.
 *
 * To serve it, one of these would have to exist first: (a) a decision that "instances" means the
 * durable game-SESSION history - which needs a renamed/repurposed member, opaque handles minted per
 * row, and a reader threaded from `SemanticGameProductionAuthority` through
 * `GamePresentationProjection` (`integration-catalog.ts`) into the composed route; or (b) a real
 * owned-instance registry, i.e. the lifecycle holding more than one Player Host at a time, which
 * the one-instance invariant deliberately forbids.
 */
const GameInstancesReadCommandV1Schema = strictObject({
  apiVersion: ApiVersion,
});

const GameStateReadCommandV1Schema = strictObject({
  apiVersion: ApiVersion,
});

/**
 * Reserved: the reference shell publishes no route for this read, so no handler produces it.
 *
 * `game.state.read` already publishes every redacted diagnostic it could carry: compatibility
 * (`unchecked|compatible|incompatible|warning`), `connectionStatus`, `instance.status`/`generation`,
 * `latestOutcome`; and the installation-discovery diagnostics ride their own admitted route
 * (`GET .../installation/discovery`), which is the only place those strings are honestly scoped.
 *
 * Exactly one browser-safe diagnostic is unpublished today: the owned AI-client role slot's
 * terminal stop outcome (`stardew-role-lifecycle-facade.ts`, `StardewAiClientSlot.lastStopOutcome`:
 * `none | identity_unverified | termination_failed`). That is a fact about the COMPANION runtime
 * rather than the game instance, and serving it would take, in addition to a result schema here: a
 * `readDiagnostics` reader carried on `GamePresentationProjection` (a second file outside this
 * contract), a mounted route in `composed-reference-game-browser.ts`, a client method in
 * `dialogue-web/src/composed-reference-game-browser-api.ts`, and the disclosure's mount site in
 * `dialogue-web/src/components/ComposedReferenceGameApp.tsx` - the last of which is not this lane's
 * file. Without it the route would be served and rendered by nothing, while its body re-read 90% of
 * what `game.state.read` already answers.
 */
const GameDiagnosticsReadCommandV1Schema = strictObject({
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
});
export const GameDiscoveryReadResultV1Schema = strictObject({
  apiVersion: ApiVersion,
  candidates: Type.Array(GameCandidateV1Schema, { maxItems: 64 }),
  diagnostics: Type.Array(Type.String({ minLength: 1, maxLength: 128 }), { maxItems: 32 }),
});
export const GameDiscoveryConfirmCommandV1Schema = strictObject({ apiVersion: ApiVersion, candidateId: OpaqueHandle });
export const GameDiscoveryActionCommandV1Schema = strictObject({ apiVersion: ApiVersion });

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
 */
export const GameDiscoveryMutationResultV1Schema = Type.Union([
  strictObject({ apiVersion: ApiVersion, status: Type.Literal("accepted") }),
  strictObject({ apiVersion: ApiVersion, status: Type.Literal("registered") }),
  strictObject({ apiVersion: ApiVersion, status: Type.Literal("cancelled") }),
  strictObject({ apiVersion: ApiVersion, status: Type.Literal("unavailable") }),
  strictObject({ apiVersion: ApiVersion, status: Type.Literal("mod_loader_missing") }),
  strictObject({ apiVersion: ApiVersion, status: Type.Literal("not_stardew_installation") }),
]);
export type GameDiscoveryMutationResultV1 = Static<typeof GameDiscoveryMutationResultV1Schema>;

export const StardewCabinChoicesV1Schema = strictObject({
  apiVersion: ApiVersion,
  choices: Type.Array(
    strictObject({
      displayLabel: Type.String({ minLength: 1, maxLength: 128 }),
      availability: Type.Literal("available"),
      choiceHandle: Type.String({ minLength: 43, maxLength: 43, format: "game-browser-canonical-base64url-v1" }),
      expiresAtMs: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
    }),
    { maxItems: 64 },
  ),
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

export const GameResumeCommandV1Schema = strictObject({
  apiVersion: ApiVersion,
  idempotencyKey: IdempotencyKey,
  expectedAttachmentGeneration: PositiveGeneration,
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
 * One action family the player may switch off, with the number of actions it
 * withholds so the choice is legible before it is made.
 *
 * The catalogue is the Mod's own: `DeniedActionFamilies` is validated against
 * `FarmhandActionCatalog` and the Mod refuses the WHOLE policy when one entry names
 * a family it does not declare, so this route can only ever offer ids from that
 * catalogue (`host/src/games/stardew/stardew-action-families.ts` derives it from
 * the Mod source, and `stardew-action-families.test.ts` holds the two equal).
 */
const StardewActionFamilyV1Schema = strictObject({
  familyId: SAFE_ID,
  actionCount: Type.Integer({ minimum: 0, maximum: 512 }),
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
 *  - the action policy is re-read from `config.json` on a 120-tick throttle
 *    (`FarmhandPolicyRefreshThrottle`), so a change reaches a RUNNING game in about
 *    two seconds and this flag is true;
 *  - the co-op night floor is read once at embodiment initialisation
 *    (`ConfigureLifecycleMinimumFarmers`), so a change takes effect the next time the
 *    world loads and its own sentence says so.
 */
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
  appliesToRunningGame: strictObject({
    actionPolicy: Type.Literal("within_seconds"),
    advanceDayMinimumOnlineFarmers: Type.Literal("next_world_load"),
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
});

export const StardewPlayerSettingsReadCommandV1Schema = strictObject({
  apiVersion: ApiVersion,
});

// ─── Problem schema ─────────────────────────────────────────────────────────

const GameProblemV1Schema = strictObject({
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
  /** Reserved: no honest body (one owned instance, already published by `game.state.read`; see the schema comment). */
  "game.instances.read",
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
  /** Reserved: no honest body (state.read already answers it; see the schema comment for the one unpublished fact). */
  "game.diagnostics.read",
  "game.installation.discovery.read",
  "game.installation.discovery.confirm",
  "game.installation.discovery.retry",
  "game.installation.discovery.cancel",
  "game.installation.discovery.manual_picker",
  "game.stardew.cabins.read",
  "game.stardew.cabins.confirm",
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
    member: "game.instances.read",
    servedBy: "host/src/composed-reference-game-browser.ts",
    instead: "game.state.read",
    reason:
      "by design: the lifecycle owns exactly one Player Host instance (`expectedPlayerHostInstanceGeneration` is fixed at 1) and `game.state.read` already publishes that whole slot, so a multi-row instances read has nothing honest to return; multi-instance support is not planned",
  }),
  Object.freeze({
    kind: "game-operation",
    member: "game.attach",
    servedBy: "host/src/composed-reference-game-browser.ts",
    instead: "game.state.read",
    reason:
      "no route serves it; the Stardew profile does not list it in its operationIds, and the composed state read publishes the attachment slot",
  }),
  Object.freeze({
    kind: "game-operation",
    member: "game.diagnostics.read",
    servedBy: "host/src/composed-reference-game-browser.ts",
    instead: "game.state.read",
    reason:
      "by design: `game.state.read` already publishes the whole slot (compatibility, connectionStatus, instance status/generation, latestOutcome) and the lifecycle owns exactly one Player Host instance (`expectedPlayerHostInstanceGeneration` fixed at 1), so neither a second diagnostics read nor multi-instance support is planned",
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

export const GameBrowserContractV1 = Object.freeze({
  id: GAME_BROWSER_API_V1,
  schemas: Object.freeze({
    GameBrowserStateV1Schema,
    GamePrerequisiteStateV1Schema,
    GameInstanceV1Schema,
    GameCompatibilityV1Schema,
    GameAttachmentStateV1Schema,
    GameCapabilitySummaryV1Schema,
    GamePrerequisitesReadCommandV1Schema,
    GamePrerequisitesSetupCommandV1Schema,
    GameInstancesReadCommandV1Schema,
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
    GameDiagnosticsReadCommandV1Schema,
    GameDiscoveryReadResultV1Schema,
    GameDiscoveryConfirmCommandV1Schema,
    GameDiscoveryActionCommandV1Schema,
    GameDiscoveryMutationResultV1Schema,
    StardewCabinChoicesV1Schema,
    StardewCabinConfirmCommandV1Schema,
    StardewCabinConfirmResultV1Schema,
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
export type GamePrerequisitesSetupCommandV1 = Static<typeof GamePrerequisitesSetupCommandV1Schema>;
export type GameLaunchCommandV1 = Static<typeof GameLaunchCommandV1Schema>;
export type GameStopCommandV1 = Static<typeof GameStopCommandV1Schema>;
export type GameResumeCommandV1 = Static<typeof GameResumeCommandV1Schema>;
export type GameCreateCommandV1 = Static<typeof GameCreateCommandV1Schema>;
export type GameCreateResultV1 = Static<typeof GameCreateResultV1Schema>;
export type GameResumeCancelCommandV1 = Static<typeof GameResumeCancelCommandV1Schema>;
export type GameResumeCancelResultV1 = Static<typeof GameResumeCancelResultV1Schema>;

/**
 * Coordinator-owned resume seam command. The browser transport schema stays
 * frozen to `GameResumeCommandV1Schema` (strict, session-less); this narrow
 * type-only extension carries the gameSessionId the coordinator needs to
 * resolve the session's registered world binding. It is not a wire schema.
 */
export type GameSessionResumeCommandV1 = GameResumeCommandV1 &
  Readonly<{
    gameSessionId: string;
  }>;
export type GameResumeResultV1 = Static<typeof GameResumeResultV1Schema>;
export type GameReopenActionAuthorityCommandV1 = Static<typeof GameReopenActionAuthorityCommandV1Schema>;
export type GameReopenActionAuthorityResultV1 = Static<typeof GameReopenActionAuthorityResultV1Schema>;
export type GameDisconnectCommandV1 = Static<typeof GameDisconnectCommandV1Schema>;
export type GameEndgameCommandV1 = Static<typeof GameEndgameCommandV1Schema>;
export type GameEndgameResultV1 = Static<typeof GameEndgameResultV1Schema>;
export type StardewCabinChoicesV1 = Static<typeof StardewCabinChoicesV1Schema>;
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
        prerequisites: { status: "met" as const, detectedGame: "Stardew Valley", missingItems: [] },
        instance: { status: "detected" as const, gameTitle: "Stardew Valley", generation: 0 },
        compatibility: { status: "compatible" as const, message: null },
        attachment: { status: "none" as const, generation: 0 },
        connectionStatus: "none" as const,
        actionAuthority: "unavailable" as const,
        role: null,
        companionName: null,
        selectedWorld: null,
        selectedSave: null,
        capabilitySummary: { available: false, count: 0 },
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
        prerequisites: { status: "met" as const, detectedGame: "Stardew Valley", missingItems: [] },
        instance: { status: "running" as const, gameTitle: "Stardew Valley", generation: 3 },
        compatibility: { status: "compatible" as const, message: null },
        attachment: { status: "attached" as const, generation: 3 },
        connectionStatus: "connected_idle" as const,
        actionAuthority: "active" as const,
        role: "player" as const,
        companionName: "Farmhand",
        selectedWorld: "Pelican Town",
        selectedSave: "Spring Year 2",
        capabilitySummary: { available: true, count: 3 },
        latestOutcome: "succeeded" as const,
      },
    }),
});
