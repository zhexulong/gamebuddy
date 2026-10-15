/**
 * Provision the two formal multiplayer profiles a shared-world gate needs.
 *
 * WHY THIS EXISTS
 * ---------------
 * `tools/run-stardew-multiplayer-gate.mjs` starts the two-process farmhand topology and refuses with
 * `multiplayer_gate_profile_missing:A-host` when a profile root has no `A-host` / `A-ai-client`. Those profiles are
 * normally provisioned by hand (see `tools/README.md:271-273` and `fixtures/stardew/RUNBOOK.md:31`), and the default
 * root they used to live in has been reset - so a lane that only ever ran single-process native-local gates has
 * neither, and a multiplayer gate cannot start.
 *
 * WHAT IT WRITES, AND WHERE THE SHAPE COMES FROM
 * ----------------------------------------------
 * Four config files and one Mod bundle per profile, exactly the layout
 * `tools/lib/stardew-fixture-profile.mjs` reads and writes (`resolveContext`, `deployModBundle`):
 *
 *   <profiles>/<profile>/GameBuddy/config.json               the sidecar (the transaction input)
 *   <profiles>/<profile>/Mods/GameBuddy/config.json          the copy SMAPI actually loads
 *   <profiles>/<profile>/Mods/GameBuddy/{GameBuddy.Stardew.dll, GameBuddy.Stardew.Core.dll, manifest.json,
 *                                        GameBuddy.Stardew.deps.json}
 *
 * Every field below is taken from the Mod's own model rather than invented:
 *   * `assertFormalAttachmentShape` (`stardew-fixture-profile.mjs:547`) requires
 *     `HostAutomation.Enable`, `HostFarmhandProvisioning.Enable` (host) and `FarmhandProvisioner.Enable` (ai), plus
 *     non-empty `SessionDirectory` + `SessionToken` (host) and `ManifestPath` + `SessionToken` (ai).
 *   * `HostFarmhandProvisioningConfig.IsValid` (`ModConfig.cs:302`) bounds the token to 16..256 printable ASCII
 *     (`FarmhandProvisioningModels.IsValidToken`), the directory to an absolute path, `FarmhandName` to 1..64
 *     alphanumerics, `ManifestLifetimeSeconds` to 30..600, and requires at least one authorized companion id that is
 *     an opaque id (`[A-Za-z0-9_-]{1,128}`).
 *   * `FarmhandProvisionerConfig.IsValid` (`ModConfig.cs:321`) requires an absolute `ManifestPath` whose FILENAME is
 *     `stardew-farmhand-manifest.json` and a `TimeoutSeconds` in 1..300.
 *   * `ModConfig.HasValidLocalBridgeConfiguration` (`ModConfig.cs:120`) requires an opaque `PipeName`, a
 *     `BridgeToken` of 16..256 characters, and a valid `BridgeScope` - so all four scope ids are opaque.
 *
 * THE SAVE IS NOT CREATED HERE, and this tool says so rather than implying otherwise: a shared-world gate additionally
 * needs a save whose Farm carries a Cabin bound to the farmhand, and nothing in this repo creates one.
 *
 * Usage:
 *   node tools/provision-stardew-multiplayer-profiles.mjs --profile-root <absolute> [--session-directory <absolute>]
 *     [--companion-id <opaque>] [--release-dir <absolute>] [--check-only]
 */

import { cp, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";

const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_RELEASE_DIR = join(REPOSITORY_ROOT, "integrations", "stardew", "bin", "Release", "net6.0");
const PROFILE_NAMES = Object.freeze(["A-host", "A-ai-client"]);
const MANIFEST_FILE_NAME = "stardew-farmhand-manifest.json";
const BUNDLE_FILE_NAMES = Object.freeze([
  "GameBuddy.Stardew.dll",
  "GameBuddy.Stardew.Core.dll",
  "manifest.json",
  "GameBuddy.Stardew.deps.json",
]);
const ARGUMENTS = Object.freeze({
  "--profile-root": "value",
  "--session-directory": "value",
  "--companion-id": "value",
  "--release-dir": "value",
  "--check-only": "flag",
  "--fixture-scenario": "value",
  "--trigger-native-save-after-attachment": "flag",
});
const OPAQUE_ID = /^[A-Za-z0-9_-]{1,128}$/u;

/** Parse the bounded argument set. Unknown keys fail rather than being ignored. */
export function parseProvisionArgs(argv = []) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    const kind = ARGUMENTS[key];
    if (kind === undefined) throw new Error(`unknown_provision_argument:${key}`);
    if (kind === "flag") {
      values.set(key, true);
      continue;
    }
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) throw new Error(`missing_provision_value:${key}`);
    values.set(key, value);
    index += 1;
  }
  const profileRoot = values.get("--profile-root");
  if (profileRoot === undefined) throw new Error("missing_provision_argument:--profile-root");
  if (!isAbsolute(profileRoot)) throw new Error("profile_root_must_be_absolute");
  const companionId = values.get("--companion-id") ?? "gamebuddy-farmhand";
  if (!OPAQUE_ID.test(companionId)) throw new Error(`invalid_companion_id:${companionId}`);
  const releaseDir = values.get("--release-dir") ?? DEFAULT_RELEASE_DIR;
  if (!isAbsolute(releaseDir)) throw new Error("release_dir_must_be_absolute");
  const sessionDirectory = values.get("--session-directory") ?? join(profileRoot, "multiplayer-session");
  const fixtureScenario = values.get("--fixture-scenario") ?? "";
  if (fixtureScenario.length > 0 && !/^native_[a-z0-9_]+_v\d*$/u.test(fixtureScenario))
    throw new Error(`invalid_fixture_scenario:${fixtureScenario}`);
  if (!isAbsolute(sessionDirectory)) throw new Error("session_directory_must_be_absolute");
  return Object.freeze({
    profileRoot,
    sessionDirectory,
    companionId,
    releaseDir,
    fixtureScenario,
    triggerNativeSaveAfterAttachment: values.get("--trigger-native-save-after-attachment") === true,
    checkOnly: values.get("--check-only") === true,
  });
}

/** The host profile's formal config, field for field. */
export function hostProfileConfig({
  sessionDirectory,
  sessionToken,
  companionId,
  fixtureScenario = "",
  triggerNativeSaveAfterAttachment = false,
}) {
  return {
    EnableLocalBridge: true,
    PipeName: "gamebuddy-stardew-host",
    BridgeToken: randomBytes(16).toString("hex"),
    SaveId: "provisioned",
    WorldId: "provisioned",
    PlayerId: "provisioned",
    CompanionId: companionId,
    WindowMode: "visible",
    PresentationLocale: "",
    NativeLocalPlayerFixture: null,
    FarmhandProvisioningProbe: null,
    SleepModalProbe: null,
    SleepLifecycle: null,
    HostAutomation: {
      Enable: true,
      FixtureScenario: fixtureScenario,
      SaveName: "",
      TimeoutSeconds: 300,
      RequireFixtureLiveLocale: "",
      TriggerNativeSaveAfterAttachment: triggerNativeSaveAfterAttachment,
      TriggerNativeSaveAfterClientExit: false,
    },
    // The formal Host half: it owns the session directory and publishes the advertisement the AI client verifies.
    HostFarmhandProvisioning: {
      Enable: true,
      SessionDirectory: sessionDirectory,
      SessionToken: sessionToken,
      IntegrationVersion: "0.1.0",
      FarmhandName: "GameBuddy",
      ManifestLifetimeSeconds: 120,
      AuthorizedCompanionIds: [companionId],
    },
    FarmhandProvisioner: null,
    WorldCreation: null,
    DeniedActions: [],
    DeniedActionFamilies: [],
    ExperimentalActions: [],
    ActionPolicyVersion: 0,
  };
}

/** The AI client profile's formal config. It consumes the manifest the Host publishes. */
export function aiProfileConfig({ sessionDirectory, sessionToken, companionId }) {
  return {
    EnableLocalBridge: true,
    PipeName: "gamebuddy-stardew-ai",
    BridgeToken: randomBytes(16).toString("hex"),
    SaveId: "provisioned",
    WorldId: "provisioned",
    PlayerId: "provisioned",
    CompanionId: companionId,
    WindowMode: "visible",
    PresentationLocale: "",
    NativeLocalPlayerFixture: null,
    FarmhandProvisioningProbe: null,
    SleepModalProbe: null,
    SleepLifecycle: null,
    HostAutomation: null,
    // The block is PRESENT but DISABLED. Present, because the shared-world driver sets its `SessionToken`
    // (`run-stardew-shared-world-action.ps1:309`) and PowerShell cannot add a property to a null; disabled, because
    // `ModEntry.cs:333` reads `Enable == true` as "I am the Host role", and `:347-351` refuses a profile that enables
    // both roles at once. The AI client's role comes from `FarmhandProvisioner` alone.
    HostFarmhandProvisioning: {
      Enable: false,
      SessionDirectory: sessionDirectory,
      SessionToken: sessionToken,
      IntegrationVersion: "0.1.0",
      FarmhandName: "GameBuddy",
      ManifestLifetimeSeconds: 120,
      AuthorizedCompanionIds: [companionId],
    },
    FarmhandProvisioner: {
      Enable: true,
      ManifestPath: join(sessionDirectory, MANIFEST_FILE_NAME),
      SessionToken: sessionToken,
      IntegrationVersion: "0.1.0",
      TimeoutSeconds: 45,
    },
    WorldCreation: null,
    DeniedActions: [],
    DeniedActionFamilies: [],
    ExperimentalActions: [],
    ActionPolicyVersion: 0,
  };
}

/**
 * Every condition this tool is responsible for, checked against the configs it just built. These mirror the Mod's own
 * `IsValid` rules; the repo's own `assertFormalAttachmentShape` and the gate entry check the rest at run time.
 */
export function assertProvisionedShape({ host, ai, checkOnly = false }) {
  const token = host.HostFarmhandProvisioning.SessionToken;
  if (host.HostAutomation.Enable !== true) throw new Error("host_automation_not_enabled");
  if (host.HostFarmhandProvisioning.Enable !== true) throw new Error("host_provisioning_not_enabled");
  if (ai.FarmhandProvisioner.Enable !== true) throw new Error("ai_provisioner_not_enabled");
  if (!isAbsolute(host.HostFarmhandProvisioning.SessionDirectory)) throw new Error("session_directory_not_absolute");
  if (token.length < 16 || token.length > 256) throw new Error("session_token_out_of_bounds");
  if ([...token].some((character) => character.codePointAt(0) < 0x21 || character.codePointAt(0) > 0x7e))
    throw new Error("session_token_not_printable_ascii");
  if (ai.FarmhandProvisioner.SessionToken !== token) throw new Error("session_token_mismatch");
  if (!isAbsolute(ai.FarmhandProvisioner.ManifestPath)) throw new Error("manifest_path_not_absolute");
  if (join(ai.FarmhandProvisioner.ManifestPath).split(/[\\/]/u).pop() !== MANIFEST_FILE_NAME)
    throw new Error("manifest_file_name_not_the_protocol_name");
  if (!isAbsolute(host.HostFarmhandProvisioning.SessionDirectory)) throw new Error("session_directory_not_absolute");
  const sessionRoot = join(host.HostFarmhandProvisioning.SessionDirectory);
  if (join(ai.FarmhandProvisioner.ManifestPath) !== join(sessionRoot, MANIFEST_FILE_NAME))
    throw new Error("manifest_path_not_inside_the_session_directory");
  for (const id of [
    host.CompanionId,
    ai.CompanionId,
    host.SaveId,
    host.WorldId,
    host.PlayerId,
    host.HostFarmhandProvisioning.AuthorizedCompanionIds[0],
  ])
    if (!OPAQUE_ID.test(id)) throw new Error(`not_an_opaque_id:${id}`);
  if (host.HostFarmhandProvisioning.AuthorizedCompanionIds.length === 0) throw new Error("no_authorized_companion_id");
  if (checkOnly) return true;
  return true;
}

async function assertReleaseBundle(releaseDir) {
  for (const fileName of BUNDLE_FILE_NAMES) {
    const path = join(releaseDir, fileName);
    if (!existsSync(path)) throw new Error(`release_bundle_missing:${path}`);
  }
}

async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function main(argv) {
  const request = parseProvisionArgs(argv);
  if (!existsSync(request.profileRoot)) throw new Error(`profile_root_missing:${request.profileRoot}`);
  const profileRootStat = await stat(request.profileRoot);
  if (!profileRootStat.isDirectory()) throw new Error("profile_root_not_a_directory");
  await assertReleaseBundle(request.releaseDir);

  const sessionToken = randomBytes(24).toString("hex");
  const host = hostProfileConfig({ ...request, sessionToken });
  const ai = aiProfileConfig({ ...request, sessionToken });
  assertProvisionedShape({ host, ai, checkOnly: request.checkOnly });
  if (request.checkOnly) {
    return { state: "checked", profileRoot: request.profileRoot, sessionDirectory: request.sessionDirectory };
  }

  await mkdir(request.sessionDirectory, { recursive: true });
  for (const [profile, config] of [
    ["A-host", host],
    ["A-ai-client", ai],
  ]) {
    const sidecarRoot = join(request.profileRoot, profile, "GameBuddy");
    const modRoot = join(request.profileRoot, profile, "Mods", "GameBuddy");
    await writeJson(join(sidecarRoot, "config.json"), config);
    await writeJson(join(modRoot, "config.json"), config);
    for (const fileName of BUNDLE_FILE_NAMES) await cp(join(request.releaseDir, fileName), join(modRoot, fileName));
  }

  // Verify by READING BACK what was written, not by trusting the objects above.
  const written = {
    hostSidecar: JSON.parse(await readFile(join(request.profileRoot, "A-host", "GameBuddy", "config.json"), "utf8")),
    aiSidecar: JSON.parse(await readFile(join(request.profileRoot, "A-ai-client", "GameBuddy", "config.json"), "utf8")),
  };
  assertProvisionedShape({ host: written.hostSidecar, ai: written.aiSidecar });
  for (const profile of PROFILE_NAMES)
    for (const fileName of [...BUNDLE_FILE_NAMES, "config.json"])
      if (!existsSync(join(request.profileRoot, profile, "Mods", "GameBuddy", fileName)))
        throw new Error(`mod_bundle_incomplete:${profile}/${fileName}`);

  return {
    state: "provisioned",
    profileRoot: request.profileRoot,
    sessionDirectory: request.sessionDirectory,
    profiles: PROFILE_NAMES,
    companionId: request.companionId,
    // Named so the operator knows the two steps this tool does NOT perform.
    stillRequired: [
      "a save NAMED GameBuddyFixture_<id> on disk: the formal Host loads it by name, and HostAutomationConfig.IsValid",
      'requires SaveName.StartsWith("GameBuddyFixture_") for any armed scenario',
      "a Cabin building inside that save:",
      "  the fixture scenario native_build_farmhand_cabin_v1 builds exactly one through the game's own",
      "  BuildStartingCabins shape (GameLocation.cs:17574-17580) and the driver's post-attachment save persists it",
    ].join(" "),
  };
}

if (import.meta.main) {
  try {
    console.log(JSON.stringify(await main(process.argv.slice(2))));
  } catch (error) {
    console.log(JSON.stringify({ state: "blocked", reasonCode: String(error?.message ?? error) }));
    process.exitCode = 1;
  }
}
