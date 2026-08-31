import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, readdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
export const hostRoot = resolve(dirname(scriptPath), "..");
export const repositoryRoot = resolve(hostRoot, "..");
export const projectRoot = resolve(hostRoot, "native", "windows-stardew-bootstrap-guardian");
export const projectFile = resolve(projectRoot, "GameBuddy.WindowsStardewBootstrapGuardian.csproj");
export const fixtureProjectFile = resolve(projectRoot, "fixtures", "RoleRootFixture.csproj");
export const outputRoot = resolve(projectRoot, ".dist");
export const guardianOutputRoot = resolve(outputRoot, "win-x64");
export const fixtureOutputRoot = resolve(outputRoot, "fixtures");
export const helperFileName = "GameBuddy.WindowsStardewBootstrapGuardian.exe";
export const fixtureFileName = "RoleRootFixture.exe";
export const manifestFileName = "windows-stardew-bootstrap-guardian.manifest.json";
export const protocolVersion = 1;
export const manifestSchemaVersion = 1;
export const rid = "win-x64";
const trustedDotnetPath = "C:\\Program Files\\dotnet\\dotnet.exe";
const timeoutMs = 5 * 60_000;
const probeTimeoutMs = 10_000;
const outputLimitBytes = 64 * 1024;
const expectedSdkVersionPattern = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

function contained(root, value) {
  const remainder = relative(root, value);
  return remainder === "" || (!isAbsolute(remainder) && remainder !== ".." && !remainder.startsWith(`..${sep}`));
}

async function verifyPhysicalPath(path) {
  const physical = await realpath(path);
  const normalized = (value) => resolve(value).replaceAll("\\", "/").toLowerCase();
  if (normalized(path) !== normalized(physical)) throw new Error("windows_stardew_bootstrap_guardian_output_unsafe");
}

async function ensureDirectory(path) {
  await mkdir(path, { recursive: true });
  const state = await lstat(path);
  if (!state.isDirectory() || state.isSymbolicLink()) throw new Error("windows_stardew_bootstrap_guardian_output_unsafe");
  await verifyPhysicalPath(path);
}

export async function resolveRepositoryDotnet() {
  const state = await lstat(trustedDotnetPath).catch(() => undefined);
  if (!state?.isFile() || state.isSymbolicLink() || !contained("C:\\", trustedDotnetPath)) throw new Error("windows_stardew_bootstrap_guardian_dotnet_missing");
  return trustedDotnetPath;
}

async function readLockedSdkVersion() {
  let parsed;
  try { parsed = JSON.parse(await readFile(resolve(repositoryRoot, "global.json"), "utf8")); }
  catch { throw new Error("windows_stardew_bootstrap_guardian_dotnet_sdk_lock_invalid"); }
  const version = parsed?.sdk?.version;
  if (typeof version !== "string" || !expectedSdkVersionPattern.test(version)) throw new Error("windows_stardew_bootstrap_guardian_dotnet_sdk_lock_invalid");
  return version;
}

function minimalDotnetEnvironment() {
  const temporaryRoot = resolve(repositoryRoot, ".tmp", "windows-stardew-bootstrap-guardian");
  return { SystemRoot: "C:\\Windows", WINDIR: "C:\\Windows", ComSpec: "C:\\Windows\\System32\\cmd.exe", OS: "Windows_NT", PROCESSOR_ARCHITECTURE: "AMD64", ProgramFiles: "C:\\Program Files", ProgramW6432: "C:\\Program Files", PROGRAMDATA: "C:\\ProgramData", TEMP: temporaryRoot, TMP: temporaryRoot, USERPROFILE: resolve(temporaryRoot, "user-profile"), APPDATA: resolve(temporaryRoot, "appdata"), LOCALAPPDATA: resolve(temporaryRoot, "localappdata"), DOTNET_CLI_HOME: resolve(temporaryRoot, "dotnet-home"), NUGET_PACKAGES: resolve(temporaryRoot, "nuget-packages"), DOTNET_CLI_TELEMETRY_OPTOUT: "1", DOTNET_SKIP_FIRST_TIME_EXPERIENCE: "1", DOTNET_NOLOGO: "1" };
}

async function runBounded(command, args, { timeout = timeoutMs } = {}) {
  return await new Promise((resolveRun, rejectRun) => {
    let child; let outputBytes = 0; let timedOut = false; const stdout = []; const stderr = [];
    const finish = (error, result) => error ? rejectRun(error) : resolveRun(result);
    try { child = spawn(command, args, { cwd: repositoryRoot, env: minimalDotnetEnvironment(), shell: false, windowsHide: true, detached: false, stdio: ["ignore", "pipe", "pipe"] }); }
    catch (error) { finish(new Error("windows_stardew_bootstrap_guardian_process_spawn_failed", { cause: error })); return; }
    const collect = (target) => (chunk) => { outputBytes += chunk.length; if (outputBytes <= outputLimitBytes) target.push(chunk); else child.kill(); };
    child.stdout.on("data", collect(stdout)); child.stderr.on("data", collect(stderr));
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, timeout);
    child.once("error", (error) => { clearTimeout(timer); finish(new Error("windows_stardew_bootstrap_guardian_process_spawn_failed", { cause: error })); });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      if (timedOut) return finish(new Error("windows_stardew_bootstrap_guardian_process_timeout"));
      if (outputBytes > outputLimitBytes) return finish(new Error("windows_stardew_bootstrap_guardian_process_output_overflow"));
      finish(undefined, Object.freeze({ code, signal, stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8") }));
    });
  });
}

async function assertLockedSdk(dotnet) {
  const result = await runBounded(dotnet, ["--version"]);
  if (result.code !== 0 || result.signal || result.stdout.trim() !== await readLockedSdkVersion()) throw new Error("windows_stardew_bootstrap_guardian_dotnet_sdk_drift");
}

async function publishProject(dotnet, project, destination) {
  await ensureDirectory(destination);
  const result = await runBounded(dotnet, ["publish", project, "--configuration", "Release", "--runtime", rid, "--self-contained", "true", "--output", destination, "-p:PublishSingleFile=true", "-p:PublishTrimmed=false", "-p:DebugType=None", "-p:DebugSymbols=false", "-p:Deterministic=true", "-p:ContinuousIntegrationBuild=true", "-p:UseAppHost=true", "--nologo"]);
  if (result.code !== 0 || result.signal) throw new Error("windows_stardew_bootstrap_guardian_dotnet_failed");
}

async function verifyExactOutput(destination, names) {
  const entries = await readdir(destination);
  if (entries.length !== names.length || !names.every((name) => entries.includes(name))) throw new Error("windows_stardew_bootstrap_guardian_output_unsafe");
  const paths = [];
  for (const name of names) {
    const path = resolve(destination, name);
    const state = await lstat(path);
    if (!state.isFile() || state.isSymbolicLink()) throw new Error("windows_stardew_bootstrap_guardian_output_unsafe");
    await verifyPhysicalPath(path);
    paths.push(path);
  }
  return paths;
}

async function probeGuardian(helperPath) {
  // The guardian has no valid no-input startup state: a bounded clean exit with
  // its fail-closed status proves this freshly published self-contained apphost launches.
  const result = await runBounded(helperPath, [], { timeout: probeTimeoutMs });
  if (result.code !== 1 || result.signal || result.stdout !== "" || result.stderr !== "windows_stardew_bootstrap_guardian_invalid_request\n") throw new Error("windows_stardew_bootstrap_guardian_probe_failed");
}

export function canonicalManifest(sha256) {
  if (!/^[a-f0-9]{64}$/.test(sha256)) throw new Error("windows_stardew_bootstrap_guardian_helper_hash_invalid");
  return `{"schemaVersion":${manifestSchemaVersion},"protocolVersion":${protocolVersion},"rid":"${rid}","helperFileName":"${helperFileName}","sha256":"${sha256}"}\n`;
}

async function renameWithBoundedRetry(from, to, renameDirectory) {
  const retryable = new Set(["EACCES", "EBUSY", "EPERM"]);
  let lastError;
  for (let attempt = 0; attempt < 5; attempt++) {
    try { await renameDirectory(from, to); return; }
    catch (error) {
      lastError = error;
      if (!retryable.has(error?.code) || attempt === 4) throw error;
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 25 * (attempt + 1)));
    }
  }
  throw lastError;
}

async function replaceFinalDirectories(stagingGuardian, stagingFixture, { output = outputRoot, guardianOutput = guardianOutputRoot, fixtureOutput = fixtureOutputRoot, renameDirectory = rename } = {}) {
  const backupRoot = resolve(output, `.replaced-${randomUUID()}`);
  const backupGuardian = resolve(backupRoot, "win-x64");
  const backupFixture = resolve(backupRoot, "fixtures");
  const moves = [];
  let replacementComplete = false;
  let rollbackComplete = false;
  try {
    await mkdir(backupRoot);
    for (const [finalRoot, backup] of [[guardianOutput, backupGuardian], [fixtureOutput, backupFixture]]) {
      if (await lstat(finalRoot).catch(() => undefined)) { await renameWithBoundedRetry(finalRoot, backup, renameDirectory); moves.push([backup, finalRoot]); }
    }
    await renameWithBoundedRetry(stagingGuardian, guardianOutput, renameDirectory); moves.push([guardianOutput, stagingGuardian]);
    await renameWithBoundedRetry(stagingFixture, fixtureOutput, renameDirectory); moves.push([fixtureOutput, stagingFixture]);
    replacementComplete = true;
  } catch (error) {
    rollbackComplete = true;
    for (const [from, to] of moves.reverse()) {
      try { await renameWithBoundedRetry(from, to, renameDirectory); }
      catch { rollbackComplete = false; }
    }
    if (!rollbackComplete) throw new Error("windows_stardew_bootstrap_guardian_publication_quarantined", { cause: error });
    throw error;
  } finally {
    if (replacementComplete || rollbackComplete) await rm(backupRoot, { recursive: true, force: true });
  }
}

/** Freshly publishes the production Guardian pair and disposable test fixture
 * into private staging, verifies both, then installs their fixed destinations.
 * Only win-x64 is a production-consumed pair. The fixtures directory is test-only
 * and is never an active generation or a production authority input. The builder
 * deliberately never reuses an existing Task 0 output. */
export async function buildWindowsStardewBootstrapGuardian() {
  const output = outputRoot;
  const guardianOutput = guardianOutputRoot;
  const fixtureOutput = fixtureOutputRoot;
  if (process.platform !== "win32" || process.arch !== "x64") throw new Error("windows_stardew_bootstrap_guardian_build_requires_win_x64");
  const stagingRoot = resolve(output, `.staging-${randomUUID()}`);
  const stagingGuardian = resolve(stagingRoot, "win-x64");
  const stagingFixture = resolve(stagingRoot, "fixtures");
  if (!contained(output, stagingRoot) || stagingRoot === output || !contained(output, guardianOutput) || !contained(output, fixtureOutput)) throw new Error("windows_stardew_bootstrap_guardian_output_unsafe");
  try {
    await ensureDirectory(output);
    await mkdir(stagingRoot);
    await verifyPhysicalPath(stagingRoot);
    const dotnet = await resolveRepositoryDotnet();
    await assertLockedSdk(dotnet);
    await publishProject(dotnet, projectFile, stagingGuardian);
    const [helperPath] = await verifyExactOutput(stagingGuardian, [helperFileName]);
    const sha256 = createHash("sha256").update(await readFile(helperPath)).digest("hex");
    await writeFile(resolve(stagingGuardian, manifestFileName), canonicalManifest(sha256), { encoding: "utf8", flag: "wx" });
    await verifyExactOutput(stagingGuardian, [helperFileName, manifestFileName]);
    await probeGuardian(helperPath);
    await publishProject(dotnet, fixtureProjectFile, stagingFixture);
    const [fixturePath] = await verifyExactOutput(stagingFixture, [fixtureFileName]);
    await replaceFinalDirectories(stagingGuardian, stagingFixture, { output, guardianOutput, fixtureOutput });
    return Object.freeze({ helperPath: resolve(guardianOutput, helperFileName), fixturePath: resolve(fixtureOutput, fixtureFileName), sha256 });
  } finally {
    await rm(stagingRoot, { recursive: true, force: true });
  }
}

if (process.argv[1] === scriptPath) {
  try { const result = await buildWindowsStardewBootstrapGuardian(); process.stdout.write(canonicalManifest(result.sha256)); }
  catch (error) { process.stderr.write(`${error instanceof Error ? error.message : "windows_stardew_bootstrap_guardian_build_failed"}\n`); process.exitCode = 1; }
}
