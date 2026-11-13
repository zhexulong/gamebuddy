import { randomBytes, timingSafeEqual } from "node:crypto";
import { StardewPlayerSettingsRevisionConflict } from "./games/stardew/stardew-player-settings.js";
import type { IncomingMessage, ServerResponse } from "node:http";

import {
  ComposedReferenceGameBrowserValidatorsV1,
  type ComposedReferenceGameBrowserProfile,
  isComposedReferenceGameBrowserProfile,
} from "./composed-browser-contract/index.js";
import { TavernBrowserValidatorsV1, type TavernStateSnapshotV1 } from "./tavern/browser-contract/index.js";
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
  type GameReopenActionAuthorityCommandV1,
  type GameReopenActionAuthorityResultV1,
  type GameStopCommandV1,
  type StardewCabinChoicesV1,
  type StardewCabinConfirmCommandV1,
  type StardewCabinConfirmResultV1,
  type StardewPlayerSettingsCommandV1,
  type StardewPlayerSettingsV1,
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
  readChat: (context: ComposedReferenceGameBrowserReadContext) => Promise<TavernStateSnapshotV1>;
  readGame?: (context: ComposedReferenceGameBrowserReadContext) => Promise<GameBrowserStateV1>;
  /**
   * The lifecycle activation seam: stage the owned player host for this authenticated
   * presentation session. It is the one command on this wire that carries no browser
   * command body at all, because everything it acts on is already authenticated here -
   * the admission names the exact browser session, and the owner derives the install,
   * registration and attempt from it. Its outcome stays private for the same reason:
   * the caller learns the staged state from the existing game state projection, not
   * from a second, invented lifecycle DTO.
   */
  gameActivate?: (admission: ComposedReferenceGameBrowserLifecycleActivationAdmission) => Promise<void>;
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
    confirm(
      admission: ComposedReferenceGameBrowserLifecycleActivationAdmission,
      command: GameDiscoveryConfirmCommandV1,
    ): Promise<GameDiscoveryMutationResultV1>;
    retry(admission: ComposedReferenceGameBrowserLifecycleActivationAdmission): Promise<GameDiscoveryReadResultV1>;
    cancel(admission: ComposedReferenceGameBrowserLifecycleActivationAdmission): Promise<GameDiscoveryMutationResultV1>;
    manualPicker(
      admission: ComposedReferenceGameBrowserLifecycleActivationAdmission,
    ): Promise<GameDiscoveryMutationResultV1>;
  }>;
  stardewCabins?: Readonly<{
    read(admission: ComposedReferenceGameBrowserLifecycleActivationAdmission): Promise<StardewCabinChoicesV1>;
    confirm(
      admission: ComposedReferenceGameBrowserLifecycleActivationAdmission,
      command: StardewCabinConfirmCommandV1,
    ): Promise<StardewCabinConfirmResultV1>;
  }>;
  /**
   * The player's own mod settings: the action consent and the co-op night floor.
   *
   * A pair, like the cabins, and mounted the same way - the profile declares both
   * operations or neither, so a route set can never advertise a save with no read
   * behind it. Nothing else about the Mod's config is reachable: the fixture fields,
   * the bridge credentials and the operator's provisioning block are not this
   * surface's to show.
   */
  stardewSettings?: Readonly<{
    read(admission: ComposedReferenceGameBrowserLifecycleActivationAdmission): Promise<StardewPlayerSettingsV1>;
    update(
      admission: ComposedReferenceGameBrowserLifecycleActivationAdmission,
      command: StardewPlayerSettingsCommandV1,
    ): Promise<StardewPlayerSettingsV1>;
  }>;
  /**
   * The one-click mod-loader install for the folder the Host has bound.
   *
   * It is a single POST with a command that carries nothing but its idempotency key: the
   * folder is the registration's, and a body naming one would be a second way to point a
   * write at a directory.
   */
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
  activate?: (admission: ComposedReferenceGameBrowserLifecycleActivationAdmission) => Promise<unknown>;
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
   * Lifecycle-owner resume seam. The command is the wire command verbatim, so
   * the session handle the player named is the one the owner resolves; a
   * command that names no session is the owner's `unavailable` case.
   */
  resume?: (
    admission: ComposedReferenceGameBrowserLifecycleActivationAdmission,
    command: GameResumeCommandV1,
  ) => Promise<GameResumeResultV1>;
  createGameSession?: NonNullable<ComposedReferenceGameBrowserRequestHandlerOptions["gameCreate"]>;
  cancelResume?: NonNullable<ComposedReferenceGameBrowserRequestHandlerOptions["gameResumeCancel"]>;
  gameDiscovery?: NonNullable<ComposedReferenceGameBrowserRequestHandlerOptions["gameDiscovery"]>;
  readCabinChoices?: NonNullable<ComposedReferenceGameBrowserRequestHandlerOptions["stardewCabins"]>["read"];
  confirmCabinChoice?: NonNullable<ComposedReferenceGameBrowserRequestHandlerOptions["stardewCabins"]>["confirm"];
  readPlayerSettings?: NonNullable<ComposedReferenceGameBrowserRequestHandlerOptions["stardewSettings"]>["read"];
  updatePlayerSettings?: NonNullable<ComposedReferenceGameBrowserRequestHandlerOptions["stardewSettings"]>["update"];
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
const STARDEW_SETTINGS_PATH = "/api/composed-reference-game/v1/game/stardew/settings";
const SESSION_COOKIE_NAME = "gb_composed_reference_game_session";
const SESSION_DURATION_MS = 7_200_000;
const MAX_BOOTSTRAP_BODY_BYTES = 4_096;
const BOOTSTRAP_TOKEN_PATTERN = /^[A-Za-z0-9_-]{22,128}$/;

/**
 * The bounded, non-secret reason a composed *bootstrap* refusal fired.
 *
 * The bootstrap route is the one refusal a launch cannot see any other way: it is
 * the first request the page makes, it happens before any session exists, and - by
 * design - every one of its failure modes answers the same `unauthorized`, so the
 * launch said only "it did not open". Naming the branch on the response is additive
 * to the problem DTO rather than a change to it, because the browser client's
 * vocabulary is closed on purpose (`unauthorized`/`csrf_failed` are its session
 * category, and a `cause` field must be a coordinator `stardew_*` code), so every
 * code and status stays exactly what it was and the client keeps classifying a
 * bootstrap 401 as the expired session it actually is.
 *
 * The value is always a bounded code: an origin guard, a token shape, a token
 * match, a consumed one-shot token, or the exact producer or projection check that
 * failed. It never names, contains or is derived from the token, so a caller cannot
 * learn a valid token from it - not even the branch that says "yours was not this
 * server's".
 */
const BOOTSTRAP_CAUSE_HEADER = "x-gamebuddy-bootstrap-cause";

const INVALID_PROFILE_ERROR = "Invalid composed reference game browser profile.";
const INVALID_BOOTSTRAP_TOKEN_ERROR = "Invalid composed reference game browser bootstrap token.";
const INVALID_GAME_READER_ERROR = "Invalid composed reference game browser game reader configuration.";

class ControlledStateError extends Error {
  /**
   * The bounded, non-secret refusal this projection failed on, when it names one.
   * A producer failure keeps the producer's own bounded code, so the projection that
   * broke is distinguishable from every other one; anything that is not a bounded
   * code is never projected.
   */
  public readonly refusalCode: string | undefined;

  public constructor(refusalCode?: string) {
    super("Composed reference game browser state is invalid.");
    this.refusalCode = refusalCode;
  }
}

function isRecord(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactOwnKeys(value: JsonObject, keys: readonly string[]): boolean {
  const ownKeys = Object.keys(value);
  return ownKeys.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function isExactJsonContentType(contentType: string | undefined): boolean {
  return contentType === "application/json";
}

function timingSafeStringEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

function parseSingleCookie(cookieHeader: string | undefined, name: string): string | undefined {
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

function sendProblem(response: ServerResponse, statusCode: number, code: string, cause?: string): void {
  sendJson(response, statusCode, cause === undefined ? { code } : { code, cause });
}

/**
 * The bootstrap refusal: exactly the problem DTO every other refusal sends, plus the
 * one additive fact the browser client's closed vocabulary cannot carry - which cause
 * fired. The body is unchanged, so nothing classifies differently; the bounded cause
 * is readable from the response by whoever has to diagnose the launch.
 */
function sendBootstrapProblem(response: ServerResponse, statusCode: number, code: string, cause: string): void {
  sendJson(response, statusCode, { code }, { [BOOTSTRAP_CAUSE_HEADER]: cause });
}

/**
 * Coordinator-owned bounded code. Every lifecycle fault the coordinator mints is
 * one of these. OS text, an installation path, a token or a raw exception message
 * never is, so this pattern is what decides whether a nested message may cross.
 */
const BOUNDED_LIFECYCLE_CODE_PATTERN = /^stardew_[a-z0-9_]+$/;

/** Small fixed depth, so a cyclic or pathologically nested `cause` chain cannot make this walk unbounded. */
const MAX_LIFECYCLE_CAUSE_DEPTH = 6;

/**
 * The bounded cause of a lifecycle refusal.
 *
 * The coordinator reports the *outer* fault as its exception message - a wrapper
 * such as `stardew_player_host_launch_failed` - and names the fault underneath on
 * `cause`. Dropping that left the one wrapper standing for a missing runtime
 * collaborator, a failed guardian arm, an installation admission failure and a
 * genuine native launch failure alike, so nobody - player, client or the person
 * fixing it - could learn which had happened.
 *
 * This walks the `cause` chain and returns the first bounded coordinator code. A
 * refusal that carries no cause falls back to its own bounded message, so every
 * coordinator refusal is distinguishable from every other. Anything unbounded
 * yields `undefined` and is never projected.
 */
function boundedLifecycleCause(error: unknown): string | undefined {
  let current: unknown = error instanceof Error ? error.cause : undefined;
  for (let depth = 0; depth < MAX_LIFECYCLE_CAUSE_DEPTH; depth += 1) {
    if (!(current instanceof Error)) break;
    if (BOUNDED_LIFECYCLE_CODE_PATTERN.test(current.message)) return current.message;
    current = current.cause;
  }
  return error instanceof Error && BOUNDED_LIFECYCLE_CODE_PATTERN.test(error.message) ? error.message : undefined;
}

/**
 * The bounded producer code a broken projection names, when it names one. A producer
 * reports its own fault as its exception message - a composed projection code such as
 * `composed_reference_game_chat_snapshot_invalid`, or a coordinator `stardew_*`
 * wrapper whose own bounded cause names the fault underneath. Those are exactly the
 * facts that tell two projection failures apart. Anything that is not a bounded code
 * (OS text, a path, a token, a raw message) yields `undefined` and is never projected,
 * and the caller then gets the closed-set code of the check that failed.
 */
const BOUNDED_PRODUCER_CODE_PATTERN = /^[a-z][a-z0-9_]{0,95}$/;

function boundedProducerCode(error: unknown): string | undefined {
  const nested = boundedLifecycleCause(error);
  if (nested !== undefined) {
    return nested;
  }
  const message = error instanceof Error ? error.message : undefined;
  return message !== undefined && BOUNDED_PRODUCER_CODE_PATTERN.test(message) ? message : undefined;
}

/**
 * The bounded coordinator causes that name a fault more precisely than the generic
 * wrapper code they arrive behind. Every value is an existing composed problem
 * code: no new code is introduced and no existing code is given a second meaning.
 */
const BOUNDED_CAUSE_PROBLEM_CODE: Readonly<Record<string, string>> = Object.freeze({
  stardew_player_host_launch_runtime_unavailable: "game_runtime_unavailable",
  stardew_ai_client_launch_runtime_unavailable: "game_runtime_unavailable",
});

/**
 * A wrapper code that stands for more than one fault consults the bounded cause so
 * the distinct faults stay distinct; every mapping it is not taken through is
 * exactly what it was.
 */
function distinguishableLifecycleProblemCode(error: unknown, wrapperCode: string): string {
  const cause = boundedLifecycleCause(error);
  return (cause === undefined ? undefined : BOUNDED_CAUSE_PROBLEM_CODE[cause]) ?? wrapperCode;
}

/**
 * The bounded cause a refusal may carry. It is projected only where the composed
 * code is itself the generic one - `game_unavailable` / `state_unavailable` - i.e.
 * only where the code alone does not tell the faults apart. A refusal that already
 * names its fault keeps exactly the body it had.
 */
function projectedLifecycleCause(error: unknown, code: string): string | undefined {
  if (code !== "game_unavailable" && code !== "state_unavailable") return undefined;
  return boundedLifecycleCause(error);
}

function sendLifecycleProblem(response: ServerResponse, statusCode: number, error: unknown, code: string): void {
  sendProblem(response, statusCode, code, projectedLifecycleCause(error, code));
}

function gameSetupProblemCode(error: unknown): string {
  if (!(error instanceof Error)) return "state_unavailable";
  switch (error.message) {
    case "stardew_game_setup_idempotency_conflict":
      return "idempotency_conflict";
    case "stardew_game_setup_in_progress":
      return "game_operation_in_progress";
    case "stardew_game_setup_failed":
      return distinguishableLifecycleProblemCode(error, "game_unavailable");
    case "stardew_player_host_launch_not_staged":
      return "game_prerequisites_missing";
    default:
      return "state_unavailable";
  }
}

function gameActivateProblemCode(error: unknown): string {
  if (!(error instanceof Error)) return "state_unavailable";
  switch (error.message) {
    case "stardew_lifecycle_activation_conflict":
      return "idempotency_conflict";
    case "stardew_lifecycle_activation_admission_invalid":
      return "unauthorized";
    case "stardew_lifecycle_closing":
      return distinguishableLifecycleProblemCode(error, "game_unavailable");
    default:
      return "state_unavailable";
  }
}

function gameLaunchProblemCode(error: unknown): string {
  if (!(error instanceof Error)) return "state_unavailable";
  switch (error.message) {
    case "stardew_game_instance_generation_conflict":
      return "game_instance_not_found";
    case "stardew_game_launch_idempotency_conflict":
      return "idempotency_conflict";
    case "stardew_game_launch_in_progress":
    case "stardew_game_setup_in_progress":
      return "game_operation_in_progress";
    case "stardew_player_host_launch_not_staged":
      return "game_prerequisites_missing";
    case "stardew_player_host_launch_failed":
    case "stardew_player_host_launch_quarantined":
    case "stardew_lifecycle_closing":
      return distinguishableLifecycleProblemCode(error, "game_unavailable");
    default:
      return "state_unavailable";
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
    // A resume that named a durable session the store holds no resumable world
    // for is not a fault and not a retry: the identity the player named does not
    // resolve. `game_instance_not_found` is the contract's word for exactly that
    // (refused, nothing ran, the world you asked for is not there), and it points
    // the player at the step that can work - choose a session or start a new game
    // - instead of the generic `state_unavailable`, which reads as "try again".
    case "stardew_game_resume_session_unavailable":
      return "game_instance_not_found";
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
      return distinguishableLifecycleProblemCode(error, "game_unavailable");
    case "stardew_game_resume_cancel_conflict":
    case "stardew_game_attachment_generation_conflict":
      return "game_attachment_conflict";
    case "stardew_lifecycle_closing":
      return distinguishableLifecycleProblemCode(error, "game_unavailable");
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
      return distinguishableLifecycleProblemCode(error, "game_unavailable");
    case "stardew_game_create_failed":
      return "game_storage_unavailable";
    case "stardew_lifecycle_closing":
      return distinguishableLifecycleProblemCode(error, "game_unavailable");
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
    // A reopen names the attachment generation it was issued against, so a
    // reconnect that moved past it is a stale controller - the same identity
    // `game.stop`, `game.disconnect` and `game.endgame` report. Dropping this
    // arm answered the one stale-epoch verb that re-enables the Agent's ability
    // to act with the generic `state_unavailable`, which reads as "try again".
    case "stardew_game_attachment_generation_conflict":
      return "game_attachment_conflict";
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

/**
 * The bounded code a settings route refusal answers with.
 *
 * \`stardew_settings_revision_conflict\` is the one refusal the player can act on: the
 * record moved under them, so the next step is to read it again. It is mapped from the
 * store's own typed conflict rather than from a message, so no other failure can ever
 * be mistaken for it.
 */
function stardewSettingsProblemCode(error: unknown): string {
  if (error instanceof StardewPlayerSettingsRevisionConflict) return "stardew_settings_revision_conflict";
  return "state_unavailable";
}

/**
 * The cabin READ's own causes.
 *
 * `stardew_player_host_cabin_unavailable` is not a fault: it is the fact that this host world has no cabin the
 * companion may use, and its cure is the guidance the product already gives - have Robin build one. Flattening it
 * to `state_unavailable` (which is what this branch did) leaves the panel able to say only "unavailable", so a
 * player reading it retries forever against a state that will never change on its own.
 *
 * `stardew_player_host_exited` is the game process itself ending: the Guardian reported the native exit code it
 * ended with, so the cabins this read asks for belong to a world that is no longer running. That is knowledge, not
 * `state_unavailable` ("this Host does not know"), and a retry cannot change it - only the player starting the game
 * again can. It is the same bounded code the coordinator refuses with because there is one fact here, not two: the
 * projection renames nothing, and the exit code the OS reported is published in exactly one place, the state read's
 * `game.instance.playerHostExitCode`.
 *
 * Both `stardew_cabin_handoff_unavailable` and `stardew_cabin_handoff_revision_changed` keep `state_unavailable`:
 * the first means no Player Host instance is awaiting attestation (the panel has a separate sentence for that via
 * `awaitsSession`), and the second is a genuine retry - the world moved while the read was in flight.
 */
function stardewCabinReadProblemCode(error: unknown): string {
  if (!(error instanceof Error)) return "state_unavailable";
  switch (error.message) {
    case "stardew_player_host_cabin_unavailable":
      return "stardew_player_host_cabin_missing";
    case "stardew_player_host_exited":
      return "stardew_player_host_exited";
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
    // An expired Farmhand join is the same fact from the browser's side - the handoff was
    // admitted and did not complete - but the Host keeps the attempt alive: the player's exit is
    // the ordinary close, not a quarantined session. Its own coordinator code stays the name the
    // Host reports; only the player-visible problem code is shared.
    case "stardew_farmhand_join_deadline_exceeded":
      return "stardew_manifest_handoff_uncertain";
    default:
      return "state_unavailable";
  }
}

async function readBody(request: IncomingMessage, maximumBytes: number): Promise<Buffer> {
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
  return request.headers["transfer-encoding"] === undefined && (contentLength === undefined || contentLength === "0");
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
  /**
   * The admitted wire shapes this broker publishes, by the one-shot operation each answers as. The route table is the
   * only declaration of them: a wire shape can mint no admission unless a row names it, and the operation a row is
   * admitted under is the row's own kind.
   */
  admissionOperations: ReadonlyMap<string, LifecycleAdmissionOperation>;
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
  | "settings_read"
  | "settings_update"
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
const lifecycleActivationAdmissions = new WeakMap<object, LifecycleActivationAdmissionState>();

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

  const operation = issuerState.admissionOperations.get(routeKey(request.method, requestUrl.pathname));
  if (operation === undefined) {
    return null;
  }

  if (
    originUrl.protocol !== "http:" ||
    !isLiteralLoopbackOrigin(originUrl) ||
    requestUrl.origin !== originUrl.origin ||
    !requestHasExpectedHost(request, originUrl) ||
    (request.method === "POST"
      ? !isExactOrigin(request, origin) || !isExactJsonContentType(singleHeaderValue(request.headers["content-type"]))
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

  const admission: ComposedReferenceGameBrowserLifecycleActivationAdmission = Object.freeze({});
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
  return callback(
    Object.freeze({
      browserSessionId: activeSession.lifecycleSessionId,
      expiresAtMs: activeSession.expiresAtMs,
    }),
  );
}

/**
 * The wire shape that decides which route answers a request: the HTTP method plus the exact path. A method or path the
 * table does not name is refused by the router itself, so anything it never named is `404 not_found`, exactly as it
 * was.
 */
function routeKey(method: string | undefined, pathname: string): string {
  return `${method ?? ""} ${pathname}`;
}

/** An inbound request, resolved to the route that answers it. */
type RouteRequest = Readonly<{
  request: IncomingMessage;
  response: ServerResponse;
  url: URL;
  origin: string;
  /** The fieldless issuer this handler minted; an admitted route consumes its own one-shot admission through it. */
  issuer: ComposedReferenceGameBrowserLifecycleActivationIssuer;
}>;

/** One declared inbound kind: the wire shape it answers, and the handler that answers it. */
type ComposedBrowserRoute = Readonly<{
  method: "GET" | "POST";
  path: string;
  handle(request: RouteRequest): Promise<void>;
}>;

/** The inbound kinds that carry no lifecycle admission. */
type SessionRouteKind = "bootstrap" | "state_read" | "game_read";

/** What a route requires of the request body before its seam runs. */
type RouteBody =
  /** The GET projections read no body at all. */
  | Readonly<{ kind: "absent" }>
  /** Exactly zero bytes: the activation command is named by its admission, not by a body. */
  | Readonly<{ kind: "empty" }>
  /** One JSON command, bound by the route's own schema. */
  | Readonly<{ kind: "command"; check(value: unknown): boolean }>;

/** The command a route's seam takes, or the fact that the request was already refused. */
type CommandRead = Readonly<{ ok: true; command: unknown }> | Readonly<{ ok: false }>;

/** How a route answers the result its seam produced. */
type RouteReply =
  /** `204` and no body: the seam's own outcome is the whole answer. */
  | Readonly<{ kind: "empty" }>
  /** `200` and the result, once its own contract accepts it. */
  | Readonly<{ kind: "result"; check(value: unknown): boolean }>
  /** `200` and the result byte for byte, with the length it measured. */
  | Readonly<{ kind: "raw" }>;

/** How a thrown seam failure becomes a refusal. */
type RouteFailure = Readonly<{ statusCode: number; code(error: unknown): string }>;

/**
 * One lifecycle route: the wire shape it answers, the body shape it requires, what it invokes, how it replies, and how
 * its failure is refused. None of it is per-kind logic - `dispatchLifecycleRoute` is the whole of the fold, which is
 * what keeps a row from growing a branch of its own.
 */
type LifecycleRouteSpec<C> = Readonly<{
  method: "GET" | "POST";
  path: string;
  /** Whether the profile this handler was built for mounts the operation behind the route. */
  mounted: boolean;
  body: RouteBody;
  run(admission: ComposedReferenceGameBrowserLifecycleActivationAdmission, command: C): Promise<unknown>;
  reply: RouteReply;
  failure: RouteFailure;
}>;

/**
 * A compiled validator's own `Check`, carried with its receiver: the validator keeps its state on `this`, so a bare
 * method reference in a row would be called on nothing.
 */
function boundCheck(validator: Readonly<{ Check(value: unknown): boolean }>): (value: unknown) => boolean {
  return (value) => validator.Check(value);
}

/**
 * The two refusals every route shares, in the order they have always been answered in: an operation the profile does
 * not mount is `404 not_found` - the route is not published - and a mounted route asked with a query or a body its
 * shape does not carry is `409 malformed_request`. Returns whether it refused.
 */
function refuseRouteRequest(response: ServerResponse, mounted: boolean, wellFormed: boolean): boolean {
  if (mounted && wellFormed) {
    return false;
  }
  sendProblem(response, mounted ? 409 : 404, mounted ? "malformed_request" : "not_found");
  return true;
}

/**
 * A refusal on the bootstrap route names its bounded cause; every refusal on every other route is exactly what it was:
 * the same code, the same status, the same body, and no added header. One helper, because the router refuses an
 * unauthenticated origin before it knows which route the caller meant.
 */
function refuseWithBootstrapCause(context: RouteRequest, statusCode: number, code: string, cause: string): void {
  if (context.url.pathname === BOOTSTRAP_PATH) {
    sendBootstrapProblem(context.response, statusCode, code, cause);
    return;
  }
  sendProblem(context.response, statusCode, code);
}

function sendNoContent(response: ServerResponse): void {
  response.writeHead(204, { "cache-control": "no-store", "content-length": "0" });
  response.end();
}

/**
 * A one-shot admission bound to the live request, or `undefined` after the `401` every route answers a caller who has
 * none with.
 */
function openRouteAdmission(
  context: RouteRequest,
): ComposedReferenceGameBrowserLifecycleActivationAdmission | undefined {
  const admission = issueComposedReferenceGameBrowserLifecycleActivationAdmission(
    context.issuer,
    context.request,
    context.origin,
  );
  if (admission !== null) {
    return admission;
  }
  sendProblem(context.response, 401, "unauthorized");
  return undefined;
}

/**
 * The command the route's seam takes, read from the body the route declares. All three refusals here are the same one,
 * as they always were: the body could not be read, is not JSON, or is not the command its own schema binds.
 */
async function readRouteCommand(context: RouteRequest, body: RouteBody): Promise<CommandRead> {
  if (body.kind === "absent") {
    return { ok: true, command: undefined };
  }

  let bytes: Buffer;
  try {
    bytes = await readBody(context.request, body.kind === "empty" ? 0 : MAX_BOOTSTRAP_BODY_BYTES);
  } catch {
    sendProblem(context.response, 409, "malformed_request");
    return { ok: false };
  }

  if (body.kind === "empty") {
    if (bytes.length === 0) {
      return { ok: true, command: undefined };
    }
    sendProblem(context.response, 409, "malformed_request");
    return { ok: false };
  }

  let command: unknown;
  try {
    command = JSON.parse(bytes.toString("utf8"));
  } catch {
    sendProblem(context.response, 409, "malformed_request");
    return { ok: false };
  }

  if (!body.check(command)) {
    sendProblem(context.response, 409, "malformed_request");
    return { ok: false };
  }

  return { ok: true, command };
}

/**
 * The response a result earns. A result its own contract rejects is never sent: the refusal is the generic
 * `state_unavailable` at `409`, which is what every one of these routes already answered a result that named no
 * bounded cause with - the discovery rows by sending it directly, the rest by failing the check before `sendJson`.
 */
function writeRouteReply(response: ServerResponse, reply: RouteReply, result: unknown): void {
  if (reply.kind === "empty") {
    sendNoContent(response);
    return;
  }

  if (reply.kind === "raw") {
    const payload = Buffer.from(JSON.stringify(result), "utf8");
    response.writeHead(200, {
      "cache-control": "no-store",
      "content-type": "application/json",
      "content-length": String(payload.length),
    });
    response.end(payload);
    return;
  }

  if (!reply.check(result)) {
    sendProblem(response, 409, "state_unavailable");
    return;
  }

  sendJson(response, 200, result);
}

/**
 * The fold every lifecycle kind is answered by: its mount check, its one-shot admission, the body shape it declares,
 * its seam, and its declared reply - or the refusal its own mapper names. Nothing below this line knows a kind.
 */
async function dispatchLifecycleRoute<C>(spec: LifecycleRouteSpec<C>, context: RouteRequest): Promise<void> {
  const wellFormed =
    isEmptyQuery(context.url) && (spec.method !== "GET" || hasEmptyRequestBodyHeaders(context.request));
  if (refuseRouteRequest(context.response, spec.mounted, wellFormed)) {
    return;
  }

  const admission = openRouteAdmission(context);
  if (admission === undefined) {
    return;
  }

  const command = await readRouteCommand(context, spec.body);
  if (!command.ok) {
    return;
  }

  try {
    writeRouteReply(context.response, spec.reply, await spec.run(admission, command.command as C));
  } catch (error) {
    sendLifecycleProblem(context.response, spec.failure.statusCode, error, spec.failure.code(error));
  }
}

function lifecycleRoute<C>(spec: LifecycleRouteSpec<C>): ComposedBrowserRoute {
  return { method: spec.method, path: spec.path, handle: (context) => dispatchLifecycleRoute(spec, context) };
}

/**
 * The table as pairs, with the kind each row answers as beside it. The cast is sound by construction: every table it
 * is given is held to `Record<LifecycleAdmissionOperation, …>` by its own `satisfies`, so it can yield no other key.
 */
function routeEntries(
  table: Readonly<Record<LifecycleAdmissionOperation, ComposedBrowserRoute>>,
): readonly (readonly [LifecycleAdmissionOperation, ComposedBrowserRoute])[] {
  return Object.entries(table) as readonly (readonly [LifecycleAdmissionOperation, ComposedBrowserRoute])[];
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
  const discoveryOperationIds: readonly (typeof GAME_BROWSER_OPERATION_IDS_V1)[number][] = [
    "game.installation.discovery.read",
    "game.installation.discovery.confirm",
    "game.installation.discovery.retry",
    "game.installation.discovery.cancel",
    "game.installation.discovery.manual_picker",
  ];
  const discoveryOperationsMounted = discoveryOperationIds.map(
    (id) => options.profile.gameProfile?.operationIds.includes(id) === true,
  );
  const discoveryMounted = discoveryOperationsMounted.some(Boolean);
  const discoveryCallbacksMounted =
    options.gameDiscovery !== undefined &&
    typeof options.gameDiscovery.read === "function" &&
    typeof options.gameDiscovery.confirm === "function" &&
    typeof options.gameDiscovery.retry === "function" &&
    typeof options.gameDiscovery.cancel === "function" &&
    typeof options.gameDiscovery.manualPicker === "function";
  if (
    discoveryMounted !== discoveryCallbacksMounted ||
    discoveryOperationsMounted.some((mounted) => mounted !== discoveryMounted)
  ) {
    throw new Error("Composed reference-game discovery operations are mismounted");
  }
  const cabinOperationIds = ["game.stardew.cabins.read", "game.stardew.cabins.confirm"] as const;
  const cabinOperationsMounted = cabinOperationIds.map(
    (id) => options.profile.gameProfile?.operationIds.includes(id) === true,
  );
  const cabinMounted = cabinOperationsMounted.some(Boolean);
  const cabinCallbacksMounted =
    options.stardewCabins !== undefined &&
    typeof options.stardewCabins.read === "function" &&
    typeof options.stardewCabins.confirm === "function";
  if (cabinMounted !== cabinCallbacksMounted || cabinOperationsMounted.some((mounted) => mounted !== cabinMounted)) {
    throw new Error("Composed reference-game cabin operations are mismounted");
  }
  const settingsOperationIds = ["game.stardew.settings.read", "game.stardew.settings.update"] as const;
  const settingsOperationsMounted = settingsOperationIds.map(
    (id) => options.profile.gameProfile?.operationIds.includes(id) === true,
  );
  const settingsMounted = settingsOperationsMounted.some(Boolean);
  const settingsCallbacksMounted =
    options.stardewSettings !== undefined &&
    typeof options.stardewSettings.read === "function" &&
    typeof options.stardewSettings.update === "function";
  if (
    settingsMounted !== settingsCallbacksMounted ||
    settingsOperationsMounted.some((mounted) => mounted !== settingsMounted)
  ) {
    throw new Error("Composed reference-game settings operations are mismounted");
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

  // Registered with its issuer state below, once the route table that decides which wire shapes it may admit exists.
  const lifecycleActivationIssuer: ComposedReferenceGameBrowserLifecycleActivationIssuer = Object.freeze({});

  const createContext = (activeSession: BrowserSession): ComposedReferenceGameBrowserReadContext =>
    Object.freeze({
      csrfToken: activeSession.csrfToken,
      browserSessionExpiresAtMs: activeSession.expiresAtMs,
    });

  const readComposedRoot = async (context: ComposedReferenceGameBrowserReadContext): Promise<unknown> => {
    let chat: TavernStateSnapshotV1;
    let game: GameBrowserStateV1 | null = null;
    try {
      chat = await options.readChat(context);
    } catch (error) {
      throw new ControlledStateError(boundedProducerCode(error) ?? "chat_projection_failed");
    }

    if (
      !TavernBrowserValidatorsV1.TavernStateSnapshotV1Schema.Check(chat) ||
      chat.build.profileId !== options.profile.tavernProfile.profileId ||
      chat.csrfToken !== context.csrfToken ||
      chat.browserSession.expiresAtMs !== context.browserSessionExpiresAtMs
    ) {
      throw new ControlledStateError("chat_snapshot_mismatch");
    }

    if (options.readGame !== undefined) {
      try {
        game = await options.readGame(context);
      } catch (error) {
        throw new ControlledStateError(boundedProducerCode(error) ?? "game_projection_failed");
      }
    }

    if (game !== null) {
      if (
        options.profile.gameProfile === null ||
        !GameBrowserValidatorsV1.GameBrowserStateV1Schema.Check(game) ||
        game.build.profileId !== options.profile.gameProfile.profileId ||
        game.csrfToken !== context.csrfToken ||
        game.browserSession.expiresAtMs !== context.browserSessionExpiresAtMs
      ) {
        throw new ControlledStateError("game_snapshot_mismatch");
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

    if (!ComposedReferenceGameBrowserValidatorsV1.ComposedReferenceGameBrowserRootV1Schema.Check(composed)) {
      throw new ControlledStateError("composed_root_invalid");
    }

    return composed;
  };

  const readGame = async (context: ComposedReferenceGameBrowserReadContext): Promise<GameBrowserStateV1> => {
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

  /**
   * The bootstrap route: the one refusal a launch cannot see any other way, and the one route that mints the session
   * every other route reads. Each branch names itself on the response, and every code and status is exactly what it
   * was.
   */
  const handleBootstrap = async (context: RouteRequest): Promise<void> => {
    if (!isEmptyQuery(context.url)) {
      refuseWithBootstrapCause(context, 409, "malformed_request", "bootstrap_query_rejected");
      return;
    }
    if (!isExactOrigin(context.request, context.origin)) {
      refuseWithBootstrapCause(context, 401, "unauthorized", "bootstrap_origin_header_mismatch");
      return;
    }
    if (!isExactJsonContentType(context.request.headers["content-type"])) {
      refuseWithBootstrapCause(context, 409, "malformed_request", "bootstrap_content_type_rejected");
      return;
    }

    let body: Buffer;
    try {
      body = await readBody(context.request, MAX_BOOTSTRAP_BODY_BYTES);
    } catch {
      refuseWithBootstrapCause(context, 409, "malformed_request", "bootstrap_body_unreadable");
      return;
    }

    const submittedToken = parseBootstrapRequest(body);
    if (submittedToken === undefined) {
      refuseWithBootstrapCause(context, 401, "unauthorized", "bootstrap_request_malformed");
      return;
    }
    if (!BOOTSTRAP_TOKEN_PATTERN.test(submittedToken)) {
      refuseWithBootstrapCause(context, 401, "unauthorized", "bootstrap_token_shape_invalid");
      return;
    }
    if (bootstrapConsumed) {
      // The one-shot token was already redeemed. This is what a reload, a second tab or a stale entry looks like, and
      // it is a different situation from a token this server never minted.
      refuseWithBootstrapCause(context, 401, "unauthorized", "bootstrap_token_consumed");
      return;
    }
    if (!timingSafeStringEqual(submittedToken, options.bootstrapToken)) {
      // The one refusal that is deliberately reported no further than this: the caller learns its token is not this
      // server's, and nothing at all about the token that is.
      refuseWithBootstrapCause(context, 401, "unauthorized", "bootstrap_token_mismatch");
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
      sendJson(context.response, 200, composed, {
        "set-cookie": `${SESSION_COOKIE_NAME}=${activeSession.bearerToken}; HttpOnly; SameSite=Strict; Path=/`,
      });
    } catch (error) {
      // A session becomes usable only after its first authoritative root projection validates; a broken producer
      // cannot leave an authenticated browser context behind for a later retry. The refusal names the projection
      // that broke (or the producer's own bounded code), because a bootstrap that consumed its one-shot token and
      // then answered a bare `state_unavailable` is exactly the launch that could not be diagnosed.
      if (session === activeSession) session = undefined;
      refuseWithBootstrapCause(
        context,
        409,
        "state_unavailable",
        error instanceof ControlledStateError && error.refusalCode !== undefined
          ? error.refusalCode
          : "composed_root_projection_failed",
      );
    }
  };

  /**
   * The authenticated read both session routes share: no query, no request body, a same-origin caller, and this
   * broker's own live session cookie. A session past its expiry is retired here, where it has always been retired.
   */
  const openSessionContext = async (
    context: RouteRequest,
  ): Promise<ComposedReferenceGameBrowserReadContext | undefined> => {
    if (!isEmptyQuery(context.url) || !hasEmptyRequestBodyHeaders(context.request)) {
      sendProblem(context.response, 409, "malformed_request");
      return undefined;
    }
    if (!isSameOriginSafeGet(context.request, context.origin)) {
      sendProblem(context.response, 401, "unauthorized");
      return undefined;
    }

    let body: Buffer;
    try {
      body = await readBody(context.request, 0);
    } catch {
      sendProblem(context.response, 409, "malformed_request");
      return undefined;
    }
    if (body.length !== 0) {
      sendProblem(context.response, 409, "malformed_request");
      return undefined;
    }

    const activeSession = session;
    const bearerToken = parseSingleCookie(context.request.headers.cookie, SESSION_COOKIE_NAME);
    if (
      activeSession === undefined ||
      activeSession.expiresAtMs <= Date.now() ||
      bearerToken === undefined ||
      !timingSafeStringEqual(bearerToken, activeSession.bearerToken)
    ) {
      if (activeSession !== undefined && activeSession.expiresAtMs <= Date.now()) {
        session = undefined;
      }
      sendProblem(context.response, 401, "unauthorized");
      return undefined;
    }

    return createContext(activeSession);
  };

  const readStateRoute = async (context: RouteRequest): Promise<void> => {
    const readContext = await openSessionContext(context);
    if (readContext === undefined) {
      return;
    }
    try {
      sendJson(context.response, 200, await readComposedRoot(readContext));
    } catch {
      sendProblem(context.response, 409, "state_unavailable");
    }
  };

  const readGameRoute = async (context: RouteRequest): Promise<void> => {
    const readContext = await openSessionContext(context);
    if (readContext === undefined) {
      return;
    }
    if (options.readGame === undefined) {
      sendProblem(context.response, 404, "not_found");
      return;
    }
    try {
      sendJson(context.response, 200, await readGame(readContext));
    } catch {
      sendProblem(context.response, 409, "state_unavailable");
    }
  };

  /**
   * Every inbound kind this handler answers, as a DECLARATION rather than a ladder of `if (request.url === …)` arms:
   * one row per kind, naming the kind, the wire shape it answers, the shape it requires of the request body, what it
   * invokes, how it replies, and how a thrown seam failure becomes a refusal.
   *
   * `satisfies` holds the table to `LifecycleAdmissionOperation` in both directions - a kind with no row, or a row for
   * a kind the one-shot admission seam does not know, is a compile error rather than a silently unanswerable route -
   * which is why the kinds must not be restated anywhere else, and why those arms must not be restored. The router
   * built from it below is its only other reader: a wire shape is admitted exactly where a row names it.
   *
   * Every `options.gameX!` below is the mount check above: a profile declares an operation exactly when its seam is
   * present, and construction refuses the mismount before this table is built.
   */
  const lifecycleRoutes = {
    discovery_read: lifecycleRoute({
      method: "GET",
      path: DISCOVERY_PATH,
      mounted: options.gameDiscovery !== undefined,
      body: { kind: "absent" },
      run: (admission) => options.gameDiscovery!.read(admission),
      reply: { kind: "result", check: boundCheck(GameBrowserValidatorsV1.GameDiscoveryReadResultV1Schema) },
      failure: { statusCode: 503, code: () => "game_unavailable" },
    }),
    discovery_confirm: lifecycleRoute({
      method: "POST",
      path: DISCOVERY_CONFIRM_PATH,
      mounted: options.gameDiscovery !== undefined,
      body: { kind: "command", check: boundCheck(GameBrowserValidatorsV1.GameDiscoveryConfirmCommandV1Schema) },
      run: (admission, command: GameDiscoveryConfirmCommandV1) => options.gameDiscovery!.confirm(admission, command),
      reply: { kind: "result", check: boundCheck(GameBrowserValidatorsV1.GameDiscoveryMutationResultV1Schema) },
      failure: { statusCode: 503, code: () => "game_unavailable" },
    }),
    // Retry, cancel and the manual picker still bind the closed `{apiVersion}` action body, but their seams take the
    // admission alone: the operation is the row's own, and the admission already names it.
    discovery_retry: lifecycleRoute({
      method: "POST",
      path: DISCOVERY_RETRY_PATH,
      mounted: options.gameDiscovery !== undefined,
      body: { kind: "command", check: boundCheck(GameBrowserValidatorsV1.GameDiscoveryActionCommandV1Schema) },
      run: (admission) => options.gameDiscovery!.retry(admission),
      reply: { kind: "result", check: boundCheck(GameBrowserValidatorsV1.GameDiscoveryReadResultV1Schema) },
      failure: { statusCode: 503, code: () => "game_unavailable" },
    }),
    discovery_cancel: lifecycleRoute({
      method: "POST",
      path: DISCOVERY_CANCEL_PATH,
      mounted: options.gameDiscovery !== undefined,
      body: { kind: "command", check: boundCheck(GameBrowserValidatorsV1.GameDiscoveryActionCommandV1Schema) },
      run: (admission) => options.gameDiscovery!.cancel(admission),
      reply: { kind: "result", check: boundCheck(GameBrowserValidatorsV1.GameDiscoveryMutationResultV1Schema) },
      failure: { statusCode: 503, code: () => "game_unavailable" },
    }),
    discovery_picker: lifecycleRoute({
      method: "POST",
      path: DISCOVERY_PICKER_PATH,
      mounted: options.gameDiscovery !== undefined,
      body: { kind: "command", check: boundCheck(GameBrowserValidatorsV1.GameDiscoveryActionCommandV1Schema) },
      run: (admission) => options.gameDiscovery!.manualPicker(admission),
      reply: { kind: "result", check: boundCheck(GameBrowserValidatorsV1.GameDiscoveryMutationResultV1Schema) },
      failure: { statusCode: 503, code: () => "game_unavailable" },
    }),
    // The command carries nothing: the session, the install and the attempt are the admission's to name, and a body
    // here would be a second, unauthenticated way to say what to activate.
    lifecycle_activation: lifecycleRoute({
      method: "POST",
      path: LIFECYCLE_ACTIVATE_PATH,
      mounted: options.gameActivate !== undefined,
      body: { kind: "empty" },
      run: (admission) => options.gameActivate!(admission),
      reply: { kind: "empty" },
      failure: { statusCode: 409, code: gameActivateProblemCode },
    }),
    game_setup: lifecycleRoute({
      method: "POST",
      path: GAME_SETUP_PATH,
      mounted: options.gameSetup !== undefined,
      body: { kind: "command", check: boundCheck(GameBrowserValidatorsV1.GamePrerequisitesSetupCommandV1Schema) },
      run: (admission, command: GamePrerequisitesSetupCommandV1) => options.gameSetup!(admission, command),
      reply: { kind: "empty" },
      failure: { statusCode: 409, code: gameSetupProblemCode },
    }),
    game_launch: lifecycleRoute({
      method: "POST",
      path: GAME_LAUNCH_PATH,
      mounted: options.gameLaunch !== undefined,
      body: { kind: "command", check: boundCheck(GameBrowserValidatorsV1.GameLaunchCommandV1Schema) },
      run: (admission, command: GameLaunchCommandV1) => options.gameLaunch!(admission, command),
      reply: { kind: "empty" },
      failure: { statusCode: 409, code: gameLaunchProblemCode },
    }),
    game_stop: lifecycleRoute({
      method: "POST",
      path: GAME_STOP_PATH,
      mounted: options.gameStop !== undefined,
      body: { kind: "command", check: boundCheck(GameBrowserValidatorsV1.GameStopCommandV1Schema) },
      run: (admission, command: GameStopCommandV1) => options.gameStop!(admission, command),
      reply: { kind: "empty" },
      failure: { statusCode: 409, code: gameStopProblemCode },
    }),
    game_resume: lifecycleRoute({
      method: "POST",
      path: GAME_RESUME_PATH,
      mounted: options.gameResume !== undefined,
      body: { kind: "command", check: boundCheck(GameBrowserValidatorsV1.GameResumeCommandV1Schema) },
      run: (admission, command: GameResumeCommandV1) => options.gameResume!(admission, command),
      reply: { kind: "result", check: boundCheck(GameBrowserValidatorsV1.GameResumeResultV1Schema) },
      failure: { statusCode: 409, code: gameResumeProblemCode },
    }),
    game_resume_cancel: lifecycleRoute({
      method: "POST",
      path: GAME_RESUME_CANCEL_PATH,
      mounted: options.gameResumeCancel !== undefined,
      body: { kind: "command", check: boundCheck(GameBrowserValidatorsV1.GameResumeCancelCommandV1Schema) },
      run: (admission, command: GameResumeCancelCommandV1) => options.gameResumeCancel!(admission, command),
      reply: { kind: "result", check: boundCheck(GameBrowserValidatorsV1.GameResumeCancelResultV1Schema) },
      failure: { statusCode: 409, code: gameResumeCancelProblemCode },
    }),
    game_create: lifecycleRoute({
      method: "POST",
      path: GAME_CREATE_PATH,
      mounted: options.gameCreate !== undefined,
      body: { kind: "command", check: boundCheck(GameBrowserValidatorsV1.GameCreateCommandV1Schema) },
      run: (admission, command: GameCreateCommandV1) => options.gameCreate!(admission, command),
      reply: { kind: "result", check: boundCheck(GameBrowserValidatorsV1.GameCreateResultV1Schema) },
      failure: { statusCode: 409, code: gameCreateProblemCode },
    }),
    game_reopen: lifecycleRoute({
      method: "POST",
      path: GAME_REOPEN_PATH,
      mounted: options.gameReopen !== undefined,
      body: { kind: "command", check: boundCheck(GameBrowserValidatorsV1.GameReopenActionAuthorityCommandV1Schema) },
      run: (admission, command: GameReopenActionAuthorityCommandV1) => options.gameReopen!(admission, command),
      reply: { kind: "result", check: boundCheck(GameBrowserValidatorsV1.GameReopenActionAuthorityResultV1Schema) },
      failure: { statusCode: 409, code: gameReopenProblemCode },
    }),
    game_disconnect: lifecycleRoute({
      method: "POST",
      path: GAME_DISCONNECT_PATH,
      mounted: options.gameDisconnect !== undefined,
      body: { kind: "command", check: boundCheck(GameBrowserValidatorsV1.GameDisconnectCommandV1Schema) },
      run: (admission, command: GameDisconnectCommandV1) => options.gameDisconnect!(admission, command),
      reply: { kind: "empty" },
      failure: { statusCode: 409, code: gameDisconnectProblemCode },
    }),
    // The settlement answers with the length it wrote and no re-check: its own payload IS the endgame result, and the
    // shape beside it is already the contract's.
    game_endgame: lifecycleRoute({
      method: "POST",
      path: GAME_ENDGAME_PATH,
      mounted: options.gameEndgame !== undefined,
      body: { kind: "command", check: boundCheck(GameBrowserValidatorsV1.GameEndgameCommandV1Schema) },
      run: (admission, command: GameEndgameCommandV1) => options.gameEndgame!(admission, command),
      reply: { kind: "raw" },
      failure: { statusCode: 409, code: gameEndgameProblemCode },
    }),
    settings_read: lifecycleRoute({
      method: "GET",
      path: STARDEW_SETTINGS_PATH,
      mounted: options.stardewSettings !== undefined,
      body: { kind: "absent" },
      run: (admission) => options.stardewSettings!.read(admission),
      reply: { kind: "result", check: boundCheck(GameBrowserValidatorsV1.StardewPlayerSettingsV1Schema) },
      failure: { statusCode: 409, code: stardewSettingsProblemCode },
    }),
    settings_update: lifecycleRoute({
      method: "POST",
      path: STARDEW_SETTINGS_PATH,
      mounted: options.stardewSettings !== undefined,
      body: { kind: "command", check: boundCheck(GameBrowserValidatorsV1.StardewPlayerSettingsCommandV1Schema) },
      run: (admission, command: StardewPlayerSettingsCommandV1) => options.stardewSettings!.update(admission, command),
      reply: { kind: "result", check: boundCheck(GameBrowserValidatorsV1.StardewPlayerSettingsV1Schema) },
      failure: { statusCode: 409, code: stardewSettingsProblemCode },
    }),
    // The read has its OWN causes, and one of them is actionable in a way `state_unavailable` is not.
    //
    // Measured 2026-10-28: a world with no cabin for the companion throws `stardew_player_host_cabin_unavailable`,
    // whose cure is "have Robin build one" - the guidance the product already gives. Flattened to
    // `state_unavailable`, the panel can only say "unavailable" and the player retries forever. The confirm branch
    // beside this one has always mapped by name; the read branch did not.
    cabin_read: lifecycleRoute({
      method: "GET",
      path: STARDEW_CABINS_PATH,
      mounted: options.stardewCabins !== undefined,
      body: { kind: "absent" },
      run: (admission) => options.stardewCabins!.read(admission),
      reply: { kind: "result", check: boundCheck(GameBrowserValidatorsV1.StardewCabinChoicesV1Schema) },
      failure: { statusCode: 409, code: stardewCabinReadProblemCode },
    }),
    cabin_confirm: lifecycleRoute({
      method: "POST",
      path: STARDEW_CABINS_CONFIRM_PATH,
      mounted: options.stardewCabins !== undefined,
      body: { kind: "command", check: boundCheck(GameBrowserValidatorsV1.StardewCabinConfirmCommandV1Schema) },
      run: (admission, command: StardewCabinConfirmCommandV1) => options.stardewCabins!.confirm(admission, command),
      reply: { kind: "result", check: boundCheck(GameBrowserValidatorsV1.StardewCabinConfirmResultV1Schema) },
      failure: { statusCode: 409, code: stardewCabinProblemCode },
    }),
  } satisfies Record<LifecycleAdmissionOperation, ComposedBrowserRoute>;

  /** The three kinds that carry no lifecycle admission, held to their own union the same way. */
  const sessionRoutes = {
    bootstrap: { method: "POST", path: BOOTSTRAP_PATH, handle: handleBootstrap },
    state_read: { method: "GET", path: STATE_PATH, handle: readStateRoute },
    game_read: { method: "GET", path: GAME_PATH, handle: readGameRoute },
  } satisfies Record<SessionRouteKind, ComposedBrowserRoute>;

  // One lookup per request, and one admission operation per admitted shape: both are read from the declarations
  // above, so no wire shape can be answered without a row or admitted without one.
  const routes = new Map<string, ComposedBrowserRoute>();
  const admissionOperations = new Map<string, LifecycleAdmissionOperation>();
  for (const [kind, route] of routeEntries(lifecycleRoutes)) {
    const key = routeKey(route.method, route.path);
    routes.set(key, route);
    admissionOperations.set(key, kind);
  }
  for (const route of Object.values(sessionRoutes)) {
    routes.set(routeKey(route.method, route.path), route);
  }
  lifecycleActivationIssuers.set(lifecycleActivationIssuer, { currentSession, admissionOperations });

  /** The whole of the routing: the closed gate, the origin guard, and the row the inbound kind resolves to. */
  const dispatch = async (request: IncomingMessage, response: ServerResponse, origin: string): Promise<void> => {
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

    const context: RouteRequest = { request, response, url: requestUrl, origin, issuer: lifecycleActivationIssuer };

    if (
      originUrl.protocol !== "http:" ||
      !isLiteralLoopbackOrigin(originUrl) ||
      requestUrl.origin !== originUrl.origin ||
      !requestHasExpectedHost(request, originUrl)
    ) {
      refuseWithBootstrapCause(context, 401, "unauthorized", "bootstrap_origin_rejected");
      return;
    }

    const route = routes.get(routeKey(request.method, requestUrl.pathname));
    if (route === undefined) {
      sendProblem(response, 404, "not_found");
      return;
    }

    await route.handle(context);
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
