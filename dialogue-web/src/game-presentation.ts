import type { GameBrowserStateV1 } from "./composed-reference-game-browser-api";
import type { Messages } from "./i18n";

/**
 * The one place where a typed `game_browser_api/v1` fact becomes player text.
 *
 * The Host projection is a closed set of machine values (`connected_idle`,
 * `attach_pending`, `unavailable`, ...). Design/104 §10 requires the UI to
 * present *localized player outcomes* and never a raw enum, and design/26 §3
 * forbids implementation vocabulary in ordinary product text. Rendering the
 * enum directly - which is what the surface did before - violates both, so the
 * translation lives here rather than inside a component: one pure function per
 * fact family, exhaustive over the frozen union, so a new Host state cannot
 * silently fall through to a raw value.
 *
 * These functions translate only what the Host published. A game title, a
 * compatibility message, a world or a save name are authored/derived content
 * (design/26 §5.2): they pass through unchanged and are never translated.
 */

type GameProjection = GameBrowserStateV1["game"];

function exhaustive(value: never): string {
  return String(value);
}

export function connectionLabel(labels: Messages, status: GameProjection["connectionStatus"]): string {
  switch (status) {
    case "none":
      return labels.gameConnectionNone;
    case "discovering":
      return labels.gameConnectionDiscovering;
    case "launch_pending":
      return labels.gameConnectionLaunchPending;
    case "attach_pending":
      return labels.gameConnectionAttachPending;
    case "compatibility_warning":
      return labels.gameConnectionCompatibilityWarning;
    case "awaiting_confirmation":
      return labels.gameConnectionAwaitingConfirmation;
    case "connecting":
      return labels.gameConnectionConnecting;
    case "connected_idle":
      return labels.gameConnectionConnectedIdle;
    case "active":
      return labels.gameConnectionActive;
    case "stopping":
      return labels.gameConnectionStopping;
    case "reconnecting":
      return labels.gameConnectionReconnecting;
    case "syncing":
      return labels.gameConnectionSyncing;
    case "stopped":
      return labels.gameConnectionStopped;
    case "failed":
      return labels.gameConnectionFailed;
    case "disconnected":
      return labels.gameConnectionDisconnected;
    default:
      return exhaustive(status);
  }
}

/**
 * The instance row shows the published game title when the Host has one, and the
 * localized lifecycle state otherwise. The title is content, never a label.
 */
export function instanceLabel(labels: Messages, instance: GameProjection["instance"]): string {
  if (instance.gameTitle !== null) return instance.gameTitle;
  switch (instance.status) {
    case "none":
      return labels.gameInstanceNone;
    case "detected":
      return labels.gameInstanceDetected;
    case "launching":
      return labels.gameInstanceLaunching;
    case "running":
      return labels.gameInstanceRunning;
    case "stopped":
      return labels.gameInstanceStopped;
    case "crashed":
      return labels.gameInstanceCrashed;
    default:
      return exhaustive(instance.status);
  }
}

/** The Host's own compatibility sentence wins over the generic state word. */
export function compatibilityLabel(
  labels: Messages,
  compatibility: GameProjection["compatibility"],
): string {
  if (compatibility.message !== null) return compatibility.message;
  switch (compatibility.status) {
    case "unchecked":
      return labels.gameCompatibilityUnchecked;
    case "compatible":
      return labels.gameCompatibilityCompatible;
    case "incompatible":
      return labels.gameCompatibilityIncompatible;
    case "warning":
      return labels.gameCompatibilityWarning;
    default:
      return exhaustive(compatibility.status);
  }
}

export function capabilitiesLabel(
  labels: Messages,
  summary: GameProjection["capabilitySummary"],
): string {
  return summary.available
    ? labels.gameCapabilityCount.replace("{{count}}", String(summary.count))
    : labels.gameCapabilitiesUnavailable;
}

/**
 * Current execution, as the action authority the Host grants right now. It is
 * deliberately not derived from companion text or a previous receipt
 * (design/28 §4).
 */
export function authorityLabel(labels: Messages, authority: GameProjection["actionAuthority"]): string {
  switch (authority) {
    case "unavailable":
      return labels.gameAuthorityUnavailable;
    case "active":
      return labels.gameAuthorityActive;
    case "paused":
      return labels.gameAuthorityPaused;
    default:
      return exhaustive(authority);
  }
}

/** The most recent source-owned outcome category. Never inferred, never optimistic. */
export function outcomeLabel(labels: Messages, outcome: GameProjection["latestOutcome"]): string {
  switch (outcome) {
    case "none":
      return labels.gameOutcomeNone;
    case "succeeded":
      return labels.gameOutcomeSucceeded;
    case "failed":
      return labels.gameOutcomeFailed;
    case "cancelled":
      return labels.gameOutcomeCancelled;
    default:
      return exhaustive(outcome);
  }
}

/** The localized label for an installation-discovery state (design/104 §5.1/§6). */
export function installationStateLabel(labels: Messages, state: string): string {
  switch (state) {
    case "not_configured":
      return labels.gameInstallationNotConfigured;
    case "loading":
      return labels.gameInstallationLoading;
    case "candidates":
      return labels.gameInstallationCandidates;
    case "confirming":
      return labels.gameInstallationConfirming;
    case "retrying":
      return labels.gameInstallationRetrying;
    case "cancelled":
      return labels.gameInstallationCancelled;
    case "source-unavailable":
      return labels.gameInstallationSourceUnavailable;
    case "no-candidates":
      return labels.gameInstallationNoCandidates;
    case "expired":
      return labels.gameInstallationExpired;
    case "error":
      return labels.gameInstallationError;
    default:
      return labels.gameInstallationError;
  }
}
