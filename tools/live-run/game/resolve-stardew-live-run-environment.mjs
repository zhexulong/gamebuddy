/**
 * Resolve the environment one Stardew live run needs, from the authorities that
 * already own those facts.
 *
 * The problem this closes: a live run used to be told its game directory by
 * hand — `GAMEBUDDY_STARDEW_GAME_DIR`, or a default like
 * `D:/Steam/steamapps/common/Stardew Valley` hard-coded in the ladder launcher.
 * A hand-passed path can be a stale path, the second Steam library, or a build
 * whose generation digests belong to a different generation than the one the run
 * will actually load; each of those has cost a wasted run.
 *
 * So this resolver derives every environment fact, and invents none:
 *
 * | Fact | Owning authority (composed, never duplicated) |
 * | --- | --- |
 * | the registered installation | `stardew-installation-registration.internal.ts` |
 * | a missing registration | `windows-stardew-installation-discovery` + `stardew-installation-admission` |
 * | the Host generation and its digests | the `current.json` pointer the release publisher writes |
 * | the profile / fixtures roots | `tools/lib/stardew-fixture-roots.mjs` (the runbook's one place) |
 * | the runtime root | the deployment manifest's own `runtimeRoot`, cross-checked |
 *
 * Every fact carries the provenance a reader needs to tell one run from another:
 *
 * - `read`     — it was already registered; this run adopts the recorded value;
 * - `derived`  — it was just discovered, admitted and registered by this run;
 * - `operator` — the operator named it explicitly on the command line;
 * - `default`  — the product layout default, with no override.
 *
 * Fail-closed by construction: no candidates, several candidates, no generation
 * pointer, an ambiguous pointer, a pointer whose digests disagree with the
 * generation it names, a registered installation that no longer admits, or an
 * environment value that contradicts the registration each stop the run with one
 * specific code. There is no "closest match" and no silent default.
 *
 * `warnings` carries what resolves but still costs a run: the two known ones are
 * a locally built generation (the Host re-attests the whole generation and a
 * local build fails that) and a not-yet-deployed Mod bundle (the run's own
 * fixture transaction deploys it).
 *
 * Credentials are reported as environment-variable *references* only: this tool
 * reads whether a variable is present, never its value, and writes no credential
 * anywhere — not to stdout, not to a file, not to an error message.
 *
 * Usage:
 *   node tools/live-run/game/resolve-stardew-live-run-environment.mjs [--print-env]
 *     [--runtime-root <abs>] [--host-production-root <abs>] [--game-dir <abs Windows path>]
 *     [--ladder <n>]
 */
import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import { isAbsolute, resolve, win32 } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { resolveProductionModule } from "../../../host/scripts/production-artifact.mjs";
import { resolveStardewFixtureRoots } from "../../lib/stardew-fixture-roots.mjs";

export const LIVE_RUN_ENVIRONMENT_SCHEMA = "gamebuddy-stardew-live-run-environment/v1";
export const HOST_GENERATION_POINTER_SCHEMA = "gamebuddy-host-production-current/v2";
export const INSTALLATION_REGISTRATION_SCHEMA = "gamebuddy-stardew-installation-registration/v1";
export const RUNTIME_ROOT_ENV = "GAMEBUDDY_RUNTIME_ROOT";
export const HOST_PRODUCTION_ROOT_ENV = "GAMEBUDDY_HOST_PRODUCTION_ROOT";
export const GAME_DIR_ENV = "GAMEBUDDY_STARDEW_GAME_DIR";
export const MODS_DIR_ENV = "GAMEBUDDY_STARDEW_MODS_DIR";
export const MOD_CONFIG_ENV = "GAMEBUDDY_STARDEW_CONFIG";
export const AGENT_LADDER_ENV = "GAMEBUDDY_AGENT_LADDER";
export const MOD_DIRECTORY_NAME = "GameBuddy.Stardew";
export const MOD_CONFIG_LEAF = "config.json";
/** The durable-root directory of the one product layout (`%LOCALAPPDATA%\GameBuddy`). */
export const RUNTIME_ROOT_DIRECTORY_NAME = "GameBuddy";
/** The three profiles one lane owns (see `fixtures/stardew/RUNBOOK.md`). */
export const LANE_PROFILE_NAMES = Object.freeze(["A-host", "A-ai-client", "A-ai-probe"]);
/**
 * Credential *references*. Presence is a fact a run needs; the value never is.
 */
export const CREDENTIAL_REFERENCES = Object.freeze([
  Object.freeze({
    name: "CPA_OAI_API_KEY",
    required: true,
    carriedBy: "the live runner's own process environment",
  }),
  Object.freeze({
    name: "MIMO_API_KEY",
    required: false,
    carriedBy: "tools/lib/voice-gateway-launch.mjs (voice only; absent means text-only)",
  }),
]);

const HOST_MODULES = Object.freeze({
  registration: "stardew-installation-registration.internal.js",
  admission: "stardew-installation-admission.js",
  discovery: "windows-stardew-installation-discovery/index.js",
  inspector: "windows-reparse-inspector/index.js",
  deploymentManifest: "deployment-manifest.js",
});
const POINTER_LEAF = "current.json";
const GENERATIONS_DIRECTORY = "generations";
const INVENTORY_LEAF = "production-inventory.json";
const RUNTIME_ADMISSION_LEAF = "host-runtime-admission.json";
const DEPLOYMENT_MANIFEST_LEAF = "manifest.json";
const REGISTRATION_DIRECTORY = "stardew-installation-registration";
const REGISTRATION_LEAF = "registration.json";
const GENERATION_ID = /^[a-z0-9-]+$/i;
const HEX64 = /^[a-f0-9]{64}$/;
const DRIVE_ROOT = /^[A-Za-z]:\\$/;
const POINTER_KEYS = Object.freeze(["schema", "generation", "inventoryDigest", "runtimeAdmissionSha256"]);

/** Every leaf I/O this resolver performs, so a test never needs the real machine. */
const nodeFileSystem = Object.freeze({
  async kind(path) {
    try {
      const state = await stat(path);
      if (state.isDirectory()) return "directory";
      if (state.isFile()) return "file";
      return "other";
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") return "missing";
      throw error;
    }
  },
  async readText(path) {
    return await readFile(path, "utf8");
  },
  async readDir(path) {
    return await readdir(path);
  },
  async sha256(path) {
    return createHash("sha256")
      .update(await readFile(path))
      .digest("hex");
  },
});

/**
 * The resolver's one failure shape: a specific code, never a generic failure and
 * never a partial environment.
 */
function blocked(code, detail) {
  const error = new Error(code);
  error.code = code;
  if (detail !== undefined) error.detail = Object.freeze({ ...detail });
  return error;
}

function isNodeError(error) {
  return error instanceof Error && typeof error.code === "string";
}

function isMissing(error) {
  return isNodeError(error) && error.code === "ENOENT";
}

function reasonOf(error) {
  return error instanceof Error ? error.message : "unknown";
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.length > 0;
}

/** One canonical absolute Windows directory, or `undefined`. */
function canonicalWindowsDirectory(value) {
  if (!isNonEmptyString(value) || value.length > 32 * 1024) return undefined;
  const normalized = value.replaceAll("/", "\\");
  if (!/^[A-Za-z]:\\/.test(normalized) || normalized.endsWith("\\")) return undefined;
  if (DRIVE_ROOT.test(normalized)) return normalized;
  const components = normalized.slice(3).split("\\");
  if (components.length === 0 || components.length > 511) return undefined;
  const legal = components.every(
    (component) =>
      component.length > 0 &&
      component !== "." &&
      component !== ".." &&
      !/[\\/:*?<>"|\u0000-\u001f]/.test(component) &&
      !component.endsWith(".") &&
      !component.endsWith(" "),
  );
  if (!legal) return undefined;
  return `${normalized.charAt(0).toUpperCase()}:\\${components.join("\\")}`;
}

/** Case-insensitive Windows path comparison, for "does this disagree?" only. */
function sameWindowsPath(left, right) {
  return canonicalWindowsDirectory(left)?.toLowerCase() === canonicalWindowsDirectory(right)?.toLowerCase();
}

function sameDirectory(left, right) {
  const a = resolve(left);
  const b = resolve(right);
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function fact(value, provenance) {
  return Object.freeze({ value, provenance });
}

async function descendantDirectories(fileSystem, directory) {
  try {
    const entries = await fileSystem.readDir(directory);
    const kinds = await Promise.all(
      entries.map(async (name) => ((await fileSystem.kind(resolve(directory, name))) === "directory" ? name : null)),
    );
    return kinds.filter((name) => name !== null).sort();
  } catch (error) {
    if (isMissing(error)) return [];
    throw error;
  }
}

function validPointer(pointer) {
  if (pointer === null || typeof pointer !== "object" || Array.isArray(pointer)) return false;
  const keys = Reflect.ownKeys(pointer);
  if (
    keys.length !== POINTER_KEYS.length ||
    keys.some((key) => typeof key !== "string" || !POINTER_KEYS.includes(key))
  ) {
    return false;
  }
  return (
    pointer.schema === HOST_GENERATION_POINTER_SCHEMA &&
    typeof pointer.generation === "string" &&
    GENERATION_ID.test(pointer.generation) &&
    typeof pointer.inventoryDigest === "string" &&
    HEX64.test(pointer.inventoryDigest) &&
    typeof pointer.runtimeAdmissionSha256 === "string" &&
    HEX64.test(pointer.runtimeAdmissionSha256)
  );
}

/**
 * Reads the one selected Host generation.
 *
 * The pointer is the release publisher's own selection artifact, so it is READ
 * here, never recomputed and never reconstructed from `generations/`: an
 * unreadable pointer with several generations on disk is refused as ambiguous
 * rather than guessed at. The two digests the pointer records are then checked
 * against the generation the pointer names — the same association checks the
 * publisher's own re-attestation performs — so that a pointer left over from
 * another build cannot silently bind this run to different bytes.
 */
async function readHostGenerationFromPointer({ hostRoot, outputRoot, fileSystem }) {
  const defaultOutputRoot = resolve(hostRoot, "dist");
  const configured = isNonEmptyString(outputRoot) ? resolve(outputRoot) : null;
  const selectedOutputRoot = configured ?? defaultOutputRoot;
  const pointerPath = resolve(selectedOutputRoot, POINTER_LEAF);
  const generationsRoot = resolve(selectedOutputRoot, GENERATIONS_DIRECTORY);
  const generationDirectories = await descendantDirectories(fileSystem, generationsRoot);

  let text;
  try {
    text = await fileSystem.readText(pointerPath);
  } catch (error) {
    if (!isMissing(error)) {
      throw blocked("stardew_live_run_host_generation_pointer_unreadable", { pointerPath });
    }
    // Refusing to pick among generations is the point: the pointer is the
    // publisher's selection, and "the only one there" is not a selection.
    if (generationDirectories.length > 1) {
      throw blocked("stardew_live_run_host_generation_ambiguous", {
        outputRoot: selectedOutputRoot,
        generationalDirectories: generationDirectories.length,
      });
    }
    throw blocked("stardew_live_run_host_generation_pointer_missing", {
      outputRoot: selectedOutputRoot,
      pointerPath,
      hint: `${HOST_PRODUCTION_ROOT_ENV} selects a locally built generation root`,
    });
  }

  let pointer;
  try {
    pointer = JSON.parse(text);
  } catch {
    throw blocked("stardew_live_run_host_generation_pointer_invalid", { pointerPath, reason: "not_json" });
  }
  if (!validPointer(pointer)) {
    throw blocked("stardew_live_run_host_generation_pointer_invalid", {
      pointerPath,
      reason: `expected schema ${HOST_GENERATION_POINTER_SCHEMA} with generation/inventoryDigest/runtimeAdmissionSha256`,
    });
  }

  const artifactRoot = resolve(selectedOutputRoot, GENERATIONS_DIRECTORY, pointer.generation);
  if ((await fileSystem.kind(artifactRoot)) !== "directory") {
    throw blocked("stardew_live_run_host_generation_unresolved", {
      generation: pointer.generation,
      artifactRoot,
      availableGenerations: generationDirectories.length,
    });
  }

  let inventoryText;
  try {
    inventoryText = await fileSystem.readText(resolve(artifactRoot, INVENTORY_LEAF));
  } catch {
    throw blocked("stardew_live_run_host_generation_unresolved", {
      generation: pointer.generation,
      artifactRoot,
      reason: `${INVENTORY_LEAF} unreadable`,
    });
  }
  let inventory;
  try {
    inventory = JSON.parse(inventoryText);
  } catch {
    throw blocked("stardew_live_run_host_generation_unresolved", {
      generation: pointer.generation,
      artifactRoot,
      reason: `${INVENTORY_LEAF} not_json`,
    });
  }
  if (inventory?.digest !== pointer.inventoryDigest) {
    throw blocked("stardew_live_run_host_generation_digest_mismatch", {
      generation: pointer.generation,
      pointerInventoryDigest: pointer.inventoryDigest,
      generationInventoryDigest: typeof inventory?.digest === "string" ? inventory.digest : null,
    });
  }

  let runtimeAdmissionSha256;
  try {
    runtimeAdmissionSha256 = await fileSystem.sha256(resolve(artifactRoot, RUNTIME_ADMISSION_LEAF));
  } catch {
    throw blocked("stardew_live_run_host_generation_unresolved", {
      generation: pointer.generation,
      artifactRoot,
      reason: `${RUNTIME_ADMISSION_LEAF} unreadable`,
    });
  }
  if (runtimeAdmissionSha256 !== pointer.runtimeAdmissionSha256) {
    throw blocked("stardew_live_run_host_generation_runtime_admission_mismatch", {
      generation: pointer.generation,
      pointerRuntimeAdmissionSha256: pointer.runtimeAdmissionSha256,
      generationRuntimeAdmissionSha256: runtimeAdmissionSha256,
    });
  }

  return Object.freeze({
    outputRootSource: configured === null ? "host/dist" : HOST_PRODUCTION_ROOT_ENV,
    outputRoot: selectedOutputRoot,
    pointerPath,
    generation: pointer.generation,
    inventoryDigest: pointer.inventoryDigest,
    runtimeAdmissionSha256,
    artifactRoot,
    inventoryEntryCount: Array.isArray(inventory.entries) ? inventory.entries.length : null,
    availableGenerations: generationDirectories.length,
    shadowedDefaultOutputRoot:
      configured !== null &&
      !sameDirectory(configured, defaultOutputRoot) &&
      (await fileSystem.kind(defaultOutputRoot)) === "directory"
        ? defaultOutputRoot
        : null,
  });
}

/**
 * Loads the Host authorities this resolver composes. The modules come from the
 * selected immutable generation — the same bytes the run's Host will load — and
 * each is integrity-checked against that generation's inventory, so no second
 * admission and no second discovery is introduced here.
 */
async function openHostAuthoritiesFromGeneration({ artifactRoot, resolveModule }) {
  const load = async (module) =>
    await import(
      pathToFileURL((await resolveModule({ selected: Object.freeze({ artifactRoot }), module })).modulePath).href
    );
  const [registration, admission, discovery, inspector, deploymentManifest] = await Promise.all([
    load(HOST_MODULES.registration),
    load(HOST_MODULES.admission),
    load(HOST_MODULES.discovery),
    load(HOST_MODULES.inspector),
    load(HOST_MODULES.deploymentManifest),
  ]);
  let inspectorCapability;
  return Object.freeze({
    readRegistration: (runtimeRoot) => registration.readStardewInstallationRegistration(runtimeRoot),
    publishRegistration: (runtimeRoot, expectedRevision, record) =>
      registration.publishStardewInstallationRegistration(runtimeRoot, expectedRevision, record),
    admitInstallation: async (locator) => {
      if (inspectorCapability === undefined) {
        inspectorCapability = await inspector.createPublishedWindowsReparseInspector(artifactRoot);
      }
      await admission.admitStardewInstallation(inspectorCapability, locator);
    },
    createDiscoveryProvider: () =>
      discovery.createStardewInstallationDiscoveryProvider({
        source: discovery.createWindowsSteamInstallationSource(),
      }),
    loadDeploymentManifest: (manifestPath) => deploymentManifest.loadHostDeploymentManifest(manifestPath),
  });
}

async function resolveRuntimeRoot({ environment }) {
  const configured = environment[RUNTIME_ROOT_ENV];
  if (isNonEmptyString(configured)) {
    if (!isAbsolute(configured)) {
      throw blocked("stardew_live_run_runtime_root_unresolved", { source: RUNTIME_ROOT_ENV, value: configured });
    }
    return fact(resolve(configured), "env");
  }
  const localAppData = environment.LOCALAPPDATA;
  if (!(isNonEmptyString(localAppData) && isAbsolute(localAppData))) {
    throw blocked("stardew_live_run_runtime_root_unresolved", {
      source: "product layout default",
      reason: "LOCALAPPDATA is absent and no override was given",
    });
  }
  return fact(resolve(localAppData, RUNTIME_ROOT_DIRECTORY_NAME), "default");
}

/**
 * The runtime root is where the registration, the pi contexts and the continuity
 * authority live, so a deployment manifest that names a different root means the
 * run and the product disagree about which install this is. Failing here is
 * cheaper than discovering it mid-run.
 */
async function readDeploymentManifest({ runtimeRoot, authorities, fileSystem }) {
  const manifestPath = resolve(runtimeRoot, DEPLOYMENT_MANIFEST_LEAF);
  if ((await fileSystem.kind(manifestPath)) !== "file") {
    return Object.freeze({ path: manifestPath, present: false });
  }
  let manifest;
  try {
    manifest = await authorities.loadDeploymentManifest(manifestPath);
  } catch (error) {
    throw blocked("stardew_live_run_deployment_manifest_invalid", {
      manifestPath,
      reason: reasonOf(error),
    });
  }
  if (!sameDirectory(manifest.runtimeRoot, runtimeRoot)) {
    throw blocked("stardew_live_run_runtime_root_manifest_mismatch", {
      runtimeRoot,
      manifestRuntimeRoot: manifest.runtimeRoot,
      manifestPath,
    });
  }
  return Object.freeze({
    path: manifestPath,
    present: true,
    runtimeRoot: manifest.runtimeRoot,
    topology: manifest.topology,
    continuityId: manifest.principal.continuityId,
    companionId: manifest.principal.companionId,
    playerId: manifest.principal.playerId,
    authorityGeneration: manifest.authorityGeneration,
  });
}

/** One confirmed discovery candidate, or the operator's explicit override. */
async function chooseInstallationCandidate({ provider, gameDirectory, diagnostics, candidates }) {
  if (isNonEmptyString(gameDirectory)) {
    const canonical = canonicalWindowsDirectory(gameDirectory);
    if (canonical === undefined) {
      throw blocked("stardew_live_run_game_directory_invalid", { gameDirectory });
    }
    // An explicit path still has to agree with discovery when discovery is
    // unambiguous: a run must not be able to name one installation while the
    // machine's own Steam metadata names another.
    if (candidates.length === 1) {
      const discovered = provider.confirm(candidates[0].candidateId);
      if (!sameWindowsPath(discovered, canonical)) {
        throw blocked("stardew_live_run_game_directory_conflicts_with_discovery", {
          gameDirectory: canonical,
          discoveredInstallation: discovered,
        });
      }
    }
    return Object.freeze({ locator: canonical, origin: "operator", candidateCount: candidates.length });
  }
  if (candidates.length === 0) {
    throw blocked("stardew_live_run_installation_candidates_none", {
      diagnostics: Object.freeze([...diagnostics]),
      hint: "name the installation explicitly with --game-dir; it still goes through the product's admission path",
    });
  }
  if (candidates.length > 1) {
    throw blocked("stardew_live_run_installation_candidates_ambiguous", {
      candidateCount: candidates.length,
      sources: Object.freeze(candidates.map((candidate) => candidate.source)),
      hint: "several Steam libraries publish this AppID; name the intended one with --game-dir",
    });
  }
  return Object.freeze({
    locator: provider.confirm(candidates[0].candidateId),
    origin: "discovery",
    candidateCount: candidates.length,
  });
}

/**
 * A ready registration is adopted as-is; the locator it records is re-admitted
 * through the product's admission path so that a stale pointer (a moved or
 * deleted install) fails here instead of mid-run.
 */
async function adoptRegisteredInstallation({ registration, authorities, gameDirectory }) {
  if (registration === null || registration.state !== "ready" || registration.locator === null) {
    if (registration?.activeAttempt != null) {
      throw blocked("stardew_live_run_registration_attempt_in_progress", {
        revision: registration.revision,
        bootstrapCorrelation: registration.activeAttempt.bootstrapCorrelation,
      });
    }
    return null;
  }
  const locator = registration.locator;
  if (isNonEmptyString(gameDirectory)) {
    const canonical = canonicalWindowsDirectory(gameDirectory);
    if (canonical === undefined) {
      throw blocked("stardew_live_run_game_directory_invalid", { gameDirectory });
    }
    if (!sameWindowsPath(canonical, locator)) {
      throw blocked("stardew_live_run_game_directory_conflicts_with_registration", {
        gameDirectory: canonical,
        registeredInstallation: locator,
        hint: "replacing the registered installation is the product's own authenticated setup operation, not this tool's",
      });
    }
  }
  try {
    await authorities.admitInstallation(locator);
  } catch (error) {
    throw blocked("stardew_live_run_registered_installation_not_admissible", {
      registeredInstallation: locator,
      revision: registration.revision,
      reason: reasonOf(error),
    });
  }
  return Object.freeze({
    locator,
    origin: "registration",
    provenance: "read",
    registrationRevision: registration.revision,
    registrationActiveAttempt: registration.activeAttempt?.bootstrapCorrelation ?? null,
  });
}

async function deriveAndRegisterInstallation({ registration, authorities, runtimeRoot, gameDirectory }) {
  const provider = authorities.createDiscoveryProvider();
  const discovered = await provider.discover();
  const candidates = Array.isArray(discovered.candidates) ? discovered.candidates : [];
  const chosen = await chooseInstallationCandidate({
    provider,
    gameDirectory,
    diagnostics: Array.isArray(discovered.diagnostics) ? discovered.diagnostics : [],
    candidates,
  });
  const locator = canonicalWindowsDirectory(chosen.locator);
  if (locator === undefined) {
    throw blocked("stardew_live_run_discovered_installation_invalid", { locator: chosen.locator });
  }
  try {
    await authorities.admitInstallation(locator);
  } catch (error) {
    throw blocked("stardew_live_run_installation_not_admitted", {
      locator,
      origin: chosen.origin,
      reason: reasonOf(error),
    });
  }
  const expectedRevision = registration?.revision ?? null;
  const revision = expectedRevision === null ? 1 : expectedRevision + 1;
  let published;
  try {
    published = await authorities.publishRegistration(runtimeRoot, expectedRevision, {
      schema: INSTALLATION_REGISTRATION_SCHEMA,
      binding: { rootLayoutVersion: 1 },
      revision,
      state: "ready",
      locator,
      activeAttempt: null,
    });
  } catch (error) {
    throw blocked("stardew_live_run_registration_publish_failed", {
      runtimeRoot,
      expectedRevision,
      reason: reasonOf(error),
    });
  }
  return Object.freeze({
    locator: published.locator,
    origin: chosen.origin,
    provenance: chosen.origin === "operator" ? "operator" : "derived",
    candidateCount: chosen.candidateCount,
    registrationRevision: published.revision,
    registrationActiveAttempt: null,
    previousRegistrationState: registration === null ? "absent" : registration.state,
  });
}

async function readInstallation({ registration, authorities, runtimeRoot, gameDirectory }) {
  const adopted = await adoptRegisteredInstallation({ registration, authorities, gameDirectory });
  if (adopted !== null) return adopted;
  return await deriveAndRegisterInstallation({ registration, authorities, runtimeRoot, gameDirectory });
}

/** The run-scoped environment a live run needs, all of it derived from the facts above. */
function buildEnvironment({
  installation,
  runtimeRoot,
  fixtureRoots,
  environment,
  ladder,
  modsDirectoryPresent,
  modDirectoryPresent,
  modConfigPresent,
}) {
  const modsDir = win32.join(installation.locator, "Mods");
  const values = [
    Object.freeze({ name: GAME_DIR_ENV, value: installation.locator, provenance: installation.provenance }),
    Object.freeze({ name: MODS_DIR_ENV, value: modsDir, provenance: "derived" }),
    Object.freeze({
      name: MOD_CONFIG_ENV,
      value: win32.join(modsDir, MOD_DIRECTORY_NAME, MOD_CONFIG_LEAF),
      provenance: "derived",
    }),
    Object.freeze({ name: RUNTIME_ROOT_ENV, value: runtimeRoot.value, provenance: runtimeRoot.provenance }),
    Object.freeze({
      name: "GAMEBUDDY_STARDEW_PROFILE_ROOT",
      value: fixtureRoots.profileRoot,
      provenance: fixtureRoots.profileRootOverridden ? "env" : "default",
    }),
    Object.freeze({
      name: "GAMEBUDDY_STARDEW_FIXTURE_ROOT",
      value: fixtureRoots.fixturesRoot,
      provenance: fixtureRoots.fixturesRootOverridden ? "env" : "default",
    }),
  ];
  if (isNonEmptyString(ladder)) {
    values.push(
      Object.freeze({
        name: AGENT_LADDER_ENV,
        value: ladder,
        provenance: isNonEmptyString(environment[AGENT_LADDER_ENV]) ? "env" : "operator",
      }),
    );
  }

  // A pre-set value that disagrees with the derived one is exactly the failure
  // class this tool exists to remove, so it is refused rather than overridden.
  const conflicts = [];
  for (const entry of values) {
    const existing = environment[entry.name];
    if (!isNonEmptyString(existing)) continue;
    const agrees =
      entry.name === GAME_DIR_ENV || entry.name === MODS_DIR_ENV || entry.name === MOD_CONFIG_ENV
        ? sameWindowsPath(existing, entry.value)
        : resolve(existing).toLowerCase() === resolve(entry.value).toLowerCase();
    if (!agrees) conflicts.push({ name: entry.name, configured: existing, derived: entry.value });
  }
  if (conflicts.length > 0) {
    throw blocked("stardew_live_run_environment_conflict", { conflicts: Object.freeze(conflicts) });
  }

  return Object.freeze({
    values: Object.freeze(values),
    modsDir,
    modsDirectoryPresent,
    modDirectoryPresent,
    modConfigPresent,
  });
}

async function readCredentialReferences(environment) {
  return Object.freeze(
    CREDENTIAL_REFERENCES.map((reference) =>
      Object.freeze({
        name: reference.name,
        required: reference.required,
        carriedBy: reference.carriedBy,
        present: isNonEmptyString(environment[reference.name]),
        valueDisclosure: "never_read",
      }),
    ),
  );
}

async function readFixtureRootFacts({ fixtureRoots, fileSystem }) {
  const directoryKinds = await Promise.all(
    [fixtureRoots.profileRoot, fixtureRoots.fixturesRoot].map(async (path) => await fileSystem.kind(path)),
  );
  const profiles = await Promise.all(
    LANE_PROFILE_NAMES.map(async (name) =>
      Object.freeze({
        name,
        path: resolve(fixtureRoots.profilesDir, name),
        present: (await fileSystem.kind(resolve(fixtureRoots.profilesDir, name))) === "directory",
      }),
    ),
  );
  return Object.freeze({
    resolution: fixtureRoots,
    profileRootPresent: directoryKinds[0] === "directory",
    fixturesRootPresent: directoryKinds[1] === "directory",
    profilesDirectoryPresent: (await fileSystem.kind(fixtureRoots.profilesDir)) === "directory",
    profiles: Object.freeze(profiles),
  });
}

/**
 * Resolve the whole environment. Throws one `blocked` error (a specific code,
 * with detail) instead of returning a partial environment.
 */
export async function resolveStardewLiveRunEnvironment(options = {}) {
  const overrides = options.overrides ?? {};
  const environment = options.env ?? process.env;
  const repositoryRoot = resolve(
    options.repositoryRoot ?? resolve(fileURLToPath(new URL("../../..", import.meta.url))),
  );
  const hostRoot = resolve(options.hostRoot ?? resolve(repositoryRoot, "host"));
  const platform = overrides.platform ?? process.platform;
  const fileSystem = overrides.fileSystem ?? nodeFileSystem;
  const resolveFixtureRoots = overrides.resolveFixtureRoots ?? resolveStardewFixtureRoots;
  const readHostGeneration = overrides.readHostGeneration ?? readHostGenerationFromPointer;
  const openHostAuthorities = overrides.openHostAuthorities ?? openHostAuthoritiesFromGeneration;
  const resolveModule = overrides.resolveModule ?? resolveProductionModule;
  const now = overrides.now ?? (() => new Date().toISOString());
  const gameDirectory = options.gameDirectory ?? null;
  const ladder = options.ladder ?? null;

  if (platform !== "win32") {
    throw blocked("stardew_live_run_environment_requires_windows", { platform });
  }

  const runtimeRoot = await resolveRuntimeRoot({ environment });
  if ((await fileSystem.kind(runtimeRoot.value)) !== "directory") {
    throw blocked("stardew_live_run_runtime_root_missing", {
      runtimeRoot: runtimeRoot.value,
      source: runtimeRoot.provenance,
    });
  }

  const hostGeneration = await readHostGeneration({
    hostRoot,
    outputRoot: options.hostGenerationOutputRoot ?? environment[HOST_PRODUCTION_ROOT_ENV],
    fileSystem,
  });
  const authorities = await openHostAuthorities({ artifactRoot: hostGeneration.artifactRoot, resolveModule });

  const deploymentManifest = await readDeploymentManifest({
    runtimeRoot: runtimeRoot.value,
    authorities,
    fileSystem,
  });

  let registration;
  try {
    registration = await authorities.readRegistration(runtimeRoot.value);
  } catch (error) {
    throw blocked("stardew_live_run_registration_unreadable", {
      runtimeRoot: runtimeRoot.value,
      registrationPath: resolve(runtimeRoot.value, REGISTRATION_DIRECTORY, REGISTRATION_LEAF),
      reason: reasonOf(error),
    });
  }

  const installation = await readInstallation({
    registration,
    authorities,
    runtimeRoot: runtimeRoot.value,
    gameDirectory,
  });

  const resolution = resolveFixtureRoots({ env: environment });
  const fixtureRoots = await readFixtureRootFacts({ fixtureRoots: resolution, fileSystem });
  const modsDir = win32.join(installation.locator, "Mods");
  const modDirectory = win32.join(modsDir, MOD_DIRECTORY_NAME);
  const runEnvironment = buildEnvironment({
    installation,
    runtimeRoot,
    fixtureRoots: resolution,
    environment,
    ladder,
    modsDirectoryPresent: (await fileSystem.kind(modsDir)) === "directory",
    modDirectoryPresent: (await fileSystem.kind(modDirectory)) === "directory",
    modConfigPresent: (await fileSystem.kind(win32.join(modDirectory, MOD_CONFIG_LEAF))) === "file",
  });

  const readFacts = [
    "runtimeRoot.value",
    "hostGeneration.generation",
    "hostGeneration.inventoryDigest",
    "hostGeneration.runtimeAdmissionSha256",
  ];
  const derivedFacts = [];
  if (installation.provenance === "read") {
    readFacts.push("installation.locator", "installation.registrationRevision");
  } else {
    derivedFacts.push("installation.locator", "installation.registrationRevision");
  }

  // The Host's own artifact selection re-attests the whole generation, and a
  // generation built on this machine fails that re-attestation (measured
  // 2026-10-05: `production_inventory_mismatch_or_orphan`). The resolver reads
  // the pointer, so it resolves either way; the run itself does not. Saying so
  // here is cheaper than a run that dies in Host construction.
  const warnings = [];
  if (hostGeneration.outputRootSource === "host/dist") {
    warnings.push(
      `${HOST_PRODUCTION_ROOT_ENV} is unset, so a live run selects the generation through the Host's full re-attestation; a generation built locally fails it and the run must set ${HOST_PRODUCTION_ROOT_ENV} to its own root`,
    );
  }
  if (!runEnvironment.modDirectoryPresent) {
    warnings.push(
      `no ${MOD_DIRECTORY_NAME} directory under ${runEnvironment.modsDir}: the run's fixture transaction is what deploys the Release Mod bundle and writes its config`,
    );
  }

  return Object.freeze({
    schema: LIVE_RUN_ENVIRONMENT_SCHEMA,
    state: "resolved",
    resolvedAt: now(),
    runtimeRoot,
    deploymentManifest,
    hostGeneration,
    installation: Object.freeze({ ...installation, admitted: true }),
    fixtureRoots,
    environment: runEnvironment,
    credentialReferences: await readCredentialReferences(environment),
    readFacts: Object.freeze(readFacts),
    derivedFacts: Object.freeze(derivedFacts),
    warnings: Object.freeze(warnings),
    notes: Object.freeze([
      "The Host generation is the pointer the release publisher wrote; its digests were checked against the generation it names, never recomputed into a new selection.",
      "A live run's own result/log file names stay run-owned; this resolver does not derive them.",
      registration?.activeAttempt == null
        ? "No bootstrap attempt is recorded on the registration pointer."
        : "The registration pointer still records a bootstrap attempt; a product session may believe an attempt is live.",
    ]),
  });
}

/** The one stable operator line: what was READ versus what this run DERIVED. */
export function formatStardewLiveRunEnvironmentSummary(facts) {
  const lines = [
    `[stardew-live-run-environment] runtimeRoot=${facts.runtimeRoot.value} (${facts.runtimeRoot.provenance})`,
    `[stardew-live-run-environment] hostGeneration=${facts.hostGeneration.generation} inventoryDigest=${facts.hostGeneration.inventoryDigest} runtimeAdmissionSha256=${facts.hostGeneration.runtimeAdmissionSha256} (read from ${facts.hostGeneration.pointerPath})`,
    `[stardew-live-run-environment] installation=${facts.installation.locator} (${facts.installation.provenance}: ${facts.installation.origin})`,
    `[stardew-live-run-environment] profileRoot=${facts.fixtureRoots.resolution.profileRoot} fixturesRoot=${facts.fixtureRoots.resolution.fixturesRoot}`,
  ];
  for (const entry of facts.environment.values) {
    lines.push(`[stardew-live-run-environment] ${entry.name}=${entry.value} (${entry.provenance})`);
  }
  const missingCredentials = facts.credentialReferences.filter((reference) => reference.required && !reference.present);
  lines.push(
    `[stardew-live-run-environment] read={${facts.readFacts.join(",")}} derived={${facts.derivedFacts.join(",")}}`,
  );
  if (missingCredentials.length > 0) {
    lines.push(
      `[stardew-live-run-environment] missing required credential reference(s): ${missingCredentials.map((reference) => reference.name).join(",")}`,
    );
  }
  for (const warning of facts.warnings) {
    lines.push(`[stardew-live-run-environment] WARNING ${warning}`);
  }
  return lines.join("\n");
}

/** `KEY=VALUE` lines for the derived run environment. Never a credential. */
export function formatStardewLiveRunEnvironmentAssignmentLines(facts) {
  return facts.environment.values.map((entry) => `${entry.name}=${entry.value}`).join("\n");
}

export function parseArguments(argv) {
  const args = [...argv];
  const option = (name, fallback = null) => {
    const index = args.indexOf(`--${name}`);
    return index >= 0 && args[index + 1] !== undefined ? args[index + 1] : fallback;
  };
  return Object.freeze({
    printEnvironment: args.includes("--print-env"),
    runtimeRoot: option("runtime-root"),
    hostGenerationOutputRoot: option("host-production-root"),
    gameDirectory: option("game-dir"),
    ladder: option("ladder"),
  });
}

async function main(argv) {
  const parsed = parseArguments(argv);
  const environment = { ...process.env };
  if (isNonEmptyString(parsed.runtimeRoot)) environment[RUNTIME_ROOT_ENV] = parsed.runtimeRoot;
  const facts = await resolveStardewLiveRunEnvironment({
    env: environment,
    hostGenerationOutputRoot: parsed.hostGenerationOutputRoot,
    gameDirectory: parsed.gameDirectory,
    ladder: parsed.ladder,
  });
  process.stderr.write(`${formatStardewLiveRunEnvironmentSummary(facts)}\n`);
  if (parsed.printEnvironment) {
    process.stdout.write(`${formatStardewLiveRunEnvironmentAssignmentLines(facts)}\n`);
    return;
  }
  process.stdout.write(`${JSON.stringify(facts, null, 2)}\n`);
}

const invokedPath = process.argv[1] === undefined ? "" : resolve(process.argv[1]);
if (invokedPath === fileURLToPath(import.meta.url)) {
  try {
    await main(process.argv.slice(2));
  } catch (error) {
    const code =
      error instanceof Error && typeof error.code === "string" ? error.code : "stardew_live_run_environment_failed";
    const reason = reasonOf(error);
    const detail = error?.detail ?? null;
    const detailText = detail === null ? "" : ` detail=${JSON.stringify(detail)}`;
    process.stderr.write(
      `[stardew-live-run-environment] BLOCKED ${code}${reason === code ? "" : `: ${reason}`}${detailText}\n`,
    );
    process.stdout.write(
      `${JSON.stringify({ schema: LIVE_RUN_ENVIRONMENT_SCHEMA, state: "blocked", code, detail }, null, 2)}\n`,
    );
    process.exitCode = 1;
  }
}
