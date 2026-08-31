import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
export const hostRoot = resolve(dirname(scriptPath), "..");
export const repositoryRoot = resolve(hostRoot, "..");
export const projectRoot = resolve(hostRoot, "native", "windows-stardew-bootstrap-guardian");
export const projectFile = resolve(projectRoot, "GameBuddy.WindowsStardewBootstrapGuardian.csproj");
export const outputRoot = resolve(projectRoot, ".dist", "win-x64");
export const helperFileName = "GameBuddy.WindowsStardewBootstrapGuardian.exe";
export const manifestFileName = "windows-stardew-bootstrap-guardian.manifest.json";
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

export async function resolveRepositoryDotnet() {
  const state = await lstat(trustedDotnetPath).catch(() => undefined);
  if (!state?.isFile() || state.isSymbolicLink() || !contained("C:\\", trustedDotnetPath))
    throw new Error("windows_stardew_bootstrap_guardian_dotnet_missing");
  return trustedDotnetPath;
}

async function readLockedSdkVersion() {
  let parsed;
  try { parsed = JSON.parse(await readFile(resolve(repositoryRoot, "global.json"), "utf8")); }
  catch { throw new Error("windows_stardew_bootstrap_guardian_dotnet_sdk_lock_invalid"); }
  const version = parsed?.sdk?.version;
  if (typeof version !== "string" || !expectedSdkVersionPattern.test(version))
    throw new Error("windows_stardew_bootstrap_guardian_dotnet_sdk_lock_invalid");
  return version;
}

async function verifyPhysicalPath(path) {
  const physical = await realpath(path);
  const normalize = (value) => resolve(value).replaceAll("\\", "/").toLowerCase();
  if (normalize(path) !== normalize(physical)) throw new Error("windows_stardew_bootstrap_guardian_output_unsafe");
}

async function verifyOutputRootChain() {
  const missing = [];
  let current = dirname(outputRoot);
  for (;;) {
    const state = await lstat(current).catch(() => undefined);
    if (state !== undefined) {
      if (!state.isDirectory() || state.isSymbolicLink()) throw new Error("windows_stardew_bootstrap_guardian_output_unsafe");
      await verifyPhysicalPath(current);
      break;
    }
    missing.push(current);
    const parent = dirname(current);
    if (parent === current) throw new Error("windows_stardew_bootstrap_guardian_output_unsafe");
    current = parent;
  }
  for (const path of missing.reverse()) {
    await mkdir(path);
    const state = await lstat(path);
    if (!state.isDirectory() || state.isSymbolicLink()) throw new Error("windows_stardew_bootstrap_guardian_output_unsafe");
    await verifyPhysicalPath(path);
  }
}

export function canonicalManifest(sha256) {
  if (!/^[a-f0-9]{64}$/.test(sha256)) throw new Error("windows_stardew_bootstrap_guardian_helper_hash_invalid");
  return `{"schemaVersion":${manifestSchemaVersion},"protocolVersion":${protocolVersion},"rid":"${rid}","helperFileName":"${helperFileName}","sha256":"${sha256}"}\n`;
}

async function readVerifiedPair() {
  const helperPath = resolve(outputRoot, helperFileName);
  const manifestPath = resolve(outputRoot, manifestFileName);
  const outputState = await lstat(outputRoot).catch(() => undefined);
  if (!outputState?.isDirectory() || outputState.isSymbolicLink()) return undefined;
  const entries = await readdir(outputRoot);
  if (entries.length !== 2 || !entries.includes(helperFileName) || !entries.includes(manifestFileName)) return undefined;
  const [helperState, manifestState] = await Promise.all([lstat(helperPath).catch(() => undefined), lstat(manifestPath).catch(() => undefined)]);
  if (!helperState?.isFile() || helperState.isSymbolicLink() || !manifestState?.isFile() || manifestState.isSymbolicLink()) return undefined;
  try {
    await verifyPhysicalPath(outputRoot);
    await verifyPhysicalPath(helperPath);
    await verifyPhysicalPath(manifestPath);
  } catch { return undefined; }
  const binary = await readFile(helperPath);
  const sha256 = createHash("sha256").update(binary).digest("hex");
  if (!(await readFile(manifestPath)).equals(Buffer.from(canonicalManifest(sha256), "utf8"))) return undefined;
  return Object.freeze({ helperPath, manifestPath, sha256 });
}

function minimalDotnetEnvironment() {
  const temporaryRoot = resolve(repositoryRoot, ".tmp", "windows-stardew-bootstrap-guardian");
  return {
    SystemRoot: "C:\\Windows", WINDIR: "C:\\Windows", ComSpec: "C:\\Windows\\System32\\cmd.exe", OS: "Windows_NT",
    PROCESSOR_ARCHITECTURE: "AMD64", ProgramFiles: "C:\\Program Files", ProgramW6432: "C:\\Program Files", PROGRAMDATA: "C:\\ProgramData",
    TEMP: temporaryRoot, TMP: temporaryRoot, USERPROFILE: resolve(temporaryRoot, "user-profile"), APPDATA: resolve(temporaryRoot, "appdata"),
    LOCALAPPDATA: resolve(temporaryRoot, "localappdata"), DOTNET_CLI_HOME: resolve(temporaryRoot, "dotnet-home"),
    NUGET_PACKAGES: resolve(temporaryRoot, "nuget-packages"), DOTNET_CLI_TELEMETRY_OPTOUT: "1", DOTNET_SKIP_FIRST_TIME_EXPERIENCE: "1", DOTNET_NOLOGO: "1",
  };
}

async function runBoundedDotnet(command, args) {
  return await new Promise((resolveRun, rejectRun) => {
    let child; let outputBytes = 0; let timedOut = false; const output = [];
    const finish = (error, result) => error ? rejectRun(error) : resolveRun(result);
    try {
      child = spawn(command, args, { cwd: repositoryRoot, env: minimalDotnetEnvironment(), shell: false, windowsHide: true, detached: false, stdio: ["ignore", "pipe", "pipe"] });
    } catch (error) { finish(new Error("windows_stardew_bootstrap_guardian_dotnet_spawn_failed", { cause: error })); return; }
    const collect = (chunk) => {
      outputBytes += chunk.length;
      if (outputBytes <= outputLimitBytes) output.push(chunk); else child.kill();
    };
    child.stdout.on("data", collect); child.stderr.on("data", collect);
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, timeoutMs);
    child.once("error", (error) => { clearTimeout(timer); finish(new Error("windows_stardew_bootstrap_guardian_dotnet_spawn_failed", { cause: error })); });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      if (timedOut) return finish(new Error("windows_stardew_bootstrap_guardian_dotnet_timeout"));
      if (outputBytes > outputLimitBytes) return finish(new Error("windows_stardew_bootstrap_guardian_dotnet_output_overflow"));
      if (code !== 0 || signal) return finish(new Error("windows_stardew_bootstrap_guardian_dotnet_failed"));
      finish(undefined, Buffer.concat(output).toString("utf8"));
    });
  });
}

async function assertLockedSdk(dotnet) {
  const expected = await readLockedSdkVersion();
  const actual = (await runBoundedDotnet(dotnet, ["--version"])).trim();
  if (actual !== expected) throw new Error("windows_stardew_bootstrap_guardian_dotnet_sdk_drift");
}

export async function buildWindowsStardewBootstrapGuardian() {
  if (process.platform !== "win32" || process.arch !== "x64") throw new Error("windows_stardew_bootstrap_guardian_build_requires_win_x64");
  const dotnet = await resolveRepositoryDotnet();
  await assertLockedSdk(dotnet);
  await verifyOutputRootChain();
  const existing = await readVerifiedPair();
  if (existing !== undefined) return existing;
  // Reserve the canonical output root exclusively. Never recursively remove
  // or overwrite a pre-existing root: a stale, partial, or concurrently-owned
  // publication is an unsafe provenance result, not a rebuild target.
  try {
    await mkdir(outputRoot);
  } catch {
    throw new Error("windows_stardew_bootstrap_guardian_output_unsafe");
  }
  const reservation = await lstat(outputRoot);
  if (!reservation.isDirectory() || reservation.isSymbolicLink()) throw new Error("windows_stardew_bootstrap_guardian_output_unsafe");
  await verifyPhysicalPath(outputRoot);
  const args = ["publish", projectFile, "--configuration", "Release", "--runtime", rid, "--self-contained", "true", "--output", outputRoot,
    "-p:PublishSingleFile=true", "-p:PublishTrimmed=false", "-p:DebugType=None", "-p:DebugSymbols=false", "-p:Deterministic=true",
    "-p:ContinuousIntegrationBuild=true", "-p:UseAppHost=true", "--nologo"];
  await runBoundedDotnet(dotnet, args);
  const helperPath = resolve(outputRoot, helperFileName);
  const helperState = await lstat(helperPath).catch(() => undefined);
  if (!helperState?.isFile() || helperState.isSymbolicLink()) throw new Error("windows_stardew_bootstrap_guardian_helper_missing");
  await verifyPhysicalPath(helperPath);
  const publishedEntries = await readdir(outputRoot);
  if (publishedEntries.length !== 1 || publishedEntries[0] !== helperFileName) throw new Error("windows_stardew_bootstrap_guardian_output_unsafe");
  const sha256 = createHash("sha256").update(await readFile(helperPath)).digest("hex");
  const manifestPath = resolve(outputRoot, manifestFileName);
  if (await lstat(manifestPath).catch(() => undefined) !== undefined) throw new Error("windows_stardew_bootstrap_guardian_output_unsafe");
  await writeFile(manifestPath, canonicalManifest(sha256), { encoding: "utf8", flag: "wx" });
  const manifestState = await lstat(manifestPath);
  if (!manifestState.isFile() || manifestState.isSymbolicLink()) throw new Error("windows_stardew_bootstrap_guardian_output_unsafe");
  await verifyPhysicalPath(manifestPath);
  const completedEntries = await readdir(outputRoot);
  if (completedEntries.length !== 2 || !completedEntries.includes(helperFileName) || !completedEntries.includes(manifestFileName)) throw new Error("windows_stardew_bootstrap_guardian_output_unsafe");
  const pair = await readVerifiedPair();
  if (pair === undefined) throw new Error("windows_stardew_bootstrap_guardian_output_unsafe");
  return pair;
}

if (process.argv[1] === scriptPath) {
  try {
    const result = await buildWindowsStardewBootstrapGuardian();
    process.stdout.write(canonicalManifest(result.sha256));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : "windows_stardew_bootstrap_guardian_build_failed"}\n`);
    process.exitCode = 1;
  }
}
