/**
 * Assembles the artifact a player downloads, and binds it to the generation it installs.
 *
 * The release lane used to stop after verifying the Host generation. Everything downstream of that - the
 * launcher publish, the payload seal, the signed installer, and a manifest naming what the player actually
 * receives - happened only by hand, and part of it not at all: `build:desktop-setup` publishes the installer
 * in Debug, which is the configuration that carries no signature.
 *
 * This script is the missing link, and it is deliberately one command rather than four steps a caller could
 * run in the wrong order:
 *
 *   1. the generation must already be built and published (`host/dist`), and its `current.json` is what the
 *      manifest binds to;
 *   2. the launcher is published self-contained, because the installer is the first thing a player runs on a
 *      machine with no .NET;
 *   3. the payload is sealed by `package-player-distribution.mjs`, which is the existing completeness and
 *      leak authority - this script does not re-walk that closure;
 *   4. `GameBuddy.Setup` is published in Release, which is the configuration whose own MSBuild target refuses
 *      to produce an unsigned artifact (`GBSIGN001`-`GBSIGN004`). The signing identity is passed in, never
 *      inferred;
 *   5. a manifest is written that names the installer's bytes, the generation, the payload digest and the
 *      signer, so the download entry and any later updater can bind to one artifact instead of a filename.
 *
 * Failures carry one bounded code each (`release_installer_failed:<reason>`), because a release that half
 * succeeded must be named precisely enough to fix without re-reading the logs of five steps.
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { packageGenerationForDistribution } from "./package-player-distribution.mjs";
import { reportPackagingCompleteness } from "./verify-self-contained-generation.mjs";
import { checkVendoredBundleLeaks } from "../../tools/check-vendored-bundle-leaks.mjs";

const scriptPath = fileURLToPath(import.meta.url);
const hostRoot = resolve(dirname(scriptPath), "..");
const repositoryRoot = resolve(hostRoot, "..");

const MANIFEST_SCHEMA = "gamebuddy-player-release-manifest/v1";
const INSTALLER_FILE = "GameBuddy.Setup.exe";

function fail(reason) {
  throw new Error(`release_installer_failed:${reason}`);
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    stdio: options.capture === true ? "pipe" : "inherit",
    cwd: options.cwd ?? repositoryRoot,
    env: options.env ?? process.env,
    windowsHide: true,
  });
  if (result.error) fail(`${options.label ?? command}_spawn_failed:${result.error.message}`);
  if (result.status !== 0) {
    const detail = options.capture === true ? `\n${(result.stdout ?? "") + (result.stderr ?? "")}` : "";
    fail(`${options.label ?? command}_exit_${result.status}${detail}`);
  }
  return result;
}

async function sha256(path) {
  const bytes = await readFile(path);
  return createHash("sha256").update(bytes).digest("hex");
}

async function sizeOf(path) {
  try {
    return (await stat(path)).size;
  } catch {
    fail(`artifact_missing:${path}`);
  }
}

/**
 * The generation a release is bound to: whatever `current.json` names, read from the tree that was built.
 *
 * Read here rather than passed in, because the manifest's whole value is that the generation it names is the
 * one inside the installer - and a caller-supplied id could disagree with the payload it sealed.
 */
async function readPublishedGeneration(generationOutputRoot) {
  const pointerPath = join(generationOutputRoot, "current.json");
  let pointer;
  try {
    pointer = JSON.parse(await readFile(pointerPath, "utf8"));
  } catch {
    fail("current_pointer_unreadable");
  }
  for (const field of ["generation", "inventoryDigest", "runtimeAdmissionSha256"]) {
    if (typeof pointer?.[field] !== "string" || pointer[field].length === 0) {
      fail(`current_pointer_field_missing:${field}`);
    }
  }
  return Object.freeze({
    generation: pointer.generation,
    inventoryDigest: pointer.inventoryDigest,
    runtimeAdmissionSha256: pointer.runtimeAdmissionSha256,
  });
}

/** Release metadata every published artifact has to carry, and which nothing may invent. */
export function releaseIdentity({ version, repository, tagUrlPattern = undefined }) {
  // A tag is `v0.1.0` and a version is `0.1.0`; accepting both keeps the workflow from stripping a prefix in YAML,
  // where a typo would name the release `vv0.1.0`.
  const normalized = typeof version === "string" ? version.replace(/^v(?=\d)/u, "") : version;
  if (typeof normalized !== "string" || !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/u.test(normalized)) {
    fail(`version_invalid:${String(version)}`);
  }
  if (typeof repository !== "string" || !/^[\w.-]+\/[\w.-]+$/u.test(repository)) {
    fail(`repository_invalid:${repository}`);
  }
  return Object.freeze({
    version: normalized,
    repository,
    downloadUrl: `https://github.com/${repository}/releases/download/v${normalized}/${INSTALLER_FILE}`,
    ...(tagUrlPattern === undefined ? {} : { downloadUrlPattern: tagUrlPattern }),
  });
}

/**
 * Reports what a release would be assembled from, and refuses if any of it is unusable.
 *
 * This is the half of the chain that can run without a certificate and without the protected environment: the pointer is
 * readable, the generation carries every piece the packaging step requires, and no shipped bundle names the build
 * machine. It writes nothing and spawns nothing.
 */
export async function dryRunPlayerRelease({
  generationOutputRoot,
  version,
  repository,
  vendorRoot = join(repositoryRoot, "vendor"),
} = {}) {
  if (typeof generationOutputRoot !== "string" || generationOutputRoot.length === 0) {
    fail("generation_output_root_required");
  }
  const identity = releaseIdentity({ version, repository });
  const resolvedGenerationRoot = resolve(generationOutputRoot);
  const published = await readPublishedGeneration(resolvedGenerationRoot);
  const generationRoot = join(resolvedGenerationRoot, "generations", published.generation);

  const packaging = await reportPackagingCompleteness({ outputRoot: resolvedGenerationRoot, generationRoot });
  // The launcher is staged by the packaging step itself, so a generation cannot carry it yet. Everything else reported
  // `absent` means the generation really is unusable as a release source.
  const incomplete = Object.entries(packaging)
    .filter(([piece, value]) => value === "absent" && piece !== "desktopBundle")
    .map(([piece]) => piece);

  const leaks = await checkVendoredBundleLeaks({ vendorRoot });

  return Object.freeze({
    version: identity.version,
    downloadUrl: identity.downloadUrl,
    generation: published.generation,
    packaging: Object.freeze(packaging),
    incomplete: Object.freeze(incomplete),
    leaks: Object.freeze({
      examined: leaks.examined,
      roots: leaks.roots.length,
      blocking: Object.freeze(leaks.blocking.map((finding) => ({
        file: finding.file,
        line: finding.line,
        value: finding.value,
      }))),
    }),
  });
}

/**
 * Assembles the player release.
 *
 * `signingThumbprint` is required in protected mode and is never defaulted: a signature identifies the
 * publisher, so a value nobody chose cannot stand in for one.
 */
export async function buildPlayerRelease({
  generationOutputRoot,
  outputDirectory,
  version,
  repository,
  signingThumbprint = undefined,
  timestampUrl = undefined,
  protectedRelease = true,
  launcherBundleRoot = join(repositoryRoot, "desktop", "dist", "launcher"),
  payloadPath = undefined,
  spawn = run,
} = {}) {
  if (typeof generationOutputRoot !== "string" || generationOutputRoot.length === 0) {
    fail("generation_output_root_required");
  }
  if (typeof outputDirectory !== "string" || outputDirectory.length === 0) fail("output_directory_required");
  const identity = releaseIdentity({ version, repository });
  const resolvedOutput = resolve(outputDirectory);
  const resolvedGenerationRoot = resolve(generationOutputRoot);

  const published = await readPublishedGeneration(resolvedGenerationRoot);

  // Cheap facts first, expensive work after. A protected release that cannot be signed must not spend minutes
  // publishing a launcher and sealing a payload, and the MSBuild target's own refusal (`GBSIGN001`) arrives one step
  // later inside SDK output - the release lane needs the reason before the work, in one line.
  if (protectedRelease && (signingThumbprint === undefined || signingThumbprint.length === 0)) {
    fail("signing_identity_required");
  }

  await mkdir(resolvedOutput, { recursive: true });

  // 1. Launcher: self-contained, because the machine that runs the installer has no .NET.
  spawn("dotnet", [
    "publish",
    join(repositoryRoot, "desktop", "GameBuddy.Desktop", "GameBuddy.Desktop.csproj"),
    "-c",
    "Release",
    "-o",
    resolve(launcherBundleRoot),
  ], { label: "launcher_publish" });

  // 2. Payload: the existing completeness + leak authority seals it.
  const resolvedPayload = resolve(payloadPath ?? join(resolvedOutput, "payload.zip"));
  await packageGenerationForDistribution({
    generationOutputRoot: resolvedGenerationRoot,
    artifactPath: resolvedPayload,
    launcherBundleRoot,
  });

  // 3. Installer: Release, which is the configuration whose own target refuses to publish unsigned.
  const signingProps =
    signingThumbprint === undefined || signingThumbprint.length === 0
      ? []
      : [
          `-p:GameBuddySigningCertificateThumbprint=${signingThumbprint}`,
          ...(timestampUrl === undefined ? [] : [`-p:GameBuddyTimestampUrl=${timestampUrl}`]),
        ];
  // Release refuses to exist unsigned, so the configuration IS the claim: a Release artifact is signed or absent,
  // and a Debug artifact is one this manifest says nobody may publish.
  const configuration = protectedRelease ? "Release" : "Debug";
  spawn("dotnet", [
    "publish",
    join(repositoryRoot, "desktop", "installer", "GameBuddy.Setup", "GameBuddy.Setup.csproj"),
    "-c",
    configuration,
    "-o",
    resolvedOutput,
    `-p:GameBuddyPlayerDistributionPayload=${resolvedPayload}`,
    "-p:Version=" + identity.version,
    ...signingProps,
  ], { label: "setup_publish" });

  // 4. The artifact that is actually downloaded, described by its own bytes.
  const installerPath = join(resolvedOutput, INSTALLER_FILE);
  const installer = Object.freeze({
    file: INSTALLER_FILE,
    bytes: await sizeOf(installerPath),
    sha256: await sha256(installerPath),
  });
  if (installer.bytes < (await sizeOf(resolvedPayload))) {
    // A single-file installer embeds the payload, so it cannot be smaller than it. This is a cheap structural
    // check that the Release build really carried the archive instead of producing a bare host.
    fail("installer_smaller_than_payload");
  }

  const manifest = Object.freeze({
    schema: MANIFEST_SCHEMA,
    version: identity.version,
    repository: identity.repository,
    downloadUrl: identity.downloadUrl,
    generation: published.generation,
    inventoryDigest: published.inventoryDigest,
    runtimeAdmissionSha256: published.runtimeAdmissionSha256,
    payload: Object.freeze({ sha256: await sha256(resolvedPayload), bytes: await sizeOf(resolvedPayload) }),
    configuration,
    installer,
    signature: Object.freeze({
      required: protectedRelease,
      scheme: "authenticode+timestamp/v1",
      thumbprint: signingThumbprint ?? null,
    }),
  });
  const manifestPath = join(resolvedOutput, "release-manifest.json");
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  return Object.freeze({ manifest, manifestPath, installerPath, payloadPath: resolvedPayload });
}

function parseArguments(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const name = argv[index];
    const value = argv[index + 1];
    if (!name.startsWith("--")) fail(`argument_invalid:${name}`);
    switch (name) {
      case "--generation-output":
        options.generationOutputRoot = value;
        index += 1;
        break;
      case "--out":
        options.outputDirectory = value;
        index += 1;
        break;
      case "--version":
        options.version = value;
        index += 1;
        break;
      case "--repository":
        options.repository = value;
        index += 1;
        break;
      case "--signing-thumbprint":
        options.signingThumbprint = value;
        index += 1;
        break;
      case "--timestamp-url":
        options.timestampUrl = value;
        index += 1;
        break;
      case "--dry-run":
        options.dryRun = true;
        break;
      case "--unsigned":
        // Only for a build nobody publishes: a developer check, or a clean-machine run of the installer.
        options.protectedRelease = false;
        break;
      default:
        fail(`argument_unknown:${name}`);
    }
  }
  return options;
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === scriptPath) {
  try {
    const options = parseArguments(process.argv.slice(2));
    if (options.dryRun === true) {
      // Reports and refuses, writes nothing: the half of the chain that needs neither a certificate nor the protected
      // environment.
      const plan = await dryRunPlayerRelease({
        generationOutputRoot: options.generationOutputRoot ?? join(hostRoot, "dist"),
        version: options.version ?? process.env.GAMEBUDDY_RELEASE_VERSION,
        repository: options.repository ?? process.env.GAMEBUDDY_RELEASE_REPOSITORY ?? "zhexulong/gamebuddy",
      });
      const lines = [
        `dry_run:version=${plan.version}`,
        `dry_run:downloadUrl=${plan.downloadUrl}`,
        `dry_run:generation=${plan.generation}`,
        ...Object.entries(plan.packaging).map(([piece, value]) => `dry_run:packaging:${piece}=${value}`),
        `dry_run:leaks:examined=${plan.leaks.examined} roots=${plan.leaks.roots} blocking=${plan.leaks.blocking.length}`,
        ...plan.leaks.blocking.map(
          (finding) => `dry_run:leak:${relative(repositoryRoot, finding.file).replaceAll("\\", "/")}:${finding.line}`,
        ),
      ];
      process.stdout.write(`${lines.join("\n")}\n`);
      if (plan.incomplete.length > 0) fail(`dry_run_incomplete:${plan.incomplete.join(",")}`);
      if (plan.leaks.blocking.length > 0) fail(`dry_run_leaks:${plan.leaks.blocking.length}`);
      process.stdout.write("dry_run_ok\n");
      process.exit(0);
    }

    const result = await buildPlayerRelease({
      generationOutputRoot: options.generationOutputRoot ?? join(hostRoot, "dist"),
      outputDirectory: options.outputDirectory ?? join(repositoryRoot, "desktop", "dist", "release"),
      version: options.version ?? process.env.GAMEBUDDY_RELEASE_VERSION,
      repository: options.repository ?? process.env.GAMEBUDDY_RELEASE_REPOSITORY ?? "zhexulong/gamebuddy",
      signingThumbprint: options.signingThumbprint ?? process.env.GAMEBUDDY_SIGNING_THUMBPRINT,
      timestampUrl: options.timestampUrl ?? process.env.GAMEBUDDY_TIMESTAMP_URL,
      protectedRelease: options.protectedRelease ?? true,
    });
    process.stdout.write(
      `release_installer_ready:${result.manifestPath} installer=${result.manifest.installer.sha256} generation=${result.manifest.generation}\n`,
    );
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exit(1);
  }
}
