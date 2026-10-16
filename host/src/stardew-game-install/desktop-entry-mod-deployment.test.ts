import assert from "node:assert/strict";
import test from "node:test";

import {
  ensureCompanionGameModDeployed,
  type CompanionGameModDeploymentOutcome,
  type CompanionGameModDeploymentSeams,
} from "./desktop-entry-mod-deployment.js";
import type {
  StardewCompanionModDeploymentFailure,
  StardewCompanionModDeploymentInput,
  StardewCompanionModDeploymentResult,
  StardewCompanionModPackage,
} from "./deployment.js";
import type { StardewGameInstallationResolution } from "./discovery.js";

/**
 * Every branch below is driven through the step's own seams, so the decision is
 * pinned on a machine with no game installed: the discovery result, the published
 * package and the deployment outcome are the only inputs.
 */
const INSTALL_ROOT = "C:\\Games\\Stardew Valley";
const ARTIFACT_ROOT = "C:\\Games\\GameBuddy\\generations\\g1";
const UNIQUE_ID = "zhexulong.GameBuddy";
const MOD_PACKAGE: StardewCompanionModPackage = Object.freeze({
  root: `${ARTIFACT_ROOT}\\native\\stardew-mod\\GameBuddy`,
  entries: Object.freeze(["GameBuddy.Stardew.dll", "manifest.json"]),
  digests: Object.freeze({ "GameBuddy.Stardew.dll": "a".repeat(64), "manifest.json": "b".repeat(64) }),
  uniqueId: UNIQUE_ID,
  version: "0.1.0",
});
const INSTALLATION = Object.freeze({
  source: "steam" as const,
  installRoot: INSTALL_ROOT,
  gameExecutable: `${INSTALL_ROOT}\\Stardew Valley.exe`,
  smapiExecutable: `${INSTALL_ROOT}\\StardewModdingAPI.exe`,
});
const RESOLVED: StardewGameInstallationResolution = Object.freeze({
  kind: "resolved",
  installation: INSTALLATION,
  diagnostics: Object.freeze([]),
});

const FAILURES: readonly StardewCompanionModDeploymentFailure[] = Object.freeze([
  "game_installation_not_found",
  "smapi_not_installed",
  "mods_directory_missing",
  "mods_directory_not_writable",
  "existing_mod_version_requires_consent",
  "foreign_mod_present",
  "installed_mod_manifest_unreadable",
  "mod_package_invalid",
  "mod_deployment_incomplete",
]);

/** The exact token an operator reads back for each named failure. */
const EXPECTED_FAILURE_TOKENS: Readonly<
  Record<StardewCompanionModDeploymentFailure, CompanionGameModDeploymentOutcome>
> = Object.freeze({
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

const LAUNCHER_STATUS_TOKEN = /^[a-z][a-z0-9-]{0,63}$/;

type DiscoverySeam = () => Promise<StardewGameInstallationResolution>;
type DeploymentSeam = (input: StardewCompanionModDeploymentInput) => Promise<StardewCompanionModDeploymentResult>;

async function outcomeFor(
  resolution: StardewGameInstallationResolution | (() => Promise<never>),
  deployment: StardewCompanionModDeploymentResult | (() => Promise<never>) = {
    kind: "current",
    version: "0.1.0",
  },
): Promise<Readonly<{ outcome: CompanionGameModDeploymentOutcome; inputs: StardewCompanionModDeploymentInput[] }>> {
  const inputs: StardewCompanionModDeploymentInput[] = [];
  const discover: DiscoverySeam = async () => (typeof resolution === "function" ? await resolution() : resolution);
  const deploy: DeploymentSeam = async (input) => {
    inputs.push(input);
    return typeof deployment === "function" ? await deployment() : deployment;
  };
  const outcome = await ensureCompanionGameModDeployed(ARTIFACT_ROOT, {
    discover,
    readPackage: async () => MOD_PACKAGE,
    deploy,
  });
  return Object.freeze({ outcome, inputs });
}

test("the resolved installation receives the shipped package", async () => {
  const { outcome, inputs } = await outcomeFor(RESOLVED, { kind: "installed", version: "0.1.0" });

  assert.equal(outcome, "companion-mod-installed");
  assert.equal(inputs.length, 1);
  assert.equal(inputs[0]!.installRoot, INSTALL_ROOT);
  assert.equal(inputs[0]!.package, MOD_PACKAGE);
  // A copy of our own Mod that is not the shipped one is replaced, so the game
  // loads the Mod this generation's Host speaks to.
  assert.equal(inputs[0]!.allowReplaceDifferentVersion, true);
});

test("an installed copy of the shipped package is reported current", async () => {
  const { outcome } = await outcomeFor(RESOLVED, { kind: "current", version: "0.1.0" });

  assert.equal(outcome, "companion-mod-current");
});

test("a replaced or repaired installed directory is reported updated", async () => {
  for (const deployment of [
    { kind: "updated", installedVersion: "0.0.9", version: "0.1.0" } as const,
    { kind: "updated", installedVersion: "0.1.0", version: "0.1.0" } as const,
  ]) {
    const { outcome } = await outcomeFor(RESOLVED, deployment);
    assert.equal(outcome, "companion-mod-updated");
  }
});

test("no game found and several games found are named without any deployment", async () => {
  const notFound = await outcomeFor({ kind: "not_found", diagnostics: Object.freeze(["steam-unavailable"]) });
  assert.equal(notFound.outcome, "companion-mod-game-not-found");
  assert.deepEqual(notFound.inputs, []);

  // Several installed games need the player's one-time choice, which is the game
  // lane's own admitted step: this step never guesses one of them.
  const choice = await outcomeFor({
    kind: "choice_required",
    installations: Object.freeze([INSTALLATION, INSTALLATION]),
    diagnostics: Object.freeze([]),
  });
  assert.equal(choice.outcome, "companion-mod-choice-required");
  assert.deepEqual(choice.inputs, []);
});

test("every named deployment failure is one bounded launcher token", async () => {
  const seen: CompanionGameModDeploymentOutcome[] = [];
  for (const failure of FAILURES) {
    const { outcome } = await outcomeFor(RESOLVED, { kind: "failed", failure });
    seen.push(outcome);
    assert.equal(outcome, EXPECTED_FAILURE_TOKENS[failure]);
    assert.match(outcome, LAUNCHER_STATUS_TOKEN);
    assert.equal(outcome.length <= 64, true);
  }
  assert.deepEqual(
    seen,
    FAILURES.map((failure) => EXPECTED_FAILURE_TOKENS[failure]),
  );
});

test("a deployment failure is named, never rejects, and never blocks startup", async () => {
  const rejecting: Readonly<Record<string, Partial<CompanionGameModDeploymentSeams>>> = {
    discovery: { discover: async () => await Promise.reject(new Error("registry_unavailable")) },
    package: { readPackage: async () => await Promise.reject(new Error("package_unreadable")) },
    deployment: { deploy: async () => await Promise.reject(new Error("mods_locked")) },
  };
  for (const [label, seam] of Object.entries(rejecting)) {
    const outcome = await ensureCompanionGameModDeployed(ARTIFACT_ROOT, {
      discover: async () => RESOLVED,
      readPackage: async () => MOD_PACKAGE,
      deploy: async () => ({ kind: "current", version: "0.1.0" }),
      ...seam,
    });
    // An unknown failure is named `companion-mod-unavailable` rather than failing
    // the launch: the player still gets the app.
    assert.equal(outcome, "companion-mod-unavailable", `${label} failure must be named, not thrown`);
    assert.match(outcome, LAUNCHER_STATUS_TOKEN);
  }
});
