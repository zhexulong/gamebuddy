import { type TavernStateSnapshotV1, validateSnapshot } from "./reference-pipeline-api.js";

/**
 * Browser-only boundary for the composed reference-game profile.
 *
 * The composed broker owns bootstrap/session identity and returns one strict
 * root. Nested Chat operations deliberately stay on the existing
 * `tavern_browser_api/v1` client; this module only owns the composed bootstrap
 * and authoritative state read. In particular, it never reads Tavern
 * `/bootstrap` or `/state` as a composed refresh source.
 */

const COMPOSED_REFERENCE_GAME_BROWSER_API_V1 = "composed_reference_game_browser_api/v1" as const;
const COMPOSED_REFERENCE_GAME_BROWSER_API_VERSION = 1 as const;
const COMPOSED_REFERENCE_GAME_PROFILE_ID = "gamebuddy.composed.reference-game" as const;
const COMPOSED_REFERENCE_GAME_TAVERN_PROFILE_ID = "gamebuddy.chat-core.reference-pipeline" as const;
const COMPOSED_REFERENCE_GAME_PROFILE_ID_GAME = "gamebuddy.game.preview" as const;

const BASE64URL_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
/**
 * The mod-loader install outcomes, in one place so the type and the runtime validator cannot
 * drift apart. The Host declares the same set (`StardewModLoaderInstallResultV1Schema`);
 * `contract-mirror-keys-gate` and this module's own tests hold the two equal.
 */
const MOD_LOADER_INSTALL_STATUSES = Object.freeze([
  "installed",
  "current",
  "game_installation_not_found",
  "installation_conflict",
  "game_dependencies_missing",
  "mods_directory_not_writable",
  "mod_loader_payload_unavailable",
  "mod_loader_install_incomplete",
] as const);
const OPAQUE_HANDLE_PATTERN = /^[A-Za-z0-9_-]{22,128}$/;
const MAX_GAME_LABEL_LENGTH = 256;
const MAX_CABIN_DISPLAY_LABEL_LENGTH = 128;
const MAX_CABIN_CHOICES = 64;
const MAX_GAME_MESSAGE_LENGTH = 512;
const MAX_GAME_MISSING_ITEMS = 50;

const PREREQUISITE_STATUSES = ["unknown", "met", "unmet", "checking", "failed"] as const;
const INSTANCE_STATUSES = ["none", "detected", "launching", "running", "stopped", "crashed"] as const;
const COMPATIBILITY_STATUSES = ["unchecked", "compatible", "incompatible", "warning"] as const;
const ATTACHMENT_STATUSES = ["none", "pending", "attached", "detaching", "failed"] as const;
const CONNECTION_STATUSES = [
  "none",
  "discovering",
  "launch_pending",
  "attach_pending",
  "compatibility_warning",
  "awaiting_confirmation",
  "connecting",
  "connected_idle",
  "active",
  "stopping",
  "reconnecting",
  "syncing",
  "stopped",
  "failed",
  "disconnected",
] as const;
const OUTCOMES = ["none", "succeeded", "failed", "cancelled"] as const;
const ACTION_AUTHORITY_STATUSES = ["unavailable", "active", "paused"] as const;
const CABIN_CHOICES_KEYS = ["apiVersion", "choices"] as const;
const CABIN_CHOICE_KEYS = ["displayLabel", "availability", "choiceHandle", "expiresAtMs"] as const;
const CABIN_CONFIRMATION_KEYS = ["apiVersion", "status"] as const;
const INSTALLATION_DISCOVERY_KEYS = ["apiVersion", "candidates", "diagnostics"] as const;
const INSTALLATION_CANDIDATE_KEYS = ["candidateId", "source", "label", "hint", "status"] as const;
/**
 * The same shape carrying `location`, which the contract declares `Type.Optional`:
 * the drive and library folder's own name, so two installations of the same game can
 * be told apart without publishing a path.
 */
const INSTALLATION_CANDIDATE_KEYS_WITH_LOCATION = [
  "candidateId",
  "source",
  "label",
  "hint",
  "location",
  "status",
] as const;
const INSTALLATION_DIAGNOSTICS_MAX = 32;

/**
 * The `game_browser_api/v1` problem vocabulary, mirrored.
 *
 * The Host declares it (`host/src/game-browser-contract/index.ts`,
 * `GAME_BROWSER_PROBLEM_CODES_V1`, and the `GameProblemCode` union beside it). This bundle cannot
 * import the Host package - no Host module, no typebox, no runtime code - so the mirror is the
 * browser's only copy, and `problem-code-gate.test.mjs` (`problem-code.9`) pins it to EQUALITY with
 * the declaration: a code the Host adds fails there until it is mirrored here, and the sentence map
 * in `composed-problem-view.ts` is typed over this union, so a mirrored code with no words for the
 * player fails the typecheck in the module that owes them.
 */
export const GAME_PROBLEM_CODES = [
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
  "closed",
  "malformed_request",
  "not_found",
  "state_unavailable",
  "game_endgame_settlement_unavailable",
  "stardew_settings_revision_conflict",
] as const;
export type GameProblemCode = (typeof GAME_PROBLEM_CODES)[number];

const ROOT_KEYS = ["apiVersion", "build", "chat", "game"] as const;
const ROOT_BUILD_KEYS = ["browserContract", "profileId"] as const;
const GAME_KEYS = [
  "prerequisites",
  "instance",
  "compatibility",
  "attachment",
  "connectionStatus",
  "actionAuthority",
  "role",
  "companionName",
  "selectedWorld",
  "selectedSave",
  "capabilitySummary",
  "latestOutcome",
] as const;
const GAME_STATE_KEYS = ["apiVersion", "build", "csrfToken", "browserSession", "game"] as const;
const GAME_BUILD_KEYS = ["browserContract", "profileId"] as const;
const GAME_PREREQUISITES_KEYS = ["status", "detectedGame", "missingItems"] as const;
const GAME_INSTANCE_KEYS = ["status", "gameTitle", "generation"] as const;
const GAME_COMPATIBILITY_KEYS = ["status", "message"] as const;
const GAME_ATTACHMENT_KEYS = ["status", "generation"] as const;
const GAME_CAPABILITY_SUMMARY_KEYS = ["available", "count"] as const;

export type GameBrowserStateV1 = Readonly<{
  apiVersion: 1;
  build: Readonly<{
    browserContract: "game_browser_api/v1";
    profileId: string;
  }>;
  csrfToken: string;
  browserSession: Readonly<{ expiresAtMs: number }>;
  game: Readonly<{
    prerequisites: Readonly<{
      status: (typeof PREREQUISITE_STATUSES)[number];
      detectedGame: string | null;
      missingItems: readonly string[];
    }>;
    instance: Readonly<{
      status: (typeof INSTANCE_STATUSES)[number];
      gameTitle: string | null;
      generation: number;
    }>;
    compatibility: Readonly<{
      status: (typeof COMPATIBILITY_STATUSES)[number];
      message: string | null;
    }>;
    attachment: Readonly<{
      status: (typeof ATTACHMENT_STATUSES)[number];
      generation: number;
    }>;
    connectionStatus: (typeof CONNECTION_STATUSES)[number];
    actionAuthority: (typeof ACTION_AUTHORITY_STATUSES)[number];
    role: "player" | "companion" | null;
    companionName: string | null;
    selectedWorld: string | null;
    selectedSave: string | null;
    capabilitySummary: Readonly<{ available: boolean; count: number }>;
    latestOutcome: (typeof OUTCOMES)[number];
  }>;
}>;

export type ComposedReferenceGameBrowserRootV1 = Readonly<{
  apiVersion: 1;
  build: Readonly<{
    browserContract: typeof COMPOSED_REFERENCE_GAME_BROWSER_API_V1;
    profileId: typeof COMPOSED_REFERENCE_GAME_PROFILE_ID;
  }>;
  chat: TavernStateSnapshotV1;
  game: GameBrowserStateV1 | null;
}>;

export class ComposedReferenceGameProtocolError extends Error {
  readonly reason: string;

  constructor(reason = "protocol_error") {
    super("composed_reference_game_browser_api/v1 protocol error");
    this.name = "ComposedReferenceGameProtocolError";
    this.reason = reason;
  }
}

export class ComposedReferenceGameProblemError extends Error {
  readonly code: string;
  readonly status: number;
  readonly requestId: string | null;
  readonly retryable: boolean;
  /**
   * The bounded coordinator cause the shell named for a lifecycle refusal, or
   * `null` when it named none. It is always a `stardew_*` snake_case code, so it
   * can never carry producer text, a path or a token into the UI.
   */
  readonly causeCode: string | null;

  constructor(code: string, status: number, requestId: string | null = null, causeCode: string | null = null) {
    super("composed reference game request was rejected");
    this.name = "ComposedReferenceGameProblemError";
    this.code = code;
    this.status = status;
    this.requestId = requestId;
    this.retryable = status >= 500 || code === "state_unavailable";
    this.causeCode = causeCode;
  }
}

export type StardewCabinChoiceV1 = Readonly<{
  displayLabel: string;
  availability: "available";
  choiceHandle: string;
  expiresAtMs: number;
}>;

/**
 * One action family the player may withhold, and whether they have. Checked means
 * the companion may use it; the surface unticks to withhold.
 */
export type StardewActionFamilyV1 = Readonly<{ familyId: string; denied: boolean }>;

/** The player's own Stardew settings: one revision, one family list, one night floor. */
export type StardewPlayerSettingsV1 = Readonly<{
  apiVersion: 1;
  revision: number;
  families: readonly StardewActionFamilyV1[];
  advanceDayMinimumOnlineFarmers: number;
  /**
   * Where each answer really takes effect. It is on the wire rather than in the
   * component so the sentence the player reads cannot drift from the Mod's own
   * behaviour: the action policy is re-read on a 120-tick throttle, the night floor
   * only when a world loads.
   */
  /** The window behaviour the player chose, or absent when they never did: the Mod then runs visibly. */
  windowMode?: StardewWindowModeV1;
  /** Actions withheld individually, on top of the families. Absent means none. */
  deniedActions?: readonly string[];
  appliesToRunningGame: Readonly<{
    actionPolicy: "within_seconds";
    advanceDayMinimumOnlineFarmers: "next_world_load";
    /** The Mod re-reads this on its own tick, so the sentence can promise a live change. */
    windowMode: "within_seconds";
    /** Per-action denials ride the same policy document the families do. */
    deniedActions: "within_seconds";
  }>;
}>;

/** The four behaviours the Mod implements. One spelling with the Host contract's union. */
export type StardewWindowModeV1 = "visible" | "minimized" | "hidden" | "background";

export type StardewPlayerSettingsRequestV1 = Readonly<{
  apiVersion: 1;
  expectedRevision: number;
  deniedActionFamilies: readonly string[];
  advanceDayMinimumOnlineFarmers: number;
  /** Absent keeps whatever the record holds, so a client that does not know the field cannot clear it. */
  windowMode?: StardewWindowModeV1;
  deniedActions?: readonly string[];
}>;

export type StardewInstallationCandidateV1 = Readonly<{
  candidateId: string;
  source: string;
  label: string;
  hint: string | null;
  /** Where it is, in the Host's redaction-safe words (`D: · SteamLibrary`), or null. */
  location: string | null;
  status: "candidate" | "invalid" | "admission_required";
}>;
export type StardewInstallationDiscoveryV1 = Readonly<{
  apiVersion: 1;
  candidates: readonly StardewInstallationCandidateV1[];
  diagnostics: readonly string[];
}>;

export type StardewInstallationMutationV1 = Readonly<{
  apiVersion: 1;
  status:
    | "accepted"
    | "registered"
    | "cancelled"
    | "unavailable"
    | "mod_loader_missing"
    | "not_stardew_installation"
    | "reparse_point";
}>;

/**
 * One-click mod-loader install outcome.
 *
 * `installed` and `current` are kept apart on purpose: a re-click must not tell the player
 * the app wrote something it did not. The rest are the bounded causes the Host reports, each
 * with a different thing for the player to do, so none of them collapses into `unavailable`.
 */
export type StardewModLoaderInstallResultV1 = Readonly<{
  apiVersion: 1;
  status: (typeof MOD_LOADER_INSTALL_STATUSES)[number];
  /**
   * The Steam launch option that starts the game through the loader, present exactly on
   * `installed` and `current`.
   *
   * It carries the loader's absolute path, which discovery deliberately never publishes. The
   * difference is who already knows the facts: discovery redacts paths because a player who
   * has not picked a folder must not receive a map of their disk, while this value exists only
   * after the player named that exact folder themselves and this session installed into it.
   * Without the real path the "paste this into Steam" card would leave the player assembling
   * the string by hand - the round trip this flow exists to remove.
   */
  steamLaunchOption?: string;
}>;

type StardewCabinChoicesV1 = Readonly<{
  apiVersion: 1;
  choices: readonly StardewCabinChoiceV1[];
}>;

type StardewCabinConfirmationRequestV1 = Readonly<{
  apiVersion: 1;
  idempotencyKey: string;
  choiceHandle: string;
  confirmed: true;
}>;

type GameSetupRequestV1 = Readonly<{
  apiVersion: 1;
  idempotencyKey: string;
}>;

/** The one-click mod-loader install carries nothing but its idempotency key. */
type StardewModLoaderInstallRequestV1 = Readonly<{
  apiVersion: 1;
  idempotencyKey: string;
}>;

type GameLaunchRequestV1 = Readonly<{
  apiVersion: 1;
  idempotencyKey: string;
  expectedInstanceGeneration: number;
}>;

type GameStopRequestV1 = Readonly<{
  apiVersion: 1;
  idempotencyKey: string;
  expectedAttachmentGeneration: number;
}>;

type GameDisconnectRequestV1 = Readonly<{
  apiVersion: 1;
  idempotencyKey: string;
  expectedAttachmentGeneration: number;
}>;

export type GameResumeRequestV1 = Readonly<{
  apiVersion: 1;
  idempotencyKey: string;
  expectedAttachmentGeneration: number;
}>;

export type GameResumeResultV1 = Readonly<{
  apiVersion: 1;
  status: "accepted" | "attached" | "unavailable";
}>;

export type GameReopenRequestV1 = Readonly<{
  apiVersion: 1;
  idempotencyKey: string;
  expectedAttachmentGeneration: number;
}>;

export type GameReopenResultV1 = Readonly<{
  apiVersion: 1;
  status: "reopened";
}>;

export type GameCreateRequestV1 = Readonly<{
  apiVersion: 1;
  idempotencyKey: string;
  integrationId: string;
  continuityIdentityId: string | null;
}>;

export type GameCreateResultV1 = Readonly<{
  apiVersion: 1;
  status: "accepted" | "attached" | "unavailable";
  gameSessionId: string | null;
}>;

export type GameResumeCancelRequestV1 = Readonly<{
  apiVersion: 1;
  idempotencyKey: string;
  expectedAttachmentGeneration: number;
}>;

export type GameResumeCancelResultV1 = Readonly<{
  apiVersion: 1;
  status: "cancelled";
}>;

export type GameEndgameRequestV1 = Readonly<{
  apiVersion: 1;
  idempotencyKey: string;
  expectedAttachmentGeneration: number;
  confirm: true;
}>;

export type GameEndgameResultV1 = Readonly<{
  apiVersion: 1;
  status: "gameended" | "unavailable";
}>;

type StardewCabinConfirmationV1 = Readonly<{
  apiVersion: 1;
  status: "manifest_admitted";
}>;

export type ComposedReferenceGameBrowserApi = Readonly<{
  bootstrap(bootstrapToken: string): Promise<ComposedReferenceGameBrowserRootV1>;
  readState(): Promise<ComposedReferenceGameBrowserRootV1>;
  activateLifecycle(): Promise<void>;
  setupGame(request: GameSetupRequestV1): Promise<void>;
  launchGame(request: GameLaunchRequestV1): Promise<void>;
  stopGame(request: GameStopRequestV1): Promise<void>;
  disconnectGame(request: GameDisconnectRequestV1): Promise<void>;
  resumeGame(request: GameResumeRequestV1): Promise<GameResumeResultV1>;
  reopenGame(request: GameReopenRequestV1): Promise<GameReopenResultV1>;
  createGameSession(request: GameCreateRequestV1): Promise<GameCreateResultV1>;
  cancelResume(request: GameResumeCancelRequestV1): Promise<GameResumeCancelResultV1>;
  endgameGame(request: GameEndgameRequestV1): Promise<GameEndgameResultV1>;
  readStardewCabins(): Promise<StardewCabinChoicesV1>;
  /** The player's own Stardew settings: the one settings route group the Game surface owns. */
  readStardewPlayerSettings(): Promise<StardewPlayerSettingsV1>;
  saveStardewPlayerSettings(request: StardewPlayerSettingsRequestV1): Promise<StardewPlayerSettingsV1>;
  readStardewInstallationDiscovery(): Promise<StardewInstallationDiscoveryV1>;
  confirmStardewInstallation(candidateId: string): Promise<StardewInstallationMutationV1>;
  retryStardewInstallationDiscovery(): Promise<StardewInstallationDiscoveryV1>;
  cancelStardewInstallationDiscovery(): Promise<StardewInstallationMutationV1>;
  openStardewInstallationPicker(): Promise<StardewInstallationMutationV1>;
  /**
   * The one-click mod-loader install, for the game folder the Host has bound.
   *
   * It takes no folder argument: the Host writes into the registration's own locator, so
   * this client method cannot point it anywhere else.
   */
  installStardewModLoader(request: StardewModLoaderInstallRequestV1): Promise<StardewModLoaderInstallResultV1>;
  confirmStardewCabin(request: StardewCabinConfirmationRequestV1): Promise<StardewCabinConfirmationV1>;
}>;

function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const ownKeys = Object.keys(value);
  return ownKeys.length === keys.length && keys.every((key) => ownKeys.includes(key));
}

function isSafeInteger(value: unknown, minimum: number): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= minimum;
}

function isOneOf<T extends readonly string[]>(value: unknown, values: T): value is T[number] {
  return typeof value === "string" && values.includes(value as T[number]);
}

function isBoundedString(value: unknown, minimum: number, maximum: number): value is string {
  return typeof value === "string" && value.length >= minimum && value.length <= maximum;
}

function isCanonicalUnpaddedBase64Url(value: string): boolean {
  if (value.length === 0 || value.length % 4 === 1) return false;
  for (const character of value) {
    if (!BASE64URL_ALPHABET.includes(character)) return false;
  }
  const finalIndex = BASE64URL_ALPHABET.indexOf(value[value.length - 1]!);
  return value.length % 4 === 0 || (value.length % 4 === 2 ? finalIndex % 16 === 0 : finalIndex % 4 === 0);
}

function isOpaqueHandle(value: unknown): value is string {
  return typeof value === "string" && OPAQUE_HANDLE_PATTERN.test(value) && isCanonicalUnpaddedBase64Url(value);
}

function isCanonicalBase64UrlBytes(value: unknown, byteLength: number): value is string {
  return (
    typeof value === "string" && value.length === Math.ceil((byteLength * 8) / 6) && isCanonicalUnpaddedBase64Url(value)
  );
}

function isStardewChoiceHandle(value: unknown): value is string {
  return isCanonicalBase64UrlBytes(value, 32);
}

function isInstallationCandidateId(value: unknown): value is string {
  return typeof value === "string" && OPAQUE_HANDLE_PATTERN.test(value) && isCanonicalUnpaddedBase64Url(value);
}

function isIdempotencyKey(value: unknown): value is string {
  return isCanonicalBase64UrlBytes(value, 16);
}

function isSafeId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value);
}

function isNullableLabel(value: unknown, maximum: number): value is string | null {
  return value === null || isBoundedString(value, 1, maximum);
}

function validateStardewCabinChoices(value: unknown): StardewCabinChoicesV1 {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, CABIN_CHOICES_KEYS) ||
    value.apiVersion !== 1 ||
    !Array.isArray(value.choices) ||
    value.choices.length > MAX_CABIN_CHOICES
  ) {
    throw new ComposedReferenceGameProtocolError("invalid_stardew_cabin_choices");
  }
  const choices: StardewCabinChoiceV1[] = [];
  for (const choice of value.choices) {
    if (
      !isRecord(choice) ||
      !hasExactKeys(choice, CABIN_CHOICE_KEYS) ||
      !isBoundedString(choice.displayLabel, 1, MAX_CABIN_DISPLAY_LABEL_LENGTH) ||
      choice.availability !== "available" ||
      !isStardewChoiceHandle(choice.choiceHandle) ||
      !isSafeInteger(choice.expiresAtMs, 0)
    ) {
      throw new ComposedReferenceGameProtocolError("invalid_stardew_cabin_choice");
    }
    choices.push(
      Object.freeze({
        displayLabel: choice.displayLabel,
        availability: choice.availability,
        choiceHandle: choice.choiceHandle,
        expiresAtMs: choice.expiresAtMs,
      }),
    );
  }
  return Object.freeze({ apiVersion: 1, choices: Object.freeze(choices) });
}

const SETTINGS_KEYS = [
  "apiVersion",
  "revision",
  "families",
  "advanceDayMinimumOnlineFarmers",
  // Optional on the wire, and named here because a validator that accepts this shape must know every key the contract
  // declares for it - otherwise a response carrying one is refused and the surface goes down with it.
  "windowMode",
  "deniedActions",
  "appliesToRunningGame",
] as const;
const SETTINGS_FAMILY_KEYS = ["familyId", "denied"] as const;
const SETTINGS_APPLIES_KEYS = [
  "actionPolicy",
  "advanceDayMinimumOnlineFarmers",
  "windowMode",
  "deniedActions",
] as const;
const STARDEW_WINDOW_MODES = ["visible", "minimized", "hidden", "background"] as const;
const DENIED_ACTION_LIMIT = 512;
const DENIED_ACTION_PATTERN = /^[a-z][a-z0-9_]{0,63}$/u;

/** The four behaviours the Mod implements; anything else is not a mode this client will carry. */
function isStardewWindowMode(value: unknown): value is StardewWindowModeV1 {
  return typeof value === "string" && (STARDEW_WINDOW_MODES as readonly string[]).includes(value);
}

/**
 * A per-action denial list is a set of action ids: bounded, duplicate-free, and shaped like an id.
 *
 * Validated here rather than trusted, for the same reason the family list beside it is - a value that reaches the surface must
 * not mean two things depending on which reader looked at it.
 */
function isDeniedActionIds(value: unknown): value is readonly string[] {
  if (!Array.isArray(value) || value.length > DENIED_ACTION_LIMIT) return false;
  if (!value.every((entry) => typeof entry === "string" && DENIED_ACTION_PATTERN.test(entry))) return false;
  return new Set(value).size === value.length;
}
const SETTINGS_MAX_FAMILIES = 64;
const SETTINGS_SAVE_REQUIRED_KEYS = [
  "apiVersion",
  "expectedRevision",
  "deniedActionFamilies",
  "advanceDayMinimumOnlineFarmers",
] as const;
/**
 * Every key a save may carry, required and optional.
 *
 * The request check is "exactly these keys and no others", so an optional member that is not named here would be refused on the
 * way out - the mirror would be stricter than the contract it mirrors, and a player who picked a window mode could not save.
 */
const SETTINGS_SAVE_KEYS = [
  "apiVersion",
  "expectedRevision",
  "deniedActionFamilies",
  "advanceDayMinimumOnlineFarmers",
  "windowMode",
  "deniedActions",
] as const;

function validateStardewPlayerSettings(value: unknown): StardewPlayerSettingsV1 {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, SETTINGS_KEYS) ||
    value.apiVersion !== 1 ||
    !isSafeInteger(value.revision, 0) ||
    !Array.isArray(value.families) ||
    value.families.length > SETTINGS_MAX_FAMILIES ||
    !isSafeInteger(value.advanceDayMinimumOnlineFarmers, 1) ||
    value.advanceDayMinimumOnlineFarmers > 4 ||
    (value.windowMode !== undefined && !isStardewWindowMode(value.windowMode)) ||
    (value.deniedActions !== undefined && !isDeniedActionIds(value.deniedActions)) ||
    !isRecord(value.appliesToRunningGame) ||
    !hasExactKeys(value.appliesToRunningGame, SETTINGS_APPLIES_KEYS) ||
    value.appliesToRunningGame.actionPolicy !== "within_seconds" ||
    value.appliesToRunningGame.advanceDayMinimumOnlineFarmers !== "next_world_load" ||
    value.appliesToRunningGame.windowMode !== "within_seconds" ||
    value.appliesToRunningGame.deniedActions !== "within_seconds"
  )
    throw new ComposedReferenceGameProtocolError("invalid_stardew_player_settings");
  const families: StardewActionFamilyV1[] = [];
  const seen = new Set<string>();
  for (const family of value.families) {
    if (
      !isRecord(family) ||
      !hasExactKeys(family, SETTINGS_FAMILY_KEYS) ||
      !isSafeId(family.familyId) ||
      seen.has(family.familyId) ||
      typeof family.denied !== "boolean"
    )
      throw new ComposedReferenceGameProtocolError("invalid_stardew_player_settings_family");
    seen.add(family.familyId);
    families.push(Object.freeze({ familyId: family.familyId, denied: family.denied }));
  }
  return Object.freeze({
    apiVersion: 1,
    revision: value.revision,
    families: Object.freeze(families),
    ...(value.windowMode === undefined ? {} : { windowMode: value.windowMode }),
    ...(value.deniedActions === undefined
      ? {}
      : { deniedActions: Object.freeze([...(value.deniedActions as readonly string[])]) }),
    advanceDayMinimumOnlineFarmers: value.advanceDayMinimumOnlineFarmers,
    appliesToRunningGame: Object.freeze({
      actionPolicy: "within_seconds" as const,
      advanceDayMinimumOnlineFarmers: "next_world_load" as const,
      windowMode: "within_seconds" as const,
      deniedActions: "within_seconds" as const,
    }),
  });
}

function validateStardewInstallationDiscovery(value: unknown): StardewInstallationDiscoveryV1 {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, INSTALLATION_DISCOVERY_KEYS) ||
    value.apiVersion !== 1 ||
    !Array.isArray(value.candidates) ||
    !Array.isArray(value.diagnostics) ||
    value.diagnostics.length > INSTALLATION_DIAGNOSTICS_MAX
  )
    throw new ComposedReferenceGameProtocolError("invalid_stardew_installation_discovery");
  const candidates: StardewInstallationCandidateV1[] = [];
  for (const candidate of value.candidates) {
    if (
      !isRecord(candidate) ||
      !(
        hasExactKeys(candidate, INSTALLATION_CANDIDATE_KEYS) ||
        hasExactKeys(candidate, INSTALLATION_CANDIDATE_KEYS_WITH_LOCATION)
      ) ||
      !isInstallationCandidateId(candidate.candidateId) ||
      !isBoundedString(candidate.source, 1, 64) ||
      !isBoundedString(candidate.label, 1, 256) ||
      !isNullableLabel(candidate.hint, 256) ||
      ("location" in candidate && !isNullableLabel(candidate.location, 64)) ||
      !["candidate", "invalid", "admission_required"].includes(candidate.status as string)
    )
      throw new ComposedReferenceGameProtocolError("invalid_stardew_installation_candidate");
    candidates.push(
      Object.freeze({
        candidateId: candidate.candidateId,
        source: candidate.source,
        label: candidate.label,
        hint: candidate.hint,
        location: (candidate.location as string | null | undefined) ?? null,
        status: candidate.status as StardewInstallationCandidateV1["status"],
      }),
    );
  }
  if (!value.diagnostics.every((item) => isBoundedString(item, 1, 128)))
    throw new ComposedReferenceGameProtocolError("invalid_stardew_installation_diagnostics");
  return Object.freeze({
    apiVersion: 1,
    candidates: Object.freeze(candidates),
    diagnostics: Object.freeze(value.diagnostics as string[]),
  });
}
function validateStardewInstallationMutation(value: unknown): StardewInstallationMutationV1 {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["apiVersion", "status"]) ||
    value.apiVersion !== 1 ||
    ![
      "accepted",
      "registered",
      "cancelled",
      "unavailable",
      "mod_loader_missing",
      "not_stardew_installation",
      "reparse_point",
    ].includes(value.status as string)
  )
    throw new ComposedReferenceGameProtocolError("invalid_stardew_installation_mutation");
  return Object.freeze({ apiVersion: 1, status: value.status as StardewInstallationMutationV1["status"] });
}

function validateStardewModLoaderInstallResult(value: unknown): StardewModLoaderInstallResultV1 {
  if (
    !isRecord(value) ||
    value.apiVersion !== 1 ||
    !(MOD_LOADER_INSTALL_STATUSES as readonly string[]).includes(value.status as string)
  )
    throw new ComposedReferenceGameProtocolError("invalid_stardew_mod_loader_install_result");
  const status = value.status as StardewModLoaderInstallResultV1["status"];
  const succeeded = status === "installed" || status === "current";
  if (succeeded) {
    // The launch option is what makes the success usable; a success that omits it would render
    // as a card with an empty box, so it is required exactly where it exists.
    if (!hasExactKeys(value, ["apiVersion", "status", "steamLaunchOption"]))
      throw new ComposedReferenceGameProtocolError("invalid_stardew_mod_loader_install_result");
    if (!isBoundedString(value.steamLaunchOption, 1, 4096))
      throw new ComposedReferenceGameProtocolError("invalid_stardew_mod_loader_install_result");
    return Object.freeze({ apiVersion: 1, status, steamLaunchOption: value.steamLaunchOption as string });
  }
  if (!hasExactKeys(value, ["apiVersion", "status"]))
    throw new ComposedReferenceGameProtocolError("invalid_stardew_mod_loader_install_result");
  return Object.freeze({ apiVersion: 1, status });
}

function validateStardewCabinConfirmation(value: unknown): StardewCabinConfirmationV1 {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, CABIN_CONFIRMATION_KEYS) ||
    value.apiVersion !== 1 ||
    value.status !== "manifest_admitted"
  ) {
    throw new ComposedReferenceGameProtocolError("invalid_stardew_cabin_confirmation");
  }
  return Object.freeze({ apiVersion: 1, status: "manifest_admitted" });
}

function validateGameResumeResult(value: unknown): GameResumeResultV1 {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["apiVersion", "status"]) ||
    value.apiVersion !== 1 ||
    (value.status !== "accepted" && value.status !== "attached" && value.status !== "unavailable")
  ) {
    throw new ComposedReferenceGameProtocolError("invalid_game_resume_result");
  }
  return Object.freeze({ apiVersion: 1, status: value.status });
}

function validateGameReopenResult(value: unknown): GameReopenResultV1 {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["apiVersion", "status"]) ||
    value.apiVersion !== 1 ||
    value.status !== "reopened"
  ) {
    throw new ComposedReferenceGameProtocolError("invalid_game_reopen_result");
  }
  return Object.freeze({ apiVersion: 1, status: "reopened" });
}

function validateGameCreateResult(value: unknown): GameCreateResultV1 {
  if (!isRecord(value) || !hasExactKeys(value, ["apiVersion", "status", "gameSessionId"]) || value.apiVersion !== 1) {
    throw new ComposedReferenceGameProtocolError("invalid_game_create_result");
  }
  if (value.status === "unavailable" && value.gameSessionId === null) {
    return Object.freeze({ apiVersion: 1, status: "unavailable", gameSessionId: null });
  }
  if ((value.status === "accepted" || value.status === "attached") && isSafeId(value.gameSessionId)) {
    return Object.freeze({ apiVersion: 1, status: value.status, gameSessionId: value.gameSessionId });
  }
  throw new ComposedReferenceGameProtocolError("invalid_game_create_result");
}

function validateGameResumeCancelResult(value: unknown): GameResumeCancelResultV1 {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["apiVersion", "status"]) ||
    value.apiVersion !== 1 ||
    value.status !== "cancelled"
  ) {
    throw new ComposedReferenceGameProtocolError("invalid_game_resume_cancel_result");
  }
  return Object.freeze({ apiVersion: 1, status: "cancelled" });
}

function validateGameEndgameResult(value: unknown): GameEndgameResultV1 {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["apiVersion", "status"]) ||
    value.apiVersion !== 1 ||
    (value.status !== "gameended" && value.status !== "unavailable")
  ) {
    throw new ComposedReferenceGameProtocolError("invalid_game_endgame_result");
  }
  return Object.freeze({ apiVersion: 1, status: value.status });
}

function isGameProjection(value: unknown): value is GameBrowserStateV1 {
  if (!isRecord(value) || !hasExactKeys(value, GAME_STATE_KEYS) || value.apiVersion !== 1) return false;
  if (
    !isRecord(value.build) ||
    !hasExactKeys(value.build, GAME_BUILD_KEYS) ||
    value.build.browserContract !== "game_browser_api/v1" ||
    value.build.profileId !== COMPOSED_REFERENCE_GAME_PROFILE_ID_GAME
  ) {
    return false;
  }
  if (
    !isOpaqueHandle(value.csrfToken) ||
    !isRecord(value.browserSession) ||
    !hasExactKeys(value.browserSession, ["expiresAtMs"]) ||
    !isSafeInteger(value.browserSession.expiresAtMs, 0) ||
    !isRecord(value.game) ||
    !hasExactKeys(value.game, GAME_KEYS)
  ) {
    return false;
  }

  const game = value.game;
  if (
    !isRecord(game.prerequisites) ||
    !hasExactKeys(game.prerequisites, GAME_PREREQUISITES_KEYS) ||
    !isOneOf(game.prerequisites.status, PREREQUISITE_STATUSES) ||
    !isNullableLabel(game.prerequisites.detectedGame, MAX_GAME_LABEL_LENGTH) ||
    !Array.isArray(game.prerequisites.missingItems) ||
    game.prerequisites.missingItems.length > MAX_GAME_MISSING_ITEMS ||
    !game.prerequisites.missingItems.every((item) => isBoundedString(item, 1, MAX_GAME_LABEL_LENGTH))
  ) {
    return false;
  }
  if (
    !isRecord(game.instance) ||
    !hasExactKeys(game.instance, GAME_INSTANCE_KEYS) ||
    !isOneOf(game.instance.status, INSTANCE_STATUSES) ||
    !isNullableLabel(game.instance.gameTitle, MAX_GAME_LABEL_LENGTH) ||
    !isSafeInteger(game.instance.generation, 0)
  ) {
    return false;
  }
  if (
    !isRecord(game.compatibility) ||
    !hasExactKeys(game.compatibility, GAME_COMPATIBILITY_KEYS) ||
    !isOneOf(game.compatibility.status, COMPATIBILITY_STATUSES) ||
    !isNullableLabel(game.compatibility.message, MAX_GAME_MESSAGE_LENGTH)
  ) {
    return false;
  }
  if (
    !isRecord(game.attachment) ||
    !hasExactKeys(game.attachment, GAME_ATTACHMENT_KEYS) ||
    !isOneOf(game.attachment.status, ATTACHMENT_STATUSES) ||
    !isSafeInteger(game.attachment.generation, 0)
  ) {
    return false;
  }
  if (
    !isOneOf(game.connectionStatus, CONNECTION_STATUSES) ||
    !isOneOf(game.actionAuthority, ACTION_AUTHORITY_STATUSES) ||
    !(game.role === null || game.role === "player" || game.role === "companion") ||
    !isNullableLabel(game.companionName, MAX_GAME_LABEL_LENGTH) ||
    !isNullableLabel(game.selectedWorld, MAX_GAME_LABEL_LENGTH) ||
    !isNullableLabel(game.selectedSave, MAX_GAME_LABEL_LENGTH) ||
    !isRecord(game.capabilitySummary) ||
    !hasExactKeys(game.capabilitySummary, GAME_CAPABILITY_SUMMARY_KEYS) ||
    typeof game.capabilitySummary.available !== "boolean" ||
    !isSafeInteger(game.capabilitySummary.count, 0) ||
    game.capabilitySummary.count > 512 ||
    !isOneOf(game.latestOutcome, OUTCOMES)
  ) {
    return false;
  }
  return true;
}

/**
 * Validates the exact composed root and both nested redacted projections.
 * Validation is closed at every object boundary: additive fields are not
 * silently ignored, and a foreign profile is never rendered as Game state.
 */
export function validateComposedReferenceGameRoot(value: unknown): ComposedReferenceGameBrowserRootV1 {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ROOT_KEYS) ||
    value.apiVersion !== 1 ||
    !isRecord(value.build) ||
    !hasExactKeys(value.build, ROOT_BUILD_KEYS) ||
    value.build.browserContract !== COMPOSED_REFERENCE_GAME_BROWSER_API_V1 ||
    value.build.profileId !== COMPOSED_REFERENCE_GAME_PROFILE_ID
  ) {
    throw new ComposedReferenceGameProtocolError("invalid_composed_root");
  }

  let chat: TavernStateSnapshotV1;
  try {
    chat = validateSnapshot(value.chat);
  } catch {
    throw new ComposedReferenceGameProtocolError("invalid_composed_chat");
  }
  if (chat.build.profileId !== COMPOSED_REFERENCE_GAME_TAVERN_PROFILE_ID) {
    throw new ComposedReferenceGameProtocolError("invalid_composed_chat_profile");
  }
  if (value.game !== null) {
    if (!isGameProjection(value.game)) {
      throw new ComposedReferenceGameProtocolError("invalid_composed_game");
    }
    if (
      value.game.csrfToken !== chat.csrfToken ||
      value.game.browserSession.expiresAtMs !== chat.browserSession.expiresAtMs
    ) {
      throw new ComposedReferenceGameProtocolError("mismatched_composed_session");
    }
  }
  return Object.freeze({
    apiVersion: value.apiVersion,
    build: Object.freeze({
      browserContract: value.build.browserContract,
      profileId: value.build.profileId,
    }),
    chat,
    game: value.game,
  });
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    throw new ComposedReferenceGameProtocolError("non_json_response");
  }
}

/**
 * Bounded token shapes for the only two fields a composed refusal may carry.
 * The shell's own vocabulary is closed, but a code this client build does not
 * know is still a *bounded* code and is preserved and shown rather than being
 * turned into an opaque protocol failure - that is the property that makes an
 * unfamiliar refusal diagnosable. Anything that is not a bounded token (raw
 * producer text, a path, a token, a space, a colon) is still refused outright.
 */
const PROBLEM_CODE_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;
const PROBLEM_CAUSE_PATTERN = /^stardew_[a-z0-9_]{1,95}$/;

function problemFromResponse(response: Response, value: unknown): ComposedReferenceGameProblemError {
  if (
    !isRecord(value) ||
    (!hasExactKeys(value, ["code"]) && !hasExactKeys(value, ["code", "cause"])) ||
    typeof value.code !== "string" ||
    !PROBLEM_CODE_PATTERN.test(value.code)
  ) {
    throw new ComposedReferenceGameProtocolError("invalid_problem");
  }
  if (Object.hasOwn(value, "cause")) {
    if (typeof value.cause !== "string" || !PROBLEM_CAUSE_PATTERN.test(value.cause)) {
      throw new ComposedReferenceGameProtocolError("invalid_problem");
    }
    return new ComposedReferenceGameProblemError(value.code, response.status, null, value.cause);
  }
  return new ComposedReferenceGameProblemError(value.code, response.status);
}

async function exchangeEmpty(fetchLike: typeof fetch, path: string, init: RequestInit): Promise<void> {
  let response: Response;
  try {
    response = await fetchLike(path, { ...init, credentials: "same-origin" });
  } catch {
    throw new ComposedReferenceGameProtocolError("network_error");
  }
  if (!response.ok) throw problemFromResponse(response, await readJson(response));
  if (response.status !== 204 || (await response.text()) !== "")
    throw new ComposedReferenceGameProtocolError("unexpected_status");
}

async function exchange<T>(
  fetchLike: typeof fetch,
  path: string,
  init: RequestInit,
  decode: (value: unknown) => T,
): Promise<T> {
  let response: Response;
  try {
    response = await fetchLike(path, { ...init, credentials: "same-origin" });
  } catch {
    throw new ComposedReferenceGameProtocolError("network_error");
  }
  const body = await readJson(response);
  if (!response.ok) throw problemFromResponse(response, body);
  if (response.status !== 200) throw new ComposedReferenceGameProtocolError("unexpected_status");
  return decode(body);
}

export function createComposedReferenceGameBrowserApi(
  fetchLike: typeof fetch = fetch,
): ComposedReferenceGameBrowserApi {
  if (typeof fetchLike !== "function") {
    throw new TypeError("createComposedReferenceGameBrowserApi requires a fetch-like function");
  }
  let csrfToken: string | undefined;
  return Object.freeze({
    async bootstrap(bootstrapToken: string): Promise<ComposedReferenceGameBrowserRootV1> {
      if (!isOpaqueHandle(bootstrapToken)) {
        throw new ComposedReferenceGameProtocolError("invalid_bootstrap_token");
      }
      const root = await exchange(
        fetchLike,
        "/api/composed-reference-game/v1/bootstrap",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            apiVersion: COMPOSED_REFERENCE_GAME_BROWSER_API_VERSION,
            bootstrapToken,
          }),
        },
        validateComposedReferenceGameRoot,
      );
      csrfToken = root.chat.csrfToken;
      return root;
    },
    async readState(): Promise<ComposedReferenceGameBrowserRootV1> {
      const root = await exchange(
        fetchLike,
        "/api/composed-reference-game/v1/state",
        { method: "GET" },
        validateComposedReferenceGameRoot,
      );
      csrfToken = root.chat.csrfToken;
      return root;
    },
    async activateLifecycle(): Promise<void> {
      // The route carries no command body: the admission already names the exact
      // authenticated browser session, and the lifecycle owner derives the
      // installation, registration and attempt from it. A body here (or a query
      // string) is refused by the route with 409 malformed_request.
      if (csrfToken === undefined) throw new ComposedReferenceGameProtocolError("missing_composed_session");
      await exchangeEmpty(fetchLike, "/api/composed-reference-game/v1/lifecycle/activate", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-CSRF-Token": csrfToken },
      });
    },
    async setupGame(request: GameSetupRequestV1): Promise<void> {
      if (
        request.apiVersion !== 1 ||
        !isIdempotencyKey(request.idempotencyKey) ||
        !hasExactKeys(request as Record<string, unknown>, ["apiVersion", "idempotencyKey"])
      )
        throw new ComposedReferenceGameProtocolError("invalid_game_setup_request");
      if (csrfToken === undefined) throw new ComposedReferenceGameProtocolError("missing_composed_session");
      await exchangeEmpty(fetchLike, "/api/composed-reference-game/v1/game/prerequisites/setup", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-CSRF-Token": csrfToken },
        body: JSON.stringify(request),
      });
    },
    async launchGame(request: GameLaunchRequestV1): Promise<void> {
      if (
        request.apiVersion !== 1 ||
        !isIdempotencyKey(request.idempotencyKey) ||
        !isSafeInteger(request.expectedInstanceGeneration, 1) ||
        !hasExactKeys(request as Record<string, unknown>, [
          "apiVersion",
          "idempotencyKey",
          "expectedInstanceGeneration",
        ])
      )
        throw new ComposedReferenceGameProtocolError("invalid_game_launch_request");
      if (csrfToken === undefined) throw new ComposedReferenceGameProtocolError("missing_composed_session");
      await exchangeEmpty(fetchLike, "/api/composed-reference-game/v1/game/launch", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-CSRF-Token": csrfToken },
        body: JSON.stringify(request),
      });
    },
    async stopGame(request: GameStopRequestV1): Promise<void> {
      if (
        request.apiVersion !== 1 ||
        !isIdempotencyKey(request.idempotencyKey) ||
        !isSafeInteger(request.expectedAttachmentGeneration, 1) ||
        !hasExactKeys(request as Record<string, unknown>, [
          "apiVersion",
          "idempotencyKey",
          "expectedAttachmentGeneration",
        ])
      )
        throw new ComposedReferenceGameProtocolError("invalid_game_stop_request");
      if (csrfToken === undefined) throw new ComposedReferenceGameProtocolError("missing_composed_session");
      await exchangeEmpty(fetchLike, "/api/composed-reference-game/v1/game/stop", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-CSRF-Token": csrfToken },
        body: JSON.stringify(request),
      });
    },
    async disconnectGame(request: GameDisconnectRequestV1): Promise<void> {
      if (
        request.apiVersion !== 1 ||
        !isIdempotencyKey(request.idempotencyKey) ||
        !isSafeInteger(request.expectedAttachmentGeneration, 1) ||
        !hasExactKeys(request as Record<string, unknown>, [
          "apiVersion",
          "idempotencyKey",
          "expectedAttachmentGeneration",
        ])
      )
        throw new ComposedReferenceGameProtocolError("invalid_game_disconnect_request");
      if (csrfToken === undefined) throw new ComposedReferenceGameProtocolError("missing_composed_session");
      await exchangeEmpty(fetchLike, "/api/composed-reference-game/v1/game/disconnect", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-CSRF-Token": csrfToken },
        body: JSON.stringify(request),
      });
    },
    async resumeGame(request: GameResumeRequestV1): Promise<GameResumeResultV1> {
      if (
        request.apiVersion !== 1 ||
        !isIdempotencyKey(request.idempotencyKey) ||
        !isSafeInteger(request.expectedAttachmentGeneration, 1) ||
        !hasExactKeys(request as Record<string, unknown>, [
          "apiVersion",
          "idempotencyKey",
          "expectedAttachmentGeneration",
        ])
      )
        throw new ComposedReferenceGameProtocolError("invalid_game_resume_request");
      if (csrfToken === undefined) throw new ComposedReferenceGameProtocolError("missing_composed_session");
      return exchange(
        fetchLike,
        "/api/composed-reference-game/v1/game/resume",
        {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-CSRF-Token": csrfToken },
          body: JSON.stringify(request),
        },
        validateGameResumeResult,
      );
    },
    async reopenGame(request: GameReopenRequestV1): Promise<GameReopenResultV1> {
      if (
        request.apiVersion !== 1 ||
        !isIdempotencyKey(request.idempotencyKey) ||
        !isSafeInteger(request.expectedAttachmentGeneration, 1) ||
        !hasExactKeys(request as Record<string, unknown>, [
          "apiVersion",
          "idempotencyKey",
          "expectedAttachmentGeneration",
        ])
      )
        throw new ComposedReferenceGameProtocolError("invalid_game_reopen_request");
      if (csrfToken === undefined) throw new ComposedReferenceGameProtocolError("missing_composed_session");
      return exchange(
        fetchLike,
        "/api/composed-reference-game/v1/game/reopen",
        {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-CSRF-Token": csrfToken },
          body: JSON.stringify(request),
        },
        validateGameReopenResult,
      );
    },
    async cancelResume(request: GameResumeCancelRequestV1): Promise<GameResumeCancelResultV1> {
      if (
        request.apiVersion !== 1 ||
        !isIdempotencyKey(request.idempotencyKey) ||
        !isSafeInteger(request.expectedAttachmentGeneration, 1) ||
        !hasExactKeys(request as Record<string, unknown>, [
          "apiVersion",
          "idempotencyKey",
          "expectedAttachmentGeneration",
        ])
      )
        throw new ComposedReferenceGameProtocolError("invalid_game_resume_cancel_request");
      if (csrfToken === undefined) throw new ComposedReferenceGameProtocolError("missing_composed_session");
      return exchange(
        fetchLike,
        "/api/composed-reference-game/v1/game/resume/cancel",
        {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-CSRF-Token": csrfToken },
          body: JSON.stringify(request),
        },
        validateGameResumeCancelResult,
      );
    },
    async createGameSession(request: GameCreateRequestV1): Promise<GameCreateResultV1> {
      if (
        request.apiVersion !== 1 ||
        !isIdempotencyKey(request.idempotencyKey) ||
        !isSafeId(request.integrationId) ||
        !(request.continuityIdentityId === null || isSafeId(request.continuityIdentityId)) ||
        !hasExactKeys(request as Record<string, unknown>, [
          "apiVersion",
          "idempotencyKey",
          "integrationId",
          "continuityIdentityId",
        ])
      )
        throw new ComposedReferenceGameProtocolError("invalid_game_create_request");
      if (csrfToken === undefined) throw new ComposedReferenceGameProtocolError("missing_composed_session");
      return exchange(
        fetchLike,
        "/api/composed-reference-game/v1/game/create",
        {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-CSRF-Token": csrfToken },
          body: JSON.stringify(request),
        },
        validateGameCreateResult,
      );
    },
    async endgameGame(request: GameEndgameRequestV1): Promise<GameEndgameResultV1> {
      if (
        request.apiVersion !== 1 ||
        !isIdempotencyKey(request.idempotencyKey) ||
        !isSafeInteger(request.expectedAttachmentGeneration, 1) ||
        request.confirm !== true ||
        !hasExactKeys(request as Record<string, unknown>, [
          "apiVersion",
          "idempotencyKey",
          "expectedAttachmentGeneration",
          "confirm",
        ])
      )
        throw new ComposedReferenceGameProtocolError("invalid_game_endgame_request");
      if (csrfToken === undefined) throw new ComposedReferenceGameProtocolError("missing_composed_session");
      return exchange(
        fetchLike,
        "/api/composed-reference-game/v1/game/endgame",
        {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-CSRF-Token": csrfToken },
          body: JSON.stringify(request),
        },
        validateGameEndgameResult,
      );
    },
    async readStardewPlayerSettings(): Promise<StardewPlayerSettingsV1> {
      return exchange(
        fetchLike,
        "/api/composed-reference-game/v1/game/stardew/settings",
        { method: "GET" },
        validateStardewPlayerSettings,
      );
    },
    async saveStardewPlayerSettings(request: StardewPlayerSettingsRequestV1): Promise<StardewPlayerSettingsV1> {
      if (
        request.apiVersion !== 1 ||
        !isSafeInteger(request.expectedRevision, 0) ||
        !Array.isArray(request.deniedActionFamilies) ||
        !request.deniedActionFamilies.every((familyId) => isSafeId(familyId)) ||
        !isSafeInteger(request.advanceDayMinimumOnlineFarmers, 1) ||
        request.advanceDayMinimumOnlineFarmers > 4 ||
        // Required keys present, and nothing outside the declared set: an optional member is admitted but never required, which
        // a length comparison cannot say.
        !SETTINGS_SAVE_REQUIRED_KEYS.every((key) => Object.hasOwn(request, key)) ||
        !Object.keys(request).every((key) => (SETTINGS_SAVE_KEYS as readonly string[]).includes(key)) ||
        (request.windowMode !== undefined && !isStardewWindowMode(request.windowMode)) ||
        (request.deniedActions !== undefined && !isDeniedActionIds(request.deniedActions))
      )
        throw new ComposedReferenceGameProtocolError("invalid_stardew_player_settings_request");
      if (csrfToken === undefined) throw new ComposedReferenceGameProtocolError("missing_composed_session");
      return exchange(
        fetchLike,
        "/api/composed-reference-game/v1/game/stardew/settings",
        {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-CSRF-Token": csrfToken },
          body: JSON.stringify(request),
        },
        validateStardewPlayerSettings,
      );
    },
    async readStardewCabins(): Promise<StardewCabinChoicesV1> {
      return exchange(
        fetchLike,
        "/api/composed-reference-game/v1/game/stardew/cabins",
        { method: "GET" },
        validateStardewCabinChoices,
      );
    },
    async readStardewInstallationDiscovery(): Promise<StardewInstallationDiscoveryV1> {
      return exchange(
        fetchLike,
        "/api/composed-reference-game/v1/game/installation/discovery",
        { method: "GET" },
        validateStardewInstallationDiscovery,
      );
    },
    async confirmStardewInstallation(candidateId: string): Promise<StardewInstallationMutationV1> {
      if (!isInstallationCandidateId(candidateId))
        throw new ComposedReferenceGameProtocolError("invalid_stardew_installation_candidate_id");
      if (csrfToken === undefined) throw new ComposedReferenceGameProtocolError("missing_composed_session");
      return exchange(
        fetchLike,
        "/api/composed-reference-game/v1/game/installation/discovery/confirm",
        {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-CSRF-Token": csrfToken },
          body: JSON.stringify({ apiVersion: 1, candidateId }),
        },
        validateStardewInstallationMutation,
      );
    },
    async retryStardewInstallationDiscovery(): Promise<StardewInstallationDiscoveryV1> {
      if (csrfToken === undefined) throw new ComposedReferenceGameProtocolError("missing_composed_session");
      return exchange(
        fetchLike,
        "/api/composed-reference-game/v1/game/installation/discovery/retry",
        {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-CSRF-Token": csrfToken },
          body: JSON.stringify({ apiVersion: 1 }),
        },
        validateStardewInstallationDiscovery,
      );
    },
    async cancelStardewInstallationDiscovery(): Promise<StardewInstallationMutationV1> {
      if (csrfToken === undefined) throw new ComposedReferenceGameProtocolError("missing_composed_session");
      return exchange(
        fetchLike,
        "/api/composed-reference-game/v1/game/installation/discovery/cancel",
        {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-CSRF-Token": csrfToken },
          body: JSON.stringify({ apiVersion: 1 }),
        },
        validateStardewInstallationMutation,
      );
    },
    async openStardewInstallationPicker(): Promise<StardewInstallationMutationV1> {
      if (csrfToken === undefined) throw new ComposedReferenceGameProtocolError("missing_composed_session");
      return exchange(
        fetchLike,
        "/api/composed-reference-game/v1/game/installation/discovery/manual-picker",
        {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-CSRF-Token": csrfToken },
          body: JSON.stringify({ apiVersion: 1 }),
        },
        validateStardewInstallationMutation,
      );
    },
    async installStardewModLoader(request: StardewModLoaderInstallRequestV1): Promise<StardewModLoaderInstallResultV1> {
      if (
        !isRecord(request) ||
        !hasExactKeys(request, ["apiVersion", "idempotencyKey"]) ||
        request.apiVersion !== 1 ||
        !isIdempotencyKey(request.idempotencyKey)
      )
        throw new ComposedReferenceGameProtocolError("invalid_stardew_mod_loader_install_request");
      if (csrfToken === undefined) throw new ComposedReferenceGameProtocolError("missing_composed_session");
      return exchange(
        fetchLike,
        "/api/composed-reference-game/v1/game/prerequisites/smapi",
        {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-CSRF-Token": csrfToken },
          body: JSON.stringify(request),
        },
        validateStardewModLoaderInstallResult,
      );
    },
    async confirmStardewCabin(request: StardewCabinConfirmationRequestV1): Promise<StardewCabinConfirmationV1> {
      if (
        request.apiVersion !== 1 ||
        !isIdempotencyKey(request.idempotencyKey) ||
        !isStardewChoiceHandle(request.choiceHandle) ||
        request.confirmed !== true ||
        !hasExactKeys(request as Record<string, unknown>, ["apiVersion", "idempotencyKey", "choiceHandle", "confirmed"])
      ) {
        throw new ComposedReferenceGameProtocolError("invalid_stardew_cabin_confirmation_request");
      }
      if (csrfToken === undefined) {
        throw new ComposedReferenceGameProtocolError("missing_composed_session");
      }
      return exchange(
        fetchLike,
        "/api/composed-reference-game/v1/game/stardew/cabins/confirm",
        {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-CSRF-Token": csrfToken },
          body: JSON.stringify(request),
        },
        validateStardewCabinConfirmation,
      );
    },
  });
}
