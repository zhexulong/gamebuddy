import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
export const hostRoot = resolve(dirname(scriptPath), "..");
export const repositoryRoot = resolve(hostRoot, "..");
export const projectRoot = resolve(hostRoot, "native", "windows-stale-lock-reclaimer");
export const projectFile = resolve(projectRoot, "GameBuddy.WindowsStaleLockReclaimer.csproj");
export const outputRoot = resolve(projectRoot, ".dist", "win-x64");
export const helperFileName = "GameBuddy.WindowsStaleLockReclaimer.exe";
export const manifestFileName = "windows-stale-lock-reclaimer.manifest.json";
export const protocolVersion = 1;
export const manifestSchemaVersion = 1;
export const rid = "win-x64";
const trustedDotnetPath = "C:\\Program Files\\dotnet\\dotnet.exe";
const timeoutMs = 5 * 60_000;
const outputLimitBytes = 64 * 1024;
const expectedSdkVersionPattern = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

function contained(root, value) {
  const remainder = relative(root, value);
  return remainder === "" || (!isAbsolute(remainder) && remainder !== ".." && !remainder.startsWith(`..${sep}`));
}

/** Resolves only the repository policy's fixed Windows SDK host. */
export async function resolveRepositoryDotnet() {
  const state = await lstat(trustedDotnetPath).catch(() => undefined);
  if (!state?.isFile() || state.isSymbolicLink() || !contained("C:\\", trustedDotnetPath)) throw new Error("windows_stale_lock_reclaimer_dotnet_missing");
  return trustedDotnetPath;
}

async function readLockedSdkVersion() {
  let parsed;
  try { parsed = JSON.parse(await readFile(resolve(repositoryRoot, "global.json"), "utf8")); }
  catch { throw new Error("windows_stale_lock_reclaimer_dotnet_sdk_lock_invalid"); }
  const version = parsed?.sdk?.version;
  if (typeof version !== "string" || !expectedSdkVersionPattern.test(version)) throw new Error("windows_stale_lock_reclaimer_dotnet_sdk_lock_invalid");
  return version;
}

/**
 * Bounded no-follow/reparse preflight of the fixed output chain. Walks from
 * the output root's parent upward until an existing directory is found,
 * verifying each existing ancestor is a real (non-link, non-reparse)
 * directory, then creates each missing level (below the output root itself)
 * one at a time and verifies it immediately after creation. The output root
 * is never created here: a fresh publication reserves it with exclusive
 * creation. Any link, reparse, file, or ambiguous entry fails closed; this
 * function never removes or overwrites anything.
 */
async function verifyOutputRootChain() {
  const missing = [];
  let current = dirname(outputRoot);
  for (;;) {
    const state = await lstat(current).catch(() => undefined);
    if (state !== undefined) {
      if (!state.isDirectory() || state.isSymbolicLink()) throw new Error("windows_stale_lock_reclaimer_output_unsafe");
      await verifyPhysicalPath(current);
      break;
    }
    missing.push(current);
    const parent = dirname(current);
    if (parent === current) throw new Error("windows_stale_lock_reclaimer_output_unsafe");
    current = parent;
  }
  for (const path of missing.reverse()) {
    await mkdir(path);
    const state = await lstat(path);
    if (!state.isDirectory() || state.isSymbolicLink()) throw new Error("windows_stale_lock_reclaimer_output_unsafe");
    await verifyPhysicalPath(path);
  }
}

async function verifyPhysicalPath(path) {
  const physical = await realpath(path);
  const normalized = (value) => resolve(value).replaceAll("\\", "/");
  if (normalized(path).toLowerCase() !== normalized(physical).toLowerCase()) {
    throw new Error("windows_stale_lock_reclaimer_output_unsafe");
  }
}

/** Returns the existing pair only when the output root and both files are
 * real non-reparse objects whose physical identity equals their canonical
 * paths and the manifest byte-exactly matches the canonical manifest of the
 * helper hash. Any incomplete, mismatched, linked, reparse, or replaced
 * output is not a pair. */
async function readVerifiedPair() {
  const helperPath = resolve(outputRoot, helperFileName);
  const manifestPath = resolve(outputRoot, manifestFileName);
  const [outputState, helperState, manifestState] = await Promise.all([
    lstat(outputRoot).catch(() => undefined),
    lstat(helperPath).catch(() => undefined),
    lstat(manifestPath).catch(() => undefined),
  ]);
  if (!outputState?.isDirectory() || outputState.isSymbolicLink()) return undefined;
  if (!helperState?.isFile() || helperState.isSymbolicLink() || !manifestState?.isFile() || manifestState.isSymbolicLink()) return undefined;
  try {
    await verifyPhysicalPath(outputRoot);
    await verifyPhysicalPath(helperPath);
    await verifyPhysicalPath(manifestPath);
  } catch {
    return undefined;
  }
  const [rawManifest, binary] = await Promise.all([readFile(manifestPath), readFile(helperPath)]);
  const sha256 = createHash("sha256").update(binary).digest("hex");
  if (!rawManifest.equals(Buffer.from(canonicalManifest(sha256), "utf8"))) return undefined;
  return Object.freeze({ helperPath, manifestPath, sha256 });
}

export function canonicalManifest(sha256) {
  if (!/^[a-f0-9]{64}$/.test(sha256)) throw new Error("windows_stale_lock_reclaimer_helper_hash_invalid");
  return `{"schemaVersion":${manifestSchemaVersion},"protocolVersion":${protocolVersion},"rid":"${rid}","helperFileName":"${helperFileName}","sha256":"${sha256}"}\n`;
}

function minimalDotnetEnvironment() {
  const temporaryRoot = resolve(repositoryRoot, ".tmp", "windows-stale-lock-reclaimer");
  return {
    SystemRoot: "C:\\Windows",
    WINDIR: "C:\\Windows",
    ComSpec: "C:\\Windows\\System32\\cmd.exe",
    OS: "Windows_NT",
    PROCESSOR_ARCHITECTURE: "AMD64",
    ProgramFiles: "C:\\Program Files",
    ProgramW6432: "C:\\Program Files",
    PROGRAMDATA: "C:\\ProgramData",
    TEMP: temporaryRoot,
    TMP: temporaryRoot,
    USERPROFILE: resolve(temporaryRoot, "user-profile"),
    APPDATA: resolve(temporaryRoot, "appdata"),
    LOCALAPPDATA: resolve(temporaryRoot, "localappdata"),
    DOTNET_CLI_HOME: resolve(temporaryRoot, "dotnet-home"),
    NUGET_PACKAGES: resolve(temporaryRoot, "nuget-packages"),
    DOTNET_CLI_TELEMETRY_OPTOUT: "1",
    DOTNET_SKIP_FIRST_TIME_EXPERIENCE: "1",
    DOTNET_NOLOGO: "1",
  };
}

async function runBoundedDotnet(command, args) {
  return await new Promise((resolveRun, rejectRun) => {
    let child; let outputBytes = 0; let timedOut = false; const output = [];
    const finish = (error, result) => error ? rejectRun(error) : resolveRun(result);
    try {
      child = spawn(command, args, { cwd: repositoryRoot, env: minimalDotnetEnvironment(), shell: false, windowsHide: true, detached: false, stdio: ["ignore", "pipe", "pipe"] });
    } catch (error) { finish(new Error("windows_stale_lock_reclaimer_dotnet_spawn_failed", { cause: error })); return; }
    const collect = (chunk) => {
      outputBytes += chunk.length;
      if (outputBytes <= outputLimitBytes) output.push(chunk);
      else child.kill();
    };
    child.stdout.on("data", collect); child.stderr.on("data", collect);
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, timeoutMs);
    child.once("error", (error) => { clearTimeout(timer); finish(new Error("windows_stale_lock_reclaimer_dotnet_spawn_failed", { cause: error })); });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      if (timedOut) return finish(new Error("windows_stale_lock_reclaimer_dotnet_timeout"));
      if (outputBytes > outputLimitBytes) return finish(new Error("windows_stale_lock_reclaimer_dotnet_output_overflow"));
      if (code !== 0 || signal) return finish(new Error("windows_stale_lock_reclaimer_dotnet_failed"));
      finish(undefined, Buffer.concat(output).toString("utf8"));
    });
  });
}

async function assertLockedSdk(dotnet) {
  const expected = await readLockedSdkVersion();
  const actual = (await runBoundedDotnet(dotnet, ["--version"])).trim();
  if (actual !== expected) throw new Error("windows_stale_lock_reclaimer_dotnet_sdk_drift");
}

export async function buildWindowsStaleLockReclaimer() {
  if (process.platform !== "win32") throw new Error("windows_stale_lock_reclaimer_build_requires_windows");
  const dotnet = await resolveRepositoryDotnet();
  await assertLockedSdk(dotnet);
  // The fixed output chain is never recursively removed or overwritten. A
  // complete canonical verified pair is returned unchanged; a fresh
  // publication reserves a previously absent output using exclusive creation
  // and publishes only into that reservation. Any pre-existing object,
  // reparse, extra entry, incomplete pair, replacement, or ambiguous identity
  // fails closed without touching an external target.
  await verifyOutputRootChain();
  const existing = await readVerifiedPair();
  if (existing !== undefined) return existing;
  // Exclusive reservation: a pre-existing object of any kind fails closed.
  try {
    await mkdir(outputRoot);
  } catch {
    throw new Error("windows_stale_lock_reclaimer_output_unsafe");
  }
  const reservation = await lstat(outputRoot);
  if (!reservation.isDirectory() || reservation.isSymbolicLink()) throw new Error("windows_stale_lock_reclaimer_output_unsafe");
  await verifyPhysicalPath(outputRoot);
  const args = ["publish", projectFile, "--configuration", "Release", "--runtime", rid, "--self-contained", "true", "--output", outputRoot, "-p:PublishSingleFile=true", "-p:PublishTrimmed=false", "-p:DebugType=None", "-p:DebugSymbols=false", "-p:Deterministic=true", "-p:ContinuousIntegrationBuild=true", "-p:UseAppHost=true", "--nologo"];
  await runBoundedDotnet(dotnet, args);
  const helperPath = resolve(outputRoot, helperFileName);
  const helperState = await lstat(helperPath).catch(() => undefined);
  if (!helperState?.isFile() || helperState.isSymbolicLink()) throw new Error("windows_stale_lock_reclaimer_helper_missing");
  await verifyPhysicalPath(helperPath);
  // The publish output must be exactly the helper; any extra object makes the
  // publication unsafe and fails closed.
  const publishedEntries = await readdir(outputRoot);
  if (publishedEntries.length !== 1 || publishedEntries[0] !== helperFileName) throw new Error("windows_stale_lock_reclaimer_output_unsafe");
  const sha256 = createHash("sha256").update(await readFile(helperPath)).digest("hex");
  const manifestPath = resolve(outputRoot, manifestFileName);
  // Manifest creation is exclusive and never follows an existing link/reparse
  // entry: any pre-existing manifest path of any kind fails closed here.
  const preExistingManifest = await lstat(manifestPath).catch(() => undefined);
  if (preExistingManifest !== undefined) throw new Error("windows_stale_lock_reclaimer_output_unsafe");
  await writeFile(manifestPath, canonicalManifest(sha256), { encoding: "utf8", flag: "wx" });
  const manifestState = await lstat(manifestPath);
  if (!manifestState.isFile() || manifestState.isSymbolicLink()) throw new Error("windows_stale_lock_reclaimer_output_unsafe");
  await verifyPhysicalPath(manifestPath);
  const completedEntries = await readdir(outputRoot);
  if (completedEntries.length !== 2 || !completedEntries.includes(helperFileName) || !completedEntries.includes(manifestFileName)) throw new Error("windows_stale_lock_reclaimer_output_unsafe");
  const pair = await readVerifiedPair();
  if (pair === undefined) throw new Error("windows_stale_lock_reclaimer_output_unsafe");
  return pair;
}

if (process.argv[1] === scriptPath) {
  try {
    const result = await buildWindowsStaleLockReclaimer();
    process.stdout.write(`${canonicalManifest(result.sha256)}`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : "windows_stale_lock_reclaimer_build_failed"}\n`);
    process.exitCode = 1;
  }
}
