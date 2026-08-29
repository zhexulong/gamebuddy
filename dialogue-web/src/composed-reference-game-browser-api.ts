import {
  type TavernStateSnapshotV1,
  TavernProtocolError,
  validateSnapshot,
} from "./reference-pipeline-api.js";

/**
 * Browser-only boundary for the composed reference-game profile.
 *
 * The composed broker owns bootstrap/session identity and returns one strict
 * root. Nested Chat operations deliberately stay on the existing
 * `tavern_browser_api/v1` client; this module only owns the composed bootstrap
 * and authoritative state read. In particular, it never reads Tavern
 * `/bootstrap` or `/state` as a composed refresh source.
 */

export const COMPOSED_REFERENCE_GAME_BROWSER_API_V1 =
  "composed_reference_game_browser_api/v1" as const;
export const COMPOSED_REFERENCE_GAME_BROWSER_API_VERSION = 1 as const;
export const COMPOSED_REFERENCE_GAME_PROFILE_ID = "gamebuddy.composed.reference-game" as const;
export const COMPOSED_REFERENCE_GAME_TAVERN_PROFILE_ID =
  "gamebuddy.chat-core.reference-pipeline" as const;
export const COMPOSED_REFERENCE_GAME_PROFILE_ID_GAME = "gamebuddy.game.preview" as const;

const BASE64URL_ALPHABET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
const OPAQUE_HANDLE_PATTERN = /^[A-Za-z0-9_-]{22,128}$/;
const STALE_CABIN_HANDOFF_CODE = "stardew_cabin_choice_stale" as const;
const CABIN_CONFLICT_CODES = ["idempotency_conflict", "game_operation_in_progress"] as const;
const UNCERTAIN_CABIN_HANDOFF_CODE = "stardew_manifest_handoff_uncertain" as const;
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
  "stopped",
  "failed",
  "disconnected",
] as const;
const OUTCOMES = ["none", "succeeded", "failed", "cancelled"] as const;
const PROBLEM_CODES = [
  "closed",
  "unauthorized",
  "malformed_request",
  "state_unavailable",
  "not_found",
  "game_attachment_conflict",
  "game_runtime_unavailable",
  "game_unavailable",
  "game_prerequisites_missing",
  STALE_CABIN_HANDOFF_CODE,
  ...CABIN_CONFLICT_CODES,
  UNCERTAIN_CABIN_HANDOFF_CODE,
] as const;
const CABIN_CHOICES_KEYS = ["apiVersion", "choices"] as const;
const CABIN_CHOICE_KEYS = ["displayLabel", "availability", "choiceHandle", "expiresAtMs"] as const;
const CABIN_CONFIRMATION_KEYS = ["apiVersion", "status"] as const;

const ROOT_KEYS = ["apiVersion", "build", "chat", "game"] as const;
const ROOT_BUILD_KEYS = ["browserContract", "profileId"] as const;
const GAME_KEYS = [
  "prerequisites",
  "instance",
  "compatibility",
  "attachment",
  "connectionStatus",
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
const GAME_INSTANCE_KEYS = ["status", "gameTitle"] as const;
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

  constructor(code: string, status: number, requestId: string | null = null) {
    super("composed reference game request was rejected");
    this.name = "ComposedReferenceGameProblemError";
    this.code = code;
    this.status = status;
    this.requestId = requestId;
    this.retryable = status >= 500 || code === "state_unavailable";
  }
}

export type StardewCabinChoiceV1 = Readonly<{
  displayLabel: string;
  availability: "available";
  choiceHandle: string;
  expiresAtMs: number;
}>;

export type StardewCabinChoicesV1 = Readonly<{
  apiVersion: 1;
  choices: readonly StardewCabinChoiceV1[];
}>;

export type StardewCabinConfirmationRequestV1 = Readonly<{
  apiVersion: 1;
  idempotencyKey: string;
  choiceHandle: string;
  confirmed: true;
}>;

export type GameSetupRequestV1 = Readonly<{
  apiVersion: 1;
  idempotencyKey: string;
}>;

export type GameStopRequestV1 = Readonly<{
  apiVersion: 1;
  idempotencyKey: string;
  expectedAttachmentGeneration: number;
}>;

export type GameDisconnectRequestV1 = Readonly<{
  apiVersion: 1;
  idempotencyKey: string;
  expectedAttachmentGeneration: number;
}>;

export type StardewCabinConfirmationV1 = Readonly<{
  apiVersion: 1;
  status: "manifest_admitted";
}>;

export type ComposedReferenceGameBrowserApi = Readonly<{
  bootstrap(bootstrapToken: string): Promise<ComposedReferenceGameBrowserRootV1>;
  readState(): Promise<ComposedReferenceGameBrowserRootV1>;
  setupGame(request: GameSetupRequestV1): Promise<void>;
  stopGame(request: GameStopRequestV1): Promise<void>;
  disconnectGame(request: GameDisconnectRequestV1): Promise<void>;
  readStardewCabins(): Promise<StardewCabinChoicesV1>;
  confirmStardewCabin(request: StardewCabinConfirmationRequestV1): Promise<StardewCabinConfirmationV1>;
}>;

/** Alias retained for callers that use the broker's client terminology. */
export type ComposedReferenceGameBrowserClient = ComposedReferenceGameBrowserApi;

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
  return value.length % 4 === 0 ||
    (value.length % 4 === 2 ? finalIndex % 16 === 0 : finalIndex % 4 === 0);
}

function isOpaqueHandle(value: unknown): value is string {
  return typeof value === "string" &&
    OPAQUE_HANDLE_PATTERN.test(value) &&
    isCanonicalUnpaddedBase64Url(value);
}

function isCanonicalBase64UrlBytes(value: unknown, byteLength: number): value is string {
  return typeof value === "string" &&
    value.length === Math.ceil(byteLength * 8 / 6) &&
    isCanonicalUnpaddedBase64Url(value);
}

function isStardewChoiceHandle(value: unknown): value is string {
  return isCanonicalBase64UrlBytes(value, 32);
}

function isIdempotencyKey(value: unknown): value is string {
  return isCanonicalBase64UrlBytes(value, 16);
}

function isNullableLabel(value: unknown, maximum: number): value is string | null {
  return value === null || isBoundedString(value, 1, maximum);
}

function validateStardewCabinChoices(value: unknown): StardewCabinChoicesV1 {
  if (!isRecord(value) || !hasExactKeys(value, CABIN_CHOICES_KEYS) || value.apiVersion !== 1 || !Array.isArray(value.choices) || value.choices.length > MAX_CABIN_CHOICES) {
    throw new ComposedReferenceGameProtocolError("invalid_stardew_cabin_choices");
  }
  const choices: StardewCabinChoiceV1[] = [];
  for (const choice of value.choices) {
    if (!isRecord(choice) ||
        !hasExactKeys(choice, CABIN_CHOICE_KEYS) ||
        !isBoundedString(choice.displayLabel, 1, MAX_CABIN_DISPLAY_LABEL_LENGTH) ||
        choice.availability !== "available" ||
        !isStardewChoiceHandle(choice.choiceHandle) ||
        !isSafeInteger(choice.expiresAtMs, 0)) {
      throw new ComposedReferenceGameProtocolError("invalid_stardew_cabin_choice");
    }
    choices.push(Object.freeze({
      displayLabel: choice.displayLabel,
      availability: choice.availability,
      choiceHandle: choice.choiceHandle,
      expiresAtMs: choice.expiresAtMs,
    }));
  }
  return Object.freeze({ apiVersion: 1, choices: Object.freeze(choices) });
}

function validateStardewCabinConfirmation(value: unknown): StardewCabinConfirmationV1 {
  if (!isRecord(value) ||
      !hasExactKeys(value, CABIN_CONFIRMATION_KEYS) ||
      value.apiVersion !== 1 ||
      value.status !== "manifest_admitted") {
    throw new ComposedReferenceGameProtocolError("invalid_stardew_cabin_confirmation");
  }
  return Object.freeze({ apiVersion: 1, status: "manifest_admitted" });
}

function isGameProjection(value: unknown): value is GameBrowserStateV1 {
  if (!isRecord(value) || !hasExactKeys(value, GAME_STATE_KEYS) || value.apiVersion !== 1) return false;
  if (!isRecord(value.build) ||
      !hasExactKeys(value.build, GAME_BUILD_KEYS) ||
      value.build.browserContract !== "game_browser_api/v1" ||
      value.build.profileId !== COMPOSED_REFERENCE_GAME_PROFILE_ID_GAME) {
    return false;
  }
  if (!isOpaqueHandle(value.csrfToken) ||
      !isRecord(value.browserSession) ||
      !hasExactKeys(value.browserSession, ["expiresAtMs"]) ||
      !isSafeInteger(value.browserSession.expiresAtMs, 0) ||
      !isRecord(value.game) ||
      !hasExactKeys(value.game, GAME_KEYS)) {
    return false;
  }

  const game = value.game;
  if (!isRecord(game.prerequisites) ||
      !hasExactKeys(game.prerequisites, GAME_PREREQUISITES_KEYS) ||
      !isOneOf(game.prerequisites.status, PREREQUISITE_STATUSES) ||
      !isNullableLabel(game.prerequisites.detectedGame, MAX_GAME_LABEL_LENGTH) ||
      !Array.isArray(game.prerequisites.missingItems) ||
      game.prerequisites.missingItems.length > MAX_GAME_MISSING_ITEMS ||
      !game.prerequisites.missingItems.every((item) => isBoundedString(item, 1, MAX_GAME_LABEL_LENGTH))) {
    return false;
  }
  if (!isRecord(game.instance) ||
      !hasExactKeys(game.instance, GAME_INSTANCE_KEYS) ||
      !isOneOf(game.instance.status, INSTANCE_STATUSES) ||
      !isNullableLabel(game.instance.gameTitle, MAX_GAME_LABEL_LENGTH)) {
    return false;
  }
  if (!isRecord(game.compatibility) ||
      !hasExactKeys(game.compatibility, GAME_COMPATIBILITY_KEYS) ||
      !isOneOf(game.compatibility.status, COMPATIBILITY_STATUSES) ||
      !isNullableLabel(game.compatibility.message, MAX_GAME_MESSAGE_LENGTH)) {
    return false;
  }
  if (!isRecord(game.attachment) ||
      !hasExactKeys(game.attachment, GAME_ATTACHMENT_KEYS) ||
      !isOneOf(game.attachment.status, ATTACHMENT_STATUSES) ||
      !isSafeInteger(game.attachment.generation, 0)) {
    return false;
  }
  if (!isOneOf(game.connectionStatus, CONNECTION_STATUSES) ||
      !(game.role === null || game.role === "player" || game.role === "companion") ||
      !isNullableLabel(game.companionName, MAX_GAME_LABEL_LENGTH) ||
      !isNullableLabel(game.selectedWorld, MAX_GAME_LABEL_LENGTH) ||
      !isNullableLabel(game.selectedSave, MAX_GAME_LABEL_LENGTH) ||
      !isRecord(game.capabilitySummary) ||
      !hasExactKeys(game.capabilitySummary, GAME_CAPABILITY_SUMMARY_KEYS) ||
      typeof game.capabilitySummary.available !== "boolean" ||
      !isSafeInteger(game.capabilitySummary.count, 0) ||
      game.capabilitySummary.count > 512 ||
      !isOneOf(game.latestOutcome, OUTCOMES)) {
    return false;
  }
  return true;
}

/**
 * Validates the exact composed root and both nested redacted projections.
 * Validation is closed at every object boundary: additive fields are not
 * silently ignored, and a foreign profile is never rendered as Game state.
 */
export function validateComposedReferenceGameRoot(
  value: unknown,
): ComposedReferenceGameBrowserRootV1 {
  if (!isRecord(value) ||
      !hasExactKeys(value, ROOT_KEYS) ||
      value.apiVersion !== 1 ||
      !isRecord(value.build) ||
      !hasExactKeys(value.build, ROOT_BUILD_KEYS) ||
      value.build.browserContract !== COMPOSED_REFERENCE_GAME_BROWSER_API_V1 ||
      value.build.profileId !== COMPOSED_REFERENCE_GAME_PROFILE_ID) {
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

function problemFromResponse(response: Response, value: unknown): ComposedReferenceGameProblemError {
  if (!isRecord(value) || !hasExactKeys(value, ["code"]) || !isOneOf(value.code, PROBLEM_CODES)) {
    throw new ComposedReferenceGameProtocolError("invalid_problem");
  }
  return new ComposedReferenceGameProblemError(value.code, response.status);
}

async function exchangeEmpty(
  fetchLike: typeof fetch,
  path: string,
  init: RequestInit,
): Promise<void> {
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
    async setupGame(request: GameSetupRequestV1): Promise<void> {
      if (request.apiVersion !== 1 || !isIdempotencyKey(request.idempotencyKey) ||
          !hasExactKeys(request as Record<string, unknown>, ["apiVersion", "idempotencyKey"]))
        throw new ComposedReferenceGameProtocolError("invalid_game_setup_request");
      if (csrfToken === undefined) throw new ComposedReferenceGameProtocolError("missing_composed_session");
      await exchangeEmpty(fetchLike, "/api/composed-reference-game/v1/game/prerequisites/setup", {
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
        !hasExactKeys(request as Record<string, unknown>, ["apiVersion", "idempotencyKey", "expectedAttachmentGeneration"])
      ) throw new ComposedReferenceGameProtocolError("invalid_game_stop_request");
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
        !hasExactKeys(request as Record<string, unknown>, ["apiVersion", "idempotencyKey", "expectedAttachmentGeneration"])
      ) throw new ComposedReferenceGameProtocolError("invalid_game_disconnect_request");
      if (csrfToken === undefined) throw new ComposedReferenceGameProtocolError("missing_composed_session");
      await exchangeEmpty(fetchLike, "/api/composed-reference-game/v1/game/disconnect", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-CSRF-Token": csrfToken },
        body: JSON.stringify(request),
      });
    },
    async readStardewCabins(): Promise<StardewCabinChoicesV1> {
      return exchange(
        fetchLike,
        "/api/composed-reference-game/v1/game/stardew/cabins",
        { method: "GET" },
        validateStardewCabinChoices,
      );
    },
    async confirmStardewCabin(
      request: StardewCabinConfirmationRequestV1,
    ): Promise<StardewCabinConfirmationV1> {
      if (request.apiVersion !== 1 ||
          !isIdempotencyKey(request.idempotencyKey) ||
          !isStardewChoiceHandle(request.choiceHandle) ||
          request.confirmed !== true ||
          !hasExactKeys(request as Record<string, unknown>, ["apiVersion", "idempotencyKey", "choiceHandle", "confirmed"])) {
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

export const createComposedReferenceGameBrowserClient = createComposedReferenceGameBrowserApi;

/** Re-exported for focused tests and browser composition diagnostics. */
export { TavernProtocolError };
