import {
  GAME_BROWSER_API_V1,
  type ComposedGameProfile,
  type GameBrowserStateV1,
  type GameFactPatchV1,
  isComposedGameProfile,
} from "../game-browser-contract/index.js";
import type { GameEventStream } from "./game-event-stream.js";
import type { StardewCompatibilityStatus } from "../stardew-compatibility.js";
import type {
  StardewGameSurfaceActionAuthorityReader,
  StardewGameSurfaceActionAuthorityView,
  StardewGameSurfaceAttachmentReader,
  StardewGameSurfaceAttachmentView,
  StardewGameSurfaceCapabilityReader,
  StardewGameSurfaceCapabilityView,
  StardewGameSurfaceInstallationReader,
  StardewGameSurfaceLaunchReadinessReader,
  StardewGameSurfaceLaunchReadinessView,
  StardewGameSurfaceWorldBindingReader,
  StardewGameSurfaceWorldBindingView,
} from "../stardew-production-lifecycle-coordinator.internal.js";
import type { StardewRoleLifecycleReader, StardewRoleLifecycleView } from "../stardew-role-lifecycle-facade.js";

const BASE64URL_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

/** One member of the closed fact union, named by its own `fact` tag. */
export type GameFactPatchOf<K extends GameFactPatchV1["fact"]> = Extract<GameFactPatchV1, Readonly<{ fact: K }>>;

/** Browser-session facts minted by the browser-session owner, never by Game state. */
type GameBrowserReadStateContext = Readonly<{
  csrfToken: string;
  browserSessionExpiresAtMs: number;
}>;

/**
 * The read-only, Host-owned source for `game.state.read`.
 *
 * This deliberately projects only facts that already exist. Role lifecycle
 * evidence governs installation compatibility; the independent Host-owned
 * attachment reader governs the exact surface generation and connection state;
 * the Host-owned action authority reader governs ready-actions-paused; the
 * Host-owned capability reader governs how many actions the attached game
 * actually advertises; the integration-private world-binding reader governs the
 * selected world. Neither source attests companion name, action outcomes, or any
 * launch fact.
 */
export type GameBrowserStateProvider = Readonly<{
  readState(context: GameBrowserReadStateContext): Promise<GameBrowserStateV1>;
  /**
   * One fact group, exactly as `/game` projects it.
   *
   * This is what the push channel publishes at a transition, and it is a method of the projection rather than a
   * second projection so a frame can never name a different fact than the snapshot beside it: both read the same
   * readers and go through the same `projectGameFacts`. The browser read context is not needed because no fact here
   * carries a session value.
   */
  readFact(fact: GameFactPatchV1["fact"]): Promise<GameFactPatchV1>;
}>;

export function createGameBrowserStateProvider(
  profile: ComposedGameProfile,
  lifecycle: StardewRoleLifecycleReader,
  attachment: StardewGameSurfaceAttachmentReader,
  launchReadiness: StardewGameSurfaceLaunchReadinessReader,
  actionAuthority?: StardewGameSurfaceActionAuthorityReader,
  installation?: StardewGameSurfaceInstallationReader,
  worldBinding?: StardewGameSurfaceWorldBindingReader,
  capability?: StardewGameSurfaceCapabilityReader,
  eventStream?: GameEventStream,
): GameBrowserStateProvider {
  if (!isComposedGameProfile(profile)) throw new TypeError("game_browser_profile_not_composed");
  if (!profile.operationIds.includes("game.state.read")) throw new TypeError("game_browser_state_read_not_mounted");

  /**
   * Every reader one projection needs, read once.
   *
   * One function rather than one call per entry point: a transition publish and a snapshot read must observe the
   * same set of readers, or the frame and the snapshot can disagree about a fact neither of them changed.
   */
  const readViews = async (): Promise<GameBrowserViews> => {
    const lifecycleView = await lifecycle.readRoleLifecycleView();
    const attachmentView = attachment.readAttachmentView();
    const launchReadinessView = launchReadiness.readLaunchReadinessView();
    const actionAuthorityView = actionAuthority?.readActionAuthorityView();
    // The bound installation is the ONE authoritative answer to "is the game
    // installed": the same registration the launch path gates on. Without it a
    // registered, ready installation still projected `prerequisites: unknown`
    // until a launch happened to be staged.
    const installationView = installation === undefined ? undefined : await installation.readInstallationView();
    // The bound world is the ONE durable answer to "which world is this player in".
    // It reaches the projection through the integration-private resolver, so the
    // browser and the resume seam can never name different worlds; no launch fact
    // (dataRoot, pid, pipe, token, native frame) travels with it.
    const worldBindingView = worldBinding === undefined ? undefined : await worldBinding.readWorldBindingView();
    const capabilityView = capability?.readCapabilityView();
    return {
      lifecycleView,
      attachmentView,
      launchReadinessView,
      actionAuthorityView,
      installationView,
      worldBindingView,
      capabilityView,
    };
  };

  return Object.freeze({
    async readState(context: GameBrowserReadStateContext): Promise<GameBrowserStateV1> {
      validateContext(context);
      return projectGameBrowserState(profile, context, await readViews(), eventStream);
    },
    async readFact(fact: GameFactPatchV1["fact"]): Promise<GameFactPatchV1> {
      const facts = projectGameFacts(await readViews());
      switch (fact) {
        case "instance":
          return facts.instance;
        case "attachment":
          return facts.attachment;
        case "selectedWorld":
          return facts.selectedWorld;
      }
    },
  });
}

type GameBrowserViews = Readonly<{
  lifecycleView: StardewRoleLifecycleView;
  attachmentView: StardewGameSurfaceAttachmentView;
  launchReadinessView: StardewGameSurfaceLaunchReadinessView;
  actionAuthorityView: StardewGameSurfaceActionAuthorityView | undefined;
  installationView: "registered" | "absent" | undefined;
  worldBindingView: StardewGameSurfaceWorldBindingView | undefined;
  capabilityView: StardewGameSurfaceCapabilityView | undefined;
}>;

/**
 * The four facts that can change without a player acting, as the push channel publishes them.
 *
 * The same values `/game` publishes, from the same readers: `projectGameBrowserState` below is built out of this, so
 * a fact cannot mean one thing on the stream and another in the snapshot. The grouping is the contract's
 * (`GameFactPatchV1Schema`): instance carries its own compatibility and outcome, attachment carries the attached
 * runtime's catalog count because that count can only move with the attachment, and the selected world stands
 * alone.
 */
function projectGameFacts(views: GameBrowserViews): Readonly<{
  instance: GameFactPatchOf<"instance">;
  attachment: GameFactPatchOf<"attachment">;
  selectedWorld: GameFactPatchOf<"selectedWorld">;
}> {
  const launchFailed = views.launchReadinessView.status === "failed";
  // The game's own fate is the exit code the Guardian reported, not the launch attempt's
  // terminality: an attempt the player ended by quitting the game is over too, but the game did
  // not fail. `0` is the OS's normal-termination code, so it reads as the ending it is and keeps
  // the `crashed` word for the code that really is a crash. With no reported exit there is no
  // code to read, and a launch that failed for its own reasons keeps the word it always had.
  const endedCleanly = launchFailed && views.launchReadinessView.playerHostExitCode === 0;
  const instanceStatus: GameBrowserStateV1["game"]["instance"]["status"] = launchFailed
    ? endedCleanly
      ? "stopped"
      : "crashed"
    : projectInstanceStatus(views.lifecycleView.playerHost);
  return Object.freeze({
    instance: Object.freeze({
      fact: "instance" as const,
      game: Object.freeze({
        instance: Object.freeze({
          status: instanceStatus,
          // A game the Host has not read has no title to publish: naming one here would be
          // the projection naming a game it has just said it could not see.
          gameTitle: instanceStatus === "none" || instanceStatus === "unread" ? null : "Stardew Valley",
          generation: views.launchReadinessView.generation,
          // Published only when the Guardian actually reported an exit for this
          // lifecycle's game: absent means "this Host observed no exit", which is a
          // different claim from an exit code of 0 and must not be defaulted.
          ...(views.launchReadinessView.playerHostExitCode === null
            ? {}
            : { playerHostExitCode: views.launchReadinessView.playerHostExitCode }),
        }),
        compatibility: Object.freeze(projectCompatibility(views.lifecycleView)),
        // The coordinator's launch terminality is the only honest source of a
        // failed Game outcome this provider can attest: it is set once the owned
        // Player Host launch or attestation correlation failed and the owner was
        // quarantined. The browser refreshes recover this fact from the root
        // state instead of trusting volatile client memory. A game the player
        // ended themselves is terminal the same way but is not a failed outcome,
        // so it publishes `none` rather than borrowing the crash's word.
        latestOutcome: launchFailed && !endedCleanly ? ("failed" as const) : ("none" as const),
      }),
    }),
    attachment: Object.freeze({
      fact: "attachment" as const,
      game: Object.freeze({
        attachment: Object.freeze({
          status: views.attachmentView.status,
          generation: views.attachmentView.generation,
        }),
        connectionStatus: views.attachmentView.connectionStatus,
        capabilitySummary: projectCapabilitySummary(views.capabilityView),
      }),
    }),
    selectedWorld: Object.freeze({
      fact: "selectedWorld" as const,
      game: Object.freeze({
        selectedWorld: views.worldBindingView?.status === "bound" ? views.worldBindingView.worldRef : null,
      }),
    }),
  });
}

function projectGameBrowserState(
  profile: ComposedGameProfile,
  context: GameBrowserReadStateContext,
  views: GameBrowserViews,
  eventStream: GameEventStream | undefined,
): GameBrowserStateV1 {
  const launchReadiness = views.launchReadinessView;
  const playerHostStarted = views.lifecycleView.playerHost.ownership === "gamebuddy_direct_spawn";
  const launchFailed = launchReadiness.status === "failed";
  const prerequisitesMet =
    playerHostStarted || launchReadiness.status === "ready" || launchFailed || views.installationView === "registered";
  const facts = projectGameFacts(views);
  return Object.freeze({
    apiVersion: 1,
    build: Object.freeze({ browserContract: GAME_BROWSER_API_V1, profileId: profile.profileId }),
    csrfToken: context.csrfToken,
    browserSession: Object.freeze({ expiresAtMs: context.browserSessionExpiresAtMs }),
    ...(eventStream === undefined
      ? {}
      : { eventStream: Object.freeze({ epoch: eventStream.epoch, cursor: eventStream.cursor }) }),
    game: Object.freeze({
      // Two facts and no third: the contract deleted `missingItems` (`0f2ca8e3`), because the Host's readiness
      // view is binary and has no per-item list to publish - "what am I missing" is the discovery route's answer.
      // A producer that kept writing the deleted key made every state read fail its own contract and the composed
      // bootstrap refuse the Host with 409 `game_snapshot_mismatch`.
      prerequisites: prerequisitesMet
        ? Object.freeze({ status: "met" as const, detectedGame: "Stardew Valley" })
        : Object.freeze({ status: "unknown" as const, detectedGame: null }),
      ...facts.instance.game,
      ...facts.attachment.game,
      ...facts.selectedWorld.game,
      actionAuthority: views.actionAuthorityView?.status ?? "unavailable",
      role: null,
      companionName: null,
      selectedSave: null,
      capabilitySummary: projectCapabilitySummary(views.capabilityView),
    }),
  });
}

/**
 * The capability surface as the browser publishes it: the runtime's own count, or the reason this layer has none.
 *
 * `published` carries the number the live surface produced, and `0` there means the runtime advertised nothing - a
 * measurement. `not_measured` carries the reason and NO count: `capabilitySummary` is the field the companion board
 * renders, and a `0` in place of an unmeasured reading is the browser telling the player a fact nobody measured.
 */
function projectCapabilitySummary(
  capability: StardewGameSurfaceCapabilityView | undefined,
): GameBrowserStateV1["game"]["capabilitySummary"] {
  if (capability === undefined) return Object.freeze({ status: "not_measured", reason: "no_capability_reader" });
  return capability.status === "published"
    ? Object.freeze({ status: "published", count: capability.count })
    : Object.freeze({ status: "not_measured", reason: capability.reason });
}

/**
 * The coordinator's Player Host slot as the browser's instance word.
 *
 * `unavailable` and `unknown` are the facade's two answers for a read of the player's
 * game that produced no fact: the evidence read threw, or a player-external game it
 * could not verify. Neither is `none` - that word means "nothing is running yet", and
 * it is the state the surface offers setup and activation from, which an unread game
 * has not established.
 */
function projectInstanceStatus(
  playerHost: StardewRoleLifecycleView["playerHost"],
): GameBrowserStateV1["game"]["instance"]["status"] {
  switch (playerHost.state) {
    case "pending":
    case "awaiting_attestation":
      return "launching";
    case "attested":
      // A GameBuddy-launched Player Host whose own advertisement correlated. This is the
      // `running` the whole surface hangs off, and it was unreachable until the coordinator
      // stopped overriding this slot with an attestation state it never left.
      return "running";
    case "authenticated":
      return "running";
    case "unavailable":
    case "unknown":
      return "unread";
    case "not_started":
    case "stopped":
      return "none";
  }
}

function projectCompatibility(lifecycle: StardewRoleLifecycleView): Readonly<{
  status: "unchecked" | "compatible" | "incompatible" | "warning";
  message: string | null;
}> {
  if (lifecycle.playerHost.state !== "authenticated") return { status: "unchecked", message: null };

  return compatibilityProjection(lifecycle.playerHost.compatibility, lifecycle.playerHost.attachmentAllowed);
}

function compatibilityProjection(
  status: StardewCompatibilityStatus,
  attachmentAllowed: boolean,
): Readonly<{
  status: "unchecked" | "compatible" | "incompatible" | "warning";
  message: string | null;
}> {
  if (!attachmentAllowed || status === "hard_incompatible")
    return { status: "incompatible", message: "This Stardew installation is incompatible." };
  if (status === "verified") return { status: "compatible", message: null };
  if (status === "below_minimum_warning")
    return { status: "warning", message: "This Stardew installation is below the advisory minimum." };
  return { status: "warning", message: "This Stardew installation is compatible but unverified." };
}

function validateContext(context: GameBrowserReadStateContext): void {
  if (
    typeof context !== "object" ||
    context === null ||
    typeof context.csrfToken !== "string" ||
    !isCanonicalOpaqueHandle(context.csrfToken) ||
    typeof context.browserSessionExpiresAtMs !== "number" ||
    !Number.isFinite(context.browserSessionExpiresAtMs) ||
    !Number.isSafeInteger(context.browserSessionExpiresAtMs) ||
    context.browserSessionExpiresAtMs < 0
  )
    throw new TypeError("invalid_game_browser_read_state_context");
}

function isCanonicalOpaqueHandle(value: string): boolean {
  if (!/^[A-Za-z0-9_-]{22,128}$/.test(value) || value.length % 4 === 1) return false;
  const finalValue = BASE64URL_ALPHABET.indexOf(value.at(-1)!);
  return value.length % 4 === 0 || (value.length % 4 === 2 ? finalValue % 16 === 0 : finalValue % 4 === 0);
}
