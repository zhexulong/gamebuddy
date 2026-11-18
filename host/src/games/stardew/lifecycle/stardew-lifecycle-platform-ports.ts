import type {
  RedactedRecoveryOutcome,
  TypedPrivateGameFacts,
} from "../../../containment/runtime/contract/game-runtime.js";
import type { StardewCompanionModDeploymentResult } from "../../../stardew-game-install/deployment.js";
import type { StardewGuardianNamedObjectProbe } from "./stardew-guardian-object-presence.js";
import type { StardewOwnedPlayerHostBootstrap } from "./stardew-private-bootstrap-composer.js";

/**
 * What the Stardew lifecycle needs from the machine it runs on, declared here instead of imported.
 *
 * Three capabilities, from seven modules:
 *
 *   `installation`  windows-reparse-inspector, windows-stardew-folder-picker and
 *                   windows-stardew-installation-discovery answer one question - where is the game on this
 *                   machine and is that path a real installation - so they are one capability.
 *   `guardian`      composition/stardew/stardew-guardian-object-presence and ...-platform both speak for the
 *                   Guardian about this attempt's OS objects, so they are one capability.
 *   `companionMod`  stardew-game-install/desktop-entry-mod-deployment reports what putting our Mod into a
 *                   player's folder did, which is one fact.
 *
 * The concrete modules are Windows, Guardian and desktop code: `tools/check-host-game-physical-seam.mjs`
 * forbids a `games/**` importer from reaching any of them. Each port is therefore satisfied by the
 * composition root, and every value type below is declared here so that no import of those modules is needed
 * to name what crosses the seam. A member added to a concrete producer's type is caught where the composition
 * root assigns that producer to this port, not at a hand-written copy in this tree.
 */
export type StardewLifecyclePlatform = Readonly<{
  installation: StardewInstallationPlatform;
  guardian: StardewGuardianPlatform;
  companionMod: StardewCompanionModPlatform;
}>;

/** Opaque native folder-picker handle; only the platform module can read what it names. */
export type StardewFolderPickerCapability = object;

/** An untrusted candidate path, or a dismissed dialog. */
export type StardewFolderSelectionResult = Readonly<{ status: "cancelled" } | { status: "selected"; path: string }>;

/** Opaque reparse-chain inspector handle; only the platform module can inspect a path with it. */
export type StardewReparseInspectorCapability = object;

/** Whether a mod loader is already in a candidate folder, so choosing it can register immediately. */
export type StardewInstallationCandidateModLoader = "present" | "missing";

/**
 * One installation the machine's own sources proposed.
 *
 * `displayPath` is a filesystem path and is published only to this lifecycle; the browser receives the
 * projection the game adapter makes.
 */
export type StardewInstallationCandidateView = Readonly<{
  candidateId: string;
  source: "steam-registry" | "steam-vdf" | "known-location" | "gog" | "microsoft-store";
  label: string;
  displayPath: string;
  location: string | null;
  status: "candidate" | "invalid" | "admission_required";
  modLoader: StardewInstallationCandidateModLoader;
}>;

/** A source-read failure, named per channel so the surface says which search could not be run. */
export type StardewInstallationDiscoveryDiagnostic =
  | "registry-unavailable"
  | "vdf-unreadable"
  | "vdf-malformed"
  | "invalid-app-manifest"
  | "library-without-game"
  | "no-candidates"
  | "source-unavailable"
  | "candidate-invalid"
  | "gog-unavailable"
  | "gog-metadata-unreadable"
  | "gog-metadata-malformed"
  | "microsoft-store-unavailable"
  | "microsoft-store-root-unreadable"
  | "microsoft-store-install-not-mod-enabled";

export type StardewInstallationDiscoveryView = Readonly<{
  candidates: readonly StardewInstallationCandidateView[];
  diagnostics: readonly StardewInstallationDiscoveryDiagnostic[];
}>;

/**
 * The machine's installation sources, as this lifecycle drives them.
 *
 * `confirm` turns one proposed candidate into the locator a registration admits, and refuses by throwing a
 * bounded code; `reset` forgets the session's proposals so a retry starts from a fresh read.
 */
export type StardewInstallationDiscoverySource = Readonly<{
  discover(): Promise<StardewInstallationDiscoveryView>;
  confirm(candidateId: string): string;
  reset(): void;
}>;

export type StardewInstallationPlatform = Readonly<{
  /** The reparse-chain inspector every admission of a locator is made with. */
  createReparseInspector(): Promise<StardewReparseInspectorCapability>;
  /** Shows the native dialog and returns its answer; a foreign handle is refused by the platform. */
  selectFolder(picker: StardewFolderPickerCapability): Promise<StardewFolderSelectionResult>;
  /** Absent when this build mounts no discovery sources; discovery then refuses by name. */
  discovery: StardewInstallationDiscoverySource | undefined;
}>;

export type StardewGuardianPlatform = Readonly<{
  /** Whether the OS proves the attempt's Guardian-owned objects gone. */
  probeNamedObjects: StardewGuardianNamedObjectProbe;
}>;

/** One bounded lowercase token per companion-Mod deployment outcome. */
export type StardewCompanionModOutcome =
  | "companion-mod-current"
  | "companion-mod-installed"
  | "companion-mod-updated"
  | "companion-mod-game-not-found"
  | "companion-mod-choice-required"
  | "companion-mod-unavailable"
  | "companion-mod-game-installation-not-found"
  | "companion-mod-smapi-not-installed"
  | "companion-mod-mods-directory-missing"
  | "companion-mod-mods-directory-not-writable"
  | "companion-mod-existing-mod-version-requires-consent"
  | "companion-mod-foreign-mod-present"
  | "companion-mod-installed-mod-manifest-unreadable"
  | "companion-mod-package-invalid"
  | "companion-mod-deployment-incomplete";

export type StardewCompanionModPlatform = Readonly<{
  /** The one mapping from a deployment result to the token this lifecycle publishes. */
  outcomeFor(result: StardewCompanionModDeploymentResult): StardewCompanionModOutcome;
}>;

/**
 * The part of a recovery only the calling layer can supply.
 *
 * The gate binding and both durable steps deliberately are NOT part of it: they come from the exact owner's
 * consumed one-shot Guardian binding, so a caller can neither substitute the gate correlation the native gate
 * must acquire nor invent a durable transition it does not own.
 */
export type StardewOwnerRecoveryRequest = Readonly<{
  /**
   * Opaque recovery actor for this attempt. An interrupted recovery resumes its exact recorded actor instead
   * of minting a new identity.
   */
  readonly recoveryInstanceId: string;
  /**
   * Durable post-CAS binding facts of the successor record, read after the `recovering` CAS ran. They are
   * typed game facts only: the composition encodes them into the post-CAS native body, and the native ingress
   * remains the authority on the gate correlation they must still match.
   */
  readonly readRecoveryBinding: () => Promise<TypedPrivateGameFacts>;
}>;

/**
 * The owner-held recovery half of the launch collaborator seam.
 *
 * The collaborator is declared by this layer, so the half it carries is declared here too: a recovery is
 * driven for the exact owner whose durable attempt is non-terminal, and the composition installs both members
 * on the same one-shot collaborator object it already returns.
 */
export type StardewOwnerRecoveryDriver = Readonly<{
  recover(
    owner: StardewOwnedPlayerHostBootstrap,
    request: StardewOwnerRecoveryRequest,
  ): Promise<RedactedRecoveryOutcome>;
  /**
   * Terminal closure of that same recovery: the durable parent record advances to its terminal state and the
   * bound registration pointer is released.
   */
  finalizeRecovered(owner: StardewOwnedPlayerHostBootstrap, request: StardewOwnerRecoveryRequest): Promise<void>;
}>;
