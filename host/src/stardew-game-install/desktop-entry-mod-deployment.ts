import {
  deployStardewCompanionMod,
  readStardewCompanionModPackage,
  type StardewCompanionModDeploymentFailure,
  type StardewCompanionModDeploymentInput,
  type StardewCompanionModDeploymentResult,
  type StardewCompanionModPackage,
} from "./deployment.js";
import { discoverStardewGameInstallation, type StardewGameInstallationResolution } from "./discovery.js";

/**
 * One bounded lowercase token per outcome, matching the shape the Desktop launcher
 * validates a bootstrap status stage by (`^[a-z][a-z0-9-]{0,63}$`), so the
 * announced outcome is also a legal last-stage diagnostic.
 */
export type CompanionGameModDeploymentOutcome =
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

/** Exhaustive: a new deployment failure cannot be added without naming its token. */
const FAILURE_OUTCOMES: Readonly<Record<StardewCompanionModDeploymentFailure, CompanionGameModDeploymentOutcome>> =
  Object.freeze({
    game_installation_not_found: "companion-mod-game-installation-not-found",
    smapi_not_installed: "companion-mod-smapi-not-installed",
    mods_directory_missing: "companion-mod-mods-directory-missing",
    mods_directory_not_writable: "companion-mod-mods-directory-not-writable",
    existing_mod_version_requires_consent: "companion-mod-existing-mod-version-requires-consent",
    foreign_mod_present: "companion-mod-foreign-mod-present",
    installed_mod_manifest_unreadable: "companion-mod-installed-mod-manifest-unreadable",
    mod_package_invalid: "companion-mod-package-invalid",
    mod_deployment_incomplete: "companion-mod-deployment-incomplete",
  });

/**
 * The three seams this step runs on, defaulted to the production ones and
 * injectable for the same reason the discovery resolver takes its probe and its
 * metadata readers: every branch of the decision - no game, several games, an
 * absent directory, a different version, the shipped version - must be provable
 * on a machine that has no game installed.
 */
export type CompanionGameModDeploymentSeams = Readonly<{
  discover: () => Promise<StardewGameInstallationResolution>;
  readPackage: (artifactRoot: string) => Promise<StardewCompanionModPackage>;
  deploy: (input: StardewCompanionModDeploymentInput) => Promise<StardewCompanionModDeploymentResult>;
}>;

/**
 * The desktop entry's pre-launch step: the player's own game installation is
 * discovered and its `Mods/GameBuddy` directory is brought to the Mod package this
 * generation ships.
 *
 * It never rejects, and it never returns a token without also being the only
 * statement of what happened: a player whose game is absent, installed several
 * times, locked, SMAPI-less or already current still gets the app, because no
 * outcome here is a startup failure. The one exception is deliberate - the Mod
 * directory of a *different* author is never touched.
 *
 * An installed copy of our own Mod is replaced when it does not match the shipped
 * package, including a different version: the player launched this generation, and
 * the game has to load the Mod that generation's Host speaks to. Consent by
 * inaction (refusing to touch our own stale directory) would leave exactly the
 * mismatch this step exists to prevent.
 */
export async function ensureCompanionGameModDeployed(
  artifactRoot: string,
  seams: Partial<CompanionGameModDeploymentSeams> = {},
): Promise<CompanionGameModDeploymentOutcome> {
  try {
    const resolution = await (seams.discover ?? discoverStardewGameInstallation)();
    if (resolution.kind === "not_found") return "companion-mod-game-not-found";
    // Several installed games are the player's one-time choice, and that choice is
    // the game lane's own admitted step; this step never guesses one of them.
    if (resolution.kind === "choice_required") return "companion-mod-choice-required";
    const mod = await (seams.readPackage ?? readStardewCompanionModPackage)(artifactRoot);
    const result = await (seams.deploy ?? deployStardewCompanionMod)({
      installRoot: resolution.installation.installRoot,
      package: mod,
      allowReplaceDifferentVersion: true,
    });
    if (result.kind === "failed") return FAILURE_OUTCOMES[result.failure];
    if (result.kind === "installed") return "companion-mod-installed";
    return result.kind === "updated" ? "companion-mod-updated" : "companion-mod-current";
  } catch {
    // Discovery, the published package and the write path all report their own
    // failures as values; anything that still throws is this step's own unknown,
    // and it is named as such rather than failing the launch.
    return "companion-mod-unavailable";
  }
}
