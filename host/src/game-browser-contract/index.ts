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

const ActionAuthority = Type.Union([
  Type.Literal("unavailable"),
  Type.Literal("active"),
  Type.Literal("paused"),
]);

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

const GameInstancesReadCommandV1Schema = strictObject({
  apiVersion: ApiVersion,
});

const GameStateReadCommandV1Schema = strictObject({
  apiVersion: ApiVersion,
});

const GameDiagnosticsReadCommandV1Schema = strictObject({
  apiVersion: ApiVersion,
});

// Installation discovery is deliberately redacted: paths and executable identity
// never cross the browser boundary.
const GameCandidateV1Schema = strictObject({
  candidateId: OpaqueHandle,
  source: Type.String({ minLength: 1, maxLength: 64 }),
  label: Type.String({ minLength: 1, maxLength: 256 }),
  hint: Type.Union([Type.String({ minLength: 1, maxLength: 256 }), Type.Null()]),
  status: Type.Union([Type.Literal("candidate"), Type.Literal("invalid"), Type.Literal("admission_required")]),
});
export const GameDiscoveryReadResultV1Schema = strictObject({
  apiVersion: ApiVersion,
  candidates: Type.Array(GameCandidateV1Schema, { maxItems: 64 }),
  diagnostics: Type.Array(Type.String({ minLength: 1, maxLength: 128 }), { maxItems: 32 }),
});
export const GameDiscoveryConfirmCommandV1Schema = strictObject({ apiVersion: ApiVersion, candidateId: OpaqueHandle });
export const GameDiscoveryActionCommandV1Schema = strictObject({ apiVersion: ApiVersion });

/** Redacted outcomes for installation-discovery mutations. */
export const GameDiscoveryMutationResultV1Schema = Type.Union([
  strictObject({ apiVersion: ApiVersion, status: Type.Literal("accepted") }),
  strictObject({ apiVersion: ApiVersion, status: Type.Literal("registered") }),
  strictObject({ apiVersion: ApiVersion, status: Type.Literal("cancelled") }),
  strictObject({ apiVersion: ApiVersion, status: Type.Literal("unavailable") }),
]);
export type GameDiscoveryMutationResultV1 = Static<typeof GameDiscoveryMutationResultV1Schema>;

export const StardewCabinChoicesV1Schema = strictObject({
  apiVersion: ApiVersion,
  choices: Type.Array(strictObject({
    displayLabel: Type.String({ minLength: 1, maxLength: 128 }),
    availability: Type.Literal("available"),
    choiceHandle: Type.String({ minLength: 43, maxLength: 43, format: "game-browser-canonical-base64url-v1" }),
    expiresAtMs: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
  }), { maxItems: 64 }),
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
    status: Type.Union([
      Type.Literal("accepted"),
      Type.Literal("attached"),
    ]),
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
  status: Type.Union([
    Type.Literal("accepted"),
    Type.Literal("attached"),
    Type.Literal("unavailable"),
  ]),
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

export const GAME_BROWSER_OPERATION_IDS_V1 = Object.freeze([
  "game.prerequisites.read",
  "game.prerequisites.setup",
  "game.instances.read",
  "game.state.read",
  "game.launch",
  "game.attach",
  "game.stop",
  "game.resume",
  "game.resume.cancel",
  "game.reopen",
  "game.disconnect",
  "game.create",
  "game.diagnostics.read",
  "game.installation.discovery.read",
  "game.installation.discovery.confirm",
  "game.installation.discovery.retry",
  "game.installation.discovery.cancel",
  "game.installation.discovery.manual_picker",
  "game.stardew.cabins.read",
  "game.stardew.cabins.confirm",
] as const);

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
export type GameSessionResumeCommandV1 = GameResumeCommandV1 & Readonly<{
  gameSessionId: string;
}>;
export type GameResumeResultV1 = Static<typeof GameResumeResultV1Schema>;
export type GameReopenActionAuthorityCommandV1 = Static<typeof GameReopenActionAuthorityCommandV1Schema>;
export type GameReopenActionAuthorityResultV1 = Static<typeof GameReopenActionAuthorityResultV1Schema>;
export type GameDisconnectCommandV1 = Static<typeof GameDisconnectCommandV1Schema>;
export type StardewCabinChoicesV1 = Static<typeof StardewCabinChoicesV1Schema>;
export type StardewCabinConfirmCommandV1 = Static<typeof StardewCabinConfirmCommandV1Schema>;
export type StardewCabinConfirmResultV1 = Static<typeof StardewCabinConfirmResultV1Schema>;

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
