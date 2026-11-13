import {
  GAME_BROWSER_API_V1,
  type ComposedGameProfile,
  type GameBrowserStateV1,
  isComposedGameProfile,
} from "../game-browser-contract/index.js";
import type { StardewCompatibilityStatus } from "../stardew-compatibility.js";
import type {
  StardewGameSurfaceActionAuthorityReader,
  StardewGameSurfaceActionAuthorityView,
  StardewGameSurfaceAttachmentReader,
  StardewGameSurfaceAttachmentView,
  StardewGameSurfaceInstallationReader,
  StardewGameSurfaceLaunchReadinessReader,
  StardewGameSurfaceLaunchReadinessView,
  StardewGameSurfaceWorldBindingReader,
  StardewGameSurfaceWorldBindingView,
} from "../stardew-production-lifecycle-coordinator.internal.js";
import type { StardewRoleLifecycleReader, StardewRoleLifecycleView } from "../stardew-role-lifecycle-facade.js";

const BASE64URL_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

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
 * integration-private world-binding reader governs the selected world. Neither
 * source attests catalog, companion, actions outcomes, or any launch fact.
 */
export type GameBrowserStateProvider = Readonly<{
  readState(context: GameBrowserReadStateContext): Promise<GameBrowserStateV1>;
}>;

export function createGameBrowserStateProvider(
  profile: ComposedGameProfile,
  lifecycle: StardewRoleLifecycleReader,
  attachment: StardewGameSurfaceAttachmentReader,
  launchReadiness: StardewGameSurfaceLaunchReadinessReader,
  actionAuthority?: StardewGameSurfaceActionAuthorityReader,
  installation?: StardewGameSurfaceInstallationReader,
  worldBinding?: StardewGameSurfaceWorldBindingReader,
): GameBrowserStateProvider {
  if (!isComposedGameProfile(profile)) throw new TypeError("game_browser_profile_not_composed");
  if (!profile.operationIds.includes("game.state.read")) throw new TypeError("game_browser_state_read_not_mounted");

  return Object.freeze({
    async readState(context: GameBrowserReadStateContext): Promise<GameBrowserStateV1> {
      validateContext(context);
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
      return projectGameBrowserState(
        profile,
        context,
        lifecycleView,
        attachmentView,
        launchReadinessView,
        actionAuthorityView,
        installationView,
        worldBindingView,
      );
    },
  });
}

function projectGameBrowserState(
  profile: ComposedGameProfile,
  context: GameBrowserReadStateContext,
  lifecycle: StardewRoleLifecycleView,
  attachment: StardewGameSurfaceAttachmentView,
  launchReadiness: StardewGameSurfaceLaunchReadinessView,
  actionAuthority: StardewGameSurfaceActionAuthorityView | undefined,
  installation: "registered" | "absent" | undefined,
  worldBinding: StardewGameSurfaceWorldBindingView | undefined,
): GameBrowserStateV1 {
  const compatibility = projectCompatibility(lifecycle);
  const playerHostStarted = lifecycle.playerHost.ownership === "gamebuddy_direct_spawn";
  const launchFailed = launchReadiness.status === "failed";
  const prerequisitesMet =
    playerHostStarted || launchReadiness.status === "ready" || launchFailed || installation === "registered";
  const instanceStatus = launchFailed ? ("crashed" as const) : projectInstanceStatus(lifecycle.playerHost);
  return Object.freeze({
    apiVersion: 1,
    build: Object.freeze({ browserContract: GAME_BROWSER_API_V1, profileId: profile.profileId }),
    csrfToken: context.csrfToken,
    browserSession: Object.freeze({ expiresAtMs: context.browserSessionExpiresAtMs }),
    game: Object.freeze({
      prerequisites: prerequisitesMet
        ? Object.freeze({ status: "met" as const, detectedGame: "Stardew Valley", missingItems: [] })
        : Object.freeze({ status: "unknown" as const, detectedGame: null, missingItems: [] }),
      instance: Object.freeze({
        status: instanceStatus,
        // A game the Host has not read has no title to publish: naming one here would be
        // the projection naming a game it has just said it could not see.
        gameTitle: instanceStatus === "none" || instanceStatus === "unread" ? null : "Stardew Valley",
        generation: launchReadiness.generation,
        // Published only when the Guardian actually reported an exit for this
        // lifecycle's game: absent means "this Host observed no exit", which is a
        // different claim from an exit code of 0 and must not be defaulted.
        ...(launchReadiness.playerHostExitCode === null
          ? {}
          : { playerHostExitCode: launchReadiness.playerHostExitCode }),
      }),
      compatibility: Object.freeze(compatibility),
      attachment: Object.freeze({ status: attachment.status, generation: attachment.generation }),
      connectionStatus: attachment.connectionStatus,
      actionAuthority: actionAuthority?.status ?? "unavailable",
      role: null,
      companionName: null,
      selectedWorld: worldBinding?.status === "bound" ? worldBinding.worldRef : null,
      selectedSave: null,
      capabilitySummary: Object.freeze({ available: false, count: 0 }),
      // The coordinator's launch terminality is the only honest source of a
      // failed Game outcome this provider can attest: it is set once the owned
      // Player Host launch or attestation correlation failed and the owner was
      // quarantined. The browser refreshes recover this fact from the root
      // state instead of trusting volatile client memory.
      latestOutcome: launchFailed ? "failed" : "none",
    }),
  });
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
