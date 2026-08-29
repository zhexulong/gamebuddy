import {
  GAME_BROWSER_API_V1,
  type ComposedGameProfile,
  type GameBrowserStateV1,
  isComposedGameProfile,
} from "../game-browser-contract/index.js";
import type { StardewCompatibilityStatus } from "../stardew-compatibility.js";
import type { StardewGameSurfaceAttachmentReader, StardewGameSurfaceAttachmentView } from "../stardew-production-lifecycle-coordinator.internal.js";
import type {
  StardewRoleLifecycleReader,
  StardewRoleLifecycleView,
} from "../stardew-role-lifecycle-facade.js";

const BASE64URL_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

/** Browser-session facts minted by the browser-session owner, never by Game state. */
export type GameBrowserReadStateContext = Readonly<{
  csrfToken: string;
  browserSessionExpiresAtMs: number;
}>;

/**
 * The read-only, Host-owned source for `game.state.read`.
 *
 * This deliberately projects only facts that already exist. Role lifecycle
 * evidence governs installation compatibility; the independent Host-owned
 * attachment reader governs the exact surface generation and connection state.
 * Neither source attests catalog, companion, world/save, or action outcomes.
 */
export type GameBrowserStateProvider = Readonly<{
  readState(context: GameBrowserReadStateContext): Promise<GameBrowserStateV1>;
}>;

export function createGameBrowserStateProvider(
  profile: ComposedGameProfile,
  lifecycle: StardewRoleLifecycleReader,
  attachment: StardewGameSurfaceAttachmentReader,
): GameBrowserStateProvider {
  if (!isComposedGameProfile(profile)) throw new TypeError("game_browser_profile_not_composed");
  if (!profile.operationIds.includes("game.state.read"))
    throw new TypeError("game_browser_state_read_not_mounted");

  return Object.freeze({
    async readState(context: GameBrowserReadStateContext): Promise<GameBrowserStateV1> {
      validateContext(context);
      const lifecycleView = await lifecycle.readRoleLifecycleView();
      const attachmentView = attachment.readAttachmentView();
      return projectGameBrowserState(profile, context, lifecycleView, attachmentView);
    },
  });
}

function projectGameBrowserState(
  profile: ComposedGameProfile,
  context: GameBrowserReadStateContext,
  lifecycle: StardewRoleLifecycleView,
  attachment: StardewGameSurfaceAttachmentView,
): GameBrowserStateV1 {
  const compatibility = projectCompatibility(lifecycle);
  return Object.freeze({
    apiVersion: 1,
    build: Object.freeze({ browserContract: GAME_BROWSER_API_V1, profileId: profile.profileId }),
    csrfToken: context.csrfToken,
    browserSession: Object.freeze({ expiresAtMs: context.browserSessionExpiresAtMs }),
    game: Object.freeze({
      prerequisites: Object.freeze({ status: "unknown", detectedGame: null, missingItems: [] }),
      instance: Object.freeze({ status: "none", gameTitle: null }),
      compatibility: Object.freeze(compatibility),
      attachment: Object.freeze({ status: attachment.status, generation: attachment.generation }),
      connectionStatus: attachment.connectionStatus,
      role: null,
      companionName: null,
      selectedWorld: null,
      selectedSave: null,
      capabilitySummary: Object.freeze({ available: false, count: 0 }),
      latestOutcome: "none",
    }),
  });
}

function projectCompatibility(
  lifecycle: StardewRoleLifecycleView): Readonly<{
  status: "unchecked" | "compatible" | "incompatible" | "warning";
  message: string | null;
}> {
  if (lifecycle.playerHost.state !== "authenticated")
    return { status: "unchecked", message: null };

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
