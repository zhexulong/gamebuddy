import { spawnSync } from "node:child_process";
import { cp, lstat, mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  parseCurrentPointer,
  reportPackagingCompleteness,
  scanGenerationEnvironmentCoupling,
  staticGateVerdict,
} from "./verify-self-contained-generation.mjs";

/**
 * Turns one published Host generation into the payload a player can be handed.
 *
 * What a generation already carries (measured by `verify-self-contained-generation.mjs`):
 * the bundled runtime, the Host/browser/native build and the verified Stardew Mod
 * package under `native/stardew-mod/GameBuddy`. What it does NOT carry, and what this
 * step therefore adds, is the launcher entry the player double-clicks
 * (`GameBuddy.Desktop.exe`, a separate .NET build artifact) laid beside `current.json`
 * at the payload root - the exact shape `GameBuddy.Setup` embeds as `payload.zip` and
 * extracts into `%LOCALAPPDATA%\Programs\GameBuddy` (`desktop/installer/GameBuddy.Setup`).
 *
 * The static leak gate is the EXISTING one: this script imports the scanner from
 * `verify-self-contained-generation.mjs` and refuses to seal an archive whose blocking
 * categories (repository_path / machine_profile_path / launch_surface_interpreter) hit.
 * It never re-walks the closure itself.
 *
 * The archive is produced by the same mechanism the installer uses
 * (`tar -a -c -f payload.zip -C <payload root> .`), so this step introduces no archive
 * library and no new dependency.
 */

const scriptPath = fileURLToPath(import.meta.url);
const hostRoot = resolve(dirname(scriptPath), "..");
const repositoryRoot = resolve(hostRoot, "..");
const DEFAULT_LAUNCHER_BUNDLE = resolve(repositoryRoot, "desktop", "GameBuddy.Desktop", "bin", "Release", "net8.0-windows");
const LAUNCHER_ENTRY = "GameBuddy.Desktop.exe";
const PACKAGE_SCHEMA = "gamebuddy-player-distribution-package/v1";
// Debug symbols are not part of a shipped payload, and a `.pdb` can carry source paths
// the text scanner deliberately does not read (it is a binary extension).
const EXCLUDED_LAUNCHER_EXTENSION = ".pdb";

function fail(reason) {
  throw new Error(`player_distribution_package_failed:${reason}`);
}

const slash = (value) => value.replaceAll("\\", "/");

async function regularFile(path) {
  try {
    const state = await lstat(path);
    return state.isFile() && !state.isSymbolicLink();
  } catch {
    return false;
  }
}

/** Every regular file under `root`, as POSIX-relative paths, ascending. */
async function filesUnder(root, prefix = "") {
  const names = await readdir(resolve(root, prefix), { withFileTypes: true });
  const files = [];
  for (const entry of names) {
    const item = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) files.push(...await filesUnder(root, item));
    else if (entry.isFile()) files.push(item);
    else fail(`nonregular_entry:${item}`);
  }
  return files.sort();
}

/** The launcher bundle is a plain build output directory; its entry must be present. */
export async function readLauncherBundle(root) {
  if (typeof root !== "string" || root.length === 0) fail("launcher_bundle_required");
  const resolved = resolve(root);
  let state;
  try {
    state = await lstat(resolved);
  } catch {
    fail("launcher_bundle_missing");
  }
  if (state.isSymbolicLink() || !state.isDirectory()) fail("launcher_bundle_missing");
  if (!(await regularFile(join(resolved, LAUNCHER_ENTRY)))) fail(`missing_launcher_entry:${LAUNCHER_ENTRY}`);
  const files = await filesUnder(resolved);
  return Object.freeze({
    root: resolved,
    entry: LAUNCHER_ENTRY,
    files: Object.freeze(files.filter((file) => !file.toLowerCase().endsWith(EXCLUDED_LAUNCHER_EXTENSION))),
  });
}

/** Lays the generation output root and the launcher bundle into one payload root. */
async function stagePayload({ generationOutputRoot, launcherBundle, stageRoot }) {
  await rm(stageRoot, { recursive: true, force: true });
  await mkdir(stageRoot, { recursive: true });
  for (const name of await readdir(generationOutputRoot)) {
    await cp(resolve(generationOutputRoot, name), resolve(stageRoot, name), { recursive: true });
  }
  for (const file of launcherBundle.files) {
    const destination = resolve(stageRoot, file.replaceAll("/", sep));
    await mkdir(dirname(destination), { recursive: true });
    await cp(resolve(launcherBundle.root, file.replaceAll("/", sep)), destination);
  }
  return stageRoot;
}

/**
 * The one archive step. `tar -a` selects the archive format from the `.zip`
 * extension and is the exact command the installer's own build uses to produce
 * its embedded `payload.zip`, so a payload this script seals is one the installer
 * already knows how to open.
 */
export function archiveInvocation({ archivePath, payloadRoot, platform = process.platform, environment = process.env }) {
  if (typeof archivePath !== "string" || !archivePath.toLowerCase().endsWith(".zip")) fail("archive_must_be_zip");
  if (platform !== "win32") fail("package_unsupported_platform");
  const tar = join(environment.SystemRoot ?? `C:${sep}Windows`, "System32", "tar.exe");
  return Object.freeze({
    command: tar,
    args: Object.freeze(["-a", "-c", "-f", resolve(archivePath), "-C", resolve(payloadRoot), "."]),
  });
}

/**
 * Packages one published generation for a player.
 *
 * `generationOutputRoot` is the publisher's output root (`current.json` plus
 * `generations/<generation>/`), i.e. exactly what `host/dist` is after a build.
 */
export async function packageGenerationForDistribution({
  generationOutputRoot,
  artifactPath,
  launcherBundleRoot = DEFAULT_LAUNCHER_BUNDLE,
  scratchRoot = undefined,
  spawn = spawnSync,
  environment = process.env,
  platform = process.platform,
  home,
} = {}) {
  if (typeof generationOutputRoot !== "string" || generationOutputRoot.length === 0) fail("generation_output_root_required");
  if (typeof artifactPath !== "string" || artifactPath.length === 0) fail("artifact_path_required");
  const resolvedOutputRoot = resolve(generationOutputRoot);
  let pointerText;
  try {
    pointerText = await readFile(resolve(resolvedOutputRoot, "current.json"), "utf8");
  } catch {
    fail("missing_current_pointer");
  }
  let pointer;
  try {
    pointer = parseCurrentPointer(pointerText);
  } catch {
    fail("invalid_current_pointer");
  }
  const publishedGenerationRoot = resolve(resolvedOutputRoot, "generations", pointer.generation);
  try {
    if (!(await lstat(publishedGenerationRoot)).isDirectory()) fail("missing_generation");
  } catch {
    fail("missing_generation");
  }

  const launcherBundle = await readLauncherBundle(launcherBundleRoot);

  const scratch = scratchRoot === undefined ? await mkdtemp(join(tmpdir(), "gamebuddy-package-")) : resolve(scratchRoot);
  const stageRoot = resolve(scratch, "payload");
  try {
    await stagePayload({ generationOutputRoot: resolvedOutputRoot, launcherBundle, stageRoot });
    const stagedGenerationRoot = resolve(stageRoot, "generations", pointer.generation);

    // Reuse the owner's packaging-completeness report verbatim: offline runtime, Host
    // build, Mod payload and the launcher entry must each be present by name.
    const packaging = await reportPackagingCompleteness({ outputRoot: stageRoot, generationRoot: stagedGenerationRoot });
    for (const [piece, value] of Object.entries(packaging)) {
      if (value === "absent") fail(`incomplete_package:${piece}`);
    }

    // The EXISTING scanner, run once per tree it is meant to judge - never a second
    // closure walker. The published generation is its own subject (so `runtime/**` and
    // `node_modules/**` keep the zones the owner's gate defines, and the verdict is the
    // verdict `verify-self-contained-generation.mjs --static-only` reports). The launcher
    // bundle is scanned in its own right: it is generation-owned code, so a repository or
    // profile path, or a PATH-interpreter spawn, inside it is blocking too.
    const scanOptions = { repositoryRoot, ...(home === undefined ? {} : { home }) };
    const generationScan = await scanGenerationEnvironmentCoupling({ generationRoot: stagedGenerationRoot, ...scanOptions });
    const launcherScan = await scanGenerationEnvironmentCoupling({ generationRoot: launcherBundle.root, ...scanOptions });
    const generationVerdict = staticGateVerdict(generationScan);
    const launcherVerdict = staticGateVerdict(launcherScan);
    const blocking = [...generationVerdict.blocking, ...launcherVerdict.blocking];
    if (blocking.length > 0) {
      fail(`package_leak:${blocking.map((hit) => `${hit.class}@${hit.file}:${hit.line}`).join(",")}`);
    }

    const invocation = archiveInvocation({ archivePath: artifactPath, payloadRoot: stageRoot, platform, environment });
    await mkdir(dirname(resolve(artifactPath)), { recursive: true });
    await rm(resolve(artifactPath), { force: true });
    const archived = spawn(invocation.command, [...invocation.args], { encoding: "utf8", shell: false, windowsHide: true });
    if (archived.error !== undefined || archived.status !== 0) fail("archive_tool_failed");

    return Object.freeze({
      schema: PACKAGE_SCHEMA,
      ok: true,
      generation: pointer.generation,
      generationRoot: publishedGenerationRoot,
      launcherBundleRoot: launcherBundle.root,
      launcherEntry: launcherBundle.entry,
      artifact: slash(resolve(artifactPath)),
      packaging,
      static: Object.freeze({
        generation: scanSummary(generationScan, generationVerdict),
        launcher: scanSummary(launcherScan, launcherVerdict),
      }),
    });
  } finally {
    await rm(scratch, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 }).catch(() => {});
  }
}

function scanSummary(scan, verdict) {
  return Object.freeze({
    files: scan.files,
    textFiles: scan.textFiles,
    oversizedFiles: scan.oversizedFiles,
    counts: scan.counts,
    verdict: Object.freeze({
      ok: verdict.ok,
      blocking: frozenHits(verdict.blocking),
      reported: Object.freeze(verdict.reported.map((hit) => Object.freeze({ class: hit.class, file: hit.file, line: hit.line }))),
    }),
  });
}

function frozenHits(hits) {
  return Object.freeze(hits.map((hit) => Object.freeze({ class: hit.class, file: hit.file, line: hit.line, snippet: hit.snippet })));
}

if (process.argv[1] === scriptPath) {
  const args = process.argv.slice(2);
  let generationOutputRoot;
  let artifactPath;
  let launcherBundleRoot = DEFAULT_LAUNCHER_BUNDLE;
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === "--launcher-bundle") {
      index += 1;
      launcherBundleRoot = args[index];
      if (typeof launcherBundleRoot !== "string" || launcherBundleRoot.length === 0) fail("launcher_bundle_required");
    } else if (generationOutputRoot === undefined) generationOutputRoot = args[index];
    else if (artifactPath === undefined) artifactPath = args[index];
    else fail(`unexpected_argument:${basename(args[index])}`);
  }
  const result = await packageGenerationForDistribution({ generationOutputRoot, artifactPath, launcherBundleRoot });
  console.log(JSON.stringify(result, null, 2));
}
