import { randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

import {
  ComposedReferenceGameBrowserValidatorsV1,
  type ComposedReferenceGameBrowserProfile,
  isComposedReferenceGameBrowserProfile,
} from "./composed-browser-contract/index.js";
import {
  TavernBrowserValidatorsV1,
  type TavernStateSnapshotV1,
} from "./tavern/browser-contract/index.js";
import {
  GameBrowserValidatorsV1,
  type GameBrowserStateV1,
  type GameCreateCommandV1,
  type GameCreateResultV1,
  type GameDisconnectCommandV1,
  type GameEndgameCommandV1,
  type GameEndgameResultV1,
  type GameLaunchCommandV1,
  type GamePrerequisitesSetupCommandV1,
  type GameResumeCancelCommandV1,
  type GameResumeCancelResultV1,
  type GameResumeCommandV1,
  type GameResumeResultV1,
  type GameSessionResumeCommandV1,
  type GameReopenActionAuthorityCommandV1,
  type GameReopenActionAuthorityResultV1,
  type GameStopCommandV1,
  type StardewCabinChoicesV1,
  type StardewCabinConfirmCommandV1,
  type StardewCabinConfirmResultV1,
  type GameDiscoveryReadResultV1,
  type GameDiscoveryConfirmCommandV1,
  type GameDiscoveryMutationResultV1,
  GAME_BROWSER_OPERATION_IDS_V1,
} from "./game-browser-contract/index.js";

export type ComposedReferenceGameBrowserReadContext = Readonly<{
  csrfToken: string;
  browserSessionExpiresAtMs: number;
}>;

export type ComposedReferenceGameBrowserRequestHandlerOptions = Readonly<{
  profile: ComposedReferenceGameBrowserProfile;
  bootstrapToken: string;
  readChat: (
    context: ComposedReferenceGameBrowserReadContext,
  ) => Promise<TavernStateSnapshotV1>;
  readGame?: (
    context: ComposedReferenceGameBrowserReadContext,
  ) => Promise<GameBrowserStateV1>;
  /**
   * The lifecycle activation seam: stage the owned player host for this authenticated
   * presentation session. It is the one command on this wire that carries no browser
   * command body at all, because everything it acts on is already authenticated here -
   * the admission names the exact browser session, and the owner derives the install,
   * registration and attempt from it. Its outcome stays private for the same reason:
   * the caller learns the staged state from the existing game state projection, not
   * from a second, invented lifecycle DTO.
   */
  gameActivate?: (
    admission: ComposedReferenceGameBrowserLifecycleActivationAdmission,
  ) => Promise<void>;
  gameSetup?: (
    admission: ComposedReferenceGameBrowserLifecycleActivationAdmission,
    command: GamePrerequisitesSetupCommandV1,
  ) => Promise<void>;
  gameLaunch?: (
    admission: ComposedReferenceGameBrowserLifecycleActivationAdmission,
    command: GameLaunchCommandV1,
  ) => Promise<void>;
  gameStop?: (
    admission: ComposedReferenceGameBrowserLifecycleActivationAdmission,
    command: GameStopCommandV1,
  ) => Promise<void>;
  gameResume?: (
    admission: ComposedReferenceGameBrowserLifecycleActivationAdmission,
    command: GameResumeCommandV1,
  ) => Promise<GameResumeResultV1>;
  gameResumeCancel?: (
    admission: ComposedReferenceGameBrowserLifecycleActivationAdmission,
    command: GameResumeCancelCommandV1,
  ) => Promise<GameResumeCancelResultV1>;
  gameCreate?: (
    admission: ComposedReferenceGameBrowserLifecycleActivationAdmission,
    command: GameCreateCommandV1,
  ) => Promise<GameCreateResultV1>;
  gameReopen?: (
    admission: ComposedReferenceGameBrowserLifecycleActivationAdmission,
    command: GameReopenActionAuthorityCommandV1,
  ) => Promise<GameReopenActionAuthorityResultV1>;
  gameDisconnect?: (
    admission: ComposedReferenceGameBrowserLifecycleActivationAdmission,
    command: GameDisconnectCommandV1,
  ) => Promise<void>;
  gameEndgame?: (
    admission: ComposedReferenceGameBrowserLifecycleActivationAdmission,
    command: GameEndgameCommandV1,
  ) => Promise<GameEndgameResultV1>;
  gameDiscovery?: Readonly<{
    read(admission: ComposedReferenceGameBrowserLifecycleActivationAdmission): Promise<GameDiscoveryReadResultV1>;
    confirm(admission: ComposedReferenceGameBrowserLifecycleActivationAdmission, command: GameDiscoveryConfirmCommandV1): Promise<GameDiscoveryMutationResultV1>;
    retry(admission: ComposedReferenceGameBrowserLifecycleActivationAdmission): Promise<GameDiscoveryReadResultV1>;
    cancel(admission: ComposedReferenceGameBrowserLifecycleActivationAdmission): Promise<GameDiscoveryMutationResultV1>;
    manualPicker(admission: ComposedReferenceGameBrowserLifecycleActivationAdmission): Promise<GameDiscoveryMutationResultV1>;
  }>;
  stardewCabins?: Readonly<{
    read(admission: ComposedReferenceGameBrowserLifecycleActivationAdmission): Promise<StardewCabinChoicesV1>;
    confirm(
      admission: ComposedReferenceGameBrowserLifecycleActivationAdmission,
      command: StardewCabinConfirmCommandV1,
    ): Promise<StardewCabinConfirmResultV1>;
  }>;
}>;

/**
 * The lifecycle activation binding one lifecycle owner supplies to the composed
 * reference-game browser surface: the admission issuer binding plus the exact
 * lifecycle command seams the composed handler exposes. A game integration
 * provider projects its private lifecycle activation owner into this shape, so
 * the composed static shell composition binds an owner whose game types and
 * coordinator object never cross the composition boundary.
 */
export type ComposedReferenceGameBrowserLifecycleActivationBindingSink = Readonly<{
  bindBrowserAdmissionIssuer(issuer: ComposedReferenceGameBrowserLifecycleActivationIssuer): void;
  /**
   * Lifecycle-owner activation seam. The owner returns its private activation
   * snapshot; the browser callback discards it, exactly as the launch seam's
   * private result is discarded.
   */
  activate?: (
    admission: ComposedReferenceGameBrowserLifecycleActivationAdmission,
  ) => Promise<unknown>;
  setupPlayerHost?: NonNullable<ComposedReferenceGameBrowserRequestHandlerOptions["gameSetup"]>;
  /** The lifecycle owner may return a private snapshot; the browser callback discards it. */
  launchPlayerHost?: (
    admission: ComposedReferenceGameBrowserLifecycleActivationAdmission,
    command: GameLaunchCommandV1,
  ) => Promise<unknown>;
  stopGame?: NonNullable<ComposedReferenceGameBrowserRequestHandlerOptions["gameStop"]>;
  disconnectGame?: NonNullable<ComposedReferenceGameBrowserRequestHandlerOptions["gameDisconnect"]>;
  endgameGame?: NonNullable<ComposedReferenceGameBrowserRequestHandlerOptions["gameEndgame"]>;
  reopenActionAuthority?: NonNullable<ComposedReferenceGameBrowserRequestHandlerOptions["gameReopen"]>;
  /**
   * Lifecycle-owner resume seam (session-keyed; the composed browser wire stays
   * session-less, so the wired adapter passes the strict command and the owner
   * fails closed on a missing session handle).
   */
  resume?: (
    admission: ComposedReferenceGameBrowserLifecycleActivationAdmission,
    command: GameSessionResumeCommandV1,
  ) => Promise<GameResumeResultV1>;
  createGameSession?: NonNullable<ComposedReferenceGameBrowserRequestHandlerOptions["gameCreate"]>;
  cancelResume?: NonNullable<ComposedReferenceGameBrowserRequestHandlerOptions["gameResumeCancel"]>;
  gameDiscovery?: NonNullable<ComposedReferenceGameBrowserRequestHandlerOptions["gameDiscovery"]>;
  readCabinChoices?: NonNullable<ComposedReferenceGameBrowserRequestHandlerOptions["stardewCabins"]>["read"];
  confirmCabinChoice?: NonNullable<ComposedReferenceGameBrowserRequestHandlerOptions["stardewCabins"]>["confirm"];
}>;

type BrowserSession = Readonly<{
  bearerToken: string;
  csrfToken: string;
  lifecycleSessionId: string;
  expiresAtMs: number;
}>;

type LifecycleActivationFacts = Readonly<{
  browserSessionId: string;
  expiresAtMs: number;
}>;

type JsonObject = Record<string, unknown>;

const BOOTSTRAP_PATH = "/api/composed-reference-game/v1/bootstrap";
const STATE_PATH = "/api/composed-reference-game/v1/state";
const GAME_PATH = "/api/composed-reference-game/v1/game";
const GAME_SETUP_PATH = `${GAME_PATH}/prerequisites/setup`;
const GAME_LAUNCH_PATH = `${GAME_PATH}/launch`;
const GAME_STOP_PATH = `${GAME_PATH}/stop`;
const GAME_RESUME_PATH = `${GAME_PATH}/resume`;
const GAME_RESUME_CANCEL_PATH = `${GAME_PATH}/resume/cancel`;
const GAME_REOPEN_PATH = `${GAME_PATH}/reopen`;
const GAME_DISCONNECT_PATH = `${GAME_PATH}/disconnect`;
const GAME_ENDGAME_PATH = `${GAME_PATH}/endgame`;
const GAME_CREATE_PATH = `${GAME_PATH}/create`;
const LIFECYCLE_ACTIVATE_PATH = "/api/composed-reference-game/v1/lifecycle/activate";
const DISCOVERY_PATH = `${GAME_PATH}/installation/discovery`;
const DISCOVERY_CONFIRM_PATH = `${DISCOVERY_PATH}/confirm`;
const DISCOVERY_RETRY_PATH = `${DISCOVERY_PATH}/retry`;
const DISCOVERY_CANCEL_PATH = `${DISCOVERY_PATH}/cancel`;
const DISCOVERY_PICKER_PATH = `${DISCOVERY_PATH}/manual-picker`;
const STARDEW_CABINS_PATH = "/api/composed-reference-game/v1/game/stardew/cabins";
const STARDEW_CABINS_CONFIRM_PATH = `${STARDEW_CABINS_PATH}/confirm`;
const SESSION_COOKIE_NAME = "gb_composed_reference_game_session";
const SESSION_DURATION_MS = 7_200_000;
const MAX_BOOTSTRAP_BODY_BYTES = 4_096;
const BOOTSTRAP_TOKEN_PATTERN = /^[A-Za-z0-9_-]{22,128}$/;

const INVALID_PROFILE_ERROR = "Invalid composed reference game browser profile.";
const INVALID_BOOTSTRAP_TOKEN_ERROR =
  "Invalid composed reference game browser bootstrap token.";
const INVALID_GAME_READER_ERROR =
  "Invalid composed reference game browser game reader configuration.";

class ControlledStateError extends Error {
  public constructor() {
    super("Composed reference game browser state is invalid.");
  }
}

function isRecord(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactOwnKeys(value: JsonObject, keys: readonly string[]): boolean {
  const ownKeys = Object.keys(value);
  return (
    ownKeys.length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key))
  );
}

function isExactJsonContentType(contentType: string | undefined): boolean {
  return contentType === "application/json";
}

function timingSafeStringEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return (
    leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes)
  );
}

function parseSingleCookie(
  cookieHeader: string | undefined,
  name: string,
): string | undefined {
  if (cookieHeader === undefined) {
    return undefined;
  }

  let value: string | undefined;
  for (const part of cookieHeader.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 1) {
      continue;
    }

    const cookieName = part.slice(0, separator).trim();
    if (cookieName !== name) {
      continue;
    }

    if (value !== undefined) {
      return undefined;
    }
    value = part.slice(separator + 1).trim();
  }

  return value;
}

function sendJson(
  response: ServerResponse,
  statusCode: number,
  body: unknown,
  headers: Readonly<Record<string, string>> = {},
): void {
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    ...headers,
  });
  response.end(JSON.stringify(body));
}

function sendProblem(response: ServerResponse, statusCode: number, code: string): void {
  sendJson(response, statusCode, { code });
}

function gameSetupProblemCode(error: unknown): string {
  if (!(error instanceof Error)) return "state_unavailable";
  switch (error.message) {
    case "stardew_game_setup_idempotency_conflict": return "idempotency_conflict";
    case "stardew_game_setup_in_progress": return "game_operation_in_progress";
    case "stardew_game_setup_failed": return "game_unavailable";
    case "stardew_player_host_launch_not_staged": return "game_prerequisites_missing";
    default: return "state_unavailable";
  }
}

function gameActivateProblemCode(error: unknown): string {
  if (!(error instanceof Error)) return "state_unavailable";
  switch (error.message) {
    case "stardew_lifecycle_activation_conflict": return "idempotency_conflict";
    case "stardew_lifecycle_activation_admission_invalid": return "unauthorized";
    case "stardew_lifecycle_closing": return "game_unavailable";
    default: return "state_unavailable";
  }
}

function gameLaunchProblemCode(error: unknown): string {
  if (!(error instanceof Error)) return "state_unavailable";
  switch (error.message) {
    case "stardew_game_instance_generation_conflict": return "game_instance_not_found";
    case "stardew_game_launch_idempotency_conflict": return "idempotency_conflict";
    case "stardew_game_launch_in_progress":
    case "stardew_game_setup_in_progress": return "game_operation_in_progress";
    case "stardew_player_host_launch_not_staged": return "game_prerequisites_missing";
    case "stardew_player_host_launch_failed":
    case "stardew_player_host_launch_quarantined":
    case "stardew_lifecycle_closing": return "game_unavailable";
    default: return "state_unavailable";
  }
}

function gameStopProblemCode(error: unknown): string {
  if (!(error instanceof Error)) return "state_unavailable";
  switch (error.message) {
    case "stardew_game_attachment_generation_conflict":
      return "game_attachment_conflict";
    case "stardew_game_runtime_unavailable":
      return "game_runtime_unavailable";
    case "stardew_game_stop_idempotency_conflict":
      return "idempotency_conflict";
    default:
      return "state_unavailable";
  }
}

function gameResumeProblemCode(error: unknown): string {
  if (!(error instanceof Error)) return "state_unavailable";
  switch (error.message) {
    case "stardew_game_attachment_generation_conflict":
      return "game_attachment_conflict";
    case "stardew_game_runtime_unavailable":
      return "game_runtime_unavailable";
    case "stardew_game_resume_idempotency_conflict":
      return "idempotency_conflict";
    case "stardew_game_resume_in_progress":
    case "stardew_game_create_in_progress":
      return "game_operation_in_progress";
    case "stardew_game_resume_cancelled":
      return "game_operation_in_progress";
    default:
      return "state_unavailable";
  }
}

function gameResumeCancelProblemCode(error: unknown): string {
  if (!(error instanceof Error)) return "state_unavailable";
  switch (error.message) {
    case "stardew_game_resume_cancel_idempotency_conflict":
      return "idempotency_conflict";
    case "stardew_game_resume_cancel_unavailable":
      return "game_unavailable";
    case "stardew_game_resume_cancel_conflict":
    case "stardew_game_attachment_generation_conflict":
      return "game_attachment_conflict";
    case "stardew_lifecycle_closing":
      return "game_unavailable";
    default:
      return "state_unavailable";
  }
}

function gameCreateProblemCode(error: unknown): string {
  if (!(error instanceof Error)) return "state_unavailable";
  switch (error.message) {
    case "stardew_game_create_idempotency_conflict":
      return "idempotency_conflict";
    case "stardew_game_create_in_progress":
      return "game_operation_in_progress";
    case "stardew_game_runtime_unavailable":
      return "game_runtime_unavailable";
    case "stardew_game_create_integration_conflict":
      return "game_unavailable";
    case "stardew_game_create_failed":
      return "game_storage_unavailable";
    case "stardew_lifecycle_closing":
      return "game_unavailable";
    default:
      return "state_unavailable";
  }
}

function gameReopenProblemCode(error: unknown): string {
  if (!(error instanceof Error)) return "state_unavailable";
  switch (error.message) {
    case "stardew_game_action_authority_not_paused":
      return "game_operation_in_progress";
    case "stardew_game_reopen_idempotency_conflict":
      return "idempotency_conflict";
    default:
      return "state_unavailable";
  }
}

function gameDisconnectProblemCode(error: unknown): string {
  if (!(error instanceof Error)) return "state_unavailable";
  switch (error.message) {
    case "stardew_game_attachment_generation_conflict":
      return "game_attachment_conflict";
    case "stardew_game_runtime_unavailable":
      return "game_runtime_unavailable";
    case "stardew_game_disconnect_idempotency_conflict":
      return "idempotency_conflict";
    case "stardew_game_disconnect_in_progress":
      return "game_operation_in_progress";
    default:
      return "state_unavailable";
  }
}

function gameEndgameProblemCode(error: unknown): string {
  if (!(error instanceof Error)) return "state_unavailable";
  switch (error.message) {
    case "stardew_game_attachment_generation_conflict":
      return "game_attachment_conflict";
    case "stardew_game_endgame_unavailable":
    case "stardew_lifecycle_closing":
      return "state_unavailable";
    case "stardew_game_endgame_idempotency_conflict":
      return "idempotency_conflict";
    case "stardew_contained_runtime_settlement_unavailable":
      return "game_endgame_settlement_unavailable";
    default:
      return "state_unavailable";
  }
}

function stardewCabinProblemCode(error: unknown): string {
  if (!(error instanceof Error)) return "state_unavailable";
  switch (error.message) {
    case "stardew_cabin_choice_handle_invalid":
    case "stardew_cabin_choice_session_conflict":
    case "stardew_cabin_choice_revision_stale":
    case "stardew_cabin_choice_expired":
    case "stardew_cabin_choice_consumed":
      return "stardew_cabin_choice_stale";
    case "stardew_cabin_idempotency_conflict":
      return "idempotency_conflict";
    case "stardew_cabin_confirmation_conflict":
      return "game_operation_in_progress";
    case "stardew_cabin_publication_uncertain":
      return "stardew_manifest_handoff_uncertain";
    default:
      return "state_unavailable";
  }
}

async function readBody(
  request: IncomingMessage,
  maximumBytes: number,
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let totalBytes = 0;

  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    totalBytes += bytes.length;
    if (totalBytes > maximumBytes) {
      throw new ControlledStateError();
    }
    chunks.push(bytes);
  }

  return Buffer.concat(chunks, totalBytes);
}

function parseBootstrapRequest(body: Buffer): string | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString("utf8"));
  } catch {
    return undefined;
  }

  if (
    !isRecord(parsed) ||
    !hasExactOwnKeys(parsed, ["apiVersion", "bootstrapToken"]) ||
    parsed.apiVersion !== 1 ||
    typeof parsed.bootstrapToken !== "string"
  ) {
    return undefined;
  }

  return parsed.bootstrapToken;
}

function isLiteralLoopbackOrigin(origin: URL): boolean {
  return origin.hostname === "127.0.0.1" || origin.hostname === "[::1]";
}

function requestHasExpectedHost(request: IncomingMessage, origin: URL): boolean {
  return request.headers.host === origin.host;
}

function hasEmptyRequestBodyHeaders(request: IncomingMessage): boolean {
  const contentLength = request.headers["content-length"];
  return (
    request.headers["transfer-encoding"] === undefined &&
    (contentLength === undefined || contentLength === "0")
  );
}

function isExactOrigin(request: IncomingMessage, origin: string): boolean {
  return request.headers.origin === origin;
}

function isSameOriginSafeGet(request: IncomingMessage, origin: string): boolean {
  const requestOrigin = request.headers.origin;
  if (requestOrigin !== undefined) {
    return requestOrigin === origin;
  }

  return request.headers["sec-fetch-site"] === "same-origin";
}

function isEmptyQuery(url: URL): boolean {
  return url.search === "";
}

/**
 * Runtime-branded opaque delegated-auth capability minted by the broker. It
 * carries no observable fields: a structural clone (including an
 * `Object.freeze` spread copy) or hand-written fake is not branded and every
 * broker-owned check fails closed before any Tavern operation.
 */
export type ComposedReferenceGameBrowserDelegatedAuthCapability = Readonly<object>;

/**
 * Broker-minted authenticated request context. It is opaque and branded with
 * the live broker session; only the guarded checks and projection below can
 * consume it, and only for requests this broker authenticated.
 */
export type ComposedReferenceGameBrowserAuthContext = Readonly<object>;

/**
 * Fieldless broker-owned capability for authenticating lifecycle activation
 * requests. It reveals no browser or request authority.
 */
export type ComposedReferenceGameBrowserLifecycleActivationIssuer = Readonly<object>;

/**
 * Fieldless, one-shot lifecycle activation admission. Its authority exists
 * only in this module's WeakMap and is bound to the issuing broker session.
 */
export type ComposedReferenceGameBrowserLifecycleActivationAdmission = Readonly<object>;

type DelegatedAuthState = Readonly<{
  /** Reads the broker's live session; an expired session is retired first. */
  currentSession(): BrowserSession | undefined;
}>;

const delegatedAuthCapabilities = new WeakSet<object>();
const delegatedAuthStates = new WeakMap<object, DelegatedAuthState>();
const delegatedAuthContextSessions = new WeakMap<object, BrowserSession>();

type LifecycleActivationIssuerState = Readonly<{
  currentSession(): BrowserSession | undefined;
}>;

type LifecycleAdmissionOperation =
  | "lifecycle_activation"
  | "cabin_read"
  | "discovery_read"
  | "discovery_confirm"
  | "discovery_retry"
  | "discovery_cancel"
  | "discovery_picker"
  | "cabin_confirm"
  | "game_setup"
  | "game_launch"
  | "game_stop"
  | "game_resume"
  | "game_resume_cancel"
  | "game_reopen"
  | "game_disconnect"
  | "game_endgame"
  | "game_create";

type LifecycleActivationAdmissionState = {
  readonly issuer: object;
  readonly session: BrowserSession;
  readonly operation: LifecycleAdmissionOperation;
  consumed: boolean;
};

const lifecycleActivationIssuers = new WeakMap<object, LifecycleActivationIssuerState>();
const lifecycleActivationAdmissions = new WeakMap<
  object,
  LifecycleActivationAdmissionState
>();

/**
 * Controlled allow/deny: true only for the exact broker-minted capability
 * object. Used by the internal delegated Tavern factory to reject forged
 * capabilities during construction, before any Tavern operation.
 */
export function isComposedReferenceGameBrowserDelegatedAuthCapability(
  value: unknown,
): value is ComposedReferenceGameBrowserDelegatedAuthCapability {
  return typeof value === "object" && value !== null && delegatedAuthCapabilities.has(value);
}

/**
 * Controlled allow/deny: verifies the request against the broker's own
 * session cookie, origin rules, and expiry. Returns a branded authenticated
 * context when admitted, or null when unauthenticated, forged, or closed.
 * The broker stays the sole session/CSRF owner; no raw session facts leave
 * through this seam.
 */
export function verifyComposedReferenceGameBrowserAuth(
  capability: ComposedReferenceGameBrowserDelegatedAuthCapability,
  request: IncomingMessage,
  origin: string,
): ComposedReferenceGameBrowserAuthContext | null {
  const state = delegatedAuthStates.get(capability);
  if (state === undefined || !isSameOriginSafeGet(request, origin)) {
    return null;
  }

  const activeSession = state.currentSession();
  const bearerToken = parseSingleCookie(request.headers.cookie, SESSION_COOKIE_NAME);
  if (
    activeSession === undefined ||
    activeSession.expiresAtMs <= Date.now() ||
    bearerToken === undefined ||
    !timingSafeStringEqual(bearerToken, activeSession.bearerToken)
  ) {
    return null;
  }

  const context = Object.freeze({});
  delegatedAuthContextSessions.set(context, activeSession);
  return context;
}

function singleHeaderValue(value: string | string[] | undefined): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/**
 * Controlled allow/deny: constant-time CSRF comparison bound to the exact
 * verified broker session. Any other or forged context is denied.
 */
export function checkComposedReferenceGameBrowserAuthCsrf(
  context: ComposedReferenceGameBrowserAuthContext,
  request: IncomingMessage,
): boolean {
  const activeSession = delegatedAuthContextSessions.get(context);
  if (activeSession === undefined) {
    return false;
  }
  const submitted = singleHeaderValue(request.headers["x-csrf-token"]);
  return submitted !== undefined && timingSafeStringEqual(submitted, activeSession.csrfToken);
}

/**
 * Brokers the exact wire-visible projection values for the already-verified
 * request. Only the internal delegated Tavern handler consumes this to render
 * the mounted Chat snapshot body; a forged or foreign context is rejected.
 */
export function composedReferenceGameBrowserAuthProjection(
  context: ComposedReferenceGameBrowserAuthContext,
): Readonly<{ csrfToken: string; browserSessionExpiresAtMs: number }> {
  const activeSession = delegatedAuthContextSessions.get(context);
  if (activeSession === undefined) {
    throw new Error("composed_reference_game_auth_context_invalid");
  }
  return Object.freeze({
    csrfToken: activeSession.csrfToken,
    browserSessionExpiresAtMs: activeSession.expiresAtMs,
  });
}

/**
 * Authenticates a prospective lifecycle activation without dispatching a
 * route. Successful admissions are fieldless, session-bound, and one-shot.
 */
export function issueComposedReferenceGameBrowserLifecycleActivationAdmission(
  issuer: ComposedReferenceGameBrowserLifecycleActivationIssuer,
  request: IncomingMessage,
  origin: string,
): ComposedReferenceGameBrowserLifecycleActivationAdmission | null {
  const issuerState = lifecycleActivationIssuers.get(issuer);
  if (issuerState === undefined) {
    return null;
  }

  let originUrl: URL;
  let requestUrl: URL;
  try {
    originUrl = new URL(origin);
    requestUrl = new URL(request.url ?? "/", originUrl);
  } catch {
    return null;
  }

  if (!isEmptyQuery(requestUrl)) {
    return null;
  }

  let operation: LifecycleAdmissionOperation;
  if (request.method === "POST" && requestUrl.pathname === LIFECYCLE_ACTIVATE_PATH) {
    operation = "lifecycle_activation";
  } else if (request.method === "GET" && requestUrl.pathname === DISCOVERY_PATH) {
    operation = "discovery_read";
  } else if (request.method === "POST" && requestUrl.pathname === DISCOVERY_CONFIRM_PATH) {
    operation = "discovery_confirm";
  } else if (request.method === "POST" && requestUrl.pathname === DISCOVERY_RETRY_PATH) {
    operation = "discovery_retry";
  } else if (request.method === "POST" && requestUrl.pathname === DISCOVERY_CANCEL_PATH) {
    operation = "discovery_cancel";
  } else if (request.method === "POST" && requestUrl.pathname === DISCOVERY_PICKER_PATH) {
    operation = "discovery_picker";
  } else if (request.method === "GET" && requestUrl.pathname === STARDEW_CABINS_PATH) {
    operation = "cabin_read";
  } else if (request.method === "POST" && requestUrl.pathname === STARDEW_CABINS_CONFIRM_PATH) {
    operation = "cabin_confirm";
  } else if (request.method === "POST" && requestUrl.pathname === GAME_SETUP_PATH) {
    operation = "game_setup";
  } else if (request.method === "POST" && requestUrl.pathname === GAME_LAUNCH_PATH) {
    operation = "game_launch";
  } else if (request.method === "POST" && requestUrl.pathname === GAME_STOP_PATH) {
    operation = "game_stop";
  } else if (request.method === "POST" && requestUrl.pathname === GAME_RESUME_PATH) {
    operation = "game_resume";
  } else if (request.method === "POST" && requestUrl.pathname === GAME_RESUME_CANCEL_PATH) {
    operation = "game_resume_cancel";
  } else if (request.method === "POST" && requestUrl.pathname === GAME_REOPEN_PATH) {
    operation = "game_reopen";
  } else if (request.method === "POST" && requestUrl.pathname === GAME_DISCONNECT_PATH) {
    operation = "game_disconnect";
  } else if (request.method === "POST" && requestUrl.pathname === GAME_ENDGAME_PATH) {
    operation = "game_endgame";
  } else if (request.method === "POST" && requestUrl.pathname === GAME_CREATE_PATH) {
    operation = "game_create";
  } else {
    return null;
  }

  if (
    originUrl.protocol !== "http:" ||
    !isLiteralLoopbackOrigin(originUrl) ||
    requestUrl.origin !== originUrl.origin ||
    !requestHasExpectedHost(request, originUrl) ||
    (request.method === "POST"
      ? (!isExactOrigin(request, origin) || !isExactJsonContentType(singleHeaderValue(request.headers["content-type"])))
      : !isSameOriginSafeGet(request, origin))
  ) {
    return null;
  }

  const activeSession = issuerState.currentSession();
  const bearerToken = parseSingleCookie(request.headers.cookie, SESSION_COOKIE_NAME);
  const submittedCsrf = singleHeaderValue(request.headers["x-csrf-token"]);
  if (
    activeSession === undefined ||
    activeSession.expiresAtMs <= Date.now() ||
    bearerToken === undefined ||
    !timingSafeStringEqual(bearerToken, activeSession.bearerToken) ||
    (request.method === "POST" &&
      (submittedCsrf === undefined || !timingSafeStringEqual(submittedCsrf, activeSession.csrfToken)))
  ) {
    return null;
  }

  const admission: ComposedReferenceGameBrowserLifecycleActivationAdmission =
    Object.freeze({});
  lifecycleActivationAdmissions.set(admission, {
    issuer,
    session: activeSession,
    operation,
    consumed: false,
  });
  return admission;
}

/**
 * Consumes an admission exactly once. Consumption is recorded synchronously
 * before the callback starts; the callback receives only the broker-minted
 * lifecycle browser-session identity and absolute expiry.
 */
export function consumeComposedReferenceGameBrowserLifecycleActivationAdmission<T>(
  issuer: ComposedReferenceGameBrowserLifecycleActivationIssuer,
  admission: ComposedReferenceGameBrowserLifecycleActivationAdmission,
  expectedOperation: LifecycleAdmissionOperation,
  callback: (facts: LifecycleActivationFacts) => T,
): T | undefined {
  const admissionState = lifecycleActivationAdmissions.get(admission);
  if (admissionState === undefined || admissionState.consumed) {
    return undefined;
  }

  const issuerState = lifecycleActivationIssuers.get(issuer);
  const activeSession = issuerState?.currentSession();
  if (
    admissionState.issuer !== issuer ||
    admissionState.operation !== expectedOperation ||
    activeSession === undefined ||
    activeSession !== admissionState.session ||
    activeSession.expiresAtMs <= Date.now()
  ) {
    return undefined;
  }

  // This is the one-shot linearization point, after authority validation but
  // synchronously before user code can run or re-enter.
  admissionState.consumed = true;
  return callback(Object.freeze({
    browserSessionId: activeSession.lifecycleSessionId,
    expiresAtMs: activeSession.expiresAtMs,
  }));
}

export type ComposedReferenceGameBrowserRequestHandler = Readonly<{
  handle(request: IncomingMessage, response: ServerResponse, origin: string): void;
  /**
   * Broker-minted runtime-branded opaque delegated-auth capability. The
   * broker stays the sole bootstrap/cookie/session/CSRF owner; this opaque
   * handle plus the guarded checks above are the only delegation surface for
   * the composed shell. A forged capability fails before any Tavern operation.
   */
  readonly delegatedAuthCapability: ComposedReferenceGameBrowserDelegatedAuthCapability;
  /** Fieldless capability for an internal lifecycle coordinator. */
  readonly lifecycleActivationIssuer: ComposedReferenceGameBrowserLifecycleActivationIssuer;
  close(): Promise<void>;
}>;

export function createComposedReferenceGameBrowserRequestHandler(
  options: ComposedReferenceGameBrowserRequestHandlerOptions,
): ComposedReferenceGameBrowserRequestHandler {
  if (!isComposedReferenceGameBrowserProfile(options.profile)) {
    throw new Error(INVALID_PROFILE_ERROR);
  }
  if (!BOOTSTRAP_TOKEN_PATTERN.test(options.bootstrapToken)) {
    throw new Error(INVALID_BOOTSTRAP_TOKEN_ERROR);
  }
  if (
    (options.profile.gameProfile === null && options.readGame !== undefined) ||
    (options.profile.gameProfile !== null && options.readGame === undefined)
  ) {
    throw new Error(INVALID_GAME_READER_ERROR);
  }
  const discoveryOperationIds: readonly (typeof GAME_BROWSER_OPERATION_IDS_V1[number])[] = ["game.installation.discovery.read", "game.installation.discovery.confirm", "game.installation.discovery.retry", "game.installation.discovery.cancel", "game.installation.discovery.manual_picker"];
  const discoveryOperationsMounted = discoveryOperationIds.map((id) => options.profile.gameProfile?.operationIds.includes(id) === true);
  const discoveryMounted = discoveryOperationsMounted.some(Boolean);
  const discoveryCallbacksMounted =
    options.gameDiscovery !== undefined &&
    typeof options.gameDiscovery.read === "function" &&
    typeof options.gameDiscovery.confirm === "function" &&
    typeof options.gameDiscovery.retry === "function" &&
    typeof options.gameDiscovery.cancel === "function" &&
    typeof options.gameDiscovery.manualPicker === "function";
  if (discoveryMounted !== discoveryCallbacksMounted || discoveryOperationsMounted.some((mounted) => mounted !== discoveryMounted)) {
    throw new Error("Composed reference-game discovery operations are mismounted");
  }
  const cabinOperationIds = ["game.stardew.cabins.read", "game.stardew.cabins.confirm"] as const;
  const cabinOperationsMounted = cabinOperationIds.map((id) => options.profile.gameProfile?.operationIds.includes(id) === true);
  const cabinMounted = cabinOperationsMounted.some(Boolean);
  const cabinCallbacksMounted =
    options.stardewCabins !== undefined &&
    typeof options.stardewCabins.read === "function" &&
    typeof options.stardewCabins.confirm === "function";
  if (
    cabinMounted !== cabinCallbacksMounted ||
    cabinOperationsMounted.some((mounted) => mounted !== cabinMounted)
  ) {
    throw new Error("Composed reference-game cabin operations are mismounted");
  }
  const gameSetupMounted = options.profile.gameProfile?.operationIds.includes("game.prerequisites.setup") === true;
  if (gameSetupMounted !== (options.gameSetup !== undefined)) {
    throw new Error("Composed reference-game setup operation is mismounted");
  }
  const gameLaunchMounted = options.profile.gameProfile?.operationIds.includes("game.launch") === true;
  if (gameLaunchMounted !== (options.gameLaunch !== undefined)) {
    throw new Error("Composed reference-game launch operation is mismounted");
  }
  const gameStopMounted = options.profile.gameProfile?.operationIds.includes("game.stop") === true;
  if (gameStopMounted !== (options.gameStop !== undefined)) {
    throw new Error("Composed reference-game stop operation is mismounted");
  }
  const gameResumeMounted = options.profile.gameProfile?.operationIds.includes("game.resume") === true;
  if (gameResumeMounted !== (options.gameResume !== undefined)) {
    throw new Error("Composed reference-game resume operation is mismounted");
  }
  const gameResumeCancelMounted = options.profile.gameProfile?.operationIds.includes("game.resume.cancel") === true;
  if (gameResumeCancelMounted !== (options.gameResumeCancel !== undefined)) {
    throw new Error("Composed reference-game resume cancel operation is mismounted");
  }
  const gameCreateMounted = options.profile.gameProfile?.operationIds.includes("game.create") === true;
  if (gameCreateMounted !== (options.gameCreate !== undefined)) {
    throw new Error("Composed reference-game create operation is mismounted");
  }
  const gameReopenMounted = options.profile.gameProfile?.operationIds.includes("game.reopen") === true;
  if (gameReopenMounted !== (options.gameReopen !== undefined)) {
    throw new Error("Composed reference-game reopen operation is mismounted");
  }
  const gameDisconnectMounted = options.profile.gameProfile?.operationIds.includes("game.disconnect") === true;
  if (gameDisconnectMounted !== (options.gameDisconnect !== undefined)) {
    throw new Error("Composed reference-game disconnect operation is mismounted");
  }
  const gameEndgameMounted = options.profile.gameProfile?.operationIds.includes("game.endgame") === true;
  if (gameEndgameMounted !== (options.gameEndgame !== undefined)) {
    throw new Error("Composed reference-game endgame operation is mismounted");
  }

  let closed = false;
  let bootstrapConsumed = false;
  let session: BrowserSession | undefined;
  const dispatches = new Set<Promise<void>>();

  const delegatedAuthCapability: ComposedReferenceGameBrowserDelegatedAuthCapability = Object.freeze({});
  delegatedAuthCapabilities.add(delegatedAuthCapability);
  const currentSession = (): BrowserSession | undefined => {
    if (closed) {
      return undefined;
    }
    if (session !== undefined && session.expiresAtMs <= Date.now()) {
      session = undefined;
    }
    return session;
  };
  delegatedAuthStates.set(delegatedAuthCapability, { currentSession });

  const lifecycleActivationIssuer: ComposedReferenceGameBrowserLifecycleActivationIssuer =
    Object.freeze({});
  lifecycleActivationIssuers.set(lifecycleActivationIssuer, { currentSession });

  const createContext = (activeSession: BrowserSession): ComposedReferenceGameBrowserReadContext =>
    Object.freeze({
      csrfToken: activeSession.csrfToken,
      browserSessionExpiresAtMs: activeSession.expiresAtMs,
    });

  const readComposedRoot = async (
    context: ComposedReferenceGameBrowserReadContext,
  ): Promise<unknown> => {
    let chat: TavernStateSnapshotV1;
    let game: GameBrowserStateV1 | null = null;
    try {
      chat = await options.readChat(context);
      if (options.readGame !== undefined) {
        game = await options.readGame(context);
      }
    } catch {
      throw new ControlledStateError();
    }

    if (
      !TavernBrowserValidatorsV1.TavernStateSnapshotV1Schema.Check(chat) ||
      chat.build.profileId !== options.profile.tavernProfile.profileId ||
      chat.csrfToken !== context.csrfToken ||
      chat.browserSession.expiresAtMs !== context.browserSessionExpiresAtMs
    ) {
      throw new ControlledStateError();
    }

    if (game !== null) {
      if (
        options.profile.gameProfile === null ||
        !GameBrowserValidatorsV1.GameBrowserStateV1Schema.Check(game) ||
        game.build.profileId !== options.profile.gameProfile.profileId ||
        game.csrfToken !== context.csrfToken ||
        game.browserSession.expiresAtMs !== context.browserSessionExpiresAtMs
      ) {
        throw new ControlledStateError();
      }
    }

    const composed = {
      apiVersion: 1,
      build: {
        browserContract: "composed_reference_game_browser_api/v1",
        profileId: "gamebuddy.composed.reference-game",
      },
      chat,
      game,
    };

    if (
      !ComposedReferenceGameBrowserValidatorsV1.ComposedReferenceGameBrowserRootV1Schema.Check(
        composed,
      )
    ) {
      throw new ControlledStateError();
    }

    return composed;
  };

  const readGame = async (
    context: ComposedReferenceGameBrowserReadContext,
  ): Promise<GameBrowserStateV1> => {
    if (options.readGame === undefined || options.profile.gameProfile === null) {
      throw new ControlledStateError();
    }

    let game: GameBrowserStateV1;
    try {
      game = await options.readGame(context);
    } catch {
      throw new ControlledStateError();
    }

    if (
      !GameBrowserValidatorsV1.GameBrowserStateV1Schema.Check(game) ||
      game.build.profileId !== options.profile.gameProfile.profileId ||
      game.csrfToken !== context.csrfToken ||
      game.browserSession.expiresAtMs !== context.browserSessionExpiresAtMs
    ) {
      throw new ControlledStateError();
    }

    return game;
  };

  const dispatch = async (
    request: IncomingMessage,
    response: ServerResponse,
    origin: string,
  ): Promise<void> => {
    if (closed) {
      sendProblem(response, 503, "closed");
      return;
    }

    let originUrl: URL;
    let requestUrl: URL;
    try {
      originUrl = new URL(origin);
      requestUrl = new URL(request.url ?? "/", originUrl);
    } catch {
      sendProblem(response, 401, "unauthorized");
      return;
    }

    if (
      originUrl.protocol !== "http:" ||
      !isLiteralLoopbackOrigin(originUrl) ||
      requestUrl.origin !== originUrl.origin ||
      !requestHasExpectedHost(request, originUrl)
    ) {
      sendProblem(response, 401, "unauthorized");
      return;
    }

    if (request.method === "POST" && requestUrl.pathname === BOOTSTRAP_PATH) {
      if (!isEmptyQuery(requestUrl)) {
        sendProblem(response, 409, "malformed_request");
        return;
      }
      if (!isExactOrigin(request, origin)) {
        sendProblem(response, 401, "unauthorized");
        return;
      }
      if (!isExactJsonContentType(request.headers["content-type"])) {
        sendProblem(response, 409, "malformed_request");
        return;
      }

      let body: Buffer;
      try {
        body = await readBody(request, MAX_BOOTSTRAP_BODY_BYTES);
      } catch {
        sendProblem(response, 409, "malformed_request");
        return;
      }

      const submittedToken = parseBootstrapRequest(body);
      if (
        submittedToken === undefined ||
        bootstrapConsumed ||
        !timingSafeStringEqual(submittedToken, options.bootstrapToken)
      ) {
        sendProblem(response, 401, "unauthorized");
        return;
      }

      bootstrapConsumed = true;
      const activeSession: BrowserSession = {
        bearerToken: randomBytes(32).toString("base64url"),
        csrfToken: randomBytes(32).toString("base64url"),
        lifecycleSessionId: randomBytes(32).toString("base64url"),
        expiresAtMs: Date.now() + SESSION_DURATION_MS,
      };
      session = activeSession;

      try {
        const composed = await readComposedRoot(createContext(activeSession));
        sendJson(response, 200, composed, {
          "set-cookie": `${SESSION_COOKIE_NAME}=${activeSession.bearerToken}; HttpOnly; SameSite=Strict; Path=/`,
        });
      } catch {
        // A session becomes usable only after its first authoritative root
        // projection validates; a broken producer cannot leave an authenticated
        // browser context behind for a later retry.
        if (session === activeSession) session = undefined;
        sendProblem(response, 409, "state_unavailable");
      }
      return;
    }

    if (requestUrl.pathname === DISCOVERY_PATH && request.method === "GET") {
      if (!isEmptyQuery(requestUrl) || !hasEmptyRequestBodyHeaders(request) || options.gameDiscovery === undefined) {
        sendProblem(response, options.gameDiscovery === undefined ? 404 : 409, options.gameDiscovery === undefined ? "not_found" : "malformed_request");
        return;
      }
      const admission = issueComposedReferenceGameBrowserLifecycleActivationAdmission(lifecycleActivationIssuer, request, origin);
      if (admission === null) { sendProblem(response, 401, "unauthorized"); return; }
      try {
        const result = await options.gameDiscovery.read(admission);
        if (result === undefined) { sendProblem(response, 409, "state_unavailable"); return; }
        if (!GameBrowserValidatorsV1.GameDiscoveryReadResultV1Schema.Check(result)) { sendProblem(response, 409, "state_unavailable"); return; }
        sendJson(response, 200, result);
      } catch { sendProblem(response, 503, "game_unavailable"); }
      return;
    }
    if (request.method === "POST" && [DISCOVERY_CONFIRM_PATH, DISCOVERY_RETRY_PATH, DISCOVERY_CANCEL_PATH, DISCOVERY_PICKER_PATH].includes(requestUrl.pathname)) {
      if (!isEmptyQuery(requestUrl) || options.gameDiscovery === undefined) {
        sendProblem(response, options.gameDiscovery === undefined ? 404 : 409, options.gameDiscovery === undefined ? "not_found" : "malformed_request");
        return;
      }
      const operation = requestUrl.pathname === DISCOVERY_CONFIRM_PATH ? "discovery_confirm" : requestUrl.pathname === DISCOVERY_RETRY_PATH ? "discovery_retry" : requestUrl.pathname === DISCOVERY_CANCEL_PATH ? "discovery_cancel" : "discovery_picker";
      const admission = issueComposedReferenceGameBrowserLifecycleActivationAdmission(lifecycleActivationIssuer, request, origin);
      if (admission === null) { sendProblem(response, 401, "unauthorized"); return; }
      let command: unknown;
      try {
        command = JSON.parse((await readBody(request, MAX_BOOTSTRAP_BODY_BYTES)).toString("utf8"));
      } catch {
        sendProblem(response, 409, "malformed_request");
        return;
      }
      if (
        (operation === "discovery_confirm" && !GameBrowserValidatorsV1.GameDiscoveryConfirmCommandV1Schema.Check(command)) ||
        (operation !== "discovery_confirm" && !GameBrowserValidatorsV1.GameDiscoveryActionCommandV1Schema.Check(command))
      ) {
        sendProblem(response, 409, "malformed_request");
        return;
      }
      try {
        const result = operation === "discovery_confirm"
          ? await options.gameDiscovery.confirm(admission, command as GameDiscoveryConfirmCommandV1)
          : operation === "discovery_retry"
            ? await options.gameDiscovery.retry(admission)
            : operation === "discovery_cancel"
              ? await options.gameDiscovery.cancel(admission)
              : await options.gameDiscovery.manualPicker(admission);
        if (result === undefined) { sendProblem(response, 409, "state_unavailable"); return; }
        const validResult = operation === "discovery_retry"
          ? GameBrowserValidatorsV1.GameDiscoveryReadResultV1Schema.Check(result)
          : GameBrowserValidatorsV1.GameDiscoveryMutationResultV1Schema.Check(result);
        if (!validResult) { sendProblem(response, 409, "state_unavailable"); return; }
        sendJson(response, 200, result);
      } catch { sendProblem(response, 503, "game_unavailable"); }
      return;
    }
    if (requestUrl.pathname === LIFECYCLE_ACTIVATE_PATH && request.method === "POST") {
      if (!isEmptyQuery(requestUrl) || options.gameActivate === undefined) {
        sendProblem(response, options.gameActivate === undefined ? 404 : 409, options.gameActivate === undefined ? "not_found" : "malformed_request");
        return;
      }
      const admission = issueComposedReferenceGameBrowserLifecycleActivationAdmission(lifecycleActivationIssuer, request, origin);
      if (admission === null) { sendProblem(response, 401, "unauthorized"); return; }
      // The command carries nothing: the session, the install and the attempt are the
      // admission's to name, and a body here would be a second, unauthenticated way to
      // say what to activate.
      let body: Buffer;
      try { body = await readBody(request, 0); } catch { sendProblem(response, 409, "malformed_request"); return; }
      if (body.length !== 0) { sendProblem(response, 409, "malformed_request"); return; }
      try {
        await options.gameActivate(admission);
        response.writeHead(204, { "cache-control": "no-store", "content-length": "0" });
        response.end();
      } catch (error) { sendProblem(response, 409, gameActivateProblemCode(error)); }
      return;
    }

    if (requestUrl.pathname === GAME_SETUP_PATH && request.method === "POST") {
      if (!isEmptyQuery(requestUrl) || options.gameSetup === undefined) {
        sendProblem(response, options.gameSetup === undefined ? 404 : 409, options.gameSetup === undefined ? "not_found" : "malformed_request");
        return;
      }
      const admission = issueComposedReferenceGameBrowserLifecycleActivationAdmission(lifecycleActivationIssuer, request, origin);
      if (admission === null) { sendProblem(response, 401, "unauthorized"); return; }
      let body: Buffer;
      try { body = await readBody(request, MAX_BOOTSTRAP_BODY_BYTES); } catch { sendProblem(response, 409, "malformed_request"); return; }
      let command: unknown;
      try { command = JSON.parse(body.toString("utf8")); } catch { sendProblem(response, 409, "malformed_request"); return; }
      if (!GameBrowserValidatorsV1.GamePrerequisitesSetupCommandV1Schema.Check(command)) {
        sendProblem(response, 409, "malformed_request"); return;
      }
      try {
        await options.gameSetup(admission, command as GamePrerequisitesSetupCommandV1);
        response.writeHead(204, { "cache-control": "no-store", "content-length": "0" }); response.end();
      } catch (error) { sendProblem(response, 409, gameSetupProblemCode(error)); }
      return;
    }

    if (requestUrl.pathname === GAME_LAUNCH_PATH && request.method === "POST") {
      if (!isEmptyQuery(requestUrl) || options.gameLaunch === undefined) {
        sendProblem(response, options.gameLaunch === undefined ? 404 : 409, options.gameLaunch === undefined ? "not_found" : "malformed_request");
        return;
      }
      const admission = issueComposedReferenceGameBrowserLifecycleActivationAdmission(lifecycleActivationIssuer, request, origin);
      if (admission === null) { sendProblem(response, 401, "unauthorized"); return; }
      let body: Buffer;
      try { body = await readBody(request, MAX_BOOTSTRAP_BODY_BYTES); } catch { sendProblem(response, 409, "malformed_request"); return; }
      let command: unknown;
      try { command = JSON.parse(body.toString("utf8")); } catch { sendProblem(response, 409, "malformed_request"); return; }
      if (!GameBrowserValidatorsV1.GameLaunchCommandV1Schema.Check(command)) {
        sendProblem(response, 409, "malformed_request"); return;
      }
      try {
        await options.gameLaunch(admission, command as GameLaunchCommandV1);
        response.writeHead(204, { "cache-control": "no-store", "content-length": "0" });
        response.end();
      } catch (error) { sendProblem(response, 409, gameLaunchProblemCode(error)); }
      return;
    }

    if (requestUrl.pathname === GAME_STOP_PATH && request.method === "POST") {
      if (!isEmptyQuery(requestUrl) || options.gameStop === undefined) {
        sendProblem(response, options.gameStop === undefined ? 404 : 409, options.gameStop === undefined ? "not_found" : "malformed_request");
        return;
      }
      const admission = issueComposedReferenceGameBrowserLifecycleActivationAdmission(lifecycleActivationIssuer, request, origin);
      if (admission === null) { sendProblem(response, 401, "unauthorized"); return; }
      let body: Buffer;
      try { body = await readBody(request, MAX_BOOTSTRAP_BODY_BYTES); } catch { sendProblem(response, 409, "malformed_request"); return; }
      let command: unknown;
      try { command = JSON.parse(body.toString("utf8")); } catch { sendProblem(response, 409, "malformed_request"); return; }
      if (!GameBrowserValidatorsV1.GameStopCommandV1Schema.Check(command)) {
        sendProblem(response, 409, "malformed_request"); return;
      }
      try {
        await options.gameStop(admission, command as GameStopCommandV1);
        response.writeHead(204, { "cache-control": "no-store", "content-length": "0" });
        response.end();
      } catch (error) { sendProblem(response, 409, gameStopProblemCode(error)); }
      return;
    }

    if (requestUrl.pathname === GAME_RESUME_PATH && request.method === "POST") {
      if (!isEmptyQuery(requestUrl) || options.gameResume === undefined) {
        sendProblem(response, options.gameResume === undefined ? 404 : 409, options.gameResume === undefined ? "not_found" : "malformed_request");
        return;
      }
      const admission = issueComposedReferenceGameBrowserLifecycleActivationAdmission(lifecycleActivationIssuer, request, origin);
      if (admission === null) { sendProblem(response, 401, "unauthorized"); return; }
      let body: Buffer;
      try { body = await readBody(request, MAX_BOOTSTRAP_BODY_BYTES); } catch { sendProblem(response, 409, "malformed_request"); return; }
      let command: unknown;
      try { command = JSON.parse(body.toString("utf8")); } catch { sendProblem(response, 409, "malformed_request"); return; }
      if (!GameBrowserValidatorsV1.GameResumeCommandV1Schema.Check(command)) {
        sendProblem(response, 409, "malformed_request"); return;
      }
      try {
        const result = await options.gameResume(admission, command as GameResumeCommandV1);
        if (!GameBrowserValidatorsV1.GameResumeResultV1Schema.Check(result)) throw new ControlledStateError();
        sendJson(response, 200, result);
      } catch (error) { sendProblem(response, 409, gameResumeProblemCode(error)); }
      return;
    }

    if (requestUrl.pathname === GAME_RESUME_CANCEL_PATH && request.method === "POST") {
      if (!isEmptyQuery(requestUrl) || options.gameResumeCancel === undefined) {
        sendProblem(response, options.gameResumeCancel === undefined ? 404 : 409, options.gameResumeCancel === undefined ? "not_found" : "malformed_request");
        return;
      }
      const admission = issueComposedReferenceGameBrowserLifecycleActivationAdmission(lifecycleActivationIssuer, request, origin);
      if (admission === null) { sendProblem(response, 401, "unauthorized"); return; }
      let body: Buffer;
      try { body = await readBody(request, MAX_BOOTSTRAP_BODY_BYTES); } catch { sendProblem(response, 409, "malformed_request"); return; }
      let command: unknown;
      try { command = JSON.parse(body.toString("utf8")); } catch { sendProblem(response, 409, "malformed_request"); return; }
      if (!GameBrowserValidatorsV1.GameResumeCancelCommandV1Schema.Check(command)) {
        sendProblem(response, 409, "malformed_request"); return;
      }
      try {
        const result = await options.gameResumeCancel(admission, command as GameResumeCancelCommandV1);
        if (!GameBrowserValidatorsV1.GameResumeCancelResultV1Schema.Check(result)) throw new ControlledStateError();
        sendJson(response, 200, result);
      } catch (error) { sendProblem(response, 409, gameResumeCancelProblemCode(error)); }
      return;
    }

    if (requestUrl.pathname === GAME_CREATE_PATH && request.method === "POST") {
      if (!isEmptyQuery(requestUrl) || options.gameCreate === undefined) {
        sendProblem(response, options.gameCreate === undefined ? 404 : 409, options.gameCreate === undefined ? "not_found" : "malformed_request");
        return;
      }
      const admission = issueComposedReferenceGameBrowserLifecycleActivationAdmission(lifecycleActivationIssuer, request, origin);
      if (admission === null) { sendProblem(response, 401, "unauthorized"); return; }
      let body: Buffer;
      try { body = await readBody(request, MAX_BOOTSTRAP_BODY_BYTES); } catch { sendProblem(response, 409, "malformed_request"); return; }
      let command: unknown;
      try { command = JSON.parse(body.toString("utf8")); } catch { sendProblem(response, 409, "malformed_request"); return; }
      if (!GameBrowserValidatorsV1.GameCreateCommandV1Schema.Check(command)) {
        sendProblem(response, 409, "malformed_request"); return;
      }
      try {
        const result = await options.gameCreate(admission, command as GameCreateCommandV1);
        if (!GameBrowserValidatorsV1.GameCreateResultV1Schema.Check(result)) throw new ControlledStateError();
        sendJson(response, 200, result);
      } catch (error) { sendProblem(response, 409, gameCreateProblemCode(error)); }
      return;
    }

    if (requestUrl.pathname === GAME_REOPEN_PATH && request.method === "POST") {
      if (!isEmptyQuery(requestUrl) || options.gameReopen === undefined) {
        sendProblem(response, options.gameReopen === undefined ? 404 : 409, options.gameReopen === undefined ? "not_found" : "malformed_request");
        return;
      }
      const admission = issueComposedReferenceGameBrowserLifecycleActivationAdmission(lifecycleActivationIssuer, request, origin);
      if (admission === null) { sendProblem(response, 401, "unauthorized"); return; }
      let body: Buffer;
      try { body = await readBody(request, MAX_BOOTSTRAP_BODY_BYTES); } catch { sendProblem(response, 409, "malformed_request"); return; }
      let command: unknown;
      try { command = JSON.parse(body.toString("utf8")); } catch { sendProblem(response, 409, "malformed_request"); return; }
      if (!GameBrowserValidatorsV1.GameReopenActionAuthorityCommandV1Schema.Check(command)) {
        sendProblem(response, 409, "malformed_request"); return;
      }
      try {
        const result = await options.gameReopen(admission, command as GameReopenActionAuthorityCommandV1);
        if (!GameBrowserValidatorsV1.GameReopenActionAuthorityResultV1Schema.Check(result)) throw new ControlledStateError();
        sendJson(response, 200, result);
      } catch (error) { sendProblem(response, 409, gameReopenProblemCode(error)); }
      return;
    }

    if (requestUrl.pathname === GAME_DISCONNECT_PATH && request.method === "POST") {
      if (!isEmptyQuery(requestUrl) || options.gameDisconnect === undefined) {
        sendProblem(response, options.gameDisconnect === undefined ? 404 : 409, options.gameDisconnect === undefined ? "not_found" : "malformed_request");
        return;
      }
      const admission = issueComposedReferenceGameBrowserLifecycleActivationAdmission(lifecycleActivationIssuer, request, origin);
      if (admission === null) { sendProblem(response, 401, "unauthorized"); return; }
      let body: Buffer;
      try { body = await readBody(request, MAX_BOOTSTRAP_BODY_BYTES); } catch { sendProblem(response, 409, "malformed_request"); return; }
      let command: unknown;
      try { command = JSON.parse(body.toString("utf8")); } catch { sendProblem(response, 409, "malformed_request"); return; }
      if (!GameBrowserValidatorsV1.GameDisconnectCommandV1Schema.Check(command)) {
        sendProblem(response, 409, "malformed_request"); return;
      }
      try {
        await options.gameDisconnect(admission, command as GameDisconnectCommandV1);
        response.writeHead(204, { "cache-control": "no-store", "content-length": "0" });
        response.end();
      } catch (error) { sendProblem(response, 409, gameDisconnectProblemCode(error)); }
      return;
    }

    if (requestUrl.pathname === GAME_ENDGAME_PATH && request.method === "POST") {
      if (!isEmptyQuery(requestUrl) || options.gameEndgame === undefined) {
        sendProblem(response, options.gameEndgame === undefined ? 404 : 409, options.gameEndgame === undefined ? "not_found" : "malformed_request");
        return;
      }
      const admission = issueComposedReferenceGameBrowserLifecycleActivationAdmission(lifecycleActivationIssuer, request, origin);
      if (admission === null) { sendProblem(response, 401, "unauthorized"); return; }
      let body: Buffer;
      try { body = await readBody(request, MAX_BOOTSTRAP_BODY_BYTES); } catch { sendProblem(response, 409, "malformed_request"); return; }
      let command: unknown;
      try { command = JSON.parse(body.toString("utf8")); } catch { sendProblem(response, 409, "malformed_request"); return; }
      if (!GameBrowserValidatorsV1.GameEndgameCommandV1Schema.Check(command)) {
        sendProblem(response, 409, "malformed_request"); return;
      }
      try {
        const result = await options.gameEndgame(admission, command as GameEndgameCommandV1);
        const payload = Buffer.from(JSON.stringify(result), "utf8");
        response.writeHead(200, { "cache-control": "no-store", "content-type": "application/json", "content-length": String(payload.length) });
        response.end(payload);
      } catch (error) { sendProblem(response, 409, gameEndgameProblemCode(error)); }
      return;
    }

    if (requestUrl.pathname === STARDEW_CABINS_PATH && request.method === "GET") {
      if (!isEmptyQuery(requestUrl) || !hasEmptyRequestBodyHeaders(request) || options.stardewCabins === undefined) {
        sendProblem(response, options.stardewCabins === undefined ? 404 : 409, options.stardewCabins === undefined ? "not_found" : "malformed_request");
        return;
      }
      const admission = issueComposedReferenceGameBrowserLifecycleActivationAdmission(lifecycleActivationIssuer, request, origin);
      if (admission === null) { sendProblem(response, 401, "unauthorized"); return; }
      try {
        const result = await options.stardewCabins.read(admission);
        if (!GameBrowserValidatorsV1.StardewCabinChoicesV1Schema.Check(result)) throw new ControlledStateError();
        sendJson(response, 200, result);
      } catch { sendProblem(response, 409, "state_unavailable"); }
      return;
    }

    if (requestUrl.pathname === STARDEW_CABINS_CONFIRM_PATH && request.method === "POST") {
      if (!isEmptyQuery(requestUrl) || options.stardewCabins === undefined) {
        sendProblem(response, options.stardewCabins === undefined ? 404 : 409, options.stardewCabins === undefined ? "not_found" : "malformed_request");
        return;
      }
      const admission = issueComposedReferenceGameBrowserLifecycleActivationAdmission(lifecycleActivationIssuer, request, origin);
      if (admission === null) { sendProblem(response, 401, "unauthorized"); return; }
      let body: Buffer;
      try { body = await readBody(request, MAX_BOOTSTRAP_BODY_BYTES); } catch { sendProblem(response, 409, "malformed_request"); return; }
      let command: unknown;
      try { command = JSON.parse(body.toString("utf8")); } catch { sendProblem(response, 409, "malformed_request"); return; }
      if (!GameBrowserValidatorsV1.StardewCabinConfirmCommandV1Schema.Check(command)) {
        sendProblem(response, 409, "malformed_request"); return;
      }
      try {
        const result = await options.stardewCabins.confirm(admission, command as StardewCabinConfirmCommandV1);
        if (!GameBrowserValidatorsV1.StardewCabinConfirmResultV1Schema.Check(result)) throw new ControlledStateError();
        sendJson(response, 200, result);
      } catch (error) { sendProblem(response, 409, stardewCabinProblemCode(error)); }
      return;
    }

    if (
      request.method === "GET" &&
      (requestUrl.pathname === STATE_PATH || requestUrl.pathname === GAME_PATH)
    ) {
      if (!isEmptyQuery(requestUrl) || !hasEmptyRequestBodyHeaders(request)) {
        sendProblem(response, 409, "malformed_request");
        return;
      }
      if (!isSameOriginSafeGet(request, origin)) {
        sendProblem(response, 401, "unauthorized");
        return;
      }

      let body: Buffer;
      try {
        body = await readBody(request, 0);
      } catch {
        sendProblem(response, 409, "malformed_request");
        return;
      }
      if (body.length !== 0) {
        sendProblem(response, 409, "malformed_request");
        return;
      }

      const activeSession = session;
      const bearerToken = parseSingleCookie(
        request.headers.cookie,
        SESSION_COOKIE_NAME,
      );
      if (
        activeSession === undefined ||
        activeSession.expiresAtMs <= Date.now() ||
        bearerToken === undefined ||
        !timingSafeStringEqual(bearerToken, activeSession.bearerToken)
      ) {
        if (activeSession !== undefined && activeSession.expiresAtMs <= Date.now()) {
          session = undefined;
        }
        sendProblem(response, 401, "unauthorized");
        return;
      }

      const context = createContext(activeSession);
      try {
        if (requestUrl.pathname === GAME_PATH) {
          if (options.readGame === undefined) {
            sendProblem(response, 404, "not_found");
            return;
          }
          sendJson(response, 200, await readGame(context));
          return;
        }

        sendJson(response, 200, await readComposedRoot(context));
      } catch {
        sendProblem(response, 409, "state_unavailable");
      }
      return;
    }

    sendProblem(response, 404, "not_found");
  };

  return Object.freeze({
    handle(request: IncomingMessage, response: ServerResponse, origin: string): void {
      if (closed) {
        sendProblem(response, 503, "closed");
        return;
      }

      const pending = dispatch(request, response, origin).catch(() => {
        if (!response.headersSent) {
          sendProblem(response, 409, "state_unavailable");
        }
      });
      dispatches.add(pending);
      void pending.finally(() => {
        dispatches.delete(pending);
      });
    },
    delegatedAuthCapability,
    lifecycleActivationIssuer,
    async close(): Promise<void> {
      closed = true;
      session = undefined;
      await Promise.allSettled([...dispatches]);
      session = undefined;
    },
  });
}
