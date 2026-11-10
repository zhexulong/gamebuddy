import { assertNever } from "./assert-never";
import type { GameBrowserStateV1 } from "./composed-reference-game-browser-api";
import type { StardewInstallationMutationV1 } from "./composed-reference-game-browser-api";
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
      return assertNever(status);
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
    case "unread":
      return labels.gameInstanceUnread;
    default:
      return assertNever(instance.status);
  }
}

/** The Host's own compatibility sentence wins over the generic state word. */
export function compatibilityLabel(labels: Messages, compatibility: GameProjection["compatibility"]): string {
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
      return assertNever(compatibility.status);
  }
}

export function capabilitiesLabel(labels: Messages, summary: GameProjection["capabilitySummary"]): string {
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
      return assertNever(authority);
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
      return assertNever(outcome);
  }
}

export type InstallationDiscoveryState =
  | "not_configured"
  | "loading"
  | "candidates"
  | "confirming"
  | "retrying"
  | "cancelled"
  | "source-unavailable"
  | "no-candidates"
  | "result-unavailable"
  // The chosen folder holds Stardew Valley and no mod loader. It is the one
  // selection refusal the player can fix, and it is never a search outcome: the
  // search found the game.
  | "mod-loader-missing"
  // The chosen folder holds no Stardew Valley at all. The second selection refusal the
  // player can fix, and - like `mod-loader-missing` - never a search outcome.
  | "not-stardew-installation"
  // The chosen folder reaches the game through a shortcut, a junction or a virtual folder
  // (a Mod Organizer 2 instance, for example). The third selection refusal the player can
  // fix, and the one whose fix is about the path rather than what sits at its end.
  | "reparse-point"
  // A registration the Host could not name a cause for (it is stopping, or the write
  // itself failed). `source-unavailable` is reserved for a source that could not be
  // read; nothing here was a search.
  | "selection-unavailable"
  // The Host registered the installation. The scan that follows a registration
  // finds nothing left to offer, so without this state the one moment the player
  // needs an answer read as an empty scan ("no installation was found") after
  // the installation had just been accepted.
  | "confirmed"
  | "expired"
  | "error";

/**
 * The discovery diagnostics that name a source or its metadata the scan could not
 * read (`host/src/windows-stardew-installation-discovery/internal.ts`, `DiscoveryDiagnostic`).
 * `no-candidates` and `candidate-invalid` are deliberately absent: they name the
 * absence of a candidate, not a source that could not be read.
 */
const SOURCE_READ_FAILURE_DIAGNOSTICS: readonly string[] = [
  "source-unavailable",
  "registry-unavailable",
  "vdf-unreadable",
  "vdf-malformed",
  "invalid-app-manifest",
  // The GOG source's three failures. Without them a player whose Galaxy registry could not be
  // read - and whose Steam libraries hold no game - was told no installation was found, which
  // is a statement about their machine that the Host never made.
  "gog-unavailable",
  "gog-metadata-unreadable",
  "gog-metadata-malformed",
];

/**
 * The state a settled discovery reply names, from the reply's own answer.
 *
 * An empty scan is only "nothing was found" when no diagnostic names a source-read
 * failure. The surface used to derive this from `candidates.length` alone, so the
 * Host's honest "I could not read Steam/GOG" read as "no Stardew Valley installation
 * was found" - on a machine where the game is installed.
 */
export function installationDiscoveryState(
  candidateCount: number,
  diagnostics: readonly string[],
): InstallationDiscoveryState {
  if (candidateCount > 0) return "candidates";
  return diagnostics.some((diagnostic) => SOURCE_READ_FAILURE_DIAGNOSTICS.includes(diagnostic))
    ? "source-unavailable"
    : "no-candidates";
}

/**
 * The state a rejected discovery read names.
 *
 * `game_unavailable`/`source_unavailable` are the Host saying the scan could not run;
 * `state_unavailable` is it refusing to produce the result - a genuine search failure.
 * Any other code is one this build does not recognise, and blaming the search for it
 * would point the player at a fault that does not exist; its own sentence says only
 * that the result could not be read.
 */
export function installationDiscoveryFailureState(code: string | null): InstallationDiscoveryState {
  if (code === "game_unavailable" || code === "source_unavailable") return "source-unavailable";
  if (code === "state_unavailable") return "error";
  return "result-unavailable";
}

/** The localized label for an installation-discovery state (design/104 §5.1/§6). */
export function installationStateLabel(labels: Messages, state: InstallationDiscoveryState): string {
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
    case "result-unavailable":
      return labels.gameInstallationResultUnavailable;
    case "mod-loader-missing":
      return labels.gameInstallationModLoaderMissing;
    case "not-stardew-installation":
      return labels.gameInstallationNotStardewInstallation;
    case "reparse-point":
      return labels.gameInstallationReparsePoint;
    case "selection-unavailable":
      return labels.gameInstallationSelectionUnavailable;
    case "confirmed":
      return labels.gameInstallationConfirmed;
    case "expired":
      return labels.gameInstallationExpired;
    case "error":
      return labels.gameInstallationError;
    default:
      return assertNever(state);
  }
}

/**
 * Where the scan found one installation, as player text.
 *
 * `source` is the discovery session's own vocabulary - `steam-registry |
 * steam-vdf | known-location | gog` (`host/src/windows-stardew-installation-discovery/
 * internal.ts`) - and design/104 §10 forbids rendering a wire member as player
 * text, which is what the panel did with it. A value this build has no sentence
 * for still describes a candidate the Host published, so it reads as the plain
 * fact that it was found rather than as the member.
 */
export function installationSourceLabel(labels: Messages, source: string): string {
  switch (source) {
    case "steam-registry":
      return labels.gameInstallationSourceSteamRegistry;
    case "steam-vdf":
      return labels.gameInstallationSourceSteamVdf;
    case "known-location":
      return labels.gameInstallationSourceKnownLocation;
    case "gog":
      return labels.gameInstallationSourceGog;
    default:
      return labels.gameInstallationSourceOther;
  }
}

/**
 * A candidate's own name as the panel speaks it, and - when the Host published one -
 * where that installation is.
 *
 * Two Steam libraries install to the same folder name, so the Host's `label` and hint
 * are identical for both and the panel rendered two identical rows a player could not
 * choose between; the Host's redaction-safe location (`D: · SteamLibrary`, the contract's
 * optional `location`) is the fact that separates them. The location is content - a
 * folder name is neither translated nor a path - and the parentheses that hold it are
 * the player's own punctuation, which is why this is a catalogue template rather than
 * string concatenation.
 */
export function installationCandidateLabel(labels: Messages, location: string | null): string {
  return location === null
    ? labels.gameInstallationCandidateName
    : labels.gameInstallationCandidateLocation
        .replace("{{name}}", labels.gameInstallationCandidateName)
        .replace("{{location}}", location);
}

/**
 * Whether a candidate's folder can load the companion Mod, as player text.
 *
 * `null` renders nothing: it means the Host did not say, which is not `missing` and must not be shown as though the
 * product had checked. `present` and `missing` are the two states the Host does report.
 *
 * This matters because the loader is the player's to install and a machine can hold several installations: without
 * it, two rows look identical and the only way to learn which one works is to try each in turn.
 */
export function installationModLoaderLabel(labels: Messages, modLoader: "present" | "missing" | null): string | null {
  switch (modLoader) {
    case "present":
      return labels.gameInstallationModLoaderPresent;
    case "missing":
      return labels.gameInstallationModLoaderMissing;
    case null:
      // The Host did not say. It is a member of this union, not a fallback: a fourth state would
      // otherwise read as "did not say" instead of failing to compile.
      return null;
    default:
      return assertNever(modLoader);
  }
}

/**
 * The candidates with a ready folder first.
 *
 * The player is looking for the installation they can use. A stable sort keeps the Host's own order within each
 * group, so the list does not reshuffle between reads, and a candidate whose state is unknown keeps its place
 * rather than being promoted on a guess.
 */
export function orderCandidatesByReadiness<T extends { readonly modLoader: "present" | "missing" | null }>(
  candidates: readonly T[],
): readonly T[] {
  const rank = (candidate: T): number => (candidate.modLoader === "present" ? 0 : 1);
  return [...candidates].sort((left, right) => rank(left) - rank(right));
}

/**
 * The candidate's own note, as player text.
 *
 * The Host's projection publishes exactly one note or none - the redacted path
 * notice (`host/src/games/stardew/provider.ts`, `projectDiscoveryReadResult`) -
 * and every other display path it read is collapsed to `null`. So a note is the
 * fact that the path the scan used is not shown, and the panel says that in the
 * player's language instead of repeating the Host's English sentence.
 */
export function installationHintLabel(labels: Messages, hint: string | null): string | null {
  return hint === null ? null : labels.gameInstallationHintPathHidden;
}

/**
 * The companion capability board: what the composed Game projection publishes
 * about the companion, as readable cards.
 *
 * It is a derivation over the published projection and deliberately *not* a
 * list of abilities. `game_browser_api/v1` publishes the capability surface as
 * a summary (`capabilitySummary`), the embodied role (`role`/`companionName`)
 * and the action authority the Host grants right now (`actionAuthority`); what
 * the companion can actually do is Mod-owned and described by the game side, so
 * the board renders the published facts and says plainly what it is waiting for
 * when nothing has been published, instead of inventing a static list
 * (design/104 §8 requires a safe capability summary; §10 forbids rendering a
 * raw enum, an operation id or an internal name as player text).
 *
 * This is the one place that turns those facts into player text, so no
 * component ever renders the projection's own vocabulary.
 */
export type CapabilityCardIcon = "companion" | "abilities" | "action";

export type CapabilityBoardCard = Readonly<{
  /** The published fact this card states; never rendered. */
  key: CapabilityCardIcon;
  icon: CapabilityCardIcon;
  title: string;
  detail: string;
}>;

export type CapabilityBoard = Readonly<{
  title: string;
  lead: string;
  cards: readonly CapabilityBoardCard[];
  /**
   * Present exactly while the session has published no capability at all: what
   * the board is waiting for. Never a fallback list.
   */
  waiting: string | null;
}>;

function withCount(template: string, count: number): string {
  return template.replace("{{count}}", String(count));
}

/** The companion's own acting authority, as player language. */
function actingDetail(labels: Messages, authority: GameProjection["actionAuthority"]): string {
  switch (authority) {
    case "active":
      return labels.gameBoardActingActive;
    case "paused":
      return labels.gameBoardActingPaused;
    case "unavailable":
      return labels.gameBoardActingUnavailable;
    default:
      return assertNever(authority);
  }
}

export function deriveCapabilityBoard(labels: Messages, projection: GameProjection): CapabilityBoard {
  const summary = projection.capabilitySummary;
  const companionName = projection.companionName ?? labels.gameBoardCompanionTitle;
  return Object.freeze({
    title: labels.gameBoardTitle,
    lead: summary.available ? withCount(labels.gameBoardPublishedLead, summary.count) : labels.gameBoardUnpublishedLead,
    cards: Object.freeze([
      Object.freeze({
        key: "companion" as const,
        icon: "companion" as const,
        title: companionName,
        detail:
          projection.role === "companion"
            ? labels.gameBoardCompanionPresent.replace("{{name}}", companionName)
            : labels.gameBoardCompanionAbsent,
      }),
      Object.freeze({
        key: "abilities" as const,
        icon: "abilities" as const,
        title: summary.available
          ? withCount(labels.gameBoardAbilitiesPublished, summary.count)
          : labels.gameBoardAbilitiesUnpublished,
        detail: summary.available
          ? labels.gameBoardAbilitiesPublishedDetail
          : labels.gameBoardAbilitiesUnpublishedDetail,
      }),
      Object.freeze({
        key: "action" as const,
        icon: "action" as const,
        title: authorityLabel(labels, projection.actionAuthority),
        detail: actingDetail(labels, projection.actionAuthority),
      }),
    ]),
    waiting: summary.available ? null : labels.gameBoardWaiting,
  });
}

/**
 * Every outcome the companion-Mod deployment can report, in one place.
 *
 * This is the launcher's own vocabulary (`CompanionGameModDeploymentOutcome`). It is a runtime array because a
 * test cannot enumerate a type, and it is declared once so the label function, the ready/not-ready split and the
 * exhaustiveness test all derive from the same list instead of three copies of it.
 */
export const COMPANION_MOD_OUTCOMES = [
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
] as const;

/**
 * Whether the companion Mod is actually in the player's `Mods/GameBuddy` after an install.
 *
 * Three of the launcher's outcomes mean it is there (`installed`, `current`, `updated`); every other
 * one means the folder is loadable but the Mod is not, which is a different thing to tell a player
 * than "ready". Exhaustive over the vocabulary so a new outcome cannot quietly read as success.
 */
export function companionModIsReady(outcome: NonNullable<StardewInstallationMutationV1["companionMod"]>): boolean {
  switch (outcome) {
    case "companion-mod-installed":
    case "companion-mod-current":
    case "companion-mod-updated":
      return true;
    case "companion-mod-game-not-found":
    case "companion-mod-choice-required":
    case "companion-mod-unavailable":
    case "companion-mod-game-installation-not-found":
    case "companion-mod-smapi-not-installed":
    case "companion-mod-mods-directory-missing":
    case "companion-mod-mods-directory-not-writable":
    case "companion-mod-existing-mod-version-requires-consent":
    case "companion-mod-foreign-mod-present":
    case "companion-mod-installed-mod-manifest-unreadable":
    case "companion-mod-package-invalid":
    case "companion-mod-deployment-incomplete":
      return false;
    default:
      // A new outcome is a compile error here, and no `return false` after it: the guard's own return
      // type is `never`, the same assertion `companionModLabel` below makes.
      return assertNever(outcome);
  }
}

/**
 * The companion Mod's state as player text.
 *
 * The ready cases say the installation is complete; each refusal names what the player has to do
 * about it, because "SMAPI installed" followed by silence is the failure this wording exists to
 * prevent.
 */
export function companionModLabel(
  labels: Messages,
  outcome: NonNullable<StardewInstallationMutationV1["companionMod"]>,
): string {
  switch (outcome) {
    case "companion-mod-installed":
    case "companion-mod-updated":
    case "companion-mod-current":
      return labels.gameCompanionModReady;
    case "companion-mod-mods-directory-missing":
      return labels.gameCompanionModModsDirectoryMissing;
    case "companion-mod-mods-directory-not-writable":
      return labels.gameCompanionModModsDirectoryNotWritable;
    case "companion-mod-foreign-mod-present":
      return labels.gameCompanionModForeignModPresent;
    case "companion-mod-installed-mod-manifest-unreadable":
      return labels.gameCompanionModManifestUnreadable;
    case "companion-mod-package-invalid":
    case "companion-mod-deployment-incomplete":
    case "companion-mod-unavailable":
      return labels.gameCompanionModUnavailable;
    case "companion-mod-game-not-found":
    case "companion-mod-game-installation-not-found":
      return labels.gameCompanionModGameMissing;
    case "companion-mod-choice-required":
      return labels.gameCompanionModChoiceRequired;
    case "companion-mod-smapi-not-installed":
      return labels.gameCompanionModLoaderMissing;
    case "companion-mod-existing-mod-version-requires-consent":
      return labels.gameCompanionModConsentRequired;
    default:
      return assertNever(outcome);
  }
}
