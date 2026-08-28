import { type Static, type TSchema, Type } from "typebox";
import { Compile, type Validator } from "typebox/compile";
import { Format } from "typebox/format";

export const GAME_BROWSER_API_V1 = "game_browser_api/v1" as const;
export const GAME_BROWSER_API_VERSION = 1 as const;

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
  Type.Literal("stopped"),
  Type.Literal("failed"),
  Type.Literal("disconnected"),
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

export const GamePrerequisiteStateV1Schema = strictObject({
  status: PrerequisiteStatus,
  detectedGame: DetectedGameLabel,
  missingItems: Type.Array(MissingItemLabel, { maxItems: 50 }),
});

export const GameInstanceV1Schema = strictObject({
  status: InstanceStatus,
  gameTitle: GameTitleLabel,
});

export const GameCompatibilityV1Schema = strictObject({
  status: CompatibilityStatus,
  message: CompatibilityMessage,
});

export const GameAttachmentStateV1Schema = strictObject({
  status: AttachmentStatus,
  generation: NonNegativeGeneration,
});

export const GameCapabilitySummaryV1Schema = strictObject({
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

export const GameInstancesReadCommandV1Schema = strictObject({
  apiVersion: ApiVersion,
});

export const GameStateReadCommandV1Schema = strictObject({
  apiVersion: ApiVersion,
});

export const GameDiagnosticsReadCommandV1Schema = strictObject({
  apiVersion: ApiVersion,
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

export const GameReconnectCommandV1Schema = strictObject({
  apiVersion: ApiVersion,
  idempotencyKey: IdempotencyKey,
  expectedAttachmentGeneration: PositiveGeneration,
});

export const GameDisconnectCommandV1Schema = strictObject({
  apiVersion: ApiVersion,
  idempotencyKey: IdempotencyKey,
  expectedAttachmentGeneration: PositiveGeneration,
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

export const GAME_BROWSER_OPERATION_IDS_V1 = Object.freeze([
  "game.prerequisites.read",
  "game.prerequisites.setup",
  "game.instances.read",
  "game.state.read",
  "game.launch",
  "game.attach",
  "game.stop",
  "game.reconnect",
  "game.disconnect",
  "game.diagnostics.read",
] as const);

const GameOperationId = Type.Union([
  Type.Literal("game.prerequisites.read"),
  Type.Literal("game.prerequisites.setup"),
  Type.Literal("game.instances.read"),
  Type.Literal("game.state.read"),
  Type.Literal("game.launch"),
  Type.Literal("game.attach"),
  Type.Literal("game.stop"),
  Type.Literal("game.reconnect"),
  Type.Literal("game.disconnect"),
  Type.Literal("game.diagnostics.read"),
]);

const GameNavigationItemId = Type.Union([Type.Literal("game")]);

const GameReleaseTier = Type.Union([Type.Literal("game_preview")]);

const contractDeclaredOperationIds = new Set<string>(GAME_BROWSER_OPERATION_IDS_V1);
const contractDeclaredNavigationItemIds = new Set<string>(["game"]);

export type GameBrowserOperationIdV1 = (typeof GAME_BROWSER_OPERATION_IDS_V1)[number];
export type GameBrowserNavigationItemIdV1 = "game";
export type GameReleaseTierV1 = "game_preview";

export type ComposedGameProfile = Readonly<{
  readonly profileId: string;
  readonly releaseTier: GameReleaseTierV1;
  readonly operationIds: readonly GameBrowserOperationIdV1[];
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
    operationIds: Object.freeze([...value.operationIds] as GameBrowserOperationIdV1[]),
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
    GameReconnectCommandV1Schema,
    GameDisconnectCommandV1Schema,
    GameDiagnosticsReadCommandV1Schema,
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

export type GameBrowserStateV1 = Static<typeof GameBrowserStateV1Schema>;
export type GamePrerequisiteStateV1 = Static<typeof GamePrerequisiteStateV1Schema>;
export type GameInstanceV1 = Static<typeof GameInstanceV1Schema>;
export type GameCompatibilityV1 = Static<typeof GameCompatibilityV1Schema>;
export type GameAttachmentStateV1 = Static<typeof GameAttachmentStateV1Schema>;
export type GameCapabilitySummaryV1 = Static<typeof GameCapabilitySummaryV1Schema>;
export type GamePrerequisitesReadCommandV1 = Static<typeof GamePrerequisitesReadCommandV1Schema>;
export type GamePrerequisitesSetupCommandV1 = Static<typeof GamePrerequisitesSetupCommandV1Schema>;
export type GameInstancesReadCommandV1 = Static<typeof GameInstancesReadCommandV1Schema>;
export type GameStateReadCommandV1 = Static<typeof GameStateReadCommandV1Schema>;
export type GameLaunchCommandV1 = Static<typeof GameLaunchCommandV1Schema>;
export type GameAttachCommandV1 = Static<typeof GameAttachCommandV1Schema>;
export type GameStopCommandV1 = Static<typeof GameStopCommandV1Schema>;
export type GameReconnectCommandV1 = Static<typeof GameReconnectCommandV1Schema>;
export type GameDisconnectCommandV1 = Static<typeof GameDisconnectCommandV1Schema>;
export type GameDiagnosticsReadCommandV1 = Static<typeof GameDiagnosticsReadCommandV1Schema>;
export type GameProblemV1 = Static<typeof GameProblemV1Schema>;

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
        instance: { status: "detected" as const, gameTitle: "Stardew Valley" },
        compatibility: { status: "compatible" as const, message: null },
        attachment: { status: "none" as const, generation: 0 },
        connectionStatus: "none" as const,
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
        instance: { status: "running" as const, gameTitle: "Stardew Valley" },
        compatibility: { status: "compatible" as const, message: null },
        attachment: { status: "attached" as const, generation: 3 },
        connectionStatus: "connected_idle" as const,
        role: "player" as const,
        companionName: "Farmhand",
        selectedWorld: "Pelican Town",
        selectedSave: "Spring Year 2",
        capabilitySummary: { available: true, count: 3 },
        latestOutcome: "succeeded" as const,
      },
    }),
});