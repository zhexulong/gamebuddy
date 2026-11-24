// @zone contract:platform
import { assertNever } from "./assert-never.js";
import { type TavernStateSnapshotV1, validateSnapshot } from "./reference-pipeline-api.js";
import {
  CABIN_OCCUPANCY_UNKNOWN_REASONS,
  type CabinOccupancyUnknownReason,
} from "./stardew-cabin-occupancy-unknown-reasons.generated.js";
import {
  CABIN_QUARANTINE_RELEASES,
  type CabinQuarantineRelease,
} from "./stardew-cabin-quarantine-releases.generated.js";

/**
 * Browser-only boundary for the composed reference-game profile.
 *
 * The composed broker owns bootstrap/session identity and returns one strict
 * root. Nested Chat operations deliberately stay on the existing
 * `tavern_browser_api/v1` client; this module only owns the composed bootstrap,
 * the authoritative state read, and the Game slice's own read. In particular, it
 * never reads Tavern `/bootstrap` or `/state` as a composed refresh source.
 */

const COMPOSED_REFERENCE_GAME_BROWSER_API_V1 = "composed_reference_game_browser_api/v1" as const;
const COMPOSED_REFERENCE_GAME_BROWSER_API_VERSION = 1 as const;
const COMPOSED_REFERENCE_GAME_PROFILE_ID = "gamebuddy.composed.reference-game" as const;
const COMPOSED_REFERENCE_GAME_TAVERN_PROFILE_ID = "gamebuddy.chat-core.reference-pipeline" as const;
const COMPOSED_REFERENCE_GAME_PROFILE_ID_GAME = "gamebuddy.game.preview" as const;

const BASE64URL_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
/**
 * Whether the companion Mod itself is in the player's `Mods/GameBuddy`, using the launcher's own
 * vocabulary (`CompanionGameModDeploymentOutcome`). One list, mirrored from the Host contract, so the
 * player never sees two spellings of "the Mod is not there" depending on which step said it.
 */
const COMPANION_MOD_OUTCOMES = Object.freeze([
  "companion-mod-installed",
  "companion-mod-current",
  "companion-mod-updated",
  "companion-mod-game-not-found",
  "companion-mod-choice-required",
  "companion-mod-unavailable",
  "companion-mod-game-installation-not-found",
  "companion-mod-smapi-not-installed",
  "companion-mod-mods-directory-missing",
  "companion-mod-mods-directory-not-writable",
  "companion-mod-existing-mod-version-requires-consent",
  "companion-mod-foreign-mod-present",
  "companion-mod-installed-mod-manifest-unreadable",
  "companion-mod-package-invalid",
  "companion-mod-deployment-incomplete",
] as const);
const OPAQUE_HANDLE_PATTERN = /^[A-Za-z0-9_-]{22,128}$/;
const MAX_GAME_LABEL_LENGTH = 256;
const MAX_CABIN_DISPLAY_LABEL_LENGTH = 128;
const MAX_CABIN_CHOICES = 64;
const MAX_GAME_MESSAGE_LENGTH = 512;

const PREREQUISITE_STATUSES = ["unknown", "met", "failed"] as const;
const INSTANCE_STATUSES = ["none", "launching", "running", "stopped", "crashed", "unread"] as const;
const COMPATIBILITY_STATUSES = ["unchecked", "compatible", "incompatible", "warning"] as const;
const ATTACHMENT_STATUSES = ["none", "pending", "attached", "failed"] as const;
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
const CABIN_OCCUPANCY_KEYS = ["apiVersion", "occupancy", "release"] as const;
const CABIN_OCCUPANCY_FIELDS_KEYS = [
  "answer",
  "reason",
  "cabinId",
  "boundBy",
  "publishedAtUnixMs",
  "observedAtUnixMs",
] as const;
/** The Mod's three answers. */
const CABIN_OCCUPANCY_ANSWERS = ["not_bound", "already_bound", "unknown"] as const;
const CABIN_CONFIRMATION_KEYS = ["apiVersion", "status"] as const;
const INSTALLATION_DISCOVERY_KEYS = ["apiVersion", "candidates", "diagnostics"] as const;
/**
 * A candidate's required members, and the members the contract declares `Type.Optional`.
 *
 * Enumerating whole key SETS is what this used to do (one list for "with location", one without), and on 2026-11-08
 * that broke the panel for real: the Host started sending the optional `modLoader` the contract has always declared,
 * the key set matched neither list, so `invalid_stardew_installation_candidate` was thrown, the panel caught a code it
 * does not recognise, and the player was shown "cannot read the installation search result" while the Host's own answer
 * was `resolved` with one candidate. A member declared optional by the contract must be validated on its own, never as
 * part of a combination, or every new optional member needs 2^n new lists - and the one that is forgotten is silent.
 */
const INSTALLATION_CANDIDATE_REQUIRED_KEYS = ["candidateId", "source", "label", "hint", "status"] as const;
const INSTALLATION_CANDIDATE_OPTIONAL_KEYS = ["location", "modLoader"] as const;
const INSTALLATION_CANDIDATE_ALLOWED_KEYS: ReadonlySet<string> = new Set([
  ...INSTALLATION_CANDIDATE_REQUIRED_KEYS,
  ...INSTALLATION_CANDIDATE_OPTIONAL_KEYS,
]);
/**
 * Every required member present, and nothing outside the required-plus-optional set. Optional members are checked
 * individually below (`location` as a bounded label, `modLoader` as one of its two literals).
 */
function hasInstallationCandidateKeys(value: Record<string, unknown>): boolean {
  const own = Object.keys(value);
  return (
    INSTALLATION_CANDIDATE_REQUIRED_KEYS.every((key) => own.includes(key)) &&
    own.every((key) => INSTALLATION_CANDIDATE_ALLOWED_KEYS.has(key))
  );
}
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
  "game_instance_not_found",
  "game_attachment_conflict",
  "game_operation_in_progress",
  "stardew_cabin_choice_stale",
  "stardew_manifest_handoff_uncertain",
  "game_runtime_unavailable",
  "game_launch_unreachable",
  "game_storage_unavailable",
  "closed",
  "malformed_request",
  "not_found",
  "state_unavailable",
  "game_endgame_settlement_unavailable",
  "stardew_settings_revision_conflict",
  "stardew_player_host_exited",
  "stardew_player_host_cabin_missing",
  "stardew_bootstrap_registration_held",
  "stardew_game_create_world_held_by_player",
  "stardew_game_create_slot_held_by_earlier_attempt",
] as const;
export type GameProblemCode = (typeof GAME_PROBLEM_CODES)[number];

const ROOT_KEYS = ["apiVersion", "build", "chat", "game"] as const;
/** The same root on a Host that could not read its Game half: the member is absent, not `null`. */
const ROOT_KEYS_WITHOUT_GAME = ["apiVersion", "build", "chat"] as const;
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
/**
 * The Game surface's push checkpoint, the one optional top-level member of a game read.
 *
 * Absent means this Host holds no Game event stream - it is a Host (or a mount) that only ever answers the snapshot,
 * which is why the panel subscribes exactly when the field is there.
 */
const GAME_STATE_OPTIONAL_KEYS = ["eventStream"] as const;
const GAME_STATE_ALLOWED_KEYS: ReadonlySet<string> = new Set([...GAME_STATE_KEYS, ...GAME_STATE_OPTIONAL_KEYS]);
const GAME_STREAM_CHECKPOINT_KEYS = ["epoch", "cursor"] as const;
/**
 * The three facts that can change without a player acting, and the frame members each one owns.
 *
 * A closed list, mirrored from `GameFactPatchV1Schema`: a fact the Host cannot publish has no shape here to arrive
 * in, and a frame carrying one is a protocol error rather than a field to merge. `prerequisites` and
 * `actionAuthority` are deliberately absent - they move only when a command moved them.
 */
const GAME_FACT_KEYS = Object.freeze({
  instance: ["instance", "compatibility", "latestOutcome"] as const,
  attachment: ["attachment", "connectionStatus", "capabilitySummary"] as const,
  selectedWorld: ["selectedWorld"] as const,
});
const GAME_FACTS = ["instance", "attachment", "selectedWorld"] as const;
const GAME_EVENT_TYPES = ["game.fact_changed", "game.stream_resync_required"] as const;
const GAME_RESYNC_REASONS = ["gap", "epoch_changed", "ambiguous_cursor"] as const;
const GAME_BUILD_KEYS = ["browserContract", "profileId"] as const;
const GAME_PREREQUISITES_KEYS = ["status", "detectedGame"] as const;
const GAME_INSTANCE_REQUIRED_KEYS = ["status", "gameTitle", "generation"] as const;
/**
 * The instance members the contract declares `Type.Optional`. `playerHostExitCode` is one: it
 * exists only on a Host whose Guardian reported the game process ending, and its absence is the
 * honest "this Host observed no exit" rather than a number a client invented.
 */
const GAME_INSTANCE_OPTIONAL_KEYS = ["playerHostExitCode"] as const;
const GAME_INSTANCE_ALLOWED_KEYS: ReadonlySet<string> = new Set([
  ...GAME_INSTANCE_REQUIRED_KEYS,
  ...GAME_INSTANCE_OPTIONAL_KEYS,
]);
const GAME_COMPATIBILITY_KEYS = ["status", "message"] as const;
const GAME_ATTACHMENT_REQUIRED_KEYS = ["status", "generation"] as const;
/**
 * The attachment member the contract declares `Type.Optional`: `cabinLabel`.
 *
 * It is the word for the cabin the attachment bound, published by a Host that records one. Absent is "this Host does
 * not publish cabin labels" and `null` is "this attachment bound no cabin this Host can name" - both render as "her
 * cabin", and neither licenses this client to name a cabin from the offers it happens to be holding.
 */
const GAME_ATTACHMENT_OPTIONAL_KEYS = ["cabinLabel"] as const;
const GAME_ATTACHMENT_ALLOWED_KEYS: ReadonlySet<string> = new Set([
  ...GAME_ATTACHMENT_REQUIRED_KEYS,
  ...GAME_ATTACHMENT_OPTIONAL_KEYS,
]);
const GAME_CAPABILITY_PUBLISHED_KEYS = ["status", "count"] as const;
const GAME_CAPABILITY_NOT_MEASURED_KEYS = ["status", "reason"] as const;

/**
 * The capability summary is ONE of two shapes, never a shape with a count that may be absent.
 *
 * `published` carries a count the Host measured - `0` there means the Mod advertised nothing. `not_measured` carries a
 * reason and no count at all: a count beside an unmeasured reading is the panel stating a number nobody produced, which
 * is what `{available: false, count: 0}` did on every reply.
 */
function isCapabilitySummary(value: Record<string, unknown>): boolean {
  if (value.status === "published")
    return hasExactKeys(value, GAME_CAPABILITY_PUBLISHED_KEYS) && isSafeInteger(value.count, 0) && value.count <= 512;
  if (value.status === "not_measured")
    return (
      hasExactKeys(value, GAME_CAPABILITY_NOT_MEASURED_KEYS) &&
      typeof value.reason === "string" &&
      value.reason.length > 0 &&
      value.reason.length <= 64
    );
  return false;
}

export type GameBrowserStateV1 = Readonly<{
  apiVersion: 1;
  build: Readonly<{
    browserContract: "game_browser_api/v1";
    profileId: string;
  }>;
  csrfToken: string;
  browserSession: Readonly<{ expiresAtMs: number }>;
  /**
   * The Game surface's own push checkpoint: the process epoch its stream is in, and the cursor to resume from.
   * Absent on a Host that holds no Game stream.
   */
  eventStream?: Readonly<{ epoch: string; cursor: string }>;
  game: Readonly<{
    prerequisites: Readonly<{
      status: (typeof PREREQUISITE_STATUSES)[number];
      detectedGame: string | null;
    }>;
    instance: Readonly<{
      status: (typeof INSTANCE_STATUSES)[number];
      gameTitle: string | null;
      generation: number;
      /**
       * The native exit code the game process ended with, present only when the Host's
       * Guardian reported an exit for this activation. Absent is "no exit observed", never
       * "running": `status` is the field that answers whether the game is there.
       */
      playerHostExitCode?: number;
    }>;
    compatibility: Readonly<{
      status: (typeof COMPATIBILITY_STATUSES)[number];
      message: string | null;
    }>;
    attachment: Readonly<{
      status: (typeof ATTACHMENT_STATUSES)[number];
      generation: number;
      /** The bound cabin's word; absent on a Host that publishes none, `null` when the binding named no cabin. */
      cabinLabel?: string | null;
    }>;
    connectionStatus: (typeof CONNECTION_STATUSES)[number];
    actionAuthority: (typeof ACTION_AUTHORITY_STATUSES)[number];
    role: "player" | "companion" | null;
    companionName: string | null;
    selectedWorld: string | null;
    selectedSave: string | null;
    capabilitySummary: Readonly<{ status: "published"; count: number } | { status: "not_measured"; reason: string }>;
    latestOutcome: (typeof OUTCOMES)[number];
  }>;
}>;

/** One member of the wire's closed fact union, named by its own `fact` tag. */
export type GameFactKindV1 = (typeof GAME_FACTS)[number];
export type GameResyncReasonV1 = (typeof GAME_RESYNC_REASONS)[number];

/**
 * One fact group, as the push channel publishes it.
 *
 * Each member names exactly the projection fields its fact owns, so a frame is merged rather than mistrusted: what
 * it carries is authoritative for those fields at that sequence, and the snapshot keeps everything else.
 */
export type GameFactPatchV1 =
  | Readonly<{
      fact: "instance";
      game: Readonly<{
        instance: GameBrowserStateV1["game"]["instance"];
        compatibility: GameBrowserStateV1["game"]["compatibility"];
        latestOutcome: GameBrowserStateV1["game"]["latestOutcome"];
      }>;
    }>
  | Readonly<{
      fact: "attachment";
      game: Readonly<{
        attachment: GameBrowserStateV1["game"]["attachment"];
        connectionStatus: GameBrowserStateV1["game"]["connectionStatus"];
        capabilitySummary: GameBrowserStateV1["game"]["capabilitySummary"];
      }>;
    }>
  | Readonly<{
      fact: "selectedWorld";
      game: Readonly<{ selectedWorld: GameBrowserStateV1["game"]["selectedWorld"] }>;
    }>;

/**
 * One frame of the Game surface's stream.
 *
 * `game.stream_resync_required` carries no fact on purpose: this channel keeps a bounded replay window, so a position
 * it cannot serve has to be replaced from `/game` instead of guessed at from whatever arrived.
 */
export type GameEventV1 =
  | Readonly<{
      apiVersion: 1;
      epoch: string;
      sequence: number;
      eventType: "game.fact_changed";
      payload: GameFactPatchV1;
    }>
  | Readonly<{
      apiVersion: 1;
      epoch: string;
      sequence: number;
      eventType: "game.stream_resync_required";
      payload: Readonly<{ reason: GameResyncReasonV1 }>;
    }>;

export type ComposedReferenceGameBrowserRootV1 = Readonly<{
  apiVersion: 1;
  build: Readonly<{
    browserContract: typeof COMPOSED_REFERENCE_GAME_BROWSER_API_V1;
    profileId: typeof COMPOSED_REFERENCE_GAME_PROFILE_ID;
  }>;
  chat: TavernStateSnapshotV1;
  /**
   * The Game half: a projection, `null` for a Host whose profile mounts no Game at all, and ABSENT when this
   * Host could not read the Game half it does mount.
   *
   * The member's presence is the distinction, and it is the only one: a surface that treats `null` and absence
   * alike is right about what it can draw (neither is a projection) and wrong about why - the profile has no
   * game to read in the first case and the game faulted in the second, which is the Game surface's own sentence.
   */
  game?: GameBrowserStateV1 | null;
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
   * The bounded producer code the Host named for this refusal, or `null` when it named
   * none. It is a snake_case code of the shape the Host's own `boundedProducerCode` admits,
   * so it can never carry producer text, a path or a token into the UI.
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
  /**
   * Whether this folder already holds a mod loader, or `null` when the Host did not say.
   *
   * `present` means the folder can load the companion Mod, so choosing it registers immediately. `missing` means
   * the game is there and the loader is not: the player installs it, then finds again. `null` is not `missing` -
   * it means nothing was checked, and it is never rendered as a result.
   */
  modLoader: "present" | "missing" | null;
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
    | "expired"
    | "mod_loader_missing"
    | "not_stardew_installation"
    | "reparse_point";
  /**
   * What happened to the companion Mod in the folder that was just registered.
   *
   * Present exactly on `registered`, which is the first moment the folder provably holds a mod loader - and
   * therefore the first moment our Mod can go where the game will load it. Reported rather than assumed, so a
   * deployment that refused names its refusal instead of the panel implying the companion is ready.
   */
  companionMod?: (typeof COMPANION_MOD_OUTCOMES)[number];
}>;

type StardewCabinChoicesV1 = Readonly<{
  apiVersion: 1;
  choices: readonly StardewCabinChoiceV1[];
}>;

/**
 * The cabin press's answer: the Mod's three answers, with their reason, and what the Host did with it.
 *
 * `publishedAtUnixMs` is null exactly when no authenticated document answered, and the two clocks are
 * carried so `unknown/session_document_stale` means what it says over the wire and not only inside the
 * Host's own tests. The world and farmhand the answer is about never travel: they are the attempt's own.
 */
export type StardewCabinOccupancyAnswerV1 = Readonly<{
  apiVersion: 1;
  occupancy: Readonly<{
    answer: (typeof CABIN_OCCUPANCY_ANSWERS)[number];
    reason: CabinOccupancyUnknownReason | null;
    cabinId: string | null;
    boundBy: "companion" | "manifest_farmhand" | null;
    publishedAtUnixMs: number | null;
    observedAtUnixMs: number;
  }>;
  release: CabinQuarantineRelease;
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
  /**
   * The Game slice alone, from the game's own route.
   *
   * A Game read is not a Chat read: the aggregate root carries the whole conversation beside the game's
   * few hundred bytes, so a panel polling it once a second re-reads a transcript it does not render -
   * and makes the Host re-project that transcript from its durable store, once per poll, for nothing.
   * This is the same projection, from the same Host seam and the same closed validator, without the
   * Chat half. It is a read, never a session writer: `bootstrap`/`readState` remain the only calls that
   * adopt a CSRF token.
   */
  readGameState(): Promise<GameBrowserStateV1>;
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
  /**
   * The press's own question: does this save hold her?
   *
   * A POST with no body: the answer can license one Host-side release, so this is an operation on the
   * attempt rather than a read of a projection, and the attempt it is about is the session's own.
   */
  readStardewCabinOccupancy(): Promise<StardewCabinOccupancyAnswerV1>;
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
  confirmStardewCabin(request: StardewCabinConfirmationRequestV1): Promise<StardewCabinConfirmationV1>;
  /**
   * `GET /api/composed-reference-game/v1/events`: the Game surface's own push channel.
   *
   * It is the Game channel, not the Chat one: no frame here carries a Chat selection generation, so switching Chats
   * cannot move this cursor, and the route is admitted on the same session cookie `/game` is. A cursor the Host
   * cannot serve comes back as one `game.stream_resync_required` frame, and the caller's answer to that is the
   * snapshot - which is why `/game` stays the authority and the recovery path.
   */
  openGameEvents(
    options: Readonly<{
      cursor?: string;
      onEvent(event: GameEventV1, lastEventId: string): void;
      onError(error: Event): void;
    }>,
  ): Readonly<{ close(): void }>;
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

/**
 * The press's answer, held to the contract the Host validates its own reply against.
 *
 * The reason is validated against the same nine the Host's probe can produce, and `reason` is null
 * exactly when the answer is not `unknown`: a reply that said `not_bound` and carried a reason would be
 * two answers in one frame, and the surface would have to pick one.
 */
function validateStardewCabinOccupancy(value: unknown): StardewCabinOccupancyAnswerV1 {
  const invalid = new ComposedReferenceGameProtocolError("invalid_stardew_cabin_answer");
  if (!isRecord(value) || !hasExactKeys(value, CABIN_OCCUPANCY_KEYS) || value.apiVersion !== 1) throw invalid;
  const occupancy = value.occupancy;
  if (!isRecord(occupancy) || !hasExactKeys(occupancy, CABIN_OCCUPANCY_FIELDS_KEYS)) throw invalid;
  if (!CABIN_OCCUPANCY_ANSWERS.includes(occupancy.answer as (typeof CABIN_OCCUPANCY_ANSWERS)[number])) throw invalid;
  const reason = occupancy.reason;
  if (reason !== null && !CABIN_OCCUPANCY_UNKNOWN_REASONS.includes(reason as CabinOccupancyUnknownReason))
    throw invalid;
  if ((occupancy.answer === "unknown") !== (reason !== null)) throw invalid;
  if (!isNullableLabel(occupancy.cabinId, MAX_CABIN_DISPLAY_LABEL_LENGTH)) throw invalid;
  if (occupancy.boundBy !== null && occupancy.boundBy !== "companion" && occupancy.boundBy !== "manifest_farmhand")
    throw invalid;
  if ((occupancy.answer === "already_bound") !== (occupancy.cabinId !== null && occupancy.boundBy !== null))
    throw invalid;
  if (occupancy.publishedAtUnixMs !== null && !isSafeInteger(occupancy.publishedAtUnixMs, 0)) throw invalid;
  if (!isSafeInteger(occupancy.observedAtUnixMs, 0)) throw invalid;
  if (!CABIN_QUARANTINE_RELEASES.includes(value.release as CabinQuarantineRelease)) throw invalid;
  return Object.freeze({
    apiVersion: 1,
    occupancy: Object.freeze({
      answer: occupancy.answer as StardewCabinOccupancyAnswerV1["occupancy"]["answer"],
      reason: reason as StardewCabinOccupancyAnswerV1["occupancy"]["reason"],
      cabinId: occupancy.cabinId as string | null,
      boundBy: occupancy.boundBy as StardewCabinOccupancyAnswerV1["occupancy"]["boundBy"],
      publishedAtUnixMs: occupancy.publishedAtUnixMs as number | null,
      observedAtUnixMs: occupancy.observedAtUnixMs as number,
    }),
    release: value.release as StardewCabinOccupancyAnswerV1["release"],
  });
}

const SETTINGS_REQUIRED_KEYS = [
  "apiVersion",
  "revision",
  "families",
  "advanceDayMinimumOnlineFarmers",
  "appliesToRunningGame",
] as const;
/**
 * The members the contract declares `Type.Optional` for player settings, and the reason the list is separate.
 *
 * This was one `SETTINGS_KEYS` list used with an exact-key check, and `windowMode`/`deniedActions` were added to it to stop
 * a reply that CARRIED them being refused. That fixed one direction and broke the other: a player who never chose a window
 * mode gets a reply without the key (the contract says so at `game-browser-contract/index.ts:586`), and the exact-key check
 * then refused it - the surface went to "these settings cannot be read" with nothing to retry. Same class as the
 * installation candidate one above, one function apart, so it is fixed the same way: required members present, nothing
 * outside required-plus-optional, and each optional member validated on its own.
 */
const SETTINGS_OPTIONAL_KEYS = ["windowMode", "deniedActions"] as const;
const SETTINGS_ALLOWED_KEYS: ReadonlySet<string> = new Set([...SETTINGS_REQUIRED_KEYS, ...SETTINGS_OPTIONAL_KEYS]);

function hasSettingsKeys(value: Record<string, unknown>): boolean {
  const own = Object.keys(value);
  return SETTINGS_REQUIRED_KEYS.every((key) => own.includes(key)) && own.every((key) => SETTINGS_ALLOWED_KEYS.has(key));
}
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
    !hasSettingsKeys(value) ||
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
      !hasInstallationCandidateKeys(candidate) ||
      !isInstallationCandidateId(candidate.candidateId) ||
      !isBoundedString(candidate.source, 1, 64) ||
      !isBoundedString(candidate.label, 1, 256) ||
      !isNullableLabel(candidate.hint, 256) ||
      ("location" in candidate && !isNullableLabel(candidate.location, 64)) ||
      ("modLoader" in candidate && candidate.modLoader !== "present" && candidate.modLoader !== "missing") ||
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
        modLoader: (candidate.modLoader as "present" | "missing" | undefined) ?? null,
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
    !(hasExactKeys(value, ["apiVersion", "status"]) || hasExactKeys(value, ["apiVersion", "status", "companionMod"])) ||
    value.apiVersion !== 1 ||
    ![
      "accepted",
      "registered",
      "cancelled",
      "unavailable",
      "expired",
      "mod_loader_missing",
      "not_stardew_installation",
      "reparse_point",
    ].includes(value.status as string)
  )
    throw new ComposedReferenceGameProtocolError("invalid_stardew_installation_mutation");
  const status = value.status as StardewInstallationMutationV1["status"];
  if (value.companionMod !== undefined) {
    if (
      status !== "registered" ||
      !(COMPANION_MOD_OUTCOMES as readonly string[]).includes(value.companionMod as string)
    )
      throw new ComposedReferenceGameProtocolError("invalid_stardew_installation_mutation");
    return Object.freeze({
      apiVersion: 1,
      status,
      companionMod: value.companionMod as StardewInstallationMutationV1["companionMod"],
    });
  }
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

function isGameStreamCheckpoint(value: unknown): value is Readonly<{ epoch: string; cursor: string }> {
  return (
    isRecord(value) &&
    hasExactKeys(value, GAME_STREAM_CHECKPOINT_KEYS) &&
    isOpaqueHandle(value.epoch) &&
    isOpaqueHandle(value.cursor)
  );
}

/**
 * One fact group, closed at every object boundary.
 *
 * The members are validated individually rather than as a key set per fact, for the reason the installation candidate
 * above records: a whole-set check is one hand-written combination per combination. The set that IS closed here is
 * the fact's own member list, which comes from the contract's union - a frame may not carry a field its fact does not
 * own, because a client merging it would be writing a word the Host never said.
 */
function validateGameFactPatch(value: unknown): GameFactPatchV1 {
  if (!isRecord(value) || !isOneOf(value.fact, GAME_FACTS) || !isRecord(value.game)) {
    throw new ComposedReferenceGameProtocolError("invalid_game_fact_patch");
  }
  const members = GAME_FACT_KEYS[value.fact];
  if (!hasExactKeys(value.game, members)) throw new ComposedReferenceGameProtocolError("invalid_game_fact_patch");
  const game = value.game;
  const invalid = new ComposedReferenceGameProtocolError("invalid_game_fact_patch");
  switch (value.fact) {
    case "instance": {
      const instance = game.instance;
      if (
        !isRecord(instance) ||
        !isOneOf(instance.status, INSTANCE_STATUSES) ||
        !isNullableLabel(instance.gameTitle, MAX_GAME_LABEL_LENGTH) ||
        !isSafeInteger(instance.generation, 0) ||
        (instance.playerHostExitCode !== undefined &&
          !(isSafeInteger(instance.playerHostExitCode, 0) && instance.playerHostExitCode <= 4_294_967_295)) ||
        !isRecord(game.compatibility) ||
        !hasExactKeys(game.compatibility, GAME_COMPATIBILITY_KEYS) ||
        !isOneOf(game.compatibility.status, COMPATIBILITY_STATUSES) ||
        !isNullableLabel(game.compatibility.message, MAX_GAME_MESSAGE_LENGTH) ||
        !isOneOf(game.latestOutcome, OUTCOMES)
      )
        throw invalid;
      return value as unknown as GameFactPatchV1;
    }
    case "attachment": {
      const attachmentKeys = isRecord(game.attachment) ? Object.keys(game.attachment) : [];
      if (
        !isRecord(game.attachment) ||
        !GAME_ATTACHMENT_REQUIRED_KEYS.every((key) => attachmentKeys.includes(key)) ||
        !attachmentKeys.every((key) => GAME_ATTACHMENT_ALLOWED_KEYS.has(key)) ||
        !isOneOf(game.attachment.status, ATTACHMENT_STATUSES) ||
        !isSafeInteger(game.attachment.generation, 0) ||
        (game.attachment.cabinLabel !== undefined &&
          !isNullableLabel(game.attachment.cabinLabel, MAX_CABIN_DISPLAY_LABEL_LENGTH)) ||
        !isOneOf(game.connectionStatus, CONNECTION_STATUSES) ||
        !isRecord(game.capabilitySummary) ||
        !isCapabilitySummary(game.capabilitySummary)
      )
        throw invalid;
      return value as unknown as GameFactPatchV1;
    }
    case "selectedWorld": {
      if (!isNullableLabel(game.selectedWorld, MAX_GAME_LABEL_LENGTH)) throw invalid;
      return value as unknown as GameFactPatchV1;
    }
    default: {
      return assertNever(value.fact);
    }
  }
}

/**
 * Validates one frame of the Game stream.
 *
 * Nothing is merged from a frame this refuses: a frame that cannot be read is a protocol error, and the surface's
 * answer to it is the same as a resync - one snapshot read, which is the authority.
 */
function validateGameEvent(value: unknown): GameEventV1 {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["apiVersion", "epoch", "sequence", "eventType", "payload"]) ||
    value.apiVersion !== 1 ||
    !isOpaqueHandle(value.epoch) ||
    !isSafeInteger(value.sequence, 1) ||
    !isOneOf(value.eventType, GAME_EVENT_TYPES)
  ) {
    throw new ComposedReferenceGameProtocolError("invalid_game_event");
  }
  if (value.eventType === "game.stream_resync_required") {
    if (
      !isRecord(value.payload) ||
      !hasExactKeys(value.payload, ["reason"]) ||
      !isOneOf(value.payload.reason, GAME_RESYNC_REASONS)
    ) {
      throw new ComposedReferenceGameProtocolError("invalid_game_event");
    }
    return value as unknown as GameEventV1;
  }
  return Object.freeze({
    apiVersion: 1 as const,
    epoch: value.epoch,
    sequence: value.sequence,
    eventType: "game.fact_changed" as const,
    payload: validateGameFactPatch(value.payload),
  });
}

function isGameProjection(value: unknown): value is GameBrowserStateV1 {
  if (!isRecord(value) || !GAME_STATE_KEYS.every((key) => key in value) || value.apiVersion !== 1) return false;
  if (!Object.keys(value).every((key) => GAME_STATE_ALLOWED_KEYS.has(key))) return false;
  if (value.eventStream !== undefined && !isGameStreamCheckpoint(value.eventStream)) return false;
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
    !isNullableLabel(game.prerequisites.detectedGame, MAX_GAME_LABEL_LENGTH)
  ) {
    return false;
  }
  const instanceKeys = isRecord(game.instance) ? Object.keys(game.instance) : [];
  if (
    !isRecord(game.instance) ||
    !GAME_INSTANCE_REQUIRED_KEYS.every((key) => instanceKeys.includes(key)) ||
    !instanceKeys.every((key) => GAME_INSTANCE_ALLOWED_KEYS.has(key)) ||
    !isOneOf(game.instance.status, INSTANCE_STATUSES) ||
    !isNullableLabel(game.instance.gameTitle, MAX_GAME_LABEL_LENGTH) ||
    !isSafeInteger(game.instance.generation, 0) ||
    (game.instance.playerHostExitCode !== undefined &&
      !(isSafeInteger(game.instance.playerHostExitCode, 0) && game.instance.playerHostExitCode <= 4_294_967_295))
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
  const attachmentKeys = isRecord(game.attachment) ? Object.keys(game.attachment) : [];
  if (
    !isRecord(game.attachment) ||
    !GAME_ATTACHMENT_REQUIRED_KEYS.every((key) => attachmentKeys.includes(key)) ||
    !attachmentKeys.every((key) => GAME_ATTACHMENT_ALLOWED_KEYS.has(key)) ||
    !isOneOf(game.attachment.status, ATTACHMENT_STATUSES) ||
    !isSafeInteger(game.attachment.generation, 0) ||
    (game.attachment.cabinLabel !== undefined &&
      !isNullableLabel(game.attachment.cabinLabel, MAX_CABIN_DISPLAY_LABEL_LENGTH))
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
    !isCapabilitySummary(game.capabilitySummary) ||
    !isOneOf(game.latestOutcome, OUTCOMES)
  ) {
    return false;
  }
  return true;
}

/**
 * Validates the Game slice's own read.
 *
 * The same closed projection the aggregate root's `game` half carries, so the slice cannot come to mean
 * two things depending on which route answered it - and, like the aggregate's `mismatched_composed_session`
 * rule, a reply from a session this client does not hold is never rendered as Game state. The aggregate
 * compares the two halves against each other; a standalone read compares against the one session the
 * client already adopted.
 */
function validateGameState(value: unknown, csrfToken: string | undefined): GameBrowserStateV1 {
  if (!isGameProjection(value)) throw new ComposedReferenceGameProtocolError("invalid_composed_game");
  if (csrfToken !== undefined && value.csrfToken !== csrfToken)
    throw new ComposedReferenceGameProtocolError("mismatched_composed_session");
  return value;
}

/**
 * Validates the exact composed root and both nested redacted projections.
 * Validation is closed at every object boundary: additive fields are not
 * silently ignored, and a foreign profile is never rendered as Game state.
 */
export function validateComposedReferenceGameRoot(value: unknown): ComposedReferenceGameBrowserRootV1 {
  const gamePresent = isRecord(value) && value.game !== undefined;
  if (
    !isRecord(value) ||
    !hasExactKeys(value, gamePresent ? ROOT_KEYS : ROOT_KEYS_WITHOUT_GAME) ||
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
  let game: GameBrowserStateV1 | null = null;
  if (gamePresent && value.game !== null) {
    if (!isGameProjection(value.game)) {
      throw new ComposedReferenceGameProtocolError("invalid_composed_game");
    }
    if (
      value.game.csrfToken !== chat.csrfToken ||
      value.game.browserSession.expiresAtMs !== chat.browserSession.expiresAtMs
    ) {
      throw new ComposedReferenceGameProtocolError("mismatched_composed_session");
    }
    game = value.game;
  }
  return Object.freeze({
    apiVersion: value.apiVersion,
    build: Object.freeze({
      browserContract: value.build.browserContract,
      profileId: value.build.profileId,
    }),
    chat,
    // A Game half that could not be read is answered with no member at all, so the absence this client was
    // handed survives the validation instead of being flattened into `null`: the two are different facts, and
    // a shell that lost the difference here could not tell its Game surface why it has nothing to draw.
    ...(gamePresent ? { game } : {}),
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
 *
 * The cause used to be a coordinator code and nothing else (`^stardew_…`), because the
 * coordinator was the only producer that named one. It is now every producer code the Host
 * reports on a refused read of the composed root: the check that failed
 * (`chat_snapshot_mismatch`), the projection's own code
 * (`composed_reference_game_chat_snapshot_invalid`), the store's admission
 * (`semantic_chat_*`), or that a producer named nothing projectable
 * (`chat_projection_failed`). Those are minted at runtime, so this client cannot enumerate
 * them; what it can hold is the shape every one of them already has - the shape the Host's
 * own `boundedProducerCode` admits.
 */
const PROBLEM_CODE_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;
const PROBLEM_CAUSE_PATTERN = /^[a-z][a-z0-9_]{0,95}$/;

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
    async readGameState(): Promise<GameBrowserStateV1> {
      return exchange(fetchLike, "/api/composed-reference-game/v1/game", { method: "GET" }, (value) =>
        validateGameState(value, csrfToken),
      );
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
    async readStardewCabinOccupancy(): Promise<StardewCabinOccupancyAnswerV1> {
      if (csrfToken === undefined) throw new ComposedReferenceGameProtocolError("missing_composed_session");
      return exchange(
        fetchLike,
        "/api/composed-reference-game/v1/game/stardew/cabins/occupancy",
        { method: "POST", headers: { "Content-Type": "application/json", "X-CSRF-Token": csrfToken } },
        validateStardewCabinOccupancy,
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
    openGameEvents(options) {
      if (
        typeof EventSource !== "function" ||
        options === null ||
        typeof options !== "object" ||
        typeof options.onEvent !== "function" ||
        typeof options.onError !== "function"
      )
        throw new ComposedReferenceGameProtocolError("invalid_game_events_request");
      if (options.cursor !== undefined && !isOpaqueHandle(options.cursor))
        throw new ComposedReferenceGameProtocolError("invalid_game_events_cursor");
      const query = options.cursor === undefined ? "" : `?cursor=${encodeURIComponent(options.cursor)}`;
      const source = new EventSource(`/api/composed-reference-game/v1/events${query}`, { withCredentials: true });
      const handle = (raw: Event): void => {
        const message = raw as MessageEvent<string>;
        try {
          const event = validateGameEvent(JSON.parse(message.data) as unknown);
          if (!isOpaqueHandle(message.lastEventId)) throw new ComposedReferenceGameProtocolError("invalid_game_event");
          options.onEvent(event, message.lastEventId);
        } catch {
          options.onError(new Event("protocol_error"));
        }
      };
      for (const eventType of GAME_EVENT_TYPES) source.addEventListener(eventType, handle);
      source.onerror = options.onError;
      return Object.freeze({
        close() {
          for (const eventType of GAME_EVENT_TYPES) source.removeEventListener(eventType, handle);
          source.close();
        },
      });
    },
  });
}
